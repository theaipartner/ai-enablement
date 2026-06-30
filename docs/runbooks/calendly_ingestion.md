# Runbook: Calendly Ingestion (Scheduled Events + Invitees)

Schema docs: `docs/schema/calendly_{event_types,scheduled_events,invitees}.md`.

This runbook covers source endpoints, auth + the 4 footguns from discovery, the webhook activation runbook, backfill, idempotency, and the deferred follow-up-meeting metric.

## What this ingestion does

Mirrors Calendly scheduled events + invitees + event-types into three Supabase tables. **Live** via `api/calendly_events.py` webhook receiver (mirror-everything posture). **Backfill** via `scripts/backfill_calendly.py` (7-day window initial).

The Engine sheet's six Calendly-sourced rows (FUNNELS section: 3 plain + 3 "with logic" closer rows) are computed at aggregation time on top of these mirror tables.

## Architecture

```
   ┌─────────────────────┐
   │ Calendly (external) │
   └──────────┬──────────┘
              │ webhook push: invitee.created / invitee.canceled /
              │              invitee_no_show.created / .deleted
              ▼
   ┌─────────────────────┐
   │ api/calendly_events │  HMAC-SHA256 signature verify
   │   .py               │  Fetches parent event per invitee tick
   └──────────┬──────────┘
              │ uses ingestion/calendly/pipeline.sync_invitee_and_event
              ▼
   ┌──────────────────────────────────────────┐
   │ calendly_scheduled_events                │
   │ calendly_invitees                        │
   │ calendly_event_types (reference)         │
   └──────────────────────────────────────────┘
              ▲
              │ scripts/backfill_calendly.py
              │   (7-day initial load; idempotent re-runs)
              │
              └── ingestion/calendly/pipeline.sync_recent_events_with_invitees
```

## Footguns (verified in discovery — handle these)

### 1. Cloudflare blocks default Python-urllib UA

Calendly sits behind Cloudflare which 403s the default `Python-urllib/3.12` User-Agent with `error 1010: browser_signature_banned`. **First source in this codebase to require a custom UA.** All client requests MUST include:

```
User-Agent: ai-enablement/1.0 (+drake@theaipartner.io)
```

Implemented in `ingestion/calendly/client.py:USER_AGENT`. Without it, every call 403s.

### 2. Filter closer bookings by event `name`, NOT `event_type` URI

58% of historical events in the discovery sample referenced RETIRED event-type URIs absent from `/event_types`. A URI-based filter silently misses them. The event's own `name` field carries the booking-time label.

Casing drifts ("Ai Partner Strategy Call" vs catalog "AI Partner Strategy Call") — match case-insensitively.

Canonical closer set lives in `ingestion/calendly/__init__.py:CLOSER_EVENT_TYPE_NAMES`:
```python
CLOSER_EVENT_TYPE_NAMES = frozenset({"ai partner strategy call"})
```
The set may expand later (team decision) — adding a name to that frozenset is the one-line change. Aggregation queries reference this constant.

### 3. Date math in business tz (`America/New_York`), NOT UTC

"Next Day" / "Two Days Out" metrics (Engine rows 35/36) compute `start_time.date - event_created_at.date`. A booking made at 22:00 EDT (= 02:00 UTC next day) for a meeting at 09:00 EDT next morning shows `delta=1d` in EDT (correct) but `delta=0d` in UTC (wrong).

Ingestion stores timestamps UTC; aggregation queries cast `AT TIME ZONE 'America/New_York'` before `::date` extraction. Same convention as ADR 0003. Example queries in `docs/schema/calendly_scheduled_events.md`.

### 4. Reschedules fire as TWO webhook events

A reschedule triggers:

1. **`invitee.canceled`** on the old invitee. Row gets `status='canceled'`, `new_invitee=<URI>`.
2. **`invitee.created`** on the new invitee. Row gets `rescheduled=true`, `old_invitee=<URI>`.

**Engine row 93 "New Scheduled Meetings" must filter `rescheduled=false`** so the new invitee from a reschedule isn't double-counted as a fresh booking. Tested in `tests/ingestion/calendly/test_pipeline.py::test_sync_invitee_and_event_reschedule_pair_no_double_count`.

## Auth

- **Token:** `CALENDLY_API_KEY` (Personal Access Token, JWT ~896 chars). HTTP Bearer.
- Required in BOTH `.env.local` (for backfill/probes/local) AND Vercel (for the deployed webhook receiver — it fetches the parent event on every invitee tick).
- Token page is **Account-Owner or Admin tier** in Calendly. If 401s start happening in `webhook_deliveries` failed rows, the token may have been rotated — Nabeel re-mints.
- **Env var naming:** the canonical name is `CALENDLY_API_KEY` (matches `CLOSE_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` precedent). `CalendlyClient.from_env()` accepts either for backwards-compat; standardize on `_API_KEY` going forward.

