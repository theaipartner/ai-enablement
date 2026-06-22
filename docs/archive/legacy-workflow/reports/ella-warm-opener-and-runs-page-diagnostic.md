# Report: Ella warm-opener misfire + /ella/runs empty — diagnostic (read-only)
**Slug:** ella-warm-opener-and-runs-page-diagnostic
**Spec:** docs/specs/ella-warm-opener-and-runs-page-diagnostic.md

## Files touched

Created:
- `docs/reports/ella-warm-opener-and-runs-page-diagnostic.md` — this report.

Modified:
- `docs/specs/ella-warm-opener-and-runs-page-diagnostic.md` — `Status:` flipped from `in-flight` to `shipped`.

No code, schema, or migration changes. The diagnostic script was a throwaway at `/tmp/run_diag.py` (deleted by `/tmp` lifecycle; not committed). All queries were read-only `SELECT`s against cloud Supabase via psycopg2 on the pooler URL.

## What I did, in plain English

Pulled the two misfire `agent_runs` rows for Nico's @-mentions in the Ruphael G channel (`C09UMFVQNMU`), surfaced their `mention_classifier_shape` + `mention_classifier_reasoning` + `status` verbatim, and confirmed against the runs around the same window that the same failure signature is occurring fleet-wide (not channel-specific to Ruphael's). Then separately characterised the dashboard: pulled the 24h + 7d Ella run counts, status + trigger_type + haiku_decision breakdowns, and read the `getEllaRunsList` post-filter logic against what the data actually looks like.

**Q1 verdict: (B) classifier errored / parsed-to-fallback.** Both misfire rows carry `mention_classifier_shape='warm_opener'` and `mention_classifier_reasoning='classifier_call_failed: BadRequestError'` — the exact byte-pattern that `agents/ella/mention_classifier.py:204-215` writes when the Anthropic Haiku call raises. The classifier never picked `warm_opener`; the API call failed and the parser collapsed to the safer-fallback. The agent run itself succeeded (`status='success'`) because posting the fallback is a successful outcome by the agent's contract — that's the reason it didn't error-out visibly.

**Fleet-wide context (bigger than Q1):** the `BadRequestError` is NOT channel-specific to Ruphael's. In the last 36h, **50+ distinct channels and 130+ rows** show either `mention_classifier_reasoning ILIKE 'classifier_call_failed%'` OR `haiku_reasoning ILIKE 'haiku_call_failed: BadRequestError'`. **Both** the mention-path classifier Haiku and the passive-decision Haiku are erroring with the same `BadRequestError` across the production fleet. The skip-decision Haiku failure mode is more invisible — it logs `haiku_call_failed: BadRequestError` and silently skips, so users never see a misfire reply; it just means Ella isn't responding when she should be. The mention path is louder only because the fallback posts to the channel.

**Q2 verdict: (D) dashboard query bug.** Rows ARE landing — 301 Ella `agent_runs` in the last 24h, 1212 in the last 7d, most recent <1 hour before the diagnostic. Trigger-type distribution last 7d: `passive_monitor` 1205, `slack_mention` 6, `bare_mention` 1, **zero `passive_substantive` / `passive_general_inquiry`**. The dashboard's `getEllaRunsList` post-filter (`lib/db/ella-runs.ts:684-692`) keeps rows only when (a) `trigger_type ∈ RESPONSE_TRIGGER_TYPES` (which only matches the 7 reactive rows) OR (b) `trigger_type='passive_monitor' AND trigger_metadata.haiku_decision === 'escalate'`. Last 7d, exactly **1** passive_monitor row had `haiku_decision='escalate'`. The actual `haiku_decision` enum landing in production today is dominated by `skip` (1164), `acknowledge_and_escalate` (27), null (7), `digest_only` (4), `respond` (1), `respond_haiku_self` (1) — the filter doesn't recognise any of these. Net effect: `/ella/runs` is rendering ~8 rows when the genuine user-visible Ella event count over 7d is in the hundreds.

