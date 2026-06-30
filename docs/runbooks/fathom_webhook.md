# Runbook: Fathom Webhook

Operational runbook for `api/fathom_events.py` — the Vercel serverless
endpoint that ingests Fathom `new-meeting-content-ready` deliveries. Full
design in `docs/archive/historical/fathom_webhook.md`.

**Status as of 2026-04-30 (M4.1 re-registration):** handler deployed,
secret rotated, webhook **re-registered via API** (not UI this time).
The original UI-based F2.5 registration was silent: zero `fathom_webhook`
deliveries landed in `webhook_deliveries` from 2026-04-24 → 2026-04-30,
zero inbound POSTs to `/api/fathom_events` in Vercel logs over the same
window. M4.1 diagnosis confirmed Fathom wasn't sending — the F2.5
subscription either dropped at Fathom's side or never started delivering.
Re-registered fresh against `https://ai-enablement-sigma.vercel.app/api/fathom_events`
on 2026-04-30; new webhook id captured (see § "Resume from F2.5 pause").
**End-to-end live-delivery verification is still pending** — needs a
real test recording. The cron path stayed reliable throughout (54
processed `fathom_cron` deliveries in the silent window).

---

## Resume from F2.5 pause

**Update 2026-04-30 (M4.1):** the F2.5 UI-based registration never
produced a single signature-verified row in `webhook_deliveries` (zero
`source='fathom_webhook'` rows over all time, not just the 7-day window
the followup originally framed it as). Re-registered fresh via API on
2026-04-30 with new id and new secret rotated into Vercel.

