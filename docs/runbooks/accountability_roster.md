# Runbook — Path 2 outbound accountability/NPS roster

Operational guide for `api/accountability_roster.py` — the daily-pull GET endpoint Make.com hits to drive accountability + NPS automation. Replaces the Financial Master Sheet as the source of truth for that scenario.

**Endpoint:** `https://ai-enablement-sigma.vercel.app/api/accountability_roster`
**Method:** GET (POST → 405; PUT/DELETE/PATCH → 501)
**Auth:** `X-Webhook-Secret` header against `MAKE_OUTBOUND_ROSTER_SECRET` env var
**Cadence:** Make.com pulls once per day (Zain's scenario)
**Architecture:** see `docs/agents/gregory.md` § "Path 2 outbound — accountability/NPS daily roster endpoint"

---

## Quick health check

```bash
PROD_SECRET=$(grep '^MAKE_OUTBOUND_ROSTER_SECRET=' .env.local | cut -d= -f2-)
curl -s -H "X-Webhook-Secret: $PROD_SECRET" \
  https://ai-enablement-sigma.vercel.app/api/accountability_roster | jq '.count, .generated_at'
```

Expected: count > 0, `generated_at` is current ISO8601 UTC. If count drops dramatically vs prior days, see "Debug a stale or unexpected roster" below.

---

## Rotate the shared secret

The secret is shared between Vercel (server side) and Make.com (caller side). Rotation must update both, or the endpoint will reject Make.com's pulls (401) until Make.com is updated.

1. **Mint a new secret locally.**
   ```bash
   python -c "import secrets; print(secrets.token_urlsafe(32))"
   ```

2. **Update Vercel first** (NOT Make.com — Make.com keeps using the old secret until step 4). Project → Settings → Environment Variables → `MAKE_OUTBOUND_ROSTER_SECRET` → Edit → paste new value → Save → Production scope only. Trigger a redeploy (Vercel does this automatically on env-var save in newer dashboards; verify by checking Deployments → latest).

3. **Wait for the redeploy to land.** Curl with the OLD secret should now return 401; curl with the NEW secret should return 200. Both verify the new secret is live.

4. **Update Make.com.** Drake or Zain edits the scenario's HTTP module → Headers → `X-Webhook-Secret` → paste new value → save scenario. Run a manual scenario execution to verify the pull succeeds (200 + payload).

5. **Update `.env.local`** for harness runs: `MAKE_OUTBOUND_ROSTER_SECRET=<new value>`. NOT committed — `.env.local` is gitignored.

**Window of disruption:** between step 2 (Vercel rotates) and step 4 (Make.com updated), Make.com's automated pulls 401. Typical rotation: <5 minutes if Drake + Zain coordinate. If the daily pull window is at risk, time the rotation to land between scheduled pulls.

**If you forget step 4:** Make.com's scenario will start logging 401s. Vercel function logs will show `unauthorized — header_present=True`. Easy to diagnose, but the day's automation won't fire until fixed.

---

## Debug a stale or unexpected roster

If Scott or Zain reports "today's automation didn't include client X" or "the count dropped":

1. **Hit the endpoint directly** with the production secret (see "Quick health check" above). Capture `count` and the full response.

2. **Compare against expected.** As of 2026-05-04 ship, the expected actionable count was 100 of 195 non-archived. If today's count is:
   - **Much lower:** something broke. Check for a recent mass status change (clients moved to archived?) or a Slack-channel migration. Rerun the local harness for full diagnostics: `.venv/bin/python scripts/test_accountability_roster_locally.py`.
   - **Same or slightly higher:** working as intended. The "missing" client may be one of the 95 filtered clients — verify their `slack_user_id` and `slack_channels` rows exist via the harness's spot-check query.

3. **Check eligibility for a specific client.** A client appears in the roster only if ALL of these hold:
   - `clients.archived_at IS NULL`
   - `clients.email IS NOT NULL`
   - `clients.slack_user_id IS NOT NULL`
   - At least one `slack_channels` row exists with `client_id = <client.id>` AND `is_archived = false`

   Quick SQL:
   ```sql
   SELECT
     c.id, c.full_name, c.email, c.slack_user_id, c.archived_at,
     (SELECT slack_channel_id FROM slack_channels sc
       WHERE sc.client_id = c.id AND sc.is_archived = false
       ORDER BY sc.created_at DESC LIMIT 1) AS channel_id
   FROM clients c
   WHERE lower(c.email) = lower('<client_email>');
   ```
   If `channel_id IS NULL` or `slack_user_id IS NULL`, that's why they're filtered.

4. **If `slack_user_id` is missing on an active client,** they're part of the broader Slack-identity coverage gap (see `docs/known-issues.md` § "Client→Slack-identity coverage gap"). Fix: lookup via Slack `users.lookupByEmail` and populate the column.

---

## Verify Make.com is actually pulling

Make.com's pull schedule lives in their scenario, not on our side. To verify pulls are happening:

1. **Vercel dashboard → Project → Logs (Functions tab).** Filter on `accountability_roster`. Each 200 response logs:
   ```
   accountability_roster: served roster — total_rows=<int> actionable_count=<int>
   ```
   Look for one such line per expected pull window (typically once per day).

2. **If no recent logs:** Make.com isn't pulling. Could be: scenario disabled, scenario errored at a prior step, Make.com auth using a stale secret (see "Rotate the shared secret"). Drake or Zain checks the scenario's run history on Make.com's side.

3. **Vercel function logs persist for ~7 days.** Beyond that, no record exists on our side — outbound-pull audit log is intentionally not implemented (see `docs/known-issues.md` § "Path 2 outbound roster — outbound-pull audit log not implemented").

---

## Re-running the local harness

Always safe to run — read-only, no DB mutations. Sets a per-run test secret independent of `MAKE_OUTBOUND_ROSTER_SECRET`.

```bash
.venv/bin/python scripts/test_accountability_roster_locally.py
```

Expected output: `27/27 checks passed`. The harness prints the live actionable count + the spot-check client name; useful for sanity-checking against expectations.

---

## Failure modes

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `HTTP 401` from valid Make.com pull | Secret out of sync after rotation | Sync Make.com to the new secret |
| `HTTP 500 server_misconfigured` | `MAKE_OUTBOUND_ROSTER_SECRET` not set in Vercel Production | Set env var, redeploy |
| `HTTP 500 query_failed` | Supabase pooler down, or schema regression | Check Supabase status; check recent migrations didn't drop `accountability_enabled` / `nps_enabled` |
| `count` is much lower than expected | Mass archive event, or `slack_channels` rows lost | Run local harness for diagnostics; cross-check against `clients` row count by status |
| `count` is 0 | Either a query failure or a mass data event; should never happen at current volume | Investigate immediately — check Vercel logs, run harness, check raw `clients` table |
| Make.com reports `channel_not_found` per-client | `slack_channels.is_archived` stale vs Slack truth | Update the row in our DB, or rely on Make.com surfacing the failure (see followup) |
