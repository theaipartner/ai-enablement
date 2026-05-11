# Ella V2 — Batch 2.3: passive monitoring
**Slug:** ella-v2-batch-2-3-passive-monitoring
**Status:** in-flight

## Context

Ella V2 has shipped reactively to date — she responds when @-mentioned (bot or human Ella account, post Batch 1.5 dual-trigger). Batch 2.3 flips the architecture: Ella passively monitors every client message in every passive-monitoring-enabled channel, decides whether to respond, and acts on a 3-5 minute delay so CSMs can interject first.

This is the headline Ella V2 deliverable. It expands surface area substantially — a new agent module, a new cron, a new queue table, two schema migrations, behavioral additions to the existing reactive flow, and operational kill switches. The default-stance is **stay out**: when in doubt, skip silently and let the audit dashboard (`/ella/runs`, Batch 2.2) surface what was missed.

**What's already in place that this spec leans on:**
- Realtime ingestion via `ingestion/slack/realtime_ingest.py:ingest_message_event` is the fork point. Every `message` event already lands here, gated on channel-allowlist + subtype. Passive-monitoring branch attaches *after* successful ingest, before return.
- `slack_messages` is the source of truth for channel history. Index `slack_messages_channel_sent_at_idx` makes the CSM-intervention check (described below) one fast indexed query.
- `agent_runs` carries `trigger_metadata jsonb` — Haiku decision + reasoning land here, no schema change needed for the audit dashboard to start populating (Batch 2.2 already renders the column).
- `slack_channels.ella_enabled` is a dormant boolean from migration 0002. **This spec renames it to `passive_monitoring_enabled`.** Same semantic intent (gate Ella's behavior per-channel), updated for V2 reality.
- `escalations` table handles the escalation outcome. Existing `context jsonb` carries the new `triggering_message_link` + `haiku_reasoning` fields without schema change.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. **The ingestion fork point** — read `ingestion/slack/realtime_ingest.py:ingest_message_event` end-to-end. Confirm where to attach the passive-monitor dispatch (after the upsert + audit row, before the return). Confirm the fail-soft pattern (any exception is caught, audited, never propagated).
2. **The reactive agent entry** — read `agents/ella/agent.py:respond_to_mention`. The four-outcome decision pipeline in this spec eventually converges on the same `_call_claude` path for `respond_substantive`. Confirm the speaker-resolution + channel-client + retrieval shape so the passive path can reuse them.
3. **`slack_channels` + `slack_messages` schemas** — `slack_channels.ella_enabled` exists (default false, indexed). `slack_messages_channel_sent_at_idx` exists. Confirm the CSM-intervention query plan: `WHERE slack_channel_id=$1 AND sent_at > $2 AND author_type IN ('team_member','ella') AND slack_user_id != $3` uses the index.
4. **`agent_runs` + `escalations`** — confirm `trigger_metadata jsonb` is the right place for `haiku_decision` + `haiku_reasoning` (precedent: Batch 1.5 stashed `real_author_role/name/id` in `trigger_metadata`). Confirm `escalations.context jsonb` accepts arbitrary keys (no CHECK on shape).
5. **`shared/claude_client.py`** — confirm the model-string handling. Haiku model identifier (`claude-haiku-4-5-20251001` per product self-knowledge) needs to be a separately-configurable model from the default Sonnet that `_call_claude` uses today. Confirm `complete()` accepts a `model=` override OR add a thin Haiku-specific wrapper.

## Goal

Ship passive monitoring end-to-end, behind dual kill switches, with the explicit guardrails:

- **Default-stance is stay out.** Every uncertain case skips silently. Misfiring is more costly than missing.
- **CSMs have a 3-5 min window to interject** before Ella responds. Intervention check via `slack_messages` table read (NOT a Slack API call).
- **Decision-vs-generation model split.** Haiku for "should I respond at all"; Sonnet only for the actual response text on `respond_substantive`.
- **CSM-directed messages auto-skip.** Any message addressed to a CSM by name or @-mention bypasses the response pipeline regardless of content.
- **Firm-after-first.** Once Ella has substantively responded + escalated on a topic, she does not re-engage substantively on follow-ups for the same topic. She routes harder ("worth picking this up with Scott directly").
- **Both kill switches are live from day one.** Global env var + per-channel boolean. Default is OFF per-channel — rollout is deliberate.

## What success looks like

### Trigger pipeline (in `ingestion/slack/realtime_ingest.py`)

After the existing ingest succeeds for a client-category message in a `passive_monitoring_enabled=true` channel:

1. **Global kill switch.** If env var `ELLA_PASSIVE_MONITORING_ENABLED != 'true'`, skip silently. No audit row beyond the existing ingest one. Log line at INFO with `skip_reason='global_kill_switch'`.
2. **Author-type gate.** Only `author_type='client'` triggers passive monitoring. Skip team_member / ella / bot / workflow / unknown. (CSMs and Ella herself don't trigger; existing reactive @-mention paths handle CSM @-Ella).
3. **CSM-directed auto-skip.** Parse the message text for `<@U...>` mentions where `U...` resolves to a `team_members.slack_user_id`, OR for first-name matches against the channel's primary_csm full_name. If found, skip with `decision='skip_csm_directed'` logged on the passive `agent_runs` row. The Haiku call is NOT made — this is a pre-Haiku cheap gate. (Reason: messages addressed to a CSM by name are unambiguously not for Ella; spending Haiku tokens to confirm that is waste.)
4. **KB-relevance gate.** Cheap vector search via `shared/kb_query.py` against the channel-mapped client's scope. If zero results above the relevance threshold (Builder picks a sensible default — likely cosine similarity > 0.3 or whatever `kb_query` exposes as a baseline), skip with `decision='skip_no_kb_match'`. Threshold is configurable via env var `ELLA_PASSIVE_KB_RELEVANCE_THRESHOLD` (default Builder-chosen).
5. **Firm-after-first gate.** Query `agent_runs` for the most recent `respond_substantive`-decision Ella run in this channel within the last 7 days that resulted in an escalation. If one exists AND the new message's topic appears related (see implementation note below), skip with `decision='skip_firm_after_first'`. Implementation note: V1 of this check is keyword-overlap against the prior escalation's `handoff_reasoning` + the new message. Don't over-engineer — if 3+ content words overlap, treat as related. Iterate from production data.
6. **Haiku decision call.** Call `claude-haiku-4-5-20251001` with a tight prompt (see § Haiku prompt design below) that returns one of four outcomes:
   - `respond_substantive` — full Sonnet generation with KB context, queued for delayed response
   - `respond_general_inquiry` — canned warm response from a randomized opener list, queued for delayed response (no Sonnet)
   - `skip` — ingest only, no response. Decision + reasoning logged.
   - `escalate` — no client-facing response. Backend DM to the channel's primary CSM with a link to the triggering Slack message (NO quoted content). Decision + reasoning logged.
7. **Persist decision.** Open an `agent_runs` row with `agent_name='ella'`, `trigger_type='passive_monitor'`, `trigger_metadata.haiku_decision=<outcome>`, `trigger_metadata.haiku_reasoning=<text>`, `trigger_metadata.triggering_message_ts`, `trigger_metadata.triggering_slack_channel_id`. Status is terminal (`success` for skip/escalate; `success` for respond outcomes — the response itself is a separate `agent_runs` row created by the cron when it generates).
8. **For respond_* outcomes:** insert a row into `pending_ella_responses` with `respond_after_ts = now() + interval '4 minutes'` (Builder's call within 3-5 min window; suggest 4 min as midpoint). Status `queued`.
9. **For escalate outcome:** DM the primary_csm. Use `shared/slack_post.py`. Message shape: `:eyes: Worth a look — <link_to_triggering_message>\n_Ella decided to escalate rather than respond. Reasoning: <haiku_reasoning truncated to ~200 chars>._` No quoted message content. Audit via `webhook_deliveries.source='ella_passive_escalation_dm'`.

### Delayed-response cron (new file `api/passive_ella_cron.py`)

Runs every minute via Vercel Cron. Per-invocation logic:

1. **Auth.** Validate `Authorization: Bearer ${CRON_SECRET}` header (existing pattern from `api/fathom_backfill.py`, `api/gregory_brain_cron.py`, `api/accountability_notification_cron.py`). Return 401 on mismatch.
2. **Pick due rows.** `SELECT * FROM pending_ella_responses WHERE status='queued' AND respond_after_ts <= now() ORDER BY respond_after_ts ASC LIMIT 50`. The limit protects against runaway backlogs.
3. **Per-row processing:**
   - **Re-check global kill switch.** `ELLA_PASSIVE_MONITORING_ENABLED != 'true'` → mark row `status='cancelled_kill_switch'`, skip.
   - **Re-check per-channel gate.** `slack_channels.passive_monitoring_enabled` for the row's channel. False → `status='cancelled_channel_disabled'`, skip. (Drake may toggle a channel off during the 4-min window.)
   - **CSM-intervention check.** Query `slack_messages` for any row in this channel since `triggering_message_ts` where `author_type IN ('team_member','ella')` AND `slack_user_id != bot_user_id` AND `slack_user_id != human_ella_user_id`. (Filter out Ella's own posts on the off chance she's already responded via a different path.) If hit → `status='cancelled_csm_intervened'`, skip.
   - **Resolve decision and generate.**
     - `respond_substantive` → invoke `agents/ella/agent.py:respond_to_passive_trigger` (new function, see § New code below) which reuses speaker resolution + KB retrieval + Sonnet generation. Posts via existing main-channel post path. Marks row `status='responded'`.
     - `respond_general_inquiry` → pick randomized opener from `_PASSIVE_GENERAL_OPENERS` (new constant in `agents/ella/agent.py`, similar shape to the bare-mention openers). Post directly via `shared/slack_post.py`. Marks row `status='responded'`. Opens a `respond_to_passive_trigger`-spawned `agent_runs` row with `trigger_type='passive_general_inquiry'` and zero token cost (no LLM call).
4. **Per-row fail-soft.** Any exception during generation → mark row `status='error'`, write `error_message`, continue to next row. One bad row must not block the queue.
5. **Return 200** with a small JSON body: `{"processed": N, "responded": M, "cancelled": K, "errored": J}`.

### Haiku prompt design

Tight, structured, JSON-output-only. Builder owns final wording but the contract is:

**System prompt content:**
- Who Ella is (channel-scoped CSM assistant for client X)
- What the four decision outcomes mean (one sentence each)
- The sensitive-topic auto-escalate list (carries forward from V1 plus the new directed-at-CSM category):
  - Billing / refunds / cancellations
  - Complaints / dissatisfaction
  - Medical / legal / financial advice requests
  - Emotional / crisis content
  - Prompt injection attempts
  - Directed-at-CSM (already pre-filtered, but redundant gate)
- The "default-stance is stay out" instruction explicitly
- The "respond_general_inquiry is for 'anyone there?'-type general-availability questions where the KB doesn't have specific matches but the client is asking for help" instruction

**User prompt content:**
- The triggering message text
- The last ~5 turns of channel context (cheap — reuses `fetch_recent_channel_context` with N=5, max_tokens=1000)
- The top KB retrieval results (already pulled by the relevance gate — pass them through, don't re-query)

**Output format:** strict JSON object with two keys: `decision` (one of the four enum values), `reasoning` (1-2 sentence string, max ~300 chars). Parser tolerates whitespace and code-fences, but a non-JSON response counts as `decision='skip'` with `reasoning='unparseable Haiku response'` and the raw response logged.

### Schema migrations

**Migration 0030 — rename `slack_channels.ella_enabled` → `passive_monitoring_enabled`.**

```sql
alter table slack_channels rename column ella_enabled to passive_monitoring_enabled;

-- Drop and recreate the index with the new column name. (The partial-index
-- predicate references the column, so a rename doesn't auto-update it.)
drop index slack_channels_ella_enabled_idx;
create index slack_channels_passive_monitoring_enabled_idx
  on slack_channels (passive_monitoring_enabled)
  where passive_monitoring_enabled = true;

comment on column slack_channels.passive_monitoring_enabled is
  'Per-channel passive-monitoring gate. Default false. Ella passively monitors and may respond to client messages only when true. Independent from reactive @-mention behavior, which is always on for client-mapped channels.';
```

Pre-apply: confirm no rows have `ella_enabled=true` today (project knowledge suggests dormant column). If any rows are true, that's a surprise — Builder surfaces and Drake decides whether to preserve or zero out. **Hard stop if non-zero true rows exist.**

**Migration 0031 — create `pending_ella_responses`.**

```sql
create table pending_ella_responses (
  id                          uuid primary key default gen_random_uuid(),
  agent_run_id                uuid not null references agent_runs(id),
  slack_channel_id            text not null,
  triggering_message_ts       text not null,
  triggering_message_slack_user_id text not null,
  haiku_decision              text not null check (haiku_decision in ('respond_substantive','respond_general_inquiry')),
  haiku_reasoning             text,
  respond_after_ts            timestamptz not null,
  status                      text not null default 'queued'
                              check (status in (
                                'queued','responded','cancelled_csm_intervened',
                                'cancelled_kill_switch','cancelled_channel_disabled','error'
                              )),
  error_message               text,
  created_at                  timestamptz not null default now(),
  responded_at                timestamptz,
  unique (slack_channel_id, triggering_message_ts)
);

create index pending_ella_responses_due_idx
  on pending_ella_responses (respond_after_ts)
  where status = 'queued';

comment on table pending_ella_responses is
  'Queue of pending Ella passive-monitoring responses. Inserted by the realtime-ingest passive-monitor branch when Haiku decides respond_substantive or respond_general_inquiry. Drained by api/passive_ella_cron.py every minute.';
```

The `(slack_channel_id, triggering_message_ts)` unique constraint protects against duplicate inserts if the same message somehow re-fires the passive monitor (e.g., a `message_changed` event for the same ts — though the realtime ingest layer already handles that case, the unique is defense-in-depth).

Note: only `respond_*` decisions persist here. `skip` and `escalate` outcomes do NOT write to this table — they're recorded on the `agent_runs` row and (for escalate) the DM is fired synchronously inside the ingest path.

### New code

**`agents/ella/passive_monitor.py`** (new module):
- `decide_passive_response(triggering_message, channel_client, recent_context, kb_results)` → returns a `PassiveDecision` dataclass with `decision` (str enum), `reasoning` (str), `haiku_cost_usd` (Decimal), `haiku_tokens_in` (int), `haiku_tokens_out` (int).
- Owns the Haiku prompt construction + JSON parse + fail-soft.
- Pre-Haiku gates (CSM-directed check, KB-relevance check, firm-after-first check) live in this module too as helper functions, so the realtime-ingest fork point can call one `evaluate_passive_trigger(payload)` entry point.
- `evaluate_passive_trigger(payload)` — the single entry point the ingest fork calls. Returns a `PassiveEvaluation` dataclass with the chosen action, all metadata needed to write the `agent_runs` row and (if applicable) the `pending_ella_responses` row.

**`api/passive_ella_cron.py`** (new endpoint, `maxDuration: 60`):
- HTTP handler matching the existing cron pattern (`api/accountability_notification_cron.py` is the cleanest reference).
- Auth via `CRON_SECRET`.
- Logic per § Delayed-response cron above.

**Additions to `agents/ella/agent.py`:**
- `respond_to_passive_trigger(pending_row)` — new entry point that reuses speaker resolution + channel-client lookup + KB retrieval + Sonnet generation. Mirrors `respond_to_mention` shape but with `trigger_type='passive_substantive'` on the agent_runs row. Posts via existing main-channel path. The function signature takes the `pending_ella_responses` row dict; it reconstructs the synthetic event needed for downstream code.
- `_PASSIVE_GENERAL_OPENERS` constant — randomized list of 4-6 warm openers, e.g. `"Hey {name} — I'm around, what's going on?"`, `"Hi {name}, what do you need?"`. Reuses `{name}` placeholder pattern from bare-mention handler.
- `_handle_passive_general_inquiry(pending_row)` — picks an opener, posts, opens + closes an `agent_runs` row with zero LLM cost.

**Additions to `ingestion/slack/realtime_ingest.py`:**
- After the existing ingest succeeds, add a fork: if author_type='client' AND channel's `passive_monitoring_enabled=true` AND global kill switch on → call `agents.ella.passive_monitor.evaluate_passive_trigger(payload)`. Fail-soft: any exception is logged + audited (new `webhook_deliveries.source='ella_passive_monitor_error'`), never propagated. The ingest itself must always succeed regardless of passive-monitor outcome.

**Additions to `agents/ella/prompts.py`:**
- A new prompt instruction in the existing `respond_to_mention` Sonnet system prompt (NOT the passive Haiku prompt) telling Ella to check the recent-channel-context for her own prior escalations on the same topic, and if found, to route harder ("worth picking this up with Scott directly") rather than re-engage substantively. **This addition affects both reactive AND passive substantive responses** since they converge on the same Sonnet path. Prompt-level only; the gate-level check earlier in the trigger pipeline catches the strict cases.

**Additions to `lib/supabase/types.ts`:**
- Per the standing followup, this file is hand-edited. Add `pending_ella_responses` table types + update `slack_channels` to rename the column. Builder writes the hand-edit; same commit as the migration apply.

### Vercel cron config

Add to `vercel.json`:

```json
{
  "path": "/api/passive_ella_cron",
  "schedule": "* * * * *"
}
```

Per-minute schedule. The 50-row LIMIT in the cron protects against pathological backlogs.

### `vercel.json` functions block

Add `api/passive_ella_cron.py` with `maxDuration: 60`. Matches the existing pattern.

### Env vars (Drake's gate (d))

New env vars Drake adds to Vercel (and `.env.local` for local testing):

- `ELLA_PASSIVE_MONITORING_ENABLED` — `'true'` to enable globally, anything else (or unset) disables. Default to unset in production at first ship; Drake flips after first verification.
- `ELLA_PASSIVE_KB_RELEVANCE_THRESHOLD` — optional. Builder picks a sensible default in code if unset.

`CRON_SECRET` already exists and is reused.

## Hard stops

- **Migration apply (0030 + 0031)** — Drake reviews the SQL before apply. Both migrations together; one push, one review.
- **`ELLA_PASSIVE_MONITORING_ENABLED` and channel-level toggle setting** — Drake's gate (d). Builder ships with both OFF; Drake flips after deploy + smoke-test confirms the path is wired.
- **If migration 0030 reveals `slack_channels.ella_enabled = true` for any row** — Builder stops, surfaces the count + the rows. Drake decides whether to preserve those rows' state under the new column or zero them out before applying.
- **If the channel-context query for the firm-after-first check or the recent-context fetch takes >500ms in single-row testing** — Builder stops and surfaces. Suggests an index addition or query simplification rather than shipping a slow path.
- **No `[ESCALATE]` token in passive Haiku output.** Haiku decisions are structured JSON; the `[ESCALATE]` reactive convention does NOT apply to the passive flow. If the Haiku ever emits `[ESCALATE]` in its reasoning, that's a prompt bug — Builder catches in tests.
- **No mass-rollout** — even with the kill switch + per-channel toggle in place, the spec ships with every channel `passive_monitoring_enabled=false`. Drake enables `#ella-test-drakeonly` first for validation. Production rollout to other channels is post-validation work, not in this spec.

## What could go wrong

Think this through yourself:

- **Race condition: client message + CSM response within 30 seconds.** The CSM responds at minute 0.5, Ella's queue row fires at minute 4, the intervention check picks up the CSM's message and cancels. Working as designed. The only edge case: CSM responds in *thread* rather than main channel — does our intervention check see thread responses? `slack_messages` ingests thread messages (verified — `slack_thread_ts` column exists). The check should include thread responses too, not just main-channel. **Builder: confirm the query includes thread replies in the same channel; if not, broaden the check.**
- **Haiku JSON parse failure.** Cheap LLMs go off-format occasionally. Per spec, unparseable → treat as `skip`. Don't retry — adds cost, doesn't fix structural prompt issues. Iterate the prompt instead.
- **Firm-after-first false positives.** Keyword-overlap is crude. A second message on the same topic from a *different* angle ("ok but what about the discount") might get auto-routed when Ella could have helped. Acceptance: V1 is keyword-overlap; iterate from observed misses on the audit dashboard.
- **Sensitive-topic miss.** The Haiku prompt enumerates the list, but Haiku may not catch all phrasings (e.g., emotional content phrased flatly). Mitigation: the audit dashboard flags lets Drake review post-hoc; iterate the prompt.
- **CSM-directed gate false positives.** A client mentioning a CSM by first name as part of a substantive question ("did Scott say the deadline was Friday?") gets auto-skipped. Acceptable — better to over-skip than misfire on a question that should have gone to the CSM anyway.
- **Cron backlog.** If something breaks for an hour, 60 minutes × 50 max rows/minute = up to 3000 backed-up rows. The kill switch makes them all `cancelled_kill_switch` cleanly. Without the kill switch, draining a 3000-row backlog at 50/min = 60 minutes of catch-up traffic. Probably fine, but Builder should add a comment in the cron handler noting this and the kill-switch recovery path.
- **The dormant `ella_enabled` column.** Confirm via project knowledge / GitHub MCP that no code reads it today before renaming. If Batch 1.5 or any older code branches on it, the rename breaks them. (Cross-check spec confirmation: the Batch 1.5 spec explicitly says "no migration to add an ella_enabled gate" so no code should be reading it.)
- **Vercel cron quotas.** Per-minute is the most aggressive Vercel Cron schedule allowed on Pro. Confirm during build that the project plan supports it. If not, fallback is 5-minute cadence (delay window becomes 8-10 min instead of 3-5; document and surface to Drake).
- **The `agent_runs.trigger_metadata` jsonb filter for firm-after-first.** Querying recent passive Ella runs in a specific channel via `trigger_metadata->>'triggering_slack_channel_id'` is a jsonb-key filter without an index. Today's scale (~0 passive runs at ship) makes this trivial; at 100+ passive runs/day per channel it grows. Mirror the existing followup in `docs/known-issues.md` § "Index on agent_runs trigger_metadata.client_id when ai_call_signal volume grows" — add a similar entry for the passive-monitor field at ship time, NOT a migration in this spec.

## Mandatory doc updates

- **`docs/agents/ella/ella.md`** — significant updates:
  - § Behavior Specification § Trigger — add the passive-monitoring trigger alongside the reactive @-mention. State the four-outcome Haiku decision explicitly.
  - § Response Location — add: passive substantive responses post to main channel (same as reactive); passive general-inquiry responses post to main channel; passive escalations are backend DMs to the primary_csm, no client-facing post.
  - § Confidence-Based Routing — add a § "Firm-after-first" subsection describing the gate behavior.
  - § System Prompt Direction — add the firm-after-first instruction as a new numbered point.
  - § Eval Criteria — note that the four Haiku decision outcomes will need their own eval coverage once production data exists. No eval shipped in this batch.
- **`docs/schema/slack_channels.md`** — rename `ella_enabled` → `passive_monitoring_enabled` everywhere; update the description to match the new semantics.
- **New `docs/schema/pending_ella_responses.md`** — purpose, columns, relationships, populated by, read by, example queries. Match the shape of existing schema docs.
- **`docs/runbooks/ella_passive_monitoring.md`** — new runbook covering: what passive monitoring is, how to enable/disable globally (env var) and per-channel (UPDATE), how to verify it's flowing (queries against `agent_runs WHERE trigger_type LIKE 'passive_%'`), failure modes (cron not firing, Haiku parse failures, kill-switch toggling mid-flight), and the recovery procedure if the queue backs up.
- **`docs/agents/ella/future-ideas.md`** — mark the existing "Per-channel ella_enabled beta gating" entry as superseded/completed (the column now exists *and* is read).
- **`CLAUDE.md` § Live System State** — append a Batch 2.3 entry. Suggested wording (Builder tightens):
  > Ella V2 Batch 2.3 — passive monitoring (shipped <date>). Passive trigger pipeline in `ingestion/slack/realtime_ingest.py` forks to `agents/ella/passive_monitor.py:evaluate_passive_trigger` for every client message in a `slack_channels.passive_monitoring_enabled=true` channel. Pre-Haiku gates (CSM-directed, KB-relevance, firm-after-first) cheap-skip; Haiku decides one of `respond_substantive / respond_general_inquiry / skip / escalate`. Respond decisions queue to new `pending_ella_responses` table with 4-min delay; new per-minute Vercel cron at `/api/passive_ella_cron` drains the queue, runs CSM-intervention check via `slack_messages` table read, generates with Sonnet on substantive path. Escalations are backend DMs to primary_csm with link-only (no quoted content). Migrations 0030 (rename `slack_channels.ella_enabled` → `passive_monitoring_enabled`) + 0031 (create `pending_ella_responses`). Dual kill switches — env var `ELLA_PASSIVE_MONITORING_ENABLED` + per-channel boolean — both default OFF at ship; Drake enables `#ella-test-drakeonly` first.
- **`CLAUDE.md` § Stack table** — add the per-minute cron to the Vercel Cron list.
- **`docs/known-issues.md`** — Builder logs follow-ups encountered during build. At minimum, log: (a) the `trigger_metadata.triggering_slack_channel_id` jsonb-filter performance note (mirrors the existing `ai_call_signal` entry), (b) any threshold/prompt iterations expected as production data lands.

## Commit + report

Per CLAUDE.md § Commits: one logical change per commit. Suggested commit shape:

1. `migration: rename slack_channels.ella_enabled to passive_monitoring_enabled`
2. `migration: create pending_ella_responses queue table`
3. `feat(ella-passive): new agents/ella/passive_monitor.py decision module`
4. `feat(ella-passive): wire passive-monitor fork in realtime_ingest`
5. `feat(ella-passive): add respond_to_passive_trigger + passive openers in agent.py`
6. `feat(ella-passive): add api/passive_ella_cron.py minute-cron`
7. `feat(ella-passive): firm-after-first prompt addition in prompts.py`
8. `chore: vercel.json — register passive cron + maxDuration`
9. `chore: hand-edit lib/supabase/types.ts for new schema`
10. `docs: ella.md + slack_channels.md + pending_ella_responses.md + runbook + future-ideas + CLAUDE.md + known-issues`
11. Final report commit.

If commits split further sensibly, let them. The principle is one logical change per commit. Tests land alongside the code commits they cover.

Report at `docs/reports/ella-v2-batch-2-3-passive-monitoring.md` per the spec/report convention.

After report lands, Drake validates: (1) deploys, (2) confirms cron is registered in Vercel dashboard, (3) flips `ELLA_PASSIVE_MONITORING_ENABLED=true` and `slack_channels.passive_monitoring_enabled=true` for `#ella-test-drakeonly` only, (4) tests a client-shaped message in the test channel and confirms via `/ella/runs` that the Haiku decision lands correctly + the response (if applicable) posts after the delay. Drake's gate (c).