**Important correction to the F2.5-era guidance below:** Fathom's API
has **no `GET /external/v1/webhooks` endpoint**. The OpenAPI spec
(https://developers.fathom.ai/api-reference/openapi.yaml) exposes only
`POST /webhooks` (create) and `DELETE /webhooks/{id}` (delete). The
diagnostic curl command originally documented here was based on a
wrong assumption and would 404. To verify a registration is alive,
use indirect signals: Vercel function logs for inbound POSTs to
`/api/fathom_events`, and the `webhook_deliveries` table.

**What's done (2026-04-30 — the active registration):**
- Webhook re-registered via `POST /external/v1/webhooks` against
  `https://ai-enablement-sigma.vercel.app/api/fathom_events` with
  `triggered_for=["my_recordings","shared_team_recordings"]` and all
  three `include_*` flags on (transcript, summary, action items).
- **Active webhook id (captured this time):** `FTVBjD_JqTfjEzVA`. Use
  this for any future rotation or teardown via `DELETE
  /external/v1/webhooks/FTVBjD_JqTfjEzVA`.
- Fresh `whsec_<base64>` secret captured from the registration response
  and written to Vercel env `FATHOM_WEBHOOK_SECRET` (Production scope
  only — the prior Preview scope value was cleaned up at the same
  time). Production redeployed; verified via 401 on a deliberately-bad
  POST signature.

**What's done (2026-04-24 — historical, F2.5 era):**
- 7 commits pushed (`bc4cbbb..e9431da`) — the entire Fathom webhook stack,
  from architecture spec through handler + tests.
- Vercel build completed; `GET https://ai-enablement-sigma.vercel.app/api/fathom_events`
  returns `200 {"status":"ok","endpoint":"fathom_events","accepts":"POST"}`.
- Webhook registered with Fathom via the Fathom Settings UI. Fathom UI
  registration doesn't surface the webhook `id` back to the user, so
  the F2.5 webhook id was never captured. The M4.1 re-registration
  superseded that registration without explicit cleanup (no `GET` to
  list it; no `id` to `DELETE` it). If the F2.5 subscription is still
  alive on Fathom's side, its deliveries 401 silently at our handler
  (signature verify fails before any DB write) — harmless but invisible.

**What's NOT yet verified (M4.1 re-registration):**
- No real-meeting delivery has landed in `webhook_deliveries` against
  the new secret yet. Hard-stop smoke test pending — see § "Smoke test
  for the re-registered webhook" below.
- All four F2.1 open unknowns (webhook-id stability across retries,
  retry schedule, duplicate deliveries on summary regen, plan-tier
  gating) remain formally open. Plan-tier is effectively resolved
  twice over now (both UI and API registration succeeded).

## Smoke test for the re-registered webhook (M4.1, 2026-04-30)

After A.5 verification (GET=200, bad-POST=401) the handler is provably
healthy. Confirming end-to-end requires a real Fathom delivery.

1. Record a Fathom meeting ≥90 seconds (talk to yourself, leave a
   voicemail-style note — anything over the short-file heuristic).
2. Wait 2–5 minutes for Fathom's post-processing.
3. Run:

```sql
select webhook_id, processing_status, received_at, processed_at,
       call_external_id, processing_error
from webhook_deliveries
where source = 'fathom_webhook'
order by received_at desc
limit 5;
```

Expect at least one fresh row with `processing_status='processed'`
and a `call_external_id` matching the recording. If nothing lands
within ~15 minutes of the meeting ending, escalate per the F2.5-era
"Option B" diagnostic checklist below.

**How to resume — two options:**

### Option A — wait for organic team-call traffic

Once any team member records a Fathom call that matches the webhook's
`triggered_for` scope (set during UI registration — likely
`my_recordings` + `shared_team_recordings` per the runbook default), it
should fire to our endpoint ~2–5 minutes after the call ends. Check:

```sql
-- The "did anything land" query — run periodically until a row appears.
select webhook_id, processing_status, received_at, processed_at,
       call_external_id, processing_error
from webhook_deliveries
order by received_at desc
limit 10;
```

Expect first real delivery to show `processing_status='processed'` with a
`call_external_id` matching a Fathom `recording_id`. Downstream verify:

```sql
-- Immediately after the webhook lands, these should show the new call:
select id, external_id, title, call_category, primary_client_id,
       is_retrievable_by_client_agents
from calls
where external_id = '<recording_id from above>';

select document_type, is_active, jsonb_array_length(metadata->'participant_emails') as n_participants
from documents
where external_id = '<recording_id from above>';

-- Summaries + action items ride on the same delivery now
select count(*) from call_action_items
where call_id = (select id from calls where external_id = '<recording_id>');
```

### Option B — force a test recording

Record a Fathom meeting ≥90 seconds (talk to yourself, leave a
voicemail-style note, chat with a colleague — anything over the short-file
threshold). End the call. Wait ~3–5 min for Fathom's post-processing.
Then run the poll query above.

If nothing lands within ~15 minutes of the meeting ending:

1. **Check Fathom's processing status** — open the meeting in Fathom UI,
   confirm transcript + summary + action items all show as generated. If
   any are still "processing," the webhook fires when the last one is
   ready, not on call-ended.
2. **Check the webhook registration matches the call's scope** — in
   Fathom Settings → API Access → Webhooks, confirm the registered
   `triggered_for` includes the scope of the meeting you recorded. A call
   that's in `shared_external_recordings` won't fire a webhook registered
   only for `my_recordings`.
3. **Check for 401s in Vercel function logs** — bad signature is the
   only failure mode that does NOT leave a `webhook_deliveries` row. If
   you suspect a secret mismatch: Vercel dashboard → Functions →
   `api/fathom_events` → Logs. Look for lines matching
   `"fathom_webhook: signature verification failed webhook-id=..."`.
4. **Check the Fathom side's delivery history** — some providers log
   retries and response codes. If Fathom surfaces that, a streak of 401s
   or 500s tells us what's breaking from our end.

**No data loss risk while resuming slowly.** F2.6 (daily cron backfill)
will eventually catch any call the webhook missed — but the cron
doesn't exist yet. Until it does, a call that falls through a failed
webhook delivery is recoverable by the backlog re-run pattern in
`docs/runbooks/fathom_backlog_ingest.md` against an export including
that day.

---

## Deploy (executed 2026-04-24 as commit `e9431da`)

### 1. Add the handler to `vercel.json`

Append to the existing `functions` block and bump `maxDuration` if needed.
Example final shape:

```json
{
  "functions": {
    "api/slack_events.py":  { "runtime": "@vercel/python@4.3.1", "maxDuration": 60 },
    "api/fathom_events.py": { "runtime": "@vercel/python@4.3.1", "maxDuration": 60 }
  }
}
```

Commit + push; Vercel builds automatically on push if the project is linked
to the repo.

### 2. Verify the deploy picked up the new function

```bash
curl -i https://ai-enablement-sigma.vercel.app/api/fathom_events
# Expect: HTTP 200 + body {"status":"ok","endpoint":"fathom_events","accepts":"POST"}
```

If this 404s: the deploy didn't pick up the new function. Check the Vercel
dashboard → Functions tab; `fathom_events.py` should be listed. If not,
force a redeploy.

### 3. Generate the Fathom API key

One-time — from the Fathom team account (NOT a personal account, NOT a
service account). Settings → API Access → Generate API Key. Capture
immediately — Fathom only shows it once. Store in Bitwarden as
`FATHOM_API_KEY_PROD`.

### 4. Register the webhook against the Vercel URL

```bash
curl -sS -X POST https://api.fathom.ai/external/v1/webhooks \
  -H "X-Api-Key: <FATHOM_API_KEY_PROD>" \
  -H "Content-Type: application/json" \
  -d '{
    "destination_url": "https://ai-enablement-sigma.vercel.app/api/fathom_events",
    "triggered_for": ["my_recordings","shared_team_recordings"],
    "include_transcript": true,
    "include_summary": true,
    "include_action_items": true,
    "include_crm_matches": false
  }'
```

Response body contains the new webhook's `id` AND `secret` (format
`whsec_<base64>`). **The secret is returned ONCE and is not recoverable** —
capture immediately. Store in Bitwarden as `FATHOM_WEBHOOK_SECRET_PROD`.

