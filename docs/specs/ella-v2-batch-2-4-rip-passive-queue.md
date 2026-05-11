# Ella V2 — Batch 2.4: rip the passive-response queue
**Slug:** ella-v2-batch-2-4-rip-passive-queue
**Status:** queued — prerequisite metric pending

## Why this spec exists

Batch 2.3 shipped a queue + per-minute cron + CSM-intervention-check pipeline for passive responses. The design rationale was a 3-5 minute CSM-interjection window — give CSMs a chance to see the client message and respond before Ella does, with the cron's `slack_messages` intervention check cancelling Ella's pending response if a CSM beat her to it.

Post-spec (Drake, 2026-05-11): CSMs are structurally in meetings and don't respond inside any realistic Slack window. The intervention path is theoretical, not real. We dropped the delay constant from 4 minutes to 1 minute in the same conversation, but the queue + cron + intervention check are still in place — they're now buying us essentially nothing while costing real complexity (one extra table, one cron endpoint, ~13 cron tests, a dual-verify migration story, observability load).

This spec rips them out **once production data confirms the intervention path is unused**. Until that data lands, the machinery stays. Acting earlier than the data justifies risks tearing out something that turns out to matter; acting later is fine.

## Prerequisite metric — gate to start this spec

**Do not start this batch until:**

```sql
select count(*)
  from pending_ella_responses
 where status = 'cancelled_csm_intervened';
```

returns **0** after at least:

- 7 calendar days of `ELLA_PASSIVE_MONITORING_ENABLED=true` in production, AND
- ≥3 channels with `slack_channels.passive_monitoring_enabled=true`, AND
- ≥50 total `respond_substantive` or `respond_general_inquiry` decisions persisted (i.e. there has been real traffic that the intervention path could have caught).

If the count is **>0** when this threshold is reached, the intervention path is real and this spec should not ship as-written. Drake reassesses then: either accept the misfire rate as the cost of synchronous response (gut anyway, accept misses), tune the CSM-directed gate harder, or keep the queue and consider the spec retired.

The verification query lives in `docs/runbooks/ella_passive_monitoring.md` § "How to verify the path is flowing" → "CSM intervention counter."

## Context

The Batch 2.3 architecture has three layers:

1. **Decision** (`agents/ella/passive_monitor.py:evaluate_passive_trigger`) — six gates + Haiku call → `PassiveEvaluation` dataclass.
2. **Persistence + side effects** (`agents/ella/passive_dispatch.py:persist_passive_evaluation`) — writes `agent_runs` always; inserts `pending_ella_responses` on `respond_*` decisions; fires backend DM on `escalate`.
3. **Cron drainer** (`api/passive_ella_cron.py`) — every minute, picks due rows, re-checks kill switches + per-channel toggle + CSM-intervention, dispatches generation via `respond_to_passive_trigger` (substantive) or `handle_passive_general_inquiry` (general).

Layer 1 stays in this spec — it's the brains of the operation, irrespective of synchronous vs deferred. Layers 2 and 3 get restructured: instead of "persist a row and let the cron drain it later," the persistence layer dispatches the response inline, in the same execution context as the realtime ingest.

The kill switches stay. The per-channel gate stays. The intervention check goes. The 1-minute delay disappears.

## Acclimatization checklist — confirm before starting

