# Runbook: Airtable Ingestion (Webhook + Cron Backstop, US + AUS Closer + Setter Triage)

Spec: `docs/specs/airtable-ingestion.md`. Discovery: `docs/reports/airtable-discovery.md`. Schema docs: `docs/schema/airtable_setter_triage_calls.md` + `docs/schema/airtable_full_closer_report.md`. Migration: `0050_airtable_mirror.sql`.

This runbook covers the activation order, the structural webhook-load-bearing fact, the five aggregation-layer-pending ambiguities, and operational concerns (webhook refresh, MAC verify, HTTP/2 retry).

## What this ingestion does

Mirrors three Airtable sources into two Supabase mirror tables:

| Airtable source | Mirror table | Notes |
|---|---|---|
| `tblaoMsiE3FSkHjQt` Setter Triage Calls EOC Form | `airtable_setter_triage_calls` | Setter-side Appointment Setting rows |
| `tblYsh3fxTpXuPdIW` Full Closer Report Form (US) | `airtable_full_closer_report` (region='US') | Engine Closing rows 96-116, US |
| `tblcC25y6lMrtgcty` Full Closer Report Form - AUS | `airtable_full_closer_report` (region='AUS') | Engine Closing rows 96-116, AUS |

All three converge on the same pipeline + parser per table (Full Closer parser threads `region` per source). Idempotent `ON CONFLICT (record_id) DO UPDATE`.

## The structural fact — webhook is load-bearing, not optional

**Neither target table has a stored `lastModifiedTime` or `createdTime` field.** Incremental ingestion can only use Airtable's record-level `createdTime` metadata — which is created-only.

