# Runbook — GHL (GoHighLevel) ingestion

Read-only mirror of the GHL sub-account into Supabase. New **outbound** campaigns
run in GHL (Close keeps the advertising funnel + the two finished Close outbound
pools, Revival & Jacob). Per Principles 1–2 we mirror GHL into our DB and read
from there; the dashboard/agents never call GHL directly.

- **Code:** `ingestion/ghl/` (`client.py`, `pipeline.py`), `api/ghl_sync_cron.py`,
  `scripts/backfill_ghl.py`.
- **Tables:** `ghl_contacts`, `ghl_conversations`, `ghl_messages` (migration `0114`).
  See `docs/schema/ghl_*.md`.
- **Schedule:** `*/15 * * * *` (`vercel.json`).

## What it does

Each tick (`run_sync(full=False)`):
0. **Custom-field defs + user map** — upsert `ghl_custom_field_definitions`
   (name→id, so an outbound campaign's `match_field_name` resolves on the GHL
   side) and map GHL users → `team_members.ghl_user_id` by email (so the Outbound
   by-rep block attributes GHL calls to named reps). Both cheap.
1. **Contacts** — paginate `/contacts/` and upsert every contact (idempotent on
   `id`). Cheap (~1.2k contacts ≈ 12 pages).
2. **Conversations** — paginate `/conversations/search`, upsert each.
3. **Messages (incremental)** — for each conversation, re-pull
   `/conversations/{id}/messages` **only** when its `last_message_date` is newer
   than the stored `messages_synced_at` watermark (or it's new). Upsert SMS +
   calls into `ghl_messages`. The watermark advances only on a clean pull, so a
   mid-pull failure re-pulls next tick instead of silently skipping.

The funnel signals this feeds (consumed later by the re-sourced
`refresh_outbound_facts` GHL arm):

| Signal | Rule |
|---|---|
| campaign membership / leads | `ghl_contacts.source` (and later `tags`) |
| responded | inbound `TYPE_SMS` |
| called | outbound `TYPE_CALL` |
| **connected** | `TYPE_CALL` with `call_status='completed'` AND `call_duration >= 90` |
| rep (by-rep) | `ghl_messages.user_id` → GHL user → `team_members` |
| closes/cash | `airtable_full_closer_report` joined on `lead_id = ghl_contacts.id` (the contact id == the Airtable "Lead ID" prefilled into the contact's "EOC From" field, mirrored as `eoc_lead_id`) |

## Auth & credentials

- `GHL_PRIVATE_TOKEN` — a **Private Integration Token** (read-only scopes). Created
  in the GHL sub-account: Settings → Private Integrations.
  Scopes granted: `contacts.readonly`, `conversations.readonly`,
  `conversations/message.readonly`, `locations.readonly`,
  `locations/customFields.readonly`, `users.readonly`. **No write scopes.**
- `GHL_LOCATION_ID` — the sub-account id (from the GHL URL `/location/<id>/`).
  Required on most v2 endpoints even with a location-scoped token.
- v2 headers: `Authorization: Bearer <token>` + `Version: 2021-07-28`.
- Inventory/rotation: `docs/runbooks/credentials-and-accounts.md`.

## First-time setup / backfill

1. Apply migration `0114` (canonical path in
   `docs/sales/ingestion.md` § Ops traps). Dual-verify against cloud.
2. Set `GHL_PRIVATE_TOKEN` + `GHL_LOCATION_ID` in `.env.local` (local) and Vercel
   (prod).
3. **Smoke first:** `.venv/bin/python scripts/backfill_ghl.py --smoke` — one
   contact + one conversation's messages round-tripped through the real API + DB.
4. **Full backfill:** `.venv/bin/python scripts/backfill_ghl.py --apply`. Do this
   **before** relying on the cron — a cold cron with no watermarks would try to
   pull every conversation's messages in one tick.

## Failure modes & debugging

- **403 Forbidden on every request** → the WAF blocked a missing/blocked
  `User-Agent` (stdlib urllib's default is blocked). The client always sends a UA;
  if you see this from a new caller, set a `User-Agent` header. With a UA set, a
  403 is a **genuine missing scope** — check the Private Integration's scopes.
- **401 Unauthorized** → bad/expired token. Note GHL may **regenerate the token**
  when you edit scopes — re-paste it into `.env.local` + Vercel.
- **429** → rate limited; the client retries with `Retry-After` backoff (GHL v2
  burst ≈ 100 req/10s). The expensive part is per-conversation message pulls;
  incremental keeps steady-state runs small.
- **Cron timing out** → a cold run (no watermarks) pulls all conversations. Run
  the local backfill once to seed watermarks. `maxDuration` is 300s.
- **Audit:** every tick writes a `webhook_deliveries` row with `source='ghl_sync'`
  (counts + first 50 errors). Query it to see run history.
- **Local DB gotcha:** `.env.local` `SUPABASE_URL` may point at local Docker — see
  `docs/sales/ingestion.md` § The env-var gotcha before running diagnostics.

## Webhooks (real-time — `api/ghl_events.py`)

Live layer on top of the cron: new leads + customer replies (and calls) land in
seconds instead of ≤15 min. The cron stays as the **reconciliation backstop**
(house pattern: webhook live + cron backstop).

**Delivery path.** Our access is a Private Integration Token, not a marketplace
OAuth app, so events arrive via a GHL **Workflow → Custom Webhook** action (built
in the GHL UI), not native signed event subscriptions. Recommended workflows
(triggers → Custom Webhook POST to `…/api/ghl_events`):
- **Contact Created** → so a new lead lands immediately.
- **Contact Tag / Custom-field changed** → because the campaign field is usually
  stamped *after* creation; this catches membership in real time (else the cron
  picks it up within 15 min).
- **Customer Replied** (inbound message) → the responded signal.
- Optionally an outbound-call/message trigger → dials/connected (`callDuration` +
  `userId`); otherwise the cron backstops calls.

**Auth.** Workflow webhooks aren't Ed25519-signed (that's marketplace apps), so
the receiver uses a shared secret: set `GHL_WEBHOOK_SECRET` (we choose a long
random value) in Vercel, and add it to each workflow's Custom Webhook **header** —
`Authorization: Bearer <secret>` or `X-GHL-Webhook-Secret: <secret>`. Until set,
the receiver returns 401.

**Shape caveat (verify the first delivery).** A workflow webhook payload may
differ from the v2 API shape, so `ingestion/ghl/pipeline.parse_webhook_*`
normalize defensively (messageTypeString→TYPE_*, callDuration/callStatus flat,
customFields dict→list). Every delivery's **raw payload is stored in
`webhook_deliveries` (`source='ghl_events'`)** — inspect the first real one and
adjust the parser if a field differs. The receiver always responds 2xx on a
handled error so GHL doesn't disable the webhook.

## Manual trigger (prod)

```
# Cron:
curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \
     https://ai-enablement-sigma.vercel.app/api/ghl_sync_cron
# Webhook receiver (simulate a delivery):
curl -i -X POST -H "Authorization: Bearer $GHL_WEBHOOK_SECRET" \
     -H "Content-Type: application/json" \
     -d '{"type":"ContactCreate","id":"test123","source":"DC Revival Lead"}' \
     https://ai-enablement-sigma.vercel.app/api/ghl_events
```