### 5. Set the env var on Vercel + redeploy

In the Vercel dashboard → Project Settings → Environment Variables → add
`FATHOM_WEBHOOK_SECRET` with the `whsec_...` value, scope to Production.
Then redeploy (any small push, or manually redeploy the latest). The
handler reads the env var on every invocation, so a deploy that postdates
the env-var set is sufficient.

### 6. Smoke-test with a short test meeting

Record a quick Fathom meeting (≥90 seconds so the classifier's short-file
heuristic doesn't exclude it). Wait 2–5 minutes for Fathom's post-
processing. Check:

```sql
-- Expect a row with processing_status='processed' within a few minutes
select webhook_id, processing_status, call_external_id, received_at, processed_at
from webhook_deliveries order by received_at desc limit 5;

-- Matching calls row
select id, title, call_category, primary_client_id, started_at
from calls where external_id = '<recording_id from above>';
```

If `processing_status = 'processed'` and a `calls` row exists → pipeline
working end-to-end. F2.5 closed.

If `processing_status = 'failed'`: inspect `processing_error` for the
traceback.

If no row at all: check Vercel function logs — either signature verify is
failing (check env var spelling + trailing whitespace) or the webhook was
registered with a wrong URL.

---

## Backfill cron — `api/fathom_backfill.py`

The cron is the daily safety net behind the live webhook. Even with a healthy
webhook, Fathom can drop or delay deliveries during outages, retry exhaustion,
or the registration-bug scenarios from M1.1. The cron sweeps Fathom's
`GET /meetings` once a day, identifies anything not yet in `calls`, and
ingests it through the same adapter + pipeline the webhook uses.

### Status

**Live.** `api/fathom_backfill.py` is deployed and runs daily on the
`0 8 * * *` cron in `vercel.json`, with `FATHOM_API_KEY` and `CRON_SECRET` set
in Vercel Production. It is the safety net behind the live webhook. The Deploy
section below is kept as a reference for re-provisioning.

### Schedule

Daily at **08:00 UTC** (`0 8 * * *` cron expression in `vercel.json`). Chosen
because:
- Fathom's own post-processing for US-hours coaching calls finishes by
  ~04:00 UTC the next day (Scott's calls end ~22:00 UTC, summaries ready
  ~15 min later).
- 08:00 UTC is before US business hours so any gap surfaces before pilot
  clients are active in Slack.
- Daily is conservative — if empirical miss-rate demands faster catch-up,
  tighten to hourly (Vercel Pro tier required for sub-day cadence).

### Required env vars (Vercel project)

| Var | Purpose | Source |
|---|---|---|
| `FATHOM_API_KEY` | Read access to `/external/v1/meetings` | Generate from the Fathom team account |
| `CRON_SECRET` | Bearer token Vercel Cron sends in `Authorization`; the handler validates against this same env var. Shared across all cron endpoints in this project (consolidated to single-var pattern in M6.2). | Generate with `openssl rand -hex 32` |
| Existing | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `OPENAI_API_KEY` | Already in Vercel env from earlier sessions |

### Deploy (reference — already provisioned)

1. **Generate `CRON_SECRET`:**
   ```bash
   openssl rand -hex 32
   ```
   Save to Bitwarden as `CRON_SECRET_PROD`. NOTE: this is the SAME secret
   used by every cron in the project — set once, used by all.

2. **Generate `FATHOM_API_KEY`** from the Fathom team account: Settings →
   API Access → Generate API Key. Save to Bitwarden as `FATHOM_API_KEY_PROD`.
   (Distinct from the webhook secret.)

3. **Set env vars on Vercel** (Project → Settings → Environment Variables,
   Production scope):
   - `FATHOM_API_KEY` = the Fathom key
   - `CRON_SECRET` = the random hex from step 1. Vercel Cron uses this
     internally to populate the `Authorization` header AND the handler
     validates against this same env var. Single source of truth.

4. **Push the commit** that adds `api/fathom_backfill.py` + the cron entry
   in `vercel.json`. Vercel auto-builds. The cron entry takes effect on
   the next deploy.

5. **Manual trigger to verify before waiting for 08:00 UTC:**
   ```bash
   curl -i -X POST \
     -H "Authorization: Bearer <CRON_SECRET>" \
     https://ai-enablement-sigma.vercel.app/api/fathom_backfill
   ```
   Expect a 200 with summary JSON: `{"ok": true, "meetings_seen": N,
   "already_present": M, "ingested": K, "failed": 0, "more_remaining": false,
   ...}`. The first sweep should show `already_present` ≈ count of
   F1.4 backlog calls in the lookback window, `ingested` = however many
   weekend/Monday calls landed since registration.

6. **Verify downstream rows** for any ingested call:
   ```sql
   select c.external_id, c.title, c.call_category,
          (select count(*) from documents where source='fathom' and external_id=c.external_id) as docs,
          (select count(*) from call_action_items where call_id=c.id) as ai
   from calls c
   where c.external_id in (
     select call_external_id from webhook_deliveries where source='fathom_cron'
   );
   ```

### Daily monitoring queries

```sql
-- Did the cron run today?
select max(received_at) from webhook_deliveries where source = 'fathom_cron';

-- Per-source counts for the last 24h (gives the webhook-vs-cron coverage picture)
select source, processing_status, count(*)
from webhook_deliveries
where received_at > now() - interval '24 hours'
group by source, processing_status order by source, processing_status;

-- Recent failures across both paths
select webhook_id, source, processing_status, received_at, processing_error
from webhook_deliveries
where processing_status in ('failed','malformed')
  and received_at > now() - interval '7 days'
order by received_at desc;
```

### Failure modes and what to do

| Symptom | Likely cause | Action |
|---|---|---|
| `select max(received_at) from webhook_deliveries where source='fathom_cron'` is older than 36h | Cron didn't fire OR fired and 401'd | Vercel dashboard → Cron Jobs tab — should show daily 08:00 UTC entries. If they're 401ing, `CRON_SECRET` is unset in Vercel; set it and redeploy. |
| Sweep returns `meetings_seen=0` consistently | `FATHOM_API_KEY` invalid OR account has no meetings in window | Verify the key works: `curl -H "X-Api-Key: $KEY" https://api.fathom.ai/external/v1/meetings?include_summary=true` should return JSON. |
| Sweep returns `more_remaining=true` repeatedly | More than 50 missed calls in the lookback window | Tomorrow's run continues catch-up. If catch-up doesn't converge after a week, raise `_MAX_INGESTS_PER_SWEEP` in `api/fathom_backfill.py` or run a manual sweep with a shorter window. |
| `failed` rows accumulating | Pipeline raising on a specific payload shape | Inspect `webhook_deliveries.processing_error` for the failing rows; the `payload` jsonb has the raw delivery for re-running through the adapter locally. |
| Sweep took >5 min and Vercel killed it | Too many missed calls + slow embeddings | Same as above — raise `_MAX_INGESTS_PER_SWEEP` OR manually run with `--limit` (the per-sweep cap defends against this). |

### Manual rerun (out-of-band)

If something goes sideways and you need to force a sweep mid-day:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer <CRON_SECRET>" \
  https://ai-enablement-sigma.vercel.app/api/fathom_backfill
```

Same idempotency rules apply — already-ingested external_ids skip cleanly.
A manual rerun within minutes of a scheduled run will mostly produce
`already_present` rows (the just-ingested ones).

---

## Monitoring

### Daily health query

```sql
select processing_status, count(*)
from webhook_deliveries
where received_at > now() - interval '24 hours'
group by processing_status;
```

Expected: one row `processed` with ~15–25 count (our daily call volume).
Any rows with `failed` or `malformed` warrant investigation.

### Recent failures

```sql
select webhook_id, received_at, call_external_id, processing_error
from webhook_deliveries
where processing_status in ('failed','malformed')
  and received_at > now() - interval '7 days'
order by received_at desc;
```

### Coverage check — webhook vs cron

After F2.6 lands, both paths will write `webhook_deliveries` rows. Tell
them apart via `source`:

```sql
select source, count(*) from webhook_deliveries
where received_at > now() - interval '7 days' group by source;
```

If `fathom_cron` > 0 but `fathom_webhook` is flat for that same window, the
webhook stopped firing — investigate Fathom-side or Vercel-side.

### Slowest deliveries (latency regression)

```sql
select webhook_id, extract(epoch from processed_at - received_at) as seconds
from webhook_deliveries
where processing_status = 'processed'
  and processed_at > now() - interval '24 hours'
order by seconds desc limit 20;
```

Typical is ~5–10s. Anything >30s is worth inspecting (long call? embedding
API slow?). Anything approaching 60s → Vercel will kill the function next
time; raise `maxDuration` or investigate the latency source.

---

## Failure modes — what to do when

| Symptom | Likely cause | Action |
|---|---|---|
| All deliveries 401 | Secret mismatch between Fathom and Vercel env var | Rotate the secret — see "Rotate Secret" below. |
| All deliveries 500 | OpenAI or Supabase outage | Check status pages. Cron backfill catches up once service restored. |
| Some deliveries `malformed` | Fathom payload shape drift | Inspect `webhook_deliveries.payload` — compare to adapter's expectations in `ingestion/fathom/webhook_adapter.py`. |
| `needs_review` queue growing fast | New client roster — resolver doesn't match | Expected; merge via the Gregory dashboard's "Merge into…" button on the Clients detail page (visible only on `needs_review`-tagged clients). See `docs/archive/historical/known-issues.md` § "Auto-created client review workflow". |
| Duplicate calls in DB | Shouldn't happen — pipeline idempotency covers this | File a bug; worth investigating the classifier / upsert paths. |
| `calls` row but no `call_summary` document | Summary was empty in the webhook payload | Normal — older calls or calls Fathom didn't summarize. Not a bug. |
| `calls` row but no `call_action_items` | Same — not all calls have action items | Normal. |

---

## Rotate Secret (F2.5+ — not yet needed)

Fathom has no `PATCH /webhooks` endpoint, so rotation = delete + recreate.
Because deliveries in-flight between the two steps would fail signature
verify, the correct pattern is:

1. Register a second webhook at the same URL via `POST /webhooks` (same
   body as the original registration). Capture the new `secret`.
2. Set `FATHOM_WEBHOOK_SECRET_PREV` = the CURRENT secret on Vercel.
3. Set `FATHOM_WEBHOOK_SECRET` = the NEW secret on Vercel.
4. Deploy. (During this deploy, the handler needs to accept either secret —
   see the existing handler's signature verify function; today it reads only
   `FATHOM_WEBHOOK_SECRET`. Update the verifier to try both env vars if
   both are present, OR accept the risk of a brief verify-fail window
   during step 5.)
5. Wait 5 minutes for Fathom's retry window to clear, then delete the
   original webhook via `DELETE /webhooks/<original_id>`.
6. Unset `FATHOM_WEBHOOK_SECRET_PREV` on Vercel + redeploy.

See `docs/archive/historical/known-issues.md` § "Fathom webhook secret rotation runbook" for the
pending work to update the handler's verify function to support the dual-
secret overlap window.

---

## Teardown

To stop Fathom deliveries entirely (e.g., for maintenance window):

```bash
curl -sS -X DELETE https://api.fathom.ai/external/v1/webhooks/<WEBHOOK_ID> \
  -H "X-Api-Key: <FATHOM_API_KEY_PROD>"
```

Fathom stops delivering immediately. The Vercel endpoint stays live (200s
on GET, 401s on POST since the secret-tied-to-deleted-webhook won't verify
any real signed request). Calls recorded during the teardown period are
recoverable via the F2.6 cron backfill once the webhook is re-registered.

---

## References

- `docs/archive/historical/fathom_webhook.md` — full design spec.
- `api/fathom_events.py` — handler source, annotated.
- `ingestion/fathom/webhook_adapter.py` — payload → FathomCallRecord.
- `ingestion/fathom/pipeline.py` — `ingest_call`, `_ensure_summary_document`,
  `_upsert_action_items`.
- `supabase/migrations/0011_webhook_deliveries_and_doc_type_unique.sql` —
  table DDL.
- `scripts/test_fathom_webhook_locally.py` — local 5-path test loop.
- `docs/archive/historical/known-issues.md` — open questions, secret rotation, observability push-
  vs-pull.
- `docs/runbooks/slack_webhook.md` — structurally-similar handler; sync
  pattern precedent.
- `docs/runbooks/fathom_backlog_ingest.md` — TXT backlog path, same
  pipeline core.