**Are Q1 and Q2 the same root cause? No — but they interact diagnostically.** Q1 is an Anthropic Haiku-side API problem (`BadRequestError` on Ella's Haiku calls fleet-wide). Q2 is a stale dashboard filter (`lib/db/ella-runs.ts` was written when the response path produced `passive_substantive` / `passive_general_inquiry` rows and the only passive_monitor variant worth surfacing was a plain `'escalate'` decision). Different files, different fixes. The interaction is that Q2 hid Q1: Drake couldn't see the row containing the `classifier_call_failed: BadRequestError` reasoning, so the misfire looked like "Haiku picked warm_opener for a substantive question" (an A-hypothesis prompt-quality problem) when it was actually "Haiku call errored and we fell back" (a B-hypothesis infrastructure problem with a totally different fix).

## Verification

Six query passes, all read-only `SELECT`s against the cloud pooler URL via psycopg2:

1. **Channel resolution.** `slack_channels WHERE name ILIKE '%ruphael%' OR name ILIKE '%getahun%'` → exactly 1 row: `C09UMFVQNMU` "Ruphael G", client `Ruphael G` (id `22dbdbb9-eae8-465f-b819-1b5349b14447`), `passive_monitoring_enabled=true`, `test_mode=false`. Confirms the misfire happened in a live passive-monitoring channel.

2. **Misfire rows (the Q1-deciding query).** Last 36h Ella rows in that channel; both 22:23 UTC mention rows surfaced cleanly. Verbatim from cloud (status, output_summary, shape, reasoning):

   ```
   id        689145b7-963c-45b9-957d-99d816f55e77
   started   2026-05-22 22:23:37.109596+00
   trigger_type        passive_monitor
   status              success
   input_summary       "<@U0B03PTJD3P> i want some strateegies on cold calling"
   output_summary      "mention/warm_opener: Hey — what can I help with?"
   shape               warm_opener
   reasoning           classifier_call_failed: BadRequestError
   haiku_decision      null
   author_type         team_member
   real_author_name    null
   ```

   ```
   id        30db9631-7766-4a40-bf84-9373e816132c
   started   2026-05-22 22:23:05.789330+00
   trigger_type        passive_monitor
   status              success
   input_summary       "<@U0B03PTJD3P> rupahel is in the prospecting phase and is cold calling. can you give him some tips for success"
   output_summary      "mention/warm_opener: Hey — what can I help with?"
   shape               warm_opener
   reasoning           classifier_call_failed: BadRequestError
   haiku_decision      null
   author_type         team_member
   real_author_name    null
   ```

   The reasoning value `classifier_call_failed: BadRequestError` is written at exactly one site in the codebase — `agents/ella/mention_classifier.py:214` — inside the `except Exception as exc:` branch where `_HAIKU_MODEL` raises. The `type(exc).__name__` formatter yields `BadRequestError` for `anthropic.BadRequestError`. This is unambiguously the API-call-raised path, not the JSON-parse path (`unparseable classifier response: ...`) and not the enum-check path (`classifier_returned_unknown_shape=...`).

3. **Q2(C) — run counts + recency.** 24h: 301 Ella runs, latest 2026-05-23 14:25:44 UTC (within an hour of the diagnostic), all `status='success'`. 7d: 1212 rows, statuses `success` 1183 + `escalated` 29 + `error` 0. Trigger-type 7d distribution: `passive_monitor` 1205, `slack_mention` 6, `bare_mention` 1. Rows are landing healthily — (C) is ruled out, (D) is the only remaining hypothesis.

4. **Q2(D) — dashboard filter analysis.** `getEllaRunsList` at `lib/db/ella-runs.ts:684-692`:
   - Status whitelist `['success', 'escalated', 'error']` matches every row last 7d.
   - `RESPONSE_TRIGGER_TYPES = {slack_mention, bare_mention, app_mention, passive_substantive, passive_general_inquiry}` matches the 7 reactive rows.
   - `passive_monitor` rows are kept only if `haiku_decision === 'escalate'`. Cloud-side count of that: **1** in 7d.
   - Cloud-side `haiku_decision` enum on passive_monitor last 7d: `skip` 1164, `acknowledge_and_escalate` 27, null 7, `digest_only` 4, `respond` 1, `escalate` 1, `respond_haiku_self` 1.
   - Cloud-side mention-classifier rows last 7d: **all 7 carry `trigger_type='passive_monitor'`** (6 `warm_opener` + 1 `respond_haiku`); none land as `passive_substantive` / `passive_general_inquiry`.

   Net: the filter recognises ~8 rows over 7d (7 reactive + 1 escalate). The user-visible Ella events the filter is hiding include all 27 acknowledge_and_escalate runs, all 7 mention-path runs (incl. the two warm_opener misfires we're diagnosing), and the 1 each `respond` / `respond_haiku_self` / `escalate`-ish rows. The "I can't see any recent runs" symptom is exactly this filter being out of sync with current production trigger-type / decision shapes.

5. **Q1 step 5 — fleet-wide shape distribution.** Last 7d mention-classifier rows: `warm_opener` 6, `respond_haiku` 1. Reasoning-class breakdown of the 6 `warm_opener` rows: `model_chose` 4, `classifier_call_failed` 2. The 2 classifier_call_failed rows ARE the two misfires (both today, both this channel). So the broader pattern is consistent: the classifier-Haiku failure mode is rare in the mention path specifically (because the mention path itself is rare — 7 rows in 7d), but the same `BadRequestError` is **systemic** in the decision Haiku path, where it accounts for 130+ rows across 50+ channels in 36h.

6. **`agent_runs.metadata` (the loose jsonb beside `trigger_metadata`).** Empty `{}` on the failing rows. There's no stack trace persisted. The classifier code only logs `logger.warning("mention_classifier: classifier Haiku call failed (%s); ...", exc)` to stdout — Vercel function logs would have the full error message + stack for the actual API rejection reason. Recovering the underlying `BadRequestError` body (which field rejected, which validation failed) requires the function logs, not the database.

No tests run (read-only diagnostic, no code changes). No `tsc --noEmit` run on `lib/db/ella-runs.ts` per spec step 4 — the dashboard issue isn't a compile error, it's a logical-filter mismatch with current data shapes; visual code-read was sufficient and `tsc` wouldn't have surfaced it.

## Surprises and judgment calls

**The big surprise — Q1's scope is much larger than "the @-mention misfired."** The same `BadRequestError` is hitting Ella's decision Haiku across the production fleet. Last 36h, 50+ distinct channels with at least one `haiku_call_failed: BadRequestError`. Top affected channels: `C0AFEC456JG` 15 rows, `C0AEEPVK36W` 15 rows, `C0B1DHYL9D5` 9 rows, `C0ALJ8UN1FH` 7 rows, `C09UMFVQNMU` (Ruphael) 5 rows. Most of these are silent — they manifest as Ella *not responding* when she should (the skip-decision branch when haiku fails). The mention misfire is a louder symptom but only one of many. **This is a live production incident broader than what Drake reported.** Flagging in case it justifies its own immediate spec instead of waiting in queue.

**The dashboard filter mismatch was load-bearing for the diagnosis itself.** Without `/ella/runs` showing the misfire row, Drake's only visible evidence was "Ella posted the canned warm opener twice." That looks like a prompt-quality problem (hypothesis A). With the row visible, the `classifier_call_failed: BadRequestError` reasoning is right there — the diagnosis would have taken seconds. Q2 isn't just a "broken dashboard, fix when convenient" — it's an audit-blindness issue that delays root-causing real production incidents like Q1. Worth treating with urgency proportional to that.

**Judgment call — naming the underlying BadRequestError.** I did NOT try to reproduce the Haiku call to extract the actual API rejection reason. The spec is read-only; reproducing means making a real API call. Vercel function logs would have it. Pointing Director at "go check Vercel logs for `mention_classifier: classifier Haiku call failed`" in the follow-up spec instead of doing it myself.

**Judgment call — didn't dig into the `acknowledge_and_escalate=27` rows hidden from the dashboard.** Spec asked to keep this light. Those rows represent real escalations that landed correctly (per the schema-side picture) but never showed in `/ella/runs`. Worth a sentence in any Q2 fix spec — the filter regression has been silent for as long as the mention path has been routing through passive_monitor.

**Judgment call — did not check Vercel deploy timeline.** A natural follow-up question is "when did this start failing?" — the `BadRequestError`s could correlate with a model version bump, a system prompt change, a deploy. I didn't pull deploy timestamps or correlate. That's a sensible first step in the follow-up spec but felt out of scope for the read-only diagnostic.

## Out of scope / deferred

**Director-spec-worthy follow-ups (NOT done in this pass):**

- **Investigate + fix the fleet-wide `BadRequestError` on Ella Haiku calls.** Highest priority. Likely root causes worth probing in order: (i) a recently-changed system prompt or KB-block render that pushes the request over the model's input-token ceiling (the channel context + KB chunks could be large); (ii) a malformed message in `recent_context` (e.g. a Slack mrkdwn structure the SDK rejects); (iii) a model-id change or rate-limit. Vercel function logs for `mention_classifier: classifier Haiku call failed` and `haiku_call_failed: BadRequestError` will have the actual API error body, which will name the failing field.
- **Fix `lib/db/ella-runs.ts:684-692` filter.** It's recognising ~8 / 1212 user-visible Ella events. At minimum: include `passive_monitor` rows where `haiku_decision IN ('escalate', 'acknowledge_and_escalate', 'respond', 'respond_haiku_self', 'digest_only')` OR `mention_classifier_shape IS NOT NULL`. Better: derive a single canonical "this row was a user-visible event" boolean at the data layer and have both the cost-hub and the dashboard read from it, since the next batch of decision-enum churn will silently re-break the filter the same way.
- **`docs/known-issues.md` entry: dashboard-blind audit risk.** The shape of "production behaviour is fine but the audit surface lies" is a class of problem worth a known-issues note so future Director / Builder sessions know to verify with a direct DB query when something "isn't showing up." Director to spec.
- **Consider: `status='success'` on a classifier-Haiku-failed run.** The agent run technically succeeded (it posted the fallback). But the classifier's failure is a real incident-level event. Worth considering whether such runs should land with a non-success status or an explicit anomaly flag so they surface on the dashboard's error counter. Out of scope here; flag for follow-up.

**Not chasing in this pass (spec said don't chase third symptoms):**

- The 7 `haiku_decision IS NULL` passive_monitor rows in 7d — small enough to not investigate today; likely the routed_to_humans / mention-path rows where the decision Haiku is bypassed. Not anomalous.
- `real_author_role` and `real_author_name` are null on the passive-path rows even though `author_type` is populated. The dashboard relies on these via `extractAuthorRole` / `deriveAuthorRoleFromAuthorType` to derive the role pill, so this is fine — but worth noting these fields' nullness is structural (passive path doesn't write them at trigger time), not a bug.

## Side effects

None. Read-only diagnostic. No writes to any cloud table, no migrations, no code paths exercised, no Slack messages posted, no API calls beyond the database SELECTs and the one defensive `git pull origin main`. The throwaway script at `/tmp/run_diag.py` was not committed and is in `/tmp` for natural cleanup.
