# Investigate Ella V2 Batch 2.3 post-rollout issues
**Slug:** ella-v2-batch-2-3-postrollout-investigation
**Status:** in-flight

## Context

Batch 2.3 code shipped earlier tonight (commits through `f634cef` on `main`). Drake set `ELLA_PASSIVE_MONITORING_ENABLED=true` in Vercel and (per earlier session) flipped `slack_channels.passive_monitoring_enabled=true` on `#ella-test-drakeonly`. Earlier passive runs WERE firing — per-message cost renders correctly on `/ella/runs/<id>` detail pages, confirming Haiku and Sonnet calls completed and `agent_runs` cost fields populated for at least some runs.

Three issues now surfaced from Drake's testing:

**Issue 1: Drake's "how can we help Javi get more sales" message in `#ella-test-drakeonly` got no response.** No client-facing Slack post; per Drake's read, no escalation DM either. The `agent_runs` row exists (visible in `/ella/runs` dashboard) but renders "unknown author / unknown channel," and Drake's note "haiku was never employed" suggests the Haiku call may not have happened for this specific message. Cause unknown — could be any of the six pre-Haiku gates firing, a Haiku=`skip` decision, a downstream queue/dispatch failure between Haiku and Slack post, or a real-author resolution failure upstream.

**Issue 2: `/ella/runs` dashboard "Cost today" total shows zero**, while per-run cost on the detail pages renders correctly. The aggregation/rollup is the bug, not the underlying data. Likely in `lib/db/ella-runs.ts` or wherever the summary band's query lives.

**Issue 3: Drake doesn't understand the five anomaly types (A/B'/C/D/E)** on the dashboard. **This is a documentation/UX gap, NOT a code bug. Director will write a brief explainer doc separately. Do NOT include in code investigation work — flag in the report as out-of-scope per spec.**

## This spec is INVESTIGATION ONLY

Do NOT ship fixes in this session. Three reasons: (a) we don't know yet what the actual bugs are, so any pre-authorized fix is speculative; (b) Issues 1 and 2 could share root cause (both touch dashboard query layer and identity resolution), and fixing one without understanding both risks one-shot patches; (c) Drake wants to wrap up the session soon — "investigate fast, decide what to fix later" gets to a clean breakpoint.

After this report lands, Director reads it and scopes fix work as a separate spec (or specs) for the next session.

Hard stop trigger: if investigation reveals an active production data corruption issue (e.g., agent_runs rows being written with wrong client_id, escalation DMs firing to the wrong CSM), STOP, surface immediately, and ask Drake whether to ship an emergency fix or kill-switch off. Otherwise: keep investigating, write the report.

## Acclimatization checklist — confirm in 4-5 bullets before any diagnostic queries

1. **Verify `ELLA_PASSIVE_MONITORING_ENABLED=true` is live in the deployed Vercel function** (NOT just set in env vars — has a deploy happened since the env var was set?). Check via `vercel env ls production` AND check the most recent production deployment timestamp via `vercel ls`. If the env var was set AFTER the most recent production deploy, the running function still has the old value and the kill switch is effectively off — diagnosis short-circuits to "Drake needs to redeploy" for Issue 1.
2. **Verify `slack_channels.passive_monitoring_enabled=true` for `#ella-test-drakeonly`**. `SELECT slack_channel_id, name, passive_monitoring_enabled FROM slack_channels WHERE name ILIKE '%ella-test%' OR name ILIKE '%drakeonly%'`. Note the slack_channel_id for use in subsequent queries.
3. **Read the Batch 2.3 spec at `docs/specs/ella-v2-batch-2-3-passive-monitoring.md`** (still in-flight status; not cleaned up yet). Specifically the six pre-Haiku gates in § Trigger pipeline and the four-outcome decision pipeline — Drake's "Javi" message could have been skipped by any of them. Don't reverse-engineer from code if the spec already tells you the gate order.
4. **Read `agents/ella/passive_monitor.py`** — the actual implementation of `evaluate_passive_trigger`. Confirm the spec matches the code; flag any drift in the report.
5. **Read `lib/db/ella-runs.ts`** — the dashboard's query layer. The "cost today" aggregation lives here. The "unknown author / unknown channel" display logic ALSO lives here (or in the rendering component at `app/(authenticated)/ella/runs/`); both rendering bugs are likely in this file or its consumers.