1. **Re-check the prerequisite metric.** Run the SQL above. Confirm count = 0 and the traffic thresholds are met. If not, stop and tell Drake the gate hasn't cleared.
2. **Read `agents/ella/passive_dispatch.py`** — the `_insert_pending` helper and the `respond_substantive` / `respond_general_inquiry` branches of `persist_passive_evaluation` are the seams to dissolve.
3. **Read `api/passive_ella_cron.py`** — the drainer logic gets re-homed into `passive_dispatch.py` (or split between dispatch and `agents/ella/agent.py`'s existing `respond_to_passive_trigger` / `handle_passive_general_inquiry` entry points, which already exist and just need new callers).
4. **Read the existing `respond_to_passive_trigger` + `handle_passive_general_inquiry` in `agents/ella/agent.py`** — these are the response-generation paths the cron currently invokes. After this batch, the dispatch path invokes them directly. The function signatures may need a light refactor: today they take a `pending_ella_responses` row dict; after this batch they take the `PassiveEvaluation` directly (or a thinner intermediate).
5. **Read `tests/agents/ella/test_passive_dispatch.py` and `tests/api/test_passive_ella_cron.py`** — the cron tests largely get deleted; the dispatch tests get restructured around the new synchronous flow.

## Goal

Move passive response generation from "queued + drained by cron" to "synchronous within the realtime-ingest fork." Remove the queue table, the cron, the CSM-intervention check, and the response delay. Keep everything else — the six decision gates, the four-outcome Haiku decision, the kill switches, the escalation DM path, the audit-row writes, the eval dashboard surface.

## What success looks like

### Behavioral change (visible)

- Passive responses post **immediately** after the realtime-ingest fork's Haiku decision, in the same HTTP request as the Slack `message` event delivery. Real-world latency drops from 1-2 min to ~the Haiku + Sonnet generation time (likely 5-20 sec depending on KB context size and Sonnet output length).
- CSMs cannot intervene before Ella responds. This is the explicit trade-off; the prerequisite metric confirms it's a non-trade-off.
- Everything else stays identical: same six gates, same four Haiku outcomes, same escalation DM behavior, same kill switches, same `/ella/runs` audit surface.

### Code changes

**Delete:**

- `api/passive_ella_cron.py` — entire file.
- `tests/api/test_passive_ella_cron.py` — entire file.
- `vercel.json` — remove the `/api/passive_ella_cron` entry from `functions` and the cron schedule entry.
- `pending_ella_responses` table — drop in a new migration (see below).

**Modify:**

- `agents/ella/passive_dispatch.py`:
  - Remove `_insert_pending` helper.
  - Remove `_RESPOND_AFTER_DELAY` constant.
  - In `persist_passive_evaluation`, replace the `respond_substantive` / `respond_general_inquiry` branches' queue-insert with a direct call to `agents.ella.agent.respond_to_passive_trigger(evaluation)` or `agents.ella.agent.handle_passive_general_inquiry(evaluation)` (signature refactor — see below).
  - Update the agent_run output_summary to reflect the immediate post (e.g., `"posted substantively; ts=<slack_ts>"` instead of `"queued (...); pending_id=<uuid>"`).
- `agents/ella/agent.py`:
  - `respond_to_passive_trigger` signature changes from `(pending_row: dict)` to `(evaluation: PassiveEvaluation)`. The function reconstructs the synthetic event from `evaluation.payload` instead of from the pending row.
  - `handle_passive_general_inquiry` similarly takes the `PassiveEvaluation`.
  - Both functions return the same shape they do today; only the input changes.
- `tests/agents/ella/test_passive_dispatch.py`:
  - Tests that asserted on `pending_ella_responses` row insertion get rewritten to assert on the immediate Slack post + agent_runs row outputs.
  - Add tests confirming the dispatch path posts inline rather than queueing.
- `lib/supabase/types.ts`:
  - Remove `pending_ella_responses` table types.

**Add:**

- Migration `00XX_drop_pending_ella_responses.sql` — `DROP TABLE pending_ella_responses;`. Note: the table likely has rows from the 1-min-delay-era. The migration should be safe — none of those rows represent un-posted responses since the cron drains within ~60s of `respond_after_ts`. But before applying, confirm: `SELECT count(*) FROM pending_ella_responses WHERE status = 'queued';` returns 0. **Hard stop if any rows are still queued at migration time** — drain them first by running the cron one last time, then apply.

### Risk: ingest fork latency blowing up

The realtime-ingest fork currently does: ingest the message, then fire the passive monitor (Haiku call). Adding synchronous response generation means: ingest the message, fire Haiku, fire Sonnet generation, post to Slack — all inside the Slack Events API webhook's 3-second response window.

This is the single most important constraint to check during build. Slack's Events API expects the webhook to return 200 within 3 seconds. Today the passive monitor is fail-soft and runs after the ingest; if the Haiku call takes longer than the remaining budget, the webhook can miss the SLA. Today's design handled this by deferring response generation to the cron. After this batch, generation runs inline.

**Mitigation paths** (Builder picks one and surfaces the choice in the report):

1. **Move passive monitoring to a background thread / async dispatch.** Vercel Python runtimes support `threading.Thread`; spawn the response generation in a thread, return the webhook 200 immediately. The thread completes within the function's `maxDuration` (already 60s for the events endpoint). Risk: if the function exits before the thread finishes (Vercel's lifecycle), the response gets dropped. Worth checking how `api/slack_events.py` handles this today for `respond_to_mention` — if it's already doing thread-based dispatch for the reactive path, mirror that pattern.
2. **Keep the realtime ingest synchronous, accept slightly higher Slack webhook latency.** Sonnet generation is typically 5-15 seconds; if the function's maxDuration allows it, this might just work. Slack's 3-second SLA isn't a hard ban — they retry after 3 seconds, which creates duplicate processing risk (already mitigated by the `(slack_channel_id, ts)` idempotency on `slack_messages`). Worst case: Ella posts twice (caught by the `(slack_channel_id, triggering_message_ts)` idempotency on a new mechanism we'd need to add).
3. **A hybrid: synchronous for the Haiku decision + escalation DM (cheap), background thread only for substantive Sonnet generation (the expensive part).** Probably the cleanest.

