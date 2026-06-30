# Runbook — Daily 7am EST accountability notification cron

Operational guide for `api/accountability_notification_cron.py` — the
Vercel Cron daily fire that posts one Slack message per CSM listing
which of their clients didn't submit accountability the prior day.

**Cron schedule:** `0 12 * * *` (12:00 UTC = 7am EST, 8am EDT).
**Endpoint:** `https://ai-enablement-sigma.vercel.app/api/accountability_notification_cron`
**Auth:** `Authorization: Bearer <CRON_SECRET>` (shared across all cron endpoints in this project; consolidated to single-var pattern in M6.2)
**Destination:** `SLACK_CS_ACCOUNTABILITY_CHANNEL_ID` (one channel; one message per CSM).
**Architecture:** see `docs/agents/gregory.md` § "CS visibility surfaces (M6.1)".

---

## What the cron does

On each fire (12:00 UTC daily):

1. **Compute `yesterday`** as `date.today() - timedelta(days=1)` (UTC, but functionally matches "yesterday in EST" because at 12:00 UTC the prior calendar day in UTC = prior calendar day in EST/EDT).
2. **Fetch yesterday's submissions from Airtable** — GET against the configured base/table with `filterByFormula = {What date is this for?} = '<yesterday>'`. Pages through results if pagination is needed (Airtable caps at 100 records/page; up to 20 pages defensively).
3. **Query Gregory** for active accountability-enabled clients (`archived_at IS NULL` AND `status = 'active'` AND `accountability_enabled = true`), with their active primary_csm joined.
4. **Compute the "missing" list** — eligible clients whose email isn't in Airtable's submissions set (lowercased + stripped on both sides).
5. **Group by CSM** — clients with no active primary_csm are dropped silently with a count in the audit row (see "No-primary-csm handling" below).
6. **Post one Slack message per CSM** to the destination channel. Skips entirely if no CSM has missing clients ("no news is good news"; audit row records the clean run with `skipped_reason='no_missing_clients'`).
7. **Write `webhook_deliveries` audit row** (`source='accountability_notification_cron'`) with the full per-CSM breakdown.

On failure (Airtable down, Gregory query broken, channel env var missing): writes a failed audit row, posts a loud `:warning:` Slack alert to the same channel referencing the audit `delivery_id`, returns HTTP 500.

---

## Per-CSM message format

```
[CSM First Name] — these clients didn't submit accountability yesterday ([yesterday's date]):
- [Client Full Name 1]
- [Client Full Name 2]
- ...
```

First-name extraction: `full_name.split()[0].capitalize()`. Mirrors the M5.8 Path 2 pattern in `accountability_roster.py`. Internal-cap names like "DeShawn" become "Deshawn"; current CSM roster (Lou / Nico / Scott / Nabeel) is clean so this is acceptable.

---

## No-primary-csm handling

Clients with `accountability_enabled=true` AND `status='active'` AND no active primary_csm assignment are **silently dropped** from per-CSM grouping. The count surfaces in the audit row's `payload.unassigned_missing_count` field so an operator can see if the bucket grows.

**Live count at M6.1 ship (2026-05-05): zero.** All 91 active accountability-enabled clients have an active primary_csm assignment. The dropped-with-count behavior is forward-defensive rather than addressing a current gap.

---

## Quick health check

Verify yesterday's run:

```sql
SELECT webhook_id, processing_status, processing_error, payload
FROM webhook_deliveries
WHERE source = 'accountability_notification_cron'
ORDER BY received_at DESC
LIMIT 5;
```

Expected (success): most recent row is `processing_status='processed'`, `payload.eligible_count` matches the count of active accountability-enabled clients, `payload.csms_messaged_ok` is non-empty (or `skipped_reason='no_missing_clients'` if everyone submitted).

---

## Manual trigger

To run the cron on demand (e.g., re-fire after a Vercel deploy or test a new env var):