- The cron backstop catches missed webhook CREATIONS via `IS_AFTER(CREATED_TIME(), ...)` filter, 6h overlap window on a 15-min cadence.
- The cron CANNOT catch EDITS. A closer updating `Closed? = No → Yes` after initial save produces NO new-record signal.
- The live webhook is the only edit-detection path. If the webhook is down for >7 days (Airtable's idle-expiry window), it disables silently — make sure the cron's `refresh_webhook()` actually fires (see § Webhook refresh).

**Implication:** the dashboard's correctness on any edited-after-creation field (`Closed?`, money fields entered late, disposition updates) depends on the webhook being live. Until the webhook is registered (gate (d) below), correctness is creation-only.

## Architecture

```
   ┌─────────────────────┐                  ┌─────────────────────┐
   │ Airtable base       │◀── refresh ─────│ api/airtable_sync_  │ */15 * * * *
   │ appCWa6TV6p7EBarC   │── ping ──────▶│ cron.py             │ 6h CREATED_TIME()
   │                     │── records ───▶│                     │ window
   └──────────┬──────────┘                  └──────────┬──────────┘
              │                                        │
              │ MAC-signed ping (X-Airtable-Content-MAC)
              ▼
   ┌─────────────────────┐
   │ api/airtable_events │  verifies MAC → pulls payloads via cursor →
   │   .py               │  extracts changedTablesById → fetches records →
   │                     │  upserts via pipeline.upsert_changed_records
   └──────────┬──────────┘
              │ persisted cursor lives in webhook_deliveries
              │ (source='airtable_webhook_cursor')
              ▼
   ┌──────────────────────────────────────────┐
   │ airtable_setter_triage_calls             │
   │ airtable_full_closer_report (region!)    │
   └──────────────────────────────────────────┘
```

## Auth

- **PAT:** `AIRTABLE_SALES_PAT` (Personal Access Token). Required scopes:
  - `schema.bases:read` — used by the discovery probe only (not the runtime path).
  - `data.records:read` — load-bearing (records list + per-record fetch + webhook payload pull).
  - **`webhook:manage`** — REQUIRED to create/list/delete/refresh webhooks. **`AIRTABLE_SALES_PAT` does NOT yet have this scope** (per discovery). Drake adds it (or mints a separate webhook-mgmt PAT) before the live webhook can be registered (gate (d) step 5 below).
- **Base access:** PAT's allow-list must include `appCWa6TV6p7EBarC`.

**Where the PAT lives:**
- `.env.local` for local runs (backfill, register helper, tests).
- Vercel project env vars for the deployed cron + webhook receiver (gate (d)).

## Activation runbook — Drake's 8-step order

Per the branch correction (parallel source work wound down; everything runs on `main`; no merge-to-main step), the activation order is:

1. **Builder writes + Drake reviews migration `0050`** (gate (a)), Builder applies + dual-verifies.
2. **Push main** — Vercel auto-deploys the receiver + cron + scripts.
3. **Drake confirms Vercel env: `AIRTABLE_SALES_PAT` set** (gate (d)) — required for both the cron AND the webhook receiver's payload fetch. Until set, the cron audits `airtable_pat_unavailable` and the receiver 500s.
4. **Builder runs `backfill_airtable.py --smoke` then `--apply` (1-day window)** — cold start. Lands the last 24h into the mirror tables. (Already done at ship time — 2 Full Closer US records + 1 Setter Triage record at 2026-05-24 cold start.)
5. **Drake adds `webhook:manage` scope to `AIRTABLE_SALES_PAT`** at airtable.com/create/tokens (or mints a separate webhook-mgmt PAT; `_safe_client` path will use whichever is in env).
6. **Drake runs `scripts/register_airtable_webhook.py --apply --url https://ai-enablement-sigma.vercel.app/api/airtable_events`** — creates the subscription. The script prints `AIRTABLE_WEBHOOK_ID` + `AIRTABLE_WEBHOOK_MAC_SECRET` in a big box. **The `macSecretBase64` is returned ONCE** — if lost, delete + re-register.
7. **Drake adds both env vars to Vercel + redeploys:**
   ```
   AIRTABLE_WEBHOOK_ID=<from registration>
   AIRTABLE_WEBHOOK_MAC_SECRET=<from registration>
   ```
   Without these, the receiver returns 500 on every ping.
8. **Verify end-to-end** (gate (c)):
   - Edit a record in Airtable (any field on Setter Triage or Full Closer US/AUS).
   - Within seconds, confirm:
     ```sql
     SELECT * FROM webhook_deliveries
     WHERE source = 'airtable_webhook'
       AND received_at >= now() - interval '5 min'
     ORDER BY received_at DESC LIMIT 5;
     ```
   - And the corresponding `airtable_setter_triage_calls` / `airtable_full_closer_report` row reflects the edit.
   - Confirm cron audits cleanly + refreshes the webhook on the next tick.

## Webhook signature scheme (verify against the first real ping)

Airtable signs notification pings with:

```
digest = HMAC-SHA256(raw_body, base64_decode(macSecretBase64))
header = X-Airtable-Content-MAC: hmac-sha256=<base64_encode(digest)>
```

Some receivers report the header value WITHOUT the `hmac-sha256=` prefix; `_verify_mac` accepts both defensively. **Confirm the exact header format against the first real ping in `webhook_deliveries.headers`** — if the format differs, adjust `_verify_mac` in `api/airtable_events.py`.

The `macSecretBase64` value is returned exactly ONCE by `register_airtable_webhook.py --apply`. Store it in Vercel as `AIRTABLE_WEBHOOK_MAC_SECRET`.

## Webhook payload pull model (NOT push)

Airtable's ping does NOT contain record data. It POSTs `{"base": {"id": "..."}, "webhook": {"id": "..."}, "timestamp": "..."}` to your URL. The receiver must:

1. Verify the MAC.
2. Load the persisted cursor (default `1` on first-ever call).
3. `GET /v0/bases/{baseId}/webhooks/{webhookId}/payloads?cursor=<n>` — response has `payloads[]`, `cursor` (next cursor), `mightHaveMore` (loop again if true).
4. Each payload's `changedTablesById` carries `changedRecordsById` + `createdRecordsById`. Filter to TARGET_TABLES; collect record ids per table.
5. For each changed record, `client.get_record(table_id, record_id)` fetches current state; parse + upsert.
6. Advance + persist the cursor (single sentinel row in `webhook_deliveries` keyed `airtable_webhook_cursor:<webhook_id>`).

**Cursor durability matters.** A lost cursor + missed ping = silently dropped edits. The cron's `IS_AFTER(CREATED_TIME(), ...)` filter does NOT heal lost edits.

## Webhook refresh — avoiding the 7-day silent death

Airtable webhooks **expire after 7 days of inactivity** unless refreshed via `POST /v0/bases/{baseId}/webhooks/{webhookId}/refresh`.

`api/airtable_sync_cron.py` calls `client.refresh_webhook(webhook_id)` on every tick (every 15 min) if `AIRTABLE_WEBHOOK_ID` is set in env. Make sure it's set post-registration. The refresh requires `webhook:manage` on the PAT — same scope as registration.

If refresh fails, the cron logs a warning + audits the failure but continues the read path (refresh is non-fatal). A silent webhook death surfaces in `webhook_deliveries` as a gap in pings beyond ~15 min, plus the refresh failure audit rows.

## Cron — what it does each tick

`api/airtable_sync_cron.py` at `*/15 * * * *`:

1. Validate `CRON_SECRET` bearer.
2. Build `AirtableClient.from_env()`. If `AIRTABLE_SALES_PAT` is missing, audit `airtable_pat_unavailable` + return — no exception, the next tick re-tries.
3. Compute `since = now - 6h` (ISO 8601 with millis + Z), build `IS_AFTER(CREATED_TIME(), DATETIME_PARSE('...'))` filter.
4. Call `pipeline.sync_all(client, db, since=since)` — walks all 3 target sources with the filter, batches per-table upserts with HTTP/2 retry.
5. If `AIRTABLE_WEBHOOK_ID` is set, call `client.refresh_webhook(webhook_id)` (fail-soft).
6. Audit one row to `webhook_deliveries` with `source='airtable_sync_cron'`, payload containing per-table counts + refresh result.

**6h window vs 15-min cadence = 24× overlap.** Plenty of room to absorb a webhook outage (creation-side only).

## Backfill

```bash
.venv/bin/python scripts/backfill_airtable.py             # dry-run preview
.venv/bin/python scripts/backfill_airtable.py --smoke     # 1 record, full path
.venv/bin/python scripts/backfill_airtable.py --apply     # 1-day window, all 3 sources
.venv/bin/python scripts/backfill_airtable.py --apply --hours 24
.venv/bin/python scripts/backfill_airtable.py --apply --table tblYsh3fxTpXuPdIW
.venv/bin/python scripts/backfill_airtable.py --apply --full   # NO filter
```

`--smoke` is the canonical pre-`--apply` gate per CLAUDE.md § Operational patterns. It also reports the observed Setter Name fill rate on Full Closer records — the attribution-hypothesis check (currently 1/2 = 50% on the post-discovery sample; needs N≥100 to confirm).

## Webhook registration helper

```bash
.venv/bin/python scripts/register_airtable_webhook.py --list
.venv/bin/python scripts/register_airtable_webhook.py --dry-run --url https://...
.venv/bin/python scripts/register_airtable_webhook.py --apply --url https://ai-enablement-sigma.vercel.app/api/airtable_events
.venv/bin/python scripts/register_airtable_webhook.py --delete <webhookId>
```

`--list` works without `webhook:manage` if you only need to confirm what exists (Airtable returns 403 if the scope is missing — gate (d) check). `--apply` requires `webhook:manage`. The created subscription is base-level (covers all 3 target tables); the receiver's `_extract_changes` filters to TARGET_TABLES per payload.

## Five aggregation-layer-pending ambiguities

Drake's explicit call per spec: **mirror raw, resolve at dashboard.** The dashboard renders these Engine rows as `NULL` / `'pending field confirmation'` rather than guessing.

1. **Objection categorization** (Engine rows Shopping Around / Think-About-It-Fear / Spouse) — no structured field. Source: `call_notes_lost` free text. Categorization (LLM or manual) is dashboard work.
2. **`is_setter_led` provisional** — derived `cardinality(setter_record_ids) > 0`. Discovery N=3 = 0% fill; post-ingestion N=2 = 50%. Needs N≥100. Dashboard flags as provisional.
3. **Canonical "cash paid today"** — both `amount_paid_today_currency` and `amount_paid_today_number` stored. Dashboard picks.
4. **Three near-duplicate payment-on-call fields** — `paid_on_call` + `contract_sent` typed; the other two in `fields_raw`. Dashboard picks canonical.
5. **Two typo'd "Financed/Cash/Both" fields** — both in `fields_raw` only. Dashboard picks canonical.

## Failure modes + debugging

| Symptom | Likely cause | Action |
|---|---|---|
| Cron audit `airtable_pat_unavailable` | `AIRTABLE_SALES_PAT` missing in Vercel | Drake adds (gate d); next tick recovers. |
| Webhook receiver returns 500 `misconfigured` | `AIRTABLE_WEBHOOK_MAC_SECRET` or `AIRTABLE_WEBHOOK_ID` missing in Vercel | Drake adds + redeploys. |
| Webhook receiver returns 401 `signature_invalid` on every ping | MAC secret wrong, OR header format differs from assumption | Inspect `webhook_deliveries.headers` (sig header NOT stored — check raw ping logs). Re-verify `macSecretBase64` matches what registration printed. |
| Register helper returns 403 on `--apply` | `webhook:manage` scope missing from PAT | Drake adds the scope (or mints a separate webhook-mgmt PAT). |
| Cron audit `errors: ["batch_upsert:... ConnectionTerminated"]` first attempt → retry succeeded | HTTP/2 stream termination on shared client; pipeline retried with fresh client | No action — retry path handled it. |
| Cron audit `errors: ["batch_upsert:... (retried fresh)"]` both attempts failed | Real Supabase write failure | Inspect `webhook_deliveries.processing_error` for the full exception. |
| Edits to existing rows not reflecting in mirror | Webhook down or `AIRTABLE_WEBHOOK_ID` unset | Check `webhook_deliveries` for recent `source='airtable_webhook'` rows. If gap > 15 min, run `register_airtable_webhook.py --list` to confirm subscription status. Re-register if `isHookEnabled=false`. |
| New records not appearing | Cron not running OR `AIRTABLE_SALES_PAT` issue | Check Vercel cron logs + `webhook_deliveries source='airtable_sync_cron'` audit rows. |

## Out of scope (future specs)

- **Other 7 tables in the base** (Sales Team Member, Contract Forms, Setter EODs, Closer EODs, High Ticket Commission Tracking, Affiliate SignUps, Setter Direct Bookings, Closer Booked Calls) — future ingestion specs when needed.
- **Soft-delete on Airtable record deletes** — `destroyedRecordIds` in webhook payloads currently ignored.
- **Promotion of currently-jsonb-only fields** to typed columns (Partner-*, payment installments, AUS-specific fields) — future spec when a dashboard needs faster access.
- **Aggregation-layer SQL views** for Engine-sheet rows 96-116 — separate spec.
- **Resolution of the 5 ambiguities** — Drake/Aman calls; dashboard reads + categorizes.
- **`Notify_*` Slack ping** on new closed deal — `_notify_upserted_record` stub in `pipeline.py` is the future-spec seam.
- **Wider sample (~100 records) for `is_setter_led` fill rate confirmation** — once the cron runs for a few days, query and report.