## Issue 1 investigation steps

1. **Find Drake's "Javi" message in `slack_messages`:**
   ```sql
   SELECT id, slack_channel_id, slack_user_id, sent_at, text, author_type
     FROM slack_messages
    WHERE slack_channel_id = '<test-channel-id>'
      AND text ILIKE '%javi%'
      AND text ILIKE '%sales%'
    ORDER BY sent_at DESC
    LIMIT 5;
   ```
   Capture the message `sent_at` (which maps to `slack_ts`), the `slack_user_id` (the actual poster), and the `author_type` (`client`/`team_member`/`ella`/etc.). **Quote the row in the report.**

2. **Find the matching `agent_runs` row:**
   ```sql
   SELECT id, agent_name, trigger_type, status, started_at, ended_at,
          output_summary, trigger_metadata, llm_model,
          llm_input_tokens, llm_output_tokens, llm_cost_usd
     FROM agent_runs
    WHERE agent_name='ella'
      AND trigger_type='passive_monitor'
      AND trigger_metadata->>'triggering_message_ts' = '<the ts>';
   ```
   **Quote the full `trigger_metadata` JSON in the report.** This is the key diagnostic artifact.

3. **Diagnose based on `trigger_metadata.skip_reason` and `haiku_decision`:**

   - **`skip_reason='global_kill_switch'`** → confirm with Step 1 acclimatization that the env var isn't live in the deployed function. Diagnosis: Drake needs to redeploy.

   - **`skip_reason='channel_disabled'`** → confirm with Step 2 acclimatization that the per-channel toggle isn't actually on. Diagnosis: Drake needs to flip `slack_channels.passive_monitoring_enabled=true` for the test channel.

   - **`skip_reason='not_client_author'`** (or whichever exact label the code uses — confirm) → Drake's `slack_user_id` is registered as `team_member`, not `client`. Run:
     ```sql
     SELECT slack_user_id, full_name, role, active
       FROM team_members
      WHERE slack_user_id = '<Drake's slack_user_id from step 1>';
     ```
     If Drake is a team_member, the passive monitor will correctly skip his messages (clients-only design — passive monitor's whole point is to respond to CLIENTS in their channels, not to CSMs/advisors). This is "working as designed" and the diagnosis becomes "Drake needs to test from a client account, OR remap the test channel's `client_id` to point at Drake's user." Surface both options in the report.

   - **`skip_reason='csm_directed'`** → Haiku/pre-Haiku gate detected a CSM mention or first-name match. The phrase "help Javi get more sales" mentions Javi, who IS a CSM (Javi Pena — confirm via `team_members.full_name`). **This is the most likely cause** given the message text. Diagnosis: the CSM-directed gate is firing on the literal name "Javi" because Javi is a CSM in the team_members table. Surface this clearly with the matching team_member row and the gate's matching logic from `passive_monitor.py`.

   - **`skip_reason='no_kb_match'`** → KB-relevance gate didn't find anything for Javi. The "how can we help Javi" framing is meta — about Javi as a person — not about Javi's content/courses, so it may legitimately not match KB content scoped to the test channel's mapped client. Quote the KB-relevance query and threshold used.

   - **`skip_reason='firm_after_first'`** → Ella escalated on a similar topic in this channel recently; gate suppressing follow-up. Check `trigger_metadata` for which prior run triggered this and quote the keyword overlap.

   - **`haiku_decision='skip'`** (no skip_reason; the gates passed but Haiku itself decided not to respond) → Haiku DID fire, returned `skip`. Quote the `haiku_reasoning` in the report. This is "working as designed but maybe the prompt is too conservative."

   - **`haiku_decision='respond_substantive'` or `'respond_general_inquiry'`** (the gates passed AND Haiku said respond) — but no Slack post happened → **this is a real bug**. Check `pending_ella_responses` for a row matching this agent_run_id:
     ```sql
     SELECT id, status, respond_after_ts, responded_at, error_message
       FROM pending_ella_responses
      WHERE agent_run_id = '<the run id from step 2>';
     ```
     If `status='queued'` and `respond_after_ts` is in the past — the cron isn't draining. Investigate cron logs. If `status='cancelled_csm_intervened'` — the intervention check fired (was there another message from a CSM between Drake's post and the 1-min mark?). If `status='error'` — quote `error_message`.