```bash
PROD_TOKEN=$(grep '^CRON_SECRET=' .env.local | cut -d= -f2-)
curl -i -X POST -H "Authorization: Bearer $PROD_TOKEN" \
  https://ai-enablement-sigma.vercel.app/api/accountability_notification_cron
```

Expected: HTTP 200 with `{"status":"ok",...}` on a successful run, or HTTP 500 with `{"status":"failed","error":...}` on Airtable / channel-env failure (and a `:warning:` Slack alert posted to the channel).

---

## Rotate the secrets

The cron uses two secrets that may need rotation:

### Cron auth token (`CRON_SECRET`)

`CRON_SECRET` is the single project-level Vercel env var ALL crons in this codebase validate against (consolidated to this pattern in M6.2). Rotating it affects every cron endpoint simultaneously — fathom_backfill, gregory_brain_cron, accountability_notification_cron.

1. Generate: `python -c "import secrets; print(secrets.token_urlsafe(32))"`
2. Set `CRON_SECRET` in Vercel Production env (Settings → Environment Variables).
3. Trigger redeploy.
4. Manually fire each cron with the new token (above) → expect 200 on all three.
5. Update `.env.local` for harness runs.

Single source of truth: no synchronization with a second env var. Rotation is one place, no risk of drift.

Window of disruption: between Vercel env update and redeploy, scheduled cron fires would 401. At daily cadence this is a ~15-minute window; usually a non-event.

### Airtable PAT (`AIRTABLE_ACCOUNTABILITY_PAT`)

1. Generate at https://airtable.com/create/tokens with scope `data.records:read` on the base.
2. Save to Bitwarden as `AIRTABLE_ACCOUNTABILITY_PAT_PROD`.
3. Set in Vercel Production env.
4. Update `.env.local` for harness runs.
5. Manually fire the cron → expect 200.

If the PAT expires or is revoked: the cron's next fire returns 500, audit row marks `failed` with `airtable_fetch_failed`, and a `:warning:` Slack alert lands in the destination channel. An operator sees this within ~24h max.

---

## Debug a missing per-CSM message

If a CSM expected a message and didn't get one:

1. **Check the latest audit row:**

   ```sql
   SELECT processing_status, processing_error, payload
   FROM webhook_deliveries
   WHERE source = 'accountability_notification_cron'
     AND received_at > now() - interval '24 hours'
   ORDER BY received_at DESC
   LIMIT 1;
   ```

   Possible states:

   - **`processing_status='processed'`, `payload.csms_messaged_ok` includes the CSM's name** → message fired successfully. Check the Slack channel; if the CSM doesn't see their message, suspect Slack-side filtering or the channel being archived/private without the CSM's membership.
   - **`processing_status='processed'`, `payload.skipped_reason='no_missing_clients'`** → the cron ran cleanly but no CSM had missing clients (everyone in the active accountability roster submitted). By design: skip + post nothing.
   - **`processing_status='failed'`, `processing_error LIKE 'slack_post_failed_for_some_csms%'`** → per-CSM Slack post failed for some CSMs. Check `payload.csms_messaged_failed[].slack_error` for the specific Slack error code per CSM.
   - **`processing_status='failed'`, `processing_error LIKE 'airtable_fetch_failed%'`** → upstream Airtable failure. The `:warning:` Slack alert should also be in the channel; see "Rotate the secrets" if the PAT expired.
   - **No row at all in the last 24h** → the cron didn't fire. Possible causes:
     - Vercel Cron paused at the project level (rare; check Vercel dashboard).
     - Vercel function deployment broke on the most recent push (check Functions tab).
     - The function is failing during startup (auth-pre-handler). Check Vercel function logs.