### Rate limit

Calendly: ~60 req/min (lower plans) / 120 (Enterprise). Returns **HTTP 429** with `Retry-After` header. Client backs off + retries 3×. Backfill volume is small (~25 events/7d × 2 calls each = ~50 calls); rate limit unlikely to bite.

## Endpoints

| Endpoint | Purpose | Notes |
|---|---|---|
| `GET /users/me` | Auth check + organization URI | Use the `current_organization` field from the response. |
| `GET /event_types?organization=<uri>` | Event-type catalog (~14 rows) | Reference table. Aggregation filters by event `name`, not URI — see footgun 2. |
| `GET /scheduled_events?organization=<uri>&min_start_time=&max_start_time=&status=&sort=` | Paginated events list | Filter by `start_time` only (no `created_at` filter); the backfill pulls a wide window then aggregation buckets by `event_created_at`. |
| `GET /scheduled_events/{uuid}/invitees` | Per-event invitees | Typically 1 per event in this org; supports multi-invitee groups. |
| `GET /scheduled_events/{uuid}` | Single-event fetch | Used by the webhook receiver to fetch the parent event on every invitee tick. |
| `POST /webhook_subscriptions` | Register subscription | via `scripts/register_calendly_webhook.py`. |
| `GET /webhook_subscriptions` | List existing subscriptions | The org has 10 existing Make.com subscriptions; ours is the 11th. |

## Webhook signature verification

Header: `Calendly-Webhook-Signature`. Format (Stripe-style): `t=<unix_ts>,v1=<hex>`.

Algorithm:
```python
signed_payload = f"{timestamp}.{body}".encode("utf-8")
expected = hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
valid = hmac.compare_digest(expected, sig_v1_from_header)
```