4. **Diagnose the "unknown author / unknown channel" rendering separately from the no-response cause.** Even if Issue 1's no-response root cause is identified above, the dashboard rendering "unknown" for author and channel is a separate display-layer issue. Read `lib/db/ella-runs.ts` and the run-detail rendering component. Specifically: how does the query resolve the channel name from `slack_channel_id` and the author display name from `slack_user_id`? If those lookups fail silently for any reason (e.g., the channel mapping doesn't exist in `slack_channels` for the resolved channel_id, OR the speaker's slack_user_id isn't in `clients`/`team_members`), the dashboard falls back to "unknown." Quote the query and identify the failure mode. This bug may apply to other recent passive runs too, not just Drake's Javi message — check 3-5 other recent passive_monitor runs to see if their author/channel renders correctly.

## Issue 2 investigation steps

1. **Read `lib/db/ella-runs.ts`** (and any related dashboard data files) to find the "cost today" summary-band query. Identify the exact SQL or query builder shape.

2. **Likely failure modes to check:**
   - **Date window bug.** Is the query filtering on `started_at >= <today 00:00 UTC>` while the dashboard displays "today" in the user's local timezone? If Drake is in EST and started_at is in UTC, the window is off by 5 hours and may catch zero runs at certain times of day.
   - **Filter mismatch.** Is the query filtering on `agent_name='ella'` AND `status='success'` (excluding skips, errors)? Skip-status runs HAVE no cost so they wouldn't affect the sum, but if the query has an unintended `AND haiku_decision='respond_substantive'` filter or similar, runs with valid cost data could be excluded.
   - **Column name drift.** Is the query reading from `llm_cost_usd` (the actual column) vs `cost_usd` or some other name? Type mismatch (string vs numeric)?
   - **Aggregation bug.** Is the query using `SUM(llm_cost_usd)` correctly, or is it `COUNT(*)` mislabeled as cost, or a GROUP BY with the wrong key that produces zero rows?
   - **Per-run rendering reads from a different source than the summary band.** Detail page may read `agent_runs.llm_cost_usd` directly; summary band may read from a view, materialized table, or different aggregation. Confirm both sources.

3. **Cross-check with raw data:**
   ```sql
   SELECT SUM(llm_cost_usd) AS total_today,
          COUNT(*) AS run_count,
          MIN(started_at) AS earliest,
          MAX(started_at) AS latest
     FROM agent_runs
    WHERE agent_name='ella'
      AND started_at >= CURRENT_DATE AT TIME ZONE 'UTC';
   ```
   If this returns a non-zero `total_today` but the dashboard shows $0, the bug is definitively in the dashboard query, not the data.

4. Quote the dashboard query (TypeScript code), the raw SQL equivalent, and the cross-check query result side-by-side in the report. Root cause should be obvious from the comparison.

## What success looks like

A clean partial-report-norm-shaped report at `docs/reports/ella-v2-batch-2-3-postrollout-investigation.md` answering three questions:

1. **Issue 1 root cause** — which gate fired or which decision led to no response, with the exact `trigger_metadata` and any matching `pending_ella_responses` row quoted. If a real bug, name the bug; if working-as-designed, name the design point and the workaround.
2. **Issue 1 "unknown author / unknown channel" root cause** — separately from the no-response cause, the dashboard rendering bug identified in `lib/db/ella-runs.ts` or its consumers. Quote the query/lookup logic and the failure mode.
3. **Issue 2 root cause** — the specific bug in the "cost today" aggregation. Quote the dashboard query and the raw-SQL cross-check side-by-side.

Each finding should include a **proposed fix shape** (NOT shipped — just described, with the file path and rough change). Director uses these to scope the fix spec for the next session.

## Hard stops

- **No fix code shipped.** This spec is read-only on the codebase except for the report file. Builder commits ONLY the report, nothing else.
- **Active production data corruption** (agent_runs rows with wrong client_id, escalation DMs firing to wrong CSM, etc.) — STOP, surface immediately, ask Drake whether to kill-switch off.
- **Vercel env var verification fails to confirm the deployed-function state** (e.g., `vercel ls` doesn't show recent deploys, or auth issues block the check) — STOP, surface. Drake can confirm via the dashboard.

## What could go wrong

- **The "Javi" message search returns multiple matches.** Drake may have posted similar text earlier in testing. Use `sent_at` to identify the most recent one matching Drake's described phrasing; quote any ambiguity.
- **The `slack_messages` row exists but the `agent_runs` row doesn't.** Means the passive monitor wasn't dispatched at all — ingestion fork didn't fire. Could be: (a) ingestion-side bug introduced between Batch 2.3 ship and now (unlikely — no commits to `ingestion/slack/realtime_ingest.py` since); (b) Drake's slack_user_id resolving to `author_type='team_member'` (the most common cause — the fork only dispatches for `client` authors); (c) the channel's `passive_monitoring_enabled` is false at query time. Check all three.
- **The "Cost today" aggregation may legitimately be zero** if all of today's passive runs were skips or general-inquiry (zero-cost path). Confirm via the raw cross-check query BEFORE concluding the dashboard is buggy. If raw SUM = 0, dashboard is correct and Drake's perception is wrong. Surface this possibility honestly.
- **The CSM-directed gate's matching logic.** First-name matching is brittle by design. "Javi" as a first name match likely fires for Javi Pena. But: is the match against the channel's primary_csm only, or against ALL team_members? If ALL, the gate is over-aggressive — any CSM name in any client channel skips Ella. Read the actual implementation in `passive_monitor.py` and quote the matching logic. This is a design question worth surfacing even if it's the expected behavior.

## Mandatory doc updates

NONE in this investigation spec — Builder writes only the report. Director updates:
- `docs/agents/ella/ella.md` § Anomaly types (separate Director work, parallel to this investigation)
- Fix specs for any issues this investigation surfaces

## Report format

Per the new partial-report norm (§ Director / Builder System § Builder behavior in `CLAUDE.md`), since this spec is investigation-only and doesn't have a "complete" state in the same way a fix spec does, write the report as a FULL report (not partial) when investigation is complete. Six sections:

1. **Files touched** — should be only the report itself. Anything else, surface as a surprise.
2. **What I did** — investigation narrative, ordered by issue.
3. **Verification** — the queries you ran with results.
4. **Surprises and judgment calls** — design questions, unclear behaviors, anything you noticed beyond the three issues.
5. **Out of scope / deferred** — Issue 3 (anomaly types — Director handles). Any side-issues noticed that warrant their own investigation.
6. **Side effects** — should be NONE for an investigation spec. If queries had side effects (writes), explain why.

Plus the standard PARTIAL-on-hard-stop fallback if Builder hits a real blocker.

## Commit shape

One commit: the report. `docs: investigation report — ella v2 batch 2.3 post-rollout`.