2. **If the audit row says the CSM was messaged but they don't see it:**

   - Verify the CSM is a member of `SLACK_CS_ACCOUNTABILITY_CHANNEL_ID`.
   - Verify the bot is a member of the channel (`/invite @<bot>` if not).
   - Slack message search in the channel for "didn't submit accountability yesterday" — if the message exists but the CSM doesn't see it, suspect a Slack notification-routing setting on their account.

3. **If the cron fires but the eligible-count looks wrong:**

   ```sql
   SELECT count(*) FROM clients c
   WHERE c.archived_at IS NULL
     AND c.status = 'active'
     AND c.accountability_enabled = true;
   ```

   That number should match `payload.eligible_count`. If it doesn't, suspect a Gregory query bug — file a followup.

---

## Re-running the local harness

```bash
.venv/bin/python scripts/test_accountability_notification_cron_locally.py
```

Expected: `31/31 checks passed`. The harness:

- Self-seeds 3 fixture clients + 2 CSMs (hard-deleted in cleanup)
- Mocks Airtable HTTP at `urllib.request.urlopen`
- Mocks Slack at `shared.slack_post.post_message`
- Reads against cloud DB for the eligibility query (so it includes real production clients alongside the fixtures)

The harness exercises happy path, idempotent re-run, no-missing skip, Airtable failure → loud alert, per-CSM partial failure, missing channel env var, and auth (401 on missing/wrong token).

---

## Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| HTTP 401 on Vercel Cron's POST | `CRON_SECRET` not set in Vercel OR doesn't match what the handler expects | Set `CRON_SECRET` in Vercel Production env; redeploy. Single source of truth — no second env var to sync. |
| HTTP 500 with `airtable_fetch_failed` | PAT expired/revoked OR Airtable down | Regenerate PAT (see "Rotate the secrets"); check status.airtable.com |
| HTTP 500 with `gregory_query_failed` | Supabase pooler down OR schema regression | Check Supabase status; verify `accountability_enabled` column still exists; check recent migrations |
| HTTP 500 with `SLACK_CS_ACCOUNTABILITY_CHANNEL_ID not set` | Env var missing in Vercel | Set + redeploy |
| All CSMs marked `csms_messaged_failed` | Bot kicked from channel OR channel archived | Re-invite bot; verify channel is active |
| Per-CSM `csms_messaged_failed[].slack_error='channel_not_found'` | Channel ID wrong | Verify channel ID matches Slack's actual ID |
| `eligible_count` is 0 unexpectedly | Either `accountability_enabled` got mass-cleared OR all clients are archived/non-active | Cross-check with a direct SQL count; likely a data event needs investigation |
| Cron fires multiple times per day (duplicate posts) | Manual `curl` triggers between scheduled fires; OR Vercel Cron retry on transient failure | V1 has no dedup; expected behavior. Audit rows distinguishable by `delivery_id` |

---

## Schema + audit references

- Cron handler: `api/accountability_notification_cron.py`
- Slack-post helper: `shared/slack_post.py:post_message`
- Harness: `scripts/test_accountability_notification_cron_locally.py`
- webhook_deliveries source label: `accountability_notification_cron`
- Cron schedule: `vercel.json` → `crons[]` → `/api/accountability_notification_cron` `0 12 * * *`
- Build log entry: `docs/agents/gregory.md` § "CS visibility surfaces (M6.1)"

Audit-trail SQL — find every cron fire over the last week with per-CSM breakdown:

```sql
SELECT
  webhook_id,
  processing_status,
  payload->>'date_checked' AS date_checked,
  (payload->>'eligible_count')::int AS eligible,
  (payload->>'submitted_count')::int AS submitted,
  (payload->>'missing_count')::int AS missing,
  (payload->>'unassigned_missing_count')::int AS unassigned_missing,
  payload->'csms_messaged_ok' AS messaged_ok,
  payload->'csms_messaged_failed' AS messaged_failed
FROM webhook_deliveries
WHERE source = 'accountability_notification_cron'
  AND received_at > now() - interval '7 days'
ORDER BY received_at DESC;
```