- Secret: the plain string returned at subscription creation (used as UTF-8 bytes).
- Replay window: 5 minutes (defensive; Calendly doesn't explicitly document one).
- Implementation: `api/calendly_events.py:_verify_signature`. Tested in `tests/api/test_calendly_events.py` (7 cases — tampered body / wrong timestamp / wrong secret / empty inputs / malformed header).

**Caveat:** Calendly's docs don't paste the exact format inline. The implementation follows the standard prose description. **If the first real delivery 401s**, inspect the captured header in `webhook_deliveries.headers` (timestamp portion preserved; signature redacted) and adjust the parser/verifier accordingly.

## Live activation runbook

Sequential — each step depends on the previous:

1. **Commit + push `api/calendly_events.py` to `main`.** Vercel auto-deploys.
2. **Confirm the deploy:**
   ```bash
   curl https://ai-enablement-sigma.vercel.app/api/calendly_events
   # → {"status":"ok","endpoint":"calendly_events","accepts":"POST"}
   ```
   If 404, deploy hasn't picked up yet — wait ~1-2 min.
3. **Run the register script:**
   ```bash
   .venv/bin/python scripts/register_calendly_webhook.py \
     --register --url https://ai-enablement-sigma.vercel.app/api/calendly_events
   ```
   Script POSTs to `/api/v1/webhook_subscriptions` with the 4 in-scope events
   (`invitee.created`, `invitee.canceled`, `invitee_no_show.created`,
   `invitee_no_show.deleted`). Response prints the **signing key — COPY IT NOW.**
4. **Add `CALENDLY_WEBHOOK_SECRET=<the_signing_key>`** to Vercel project env vars. Redeploy to pick it up.
5. **Verify end-to-end:** book a test meeting in Calendly (any event type triggers the webhook). Within seconds:
   ```sql
   SELECT count(*) FROM webhook_deliveries
   WHERE source='calendly_webhook' AND received_at >= now() - interval '5 min';
   -- expect ≥ 1

   SELECT uri, status, invitee_created_at
   FROM calendly_invitees
   ORDER BY synced_at DESC LIMIT 3;
   ```
6. **If signature 401s on first delivery:** inspect `webhook_deliveries.headers` for the actual `calendly-webhook-signature` header (timestamp preserved; v1 redacted for safety). Adjust `_parse_signature_header` / `_verify_signature` in `api/calendly_events.py` if Calendly's format differs from the Stripe-style assumption.

## Backfill

```bash
.venv/bin/python scripts/backfill_calendly.py             # dry-run
.venv/bin/python scripts/backfill_calendly.py --smoke     # 1 event + invitees
.venv/bin/python scripts/backfill_calendly.py --apply
.venv/bin/python scripts/backfill_calendly.py --apply --limit 10
.venv/bin/python scripts/backfill_calendly.py --apply --lookback-days 35   # wider historical pull
```

**Window:** events with `start_time` in `[now - lookback_days, now + 60d]` (`--lookback-days` defaults to 7). The wide future-window catches events booked recently for far-out meetings (closer-strategy-calls are often scheduled days-to-weeks in advance). Aggregation buckets by `event_created_at`. Because a booking's created-time is always ≤ its meeting start-time, setting the lookback floor at date D captures every booking *created* on/after D (then filter precisely on `event_created_at` downstream).

**Smoke gate (mandatory before `--apply`):** smoke refreshes event-types + upserts ONE event + its invitees. Idempotent. Per CLAUDE.md § Operational patterns.

**Run `--smoke` before the first bulk `--apply`** (first large-scale production write). Re-runs after parser fixes are safe — idempotency contract holds.

**Volume:** Discovery saw ~100 events over 30 days → ~25 events/7d. Wide future window adds maybe 50 more events booked recently for future meetings = ~75 events × 2 calls each = ~150 API calls. Fits comfortably under rate limit.

## Idempotency

`UPSERT ON CONFLICT (uri)` on all three tables. Webhook redeliveries / backfill overlaps / reschedule-pair handling all land cleanly. The synthesized webhook_deliveries dedup key (`calendly:{ts}:{sha256(body)[:16]}`) handles true webhook duplicates fast.

## DEFERRED — "Follow Up Meetings" (Engine row 95)

Calendly has no native "follow-up meeting" concept. Aman/team has NOT defined what counts. Possible interpretations:

1. **Any meeting by an invitee email who has had ≥1 prior booking** — buildable via self-join on `calendly_invitees.email`.
2. **A specific event-type named "Follow Up"** — none exists today; would require Aman/team to create one.
3. **Same invitee re-booking the SAME event type within N days** — buildable; needs N.

**Action:** the ingestion mirrors everything raw, so any of the above definitions can be computed later in the aggregation layer. **Row 95 stays as a documented TODO in the aggregation layer until Aman/team picks a definition.** Don't block this ingestion; don't pre-pick a definition.

## Failure modes + debugging

| Symptom | Likely cause | Action |
|---|---|---|
| Every Calendly call 403s with `error 1010: browser_signature_banned` | Custom User-Agent header missing | Check the client; `USER_AGENT` constant must be set on every request |
| Cron audit `wistia_token_unavailable` style msg | `CALENDLY_API_KEY` missing in Vercel | Add it in Vercel; redeploy |
| HTTP 401 on `/users/me` | Token rotated or revoked | Nabeel regenerates Personal Access Token; update `.env.local` + Vercel |
| Webhook 401s repeatedly | `CALENDLY_WEBHOOK_SECRET` mismatch | Confirm Vercel env value matches what the register script printed; if lost, delete + recreate subscription |
| Webhook signature parser returns empty tuple every time | Calendly's actual header format differs from the Stripe-style assumption | Inspect `webhook_deliveries.headers.calendly-webhook-signature` (timestamp preserved); adjust `_parse_signature_header` |
| Duplicate invitee rows appearing | Webhook redelivery NOT deduped | Should never happen — synthesized webhook_id PK guards. If observed, inspect the webhook_id values for collisions |
| Reschedule double-counts in New Scheduled Meetings metric | Aggregation query missing `rescheduled = false` filter | Fix the query, not the ingestion — see footgun 4 |
| Engine row 95 (Follow Up) shows no data | Expected — metric definition pending per DEFERRED section | No action; ingestion stores data; aggregation waits on Aman/team |

## Out of scope (future specs)

- **"Follow Up Meetings" metric definition** — see DEFERRED.
- **`no_show` consolidation** — Calendly has a native `no_show` field; Engine sheet currently sources No Show from a different system. Potential consolidation TBD.
- **`routing_form_submission` ingestion** — invitee payload includes a `routing_form_submission` field for Calendly's pre-meeting form data. Not used today; future spec if the team adopts routing forms.
- **Multi-invitee group events** — this org uses solo events today. Schema supports group via the invitees-counter, but aggregation queries assume single-invitee.
- **Auto-reactivation of paused subscriptions** — if Calendly auto-disables our subscription after repeated 5xx, current recovery is a manual action via `register_calendly_webhook.py --delete` + re-register.
- **Per-event-type aggregation layer** — separate dashboard spec; this ingestion just stores raw.
