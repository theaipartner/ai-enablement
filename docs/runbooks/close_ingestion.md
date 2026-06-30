# Runbook: Close CRM Ingestion

This runbook covers backfill, ongoing ingestion approach, idempotency, the canonical-decisions baked into the schema (triage-count path + tier derivation), and failure-mode debugging. Mirrors the shape of `docs/runbooks/fathom_backlog_ingest.md` + `docs/runbooks/cs_call_summary.md`.

## What this ingestion does

Mirrors Close CRM raw objects into six Supabase tables (see `docs/schema/close_*.md`):

- `close_leads` — denormalized lead mirror
- `close_lead_status_changes` — funnel-spine event stream
- `close_calls` — Call activities
- `close_sms` — SMS activities (the dominant channel)
- `close_opportunities` — workflow markers (NOT money)
- `close_custom_field_definitions` — cf reference table

Idempotent on Close's stable IDs (`lead_*`, `acti_*`, `oppo_*`, `cf_*`). Re-running never duplicates rows.

## Architecture

```
                          ┌───────────────────────┐
                          │  Close REST API       │
                          │  (read-only)          │
                          └───────────┬───────────┘
                                      │
                          ┌───────────▼───────────┐
                          │  ingestion/close/     │
                          │    client.py          │  HTTP Basic auth (key-as-username)
                          │    parser.py          │  JSON → row dicts + cf projection
                          │    pipeline.py        │  Idempotent upserts (supabase-py)
                          └───────────┬───────────┘
                                      │
              ┌───────────────────────┼──────────────────────────┐
              ▼                       ▼                          ▼
   scripts/backfill_close.py    api/close_poll_cron.py    (future: webhook receiver)
   one-shot backfill            scheduled incremental     real-time push
                                (planned — see below)     (deferred — see below)
```

No agent code reads from Close. No code outside `ingestion/close/` and `scripts/backfill_close.py` calls Close's API.

## Backfill

### Modes

```bash
.venv/bin/python scripts/backfill_close.py            # dry-run (default)
.venv/bin/python scripts/backfill_close.py --smoke    # 1 lead end-to-end
.venv/bin/python scripts/backfill_close.py --apply    # bulk
.venv/bin/python scripts/backfill_close.py --apply --limit 50
```

### Smoke gate (mandatory before any `--apply`)

Per CLAUDE.md § Operational patterns, a real-API smoke MUST pass before any bulk apply. The smoke pulls one real lead end-to-end (full lead JSON + activities + cf definitions) against the real DB. It's idempotent — safe to re-run after fixes.

If smoke fails, investigate before re-trying. Common failure modes:

- **401/403 on `/me/`** — `CLOSE_API_KEY` not set, or API key rotated. Confirm `.env.local` value (Settings → Developer → API Keys in Close to regenerate).
- **Supabase column mismatch** — migration 0043 not applied, or applied to wrong env. Run dual-verify per `docs/runbooks/apply_migrations.md`.
- **`HTTP 400` from /activity/** — unexpected `_type__in` value. The pipeline requests `Call,SMS,LeadStatusChange`; if Close renames a type, the parser silently skips unknown types but won't 400.

### Bulk `--apply`

The first bulk `--apply` is the first large-scale production write of this arc. **Confirm the smoke result before invoking `--apply` at full scope.** Subsequent re-runs (after a parser fix, etc.) are safe — the idempotency contract holds.

### Expected scale (today)

From the inventory probe sampling: the org has at least 2000 recent leads. With ~30 activities per lead average (calls + SMS + status changes; SMS is by far the densest), expect roughly:

- ~10,000+ leads total
- ~10,000+ status-change rows
- ~10,000+ call rows
- ~50,000+ SMS rows (SMS is 67% of activity)
- ~30,000+ opportunity rows (multiple per lead)

These are rough order-of-magnitude estimates — the bulk apply's actual counts will be reported and should be eyeball-sanity-checked against the team's expectations.

### Pagination ceilings

Close documents a `_skip` ceiling that varies by resource. The pipeline's `PAGINATION_SAFETY_MAX_PAGES = 200` (page size 100) caps top-level paginators at 20000 rows. If the backfill hits this ceiling, switch to the Close Export API (deferred — see § Out of scope).

## Canonical decisions baked into the schema

### Triage-count path: `close_leads.triage_showed = 'Yes'`

The Engine sheet has "Total Closer Triages" as an APPOINTMENT SETTING metric. Two paths exist in Close:

| Path | Source | Semantic | Sample density |
|------|--------|----------|---------------|
| A | `close_lead_status_changes` where `new_status_id = 'stat_GZca...' (Unconfirmed Booking - Handed over)` | Hand-OVER event (closer takes the lead) | 51 events / 25 sampled leads — dense |
| B | `close_leads.triage_showed = 'Yes'` (cf) | Triage CALL happened (closer marks the cf) | 3 / 25 sampled leads — sparse |

**Canonical = Path B** because the definition of triage is "the phone call where a human qualifies the lead." A status flip to Handed-over marks the hand-OVER, not the triage call.

**Gap risk:** Path B undercounts unless closers consistently fill in the `Triage Showed` cf. Daily reconciliation:

```sql
-- Count gap between hand-overs and triages-marked-as-done
SELECT
  count(*) FILTER (WHERE new_status_id = 'stat_GZca7DExvxZ2FkjKNFgWxqrlKwB1ULxA2xKrYszhVf5') AS handovers,
  (SELECT count(*) FROM close_leads
   WHERE triage_showed = 'Yes' AND date_updated >= current_date - interval '7 days') AS triages_marked
FROM close_lead_status_changes
WHERE date_created >= current_date - interval '7 days';
```

If the gap grows materially, surface to the team — the cf is the canonical source and closers must fill it in.

### Tier derivation: ≥ $2k disposable → tier_1

Business logic: qualified for high-ticket if ≥ $2k disposable income; otherwise unqualified, routes to setter / digital college. The `investment` cf carries Typeform output strings (e.g. `'Under $2,000'`, `'$2,000 - $5,000'`).

Implementation: `ingestion.close.parser.derive_tier()`.

| Investment value (typical) | Tier |
|----------------------------|------|
| `Under $2,000` | `tier_2` |
| `Under $5,000` | `tier_1` (ceiling > $2k qualifies) |
| `$2,000 - $5,000` | `tier_1` (floor ≥ $2k) |
| `$5,000 - $10,000` | `tier_1` |
| `$1,000 - $2,000` | `tier_2` (floor < $2k) |
| empty / unrecognized | `null` (don't guess) |

Refreshed in ingestion on every lead upsert; written to `close_leads.tier`.

If Typeform values diverge from the assumed pattern, update `_CF_NAME_TO_COLUMN` / `derive_tier` in `ingestion/close/parser.py` and re-run the backfill (idempotent — `tier` refreshes on every upsert).

## Ongoing ingestion: live webhooks (shipped 2026-05-23 — `close-live-webhooks`)

**Live path: `api/close_events.py`** — a Vercel serverless function Close pushes events to in real time. Webhooks are used over polling for true real-time freshness; the polling helper (`sync_recently_updated_leads`) is kept as an operational backstop for catching up after webhook outages.

### Subscribed events

Registered via `scripts/register_close_webhook.py`; the script's `EVENTS_IN_SCOPE` list is the source of truth. Current set:

| Object type | Action | Routes to |
|---|---|---|
| `lead` | `created` / `updated` / `merged` | `close_leads` |
| `opportunity` | `created` / `updated` | `close_opportunities` |
| `activity.call` | `created` / `updated` / `answered` / `completed` | `close_calls` |
| `activity.sms` | `created` / `updated` / `sent` | `close_sms` |
| `activity.lead_status_change` | `created` / `updated` | `close_lead_status_changes` |

**Triage stays in Airtable, NOT Close** — see § Triage-count path above. The webhook ingest mirrors `close_leads.triage_showed` if it appears in a lead payload (harmless), but it's not the canonical triage source.

**Custom-activity events + opportunity-status-change activity events are NOT routed** today — both fold into the lead-status-change or opportunity.updated events that already trigger upserts. Add a route in `_route_event` (api/close_events.py) if a future metric needs the dedicated stream.

### Signature verification (security boundary)

Close signs every delivery. Algorithm (verbatim from Close docs, fetched 2026-05-23):

```python
data = headers['close-sig-timestamp'] + payload
signature = hmac.new(bytearray.fromhex(key), data.encode('utf-8'),
                     hashlib.sha256).hexdigest()
valid = hmac.compare_digest(headers['close-sig-hash'], signature)
```

- `key` = `CLOSE_WEBHOOK_SECRET` env var (hex string; Close gives it once at subscription creation).
- Replay window: 5 minutes against `close-sig-timestamp` (Close doesn't document a window; we add one defensively).
- Implementation: `api/close_events.py:_verify_signature`. Unit tests in `tests/api/test_close_events.py` exercise tampered body, wrong timestamp, wrong/empty/non-hex secret, empty headers.

### Idempotency

Three layers:

1. **Audit-row dedup:** synthesized `webhook_id = "close:{timestamp}:{sha256(body)[:16]}"`. PK on `webhook_deliveries.webhook_id` makes true duplicates a no-op (200 fast-ack, no re-processing).
2. **Per-row upsert:** every helper in `ingestion/close/pipeline.py` calls `.upsert(on_conflict="close_id")`. A legitimate retry with a fresh timestamp re-attempts processing but doesn't duplicate.
3. **Fail-soft:** handler exceptions mark the row `failed` and STILL return 200 so Close doesn't auto-disable after 3 days of failures. Use the polling backstop to heal anything that truly failed.

### Live activation runbook

Sequential — each step depends on the previous one landing:

1. **Commit + push `api/close_events.py` to `main`.** Vercel auto-deploys.
2. **Confirm the deploy.** `curl https://ai-enablement-sigma.vercel.app/api/close_events` should return `{"status":"ok","endpoint":"close_events","accepts":"POST"}`. (Or hit it in a browser.) If the function 404s, the deploy didn't include `api/close_events.py` — wait + retry.
3. **Run `scripts/register_close_webhook.py --register --url https://ai-enablement-sigma.vercel.app/api/close_events`.** Script POSTs to Close's `/webhook/` endpoint with the events from `EVENTS_IN_SCOPE`. Response prints the signing secret — **copy it now**, Close only shows it once.
4. **Add `CLOSE_WEBHOOK_SECRET=<the hex string>` to Vercel project env vars.** Redeploy (Vercel may not pick up env changes automatically on next request — confirm via the dashboard).
5. **Verify end-to-end.** Change something on a lead in the Close UI (e.g. update a status). Within seconds:
   - `SELECT count(*) FROM webhook_deliveries WHERE source='close_webhook' AND received_at >= now() - interval '5 min'` → ≥ 1.
   - Matching row in the relevant mirror table updated (e.g. `close_leads.date_updated` for that lead's `close_id`).
6. **If something looks wrong**, check `webhook_deliveries.processing_status` for `failed` / `malformed` rows, plus the corresponding `processing_error` field for the traceback.

### Polling backstop (operational, not primary)

`scripts/backfill_close.py --apply --limit N` and the pipeline's `sync_recently_updated_leads(since_iso=...)` stay available for catching up after:

- A webhook outage (Vercel down, Close-side failure, network).
- A Close auto-pause of the subscription (3 days of failures or 100k backlog — reactivate via the Close API).
- A receiver-bug repair where we want to backfill the missed window.

There is no scheduled cron for polling today; run on-demand when needed.

### Keeping custom-field definitions fresh

The webhook receiver loads `cf_id → name` from our `close_custom_field_definitions` mirror table (populated by the backfill). When a Close admin adds or renames a custom field, run `scripts/sync_close_cf_definitions.py` to refresh the mirror. Until refreshed:

- New leads / lead updates still ingest correctly.
- The new cf's value lands in `close_leads.custom_fields_raw` jsonb but NOT in a typed column.
- After the sync script runs, subsequent webhook deliveries project the new cf to its typed column (if mapped in `_CF_NAME_TO_COLUMN`). Existing rows need a backfill re-run (`--apply --limit N` against affected leads) to backfill the typed column.

Wrap into a scheduled cron in a future spec if cf drift becomes a real ops problem.

## Failure modes + debugging

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| `HARD STOP: CLOSE_API_KEY missing` | Env var unset | Set in `.env.local`; in Vercel for production |
| 401/403 on `/me/` | Trailing-colon detail or rotated key | Confirm Basic auth is `<api_key>:` (empty password); regenerate key if rotated |
| 429s | Rate limit | Client backs off + retries 3× automatically; if persistent, reduce concurrency or page size |
| Read timeout on heavy lead's `/activity/` | Some leads have very long timelines | Client has 60s timeout + 3-try retry; persistent timeouts → switch to `_type__in` per-type calls instead of bundled |
| Tier values wrong on real data | Typeform values diverged from assumed pattern | Update `_CF_NAME_TO_COLUMN` + `derive_tier()` in `ingestion/close/parser.py`; re-run backfill (idempotent) |
| `close_leads` row missing custom-field columns | cf id ≠ name map | Re-run `scripts/sync_close_cf_definitions.py` first to refresh names |
| Webhook 401s repeatedly | `CLOSE_WEBHOOK_SECRET` wrong/missing in Vercel | Confirm env var is set; redeploy to pick it up; verify by re-registering subscription if secret was lost (Close shows it only once) |
| `webhook_deliveries.processing_status='failed'` accumulating | Receiver bug or persistent transient error | Inspect `processing_error` for the traceback; fix + redeploy; re-process via polling backstop |
| Close subscription `status='paused'` | 3 days of failures or 100k backlog hit | Diagnose the failure mode first, then reactivate via Close API or dashboard |
| Unknown event types in logs | Close sent something we haven't routed | Audit row exists with full payload; add a route in `_route_event` if a metric needs it |

## Re-run safety

All upserts key on `close_id`. Re-running any subset (one lead, all leads, all opportunities) is idempotent: existing rows refresh, no duplicates.

Soft-deletion in Close (which is rare) is NOT mirrored — a lead deleted in Close stays in `close_leads` until manually purged. If this becomes a problem, the polling cron can be extended to track deletions via Event Log.

## Close users sync (daily cron, populates `team_members.close_user_id`)

Daily cron at **11:30 UTC** that paginates Close's `/user/` endpoint and writes each user's `id` into the matching active `team_members` row keyed by email.

**Why this exists:** before this cron, the appointment-setting dashboard inferred who's a setter/closer from `close_leads.closer_owner_id`/`setter_owner_id` (only ~30% coverage) plus hardcoded override + manual-setter maps. The clean state is `team_members.close_user_id` as the canonical bridge; this cron keeps that column current as Sales onboards new reps.

**What it does per tick:**

1. `GET /user/` (paginated, `_skip`/`_limit=100`) — fetches every Close user in the org.
2. For each user with a Close `id` + `email`:
   - Look up the active (`archived_at IS NULL`) `team_members` row by `email` match.
   - **Match + `close_user_id` is null** → UPDATE the row with the Close id. Log INFO.
   - **Match + `close_user_id` already equals Close's id** → skip (most common path).
   - **Match + `close_user_id` set to a DIFFERENT id** → log WARNING with both ids. This indicates drift (rare; usually a re-paired Close user) and surfaces in the cron's audit payload as `drift_warnings` for manual review.
   - **No match** → append to `unmatched_close_users` in the audit. The cron does NOT auto-create team_members rows; sales onboarding adds the row manually first, then the cron fills the close_user_id.
3. Audit row written to `webhook_deliveries.source='close_users_sync'`.

**When a new sales rep joins:**

1. Manually add the `team_members` row first (`role='sales'`, `sales_role` set as appropriate, `close_user_id` left null).
2. Within 24 hours, the daily cron picks up their Close user_id from the email match.
3. The appointment-setting dashboard sees them on the next page load.

Step 1 is intentional — we don't want the cron to create team_members rows from raw Close membership because Close may contain users who shouldn't be in our agency registry (test accounts, paused users, integrations like Aircall).

**Why polling, not webhook:** user-create / user-update events happen 1-2 times/month at this team's volume. A daily polling cron is idempotent, simpler to maintain, and recovers from missed deliveries automatically. Revisit if onboarding cadence sharply increases or real-time user attribution becomes load-bearing.

**Manual trigger:**

```bash
curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \
  https://ai-enablement-sigma.vercel.app/api/close_users_sync_cron
```

**Audit query** (find recent unmatched Close users):

```sql
select
  received_at,
  payload->'unmatched_close_users' as unmatched,
  payload->'drift_warnings' as drift
from webhook_deliveries
where source = 'close_users_sync'
order by received_at desc
limit 5;
```

## Out of scope (future specs)

- **Triage ingestion** — lives in Airtable forms, not Close. Will be its own ingestion spec.
- **EOC Forms ingestion** — separate source, serves the Engine sheet's CLOSING section. Until it lands, closing-funnel money rows have no Supabase source. Close payment cfs on `close_leads` are mirrored as secondary cross-validation only.
- **Custom-field value history** — Close exposes 30-day rolling history via the Event Log API. Useful for back-population if we need historical reconstruction of cf values.
- **Email activity mirror** — deferred (6% of activity; excluded from the First Message Response definition). Add `close_emails` if a future metric needs it.
- **Custom-activity events + opportunity-status-change activity events** — not routed today; folded into lead-status-change / opportunity.updated. Add to `_route_event` if needed.
- **Scheduled cf-definition cron** — manual `scripts/sync_close_cf_definitions.py` for V1; cron-ify if drift becomes a real problem.
- **Close Export API for cold-start re-backfill** — if pagination ceilings ever become a problem.
- **Auto-reactivation of paused subscriptions** — currently a manual action.