Builder evaluates how `api/slack_events.py` already handles this for `_process_mention` (which also does Sonnet generation) — reuse the same pattern. The reactive @-mention path has been running in production for months without webhook SLA issues, so whatever it does works.

### Schema migration

```sql
-- Migration: drop pending_ella_responses table.
-- Pre-apply check: confirm zero queued rows. Drain via one final cron
-- run before applying if needed.

drop index if exists pending_ella_responses_due_idx;
drop table if exists pending_ella_responses;
```

The table also has an `agent_run_id` foreign key into `agent_runs`. Dropping the table doesn't affect `agent_runs` rows — the FK is one-way (pending → runs, not runs → pending). Historical agent_runs with `trigger_type='passive_monitor'` retain their data forever; only the queue rows go.

### Vercel config changes

Remove from `vercel.json`:

- The `/api/passive_ella_cron` entry in `functions` (with its `maxDuration: 60`).
- The cron schedule entry pointing at `/api/passive_ella_cron`.

Function count drops from 9 to 8. Update `CLAUDE.md` § Hosting accordingly.

## Hard stops

- **Prerequisite metric not cleared.** If `count(*) FROM pending_ella_responses WHERE status = 'cancelled_csm_intervened'` returns > 0 at spec start, stop and tell Drake. This is the explicit gate that justifies the spec.
- **Slack webhook SLA risk not resolved.** Builder must pick a mitigation path (background thread, accept higher latency, hybrid) and verify against the existing reactive @-mention path's behavior before shipping. If the reactive path uses a pattern that can't be reused, surface and pause.
- **`pending_ella_responses` not empty at migration time.** Drain first via one final cron run before applying the DROP TABLE.
- **Test suite not green post-refactor.** The 13 cron tests get deleted, the 6 dispatch tests get restructured. Net test count may drop by ~5-10. Confirm the remaining suite passes and that the synchronous flow is covered as thoroughly as the deferred flow was.

## What could go wrong

- **Sonnet latency exceeds Slack's 3-second webhook SLA.** Covered above — background thread is the standard mitigation. The reactive @-mention path is the reference implementation; mirror it.
- **Mid-flight responses during migration.** If you ship the synchronous path while old queued rows still exist, the cron deletion strands them. Sequence the changes: drain queue first (one final cron run after global kill switch flip to drain everything cleanly), then apply migration, then ship code.
- **Lost observability.** The pending-queue depth was a useful operational signal. After this batch, the only observability is `agent_runs` rows + `webhook_deliveries` audit rows. Builder confirms the `/ella/runs` dashboard still surfaces decision counts + outcome distribution adequately for ongoing iteration.
- **The CSM-intervention metric retroactively becomes useful.** If we ever roll passive monitoring to a channel where a CSM IS structurally watchful (e.g., a high-touch enterprise account), the intervention path mattered. Mitigation: this spec's prerequisite metric is workspace-wide, not per-channel. If a future per-channel rollout introduces a watchful-CSM channel, reassess before enabling passive monitoring there.

## Mandatory doc updates

- **`docs/runbooks/ella_passive_monitoring.md`** — rewrite the "Pipeline" section (synchronous now), remove the cron failure mode section, remove the queue-depth verification queries, remove the "CSM intervention counter" section (it's why we got here; doesn't apply going forward).
- **`docs/agents/ella/ella.md`** — update the Trigger section to remove the delay language, note responses post immediately.
- **`docs/schema/pending_ella_responses.md`** — delete the file.
- **`CLAUDE.md`** — § Live System State updated to reflect the simpler architecture; § Hosting paragraph function count + cron list updated.
- **`docs/known-issues.md`** — remove the "Passive Haiku prompt — thresholds + categories will need iteration" entry if it's been satisfied by then; otherwise carry forward.

## Commit shape

1. `migration: drop pending_ella_responses table`
2. `refactor(ella-passive): move dispatch to synchronous; remove queue logic`
3. `refactor(ella-passive): respond_to_passive_trigger + handle_passive_general_inquiry take PassiveEvaluation`
4. `chore: delete api/passive_ella_cron.py + its tests; remove cron from vercel.json`
5. `chore: types.ts removes pending_ella_responses`
6. `docs: runbook + ella.md + CLAUDE.md updated for synchronous flow; delete pending_ella_responses.md`
7. Final report commit.

Report at `docs/reports/ella-v2-batch-2-4-rip-passive-queue.md` per the spec/report convention. The report should explicitly state the prerequisite metric value at spec-start time and at ship time.
