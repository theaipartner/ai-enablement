# Runbook: Ella passive monitoring

Operational guide for Ella V2 Batch 2.3 passive monitoring. Covers what it is, how to enable / disable, how to verify the path is flowing, and the failure / recovery procedures.

## What it is

Passive monitoring flips Ella from "reactive only" (responds when @-mentioned) to "passively observing every client message in passive-monitoring-enabled channels, deciding whether to respond, and acting on a 1-minute delay." (Original spec wrote this as a 3-5 min CSM-interjection window; Drake's 2026-05-11 call dropped the delay to 1 min because CSMs are structurally in meetings and don't respond inside any realistic window. The queue + cron + intervention-check machinery stays in place pending production data; if `cancelled_csm_intervened` stays at ~0 after meaningful traffic, Batch 2.4 will rip the queue and move to synchronous response from the ingest fork.)

Pipeline (one entry per client-authored message):

1. **Realtime ingest** (`ingestion/slack/realtime_ingest.py`) — every Slack `message` event lands here (the `app_mention` event is a logged no-op; the parallel `message` event is the ONE evaluation path — @-mentions included). The fork calls `detect_at_mentions` (parses every `<@U...>` mention, returns `is_ella_mentioned` + `is_routed_to_others`) and threads both booleans through `PassiveTriggerPayload`.
2. **Decision** (`agents/ella/passive_monitor.py:evaluate_passive_trigger`) — **two-path dispatch (structural override, 2026-05-19 PM):** three pre-LLM gates run once — (1) global kill switch, (2) author-type (`client` + `team_member` always evaluated; `ella`/`bot`/`workflow`/`unknown` skip *with* an audit row), (3) routed-to-humans (added 2026-05-20: when `is_routed_to_others=True`, skip pre-LLM with `skip_reason='routed_to_humans'` + `digest_flag=True` + `digest_category='other'` — the dispatch writes the audit row + the digest item; no DB fetch, no Haiku call, no in-channel ack, no DM fan-out). Then KB vector search + recent-context fetch + speaker resolve, then **branch on `payload.is_ella_mentioned`:**
   - **`true` → CLASSIFIER PATH.** `agents.ella.mention_classifier.classify_mention_response` picks one of four shapes: `respond_haiku` / `respond_sonnet` / `acknowledge_and_escalate` / `warm_opener`. **`skip` is structurally absent from the enum** (the structural fix after three failed prompt iterations — `docs/specs/ella-at-mention-structural-override.md`). Result lands on `PassiveEvaluation.mention_classification`.
   - **`false` → DECISION HAIKU PATH.** `decide_passive_response` returns `respond` (+`response_model: haiku|sonnet`) / `acknowledge_and_escalate` (+`ack_text`) / `skip`, plus independent `digest_flag`/`digest_category`. CSM-directed / KB-relevance / firm-after-first are soft prompt rules, not gates.
3. **Persistence + side effects** (`agents/ella/passive_dispatch.py:persist_passive_evaluation`) — branches on `evaluation.mention_classification`:
   - `skip_reason='kill_switch'` → **no `agent_runs` row at all**. `skip_reason='non_human_author'` → audit row written.
   - **Mention path** (`_dispatch_mention`, classifier handled):
     - `respond_haiku` → response Haiku posts directly.
     - `respond_sonnet` → `pending_ella_responses` row with the `respond_substantive` shim for the unchanged cron.
     - `acknowledge_and_escalate` → post `ack_text`, write `escalations` row, fan DMs to Scott + primary advisor, write `pending_digest_items`. `status='escalated'`.
     - `warm_opener` → `digest_response.generate_response(mode='warm_opener')` writes a 1-sentence invite + posts.
     - `trigger_metadata.mention_classifier_shape` is set (not `haiku_decision`).
   - **Decision Haiku path** (non-mention):
     - `respond` + `response_model='haiku'` → response Haiku posts directly.
     - `respond` + `response_model='sonnet'` → `pending_ella_responses` row (`haiku_decision='respond_substantive'`, +1 min).
     - `acknowledge_and_escalate` → posts ack, writes `escalations` row, fans DMs, writes digest item. `status='escalated'`.
     - `skip` → nothing further (a `pending_digest_items` row too if `digest_flag=true`).
     - `trigger_metadata.haiku_decision` is set (not `mention_classifier_shape`).
   - Independent of path: any `digest_flag=true` writes a `pending_digest_items` row for the daily digest (`docs/runbooks/ella_daily_digest.md`).
4. **Cron drainer** (`api/passive_ella_cron.py:run_passive_ella_cron`) — runs every minute, picks due rows, re-checks the kill switches + per-channel toggle + CSM-intervention, dispatches the response or cancels the row.

Real-world perceived latency is **1-2 minutes** end-to-end: the 1-minute insert-time delay plus up to 60 seconds of cron-tick lag. Per-minute is the floor on Vercel Cron (Pro plan); going lower would require a different scheduling primitive.

Default-stance is **stay out**: every uncertain case skips silently. Misfiring is more costly than missing.

## Dual kill switches

The passive monitor is gated by TWO independent switches. **Both must be ON** for any passive behavior to occur.

### 1. Global env var: `ELLA_PASSIVE_MONITORING_ENABLED`

Set in Vercel project env vars (Drake's gate (d)).

- `ELLA_PASSIVE_MONITORING_ENABLED=true` → globally enabled
- Anything else (or unset) → globally disabled

**Enable:**
1. Set `ELLA_PASSIVE_MONITORING_ENABLED=true` in Vercel project env vars.
2. Redeploy to pick up the change (Vercel doesn't hot-reload env vars).

**Disable (emergency):**
1. Set `ELLA_PASSIVE_MONITORING_ENABLED=false` (or any other value) in Vercel.
2. Redeploy.
3. The next cron drain (within 60 seconds) marks every queued row `cancelled_kill_switch`. Queue clears on its own.

### 2. Per-channel: `slack_channels.passive_monitoring_enabled`

UPDATE the boolean in Postgres. **Default is `true` on every new channel** as of migration 0042 (2026-05-19 PM) — Drake's invariant: any channel Ella is added to should be monitored. Pre-0042 the default was `false` (opt-in per channel); the 2026-05-19 bulk-flip set 129 existing non-archived client-mapped channels from `false` → `true`, bringing the total to 137 monitored. The Path-3 onboarding RPC (`create_or_update_client_from_onboarding` Branch C) also writes `true` explicitly at row creation, so new clients onboard with monitoring on. The toggle still exists for **explicit opt-out** on a specific channel where Ella shouldn't observe — keep this UPDATE in the toolkit for that exception case.

**Opt-out a specific channel:**

```sql
update slack_channels
   set passive_monitoring_enabled = false
 where slack_channel_id = 'C09JYRAENPJ';  -- or whatever
```

**Re-enable a previously opted-out channel:**

```sql
update slack_channels
   set passive_monitoring_enabled = true
 where slack_channel_id = 'C09JYRAENPJ';
```

The cron re-checks this on every drain; flipping it off during the 1-minute queue wait marks the in-flight row `cancelled_channel_disabled`.

## How to verify the path is flowing

### Decision-level (any outcome)

```sql
select id, started_at, trigger_metadata->>'haiku_decision' as decision,
       trigger_metadata->>'skip_reason' as skip_reason,
       output_summary
  from agent_runs
 where agent_name = 'ella'
   and trigger_type = 'passive_monitor'
 order by started_at desc
 limit 20;
```

Or filter in the dashboard at `/ella/runs` (Batch 2.2 audit surface — the dropdown surfaces `trigger_type` and the decision metadata directly).

### Queue depth (substantive + general-inquiry only)

```sql
select status, count(*)
  from pending_ella_responses
 group by status
 order by count(*) desc;
```

A growing `queued` count without corresponding `responded` rows suggests the cron isn't firing (Vercel Cron failure) or every row is being cancelled by the kill switch / channel toggle.

### Substantive + general-inquiry responses (the cron's outputs)

```sql
select id, started_at, trigger_type, output_summary
  from agent_runs
 where agent_name = 'ella'
   and trigger_type in ('passive_substantive', 'passive_general_inquiry')
 order by started_at desc
 limit 20;
```

### Digest-flagged messages (replaces passive escalation DMs)

**2026-05-18:** the passive path no longer fires escalation DMs or
writes `escalations` rows. Human-attention messages land in
`pending_digest_items` and surface via the daily digest cron — see
`docs/runbooks/ella_daily_digest.md`. Query what was flagged:

```sql
select created_at, slack_channel_id, haiku_decision, digest_category,
       haiku_reasoning, ella_responded, sent_in_digest_at
  from pending_digest_items
 order by created_at desc
 limit 20;
```

Historical `webhook_deliveries` rows under `source='ella_escalation_dm'`
/ `'ella_passive_escalation_dm'` from before the rewrite still exist
and render on `/ella/runs`; only **reactive `digest_only`** writes new
`ella_escalation_dm` rows now.

### CSM intervention counter (the key Batch 2.4 prerequisite metric)

```sql
select date_trunc('day', created_at) as day, count(*)
  from pending_ella_responses
 where status = 'cancelled_csm_intervened'
 group by 1
 order by 1 desc;
```

If this stays at zero across a week of meaningful traffic, the queue+cron infrastructure is dead weight and Batch 2.4 should rip it.

## Failure modes

### Cron not firing

Symptom: `pending_ella_responses` queue depth grows; no rows transition out of `queued`.

Diagnosis:
1. Vercel dashboard → Crons tab → check the `/api/passive_ella_cron` schedule is registered and recent invocations succeeded.
2. If the cron is firing but rows aren't draining, check the cron's HTTP response body — `processed=0` means the SELECT returned no due rows (clocks out of sync between Postgres and Vercel? unlikely but possible).
3. If invocations are returning 401, `CRON_SECRET` is misconfigured or stale.

Recovery: flip the global kill switch (`ELLA_PASSIVE_MONITORING_ENABLED=false` + redeploy). The first drain after kill-switch flip cancels every queued row cleanly. Then debug at leisure and flip back on.

### Haiku JSON parse failures

Symptom: `agent_runs.trigger_metadata->>'haiku_decision' = 'skip'` with `haiku_reasoning` starting `"unparseable Haiku response"` or `"haiku_returned_unknown_decision"`.

Iteration: cheap LLMs go off-format occasionally. Per spec, unparseable defaults to skip. Don't retry — adds cost, doesn't fix structural prompt issues. Iterate the Haiku system prompt in `agents/ella/passive_monitor.py:_HAIKU_SYSTEM_PROMPT` if the pattern persists.

### Kill switch flipped during the 1-min queue wait

Behavior: the next cron drain marks the row `cancelled_kill_switch` (global) or `cancelled_channel_disabled` (per-channel). No client-facing posts fire. Drake sees the cancellation in `/ella/runs`.

### Cron backlog after extended outage

Worst case: 60-minute Vercel outage → up to 60 × 50 = 3000 backed-up rows. After Vercel recovers, draining at 50/minute = 60 minutes of catch-up traffic. Probably fine at production scale; if you need to clear it immediately, flip the global kill switch — every queued row marks `cancelled_kill_switch` on the next drain and the queue clears in one tick.

### Sensitive-topic miss (unified-decision rewrite)

Symptom: a billing / refund / crisis / confused message gets
`decision='respond_haiku_self'`/`'respond_via_sonnet'`/`'skip'` with
`digest_flag=false` instead of `'digest_only'` (or at least
`digest_flag=true`).

There is **no KB-relevance gate and no escalation-keyword bypass
anymore** — the KB search is context only, never a drop point, so the
"message died before Haiku" failure mode is structurally gone. Every
client message that passes the 2 pre-LLM gates reaches Haiku. A miss
is now purely a Haiku-judgment miss.

Mitigation: `/ella/runs` surfaces every decision with the message text,
`haiku_decision`, `digest_flag`, `digest_category`, and reasoning.
Drake reviews post-hoc and iterates `_HAIKU_SYSTEM_PROMPT` (the
DIGEST FLAG / digest_only criteria). Because the flagging stance is
permissive ("flag if uncertain about whether Scott would care"), the
expected failure mode is over-flagging, not under-flagging — which is
the intended bias. Query recent flagged decisions:

```sql
select created_at, slack_channel_id, haiku_decision, digest_category,
       haiku_reasoning
  from pending_digest_items
 order by created_at desc
 limit 30;
```

### Client message with non-Ella @-mentions was silently skipped — is that right?

Yes, by design as of 2026-05-20. When a client posts a message containing
one or more `<@U...>` mentions and none of those mentions is Ella, Gate 3
in `passive_monitor._evaluate` fires a pre-LLM skip. The reasoning is "the
client is routing this to specific humans themselves; Ella shouldn't
interject." The behavior is:

- `agent_runs` row written, `status='success'`, `trigger_metadata` carries
  `is_routed_to_others=true` + `skip_reason='routed_to_humans'`.
- `pending_digest_items` row written (`digest_category='other'`,
  `haiku_decision='skip'`, `haiku_reasoning` contains "routed to humans")
  so Scott's daily digest still surfaces awareness of the message.
- No in-channel ack from Ella.
- No DM to Scott or the primary advisor.
- No `escalations` row.
- No Haiku cost (Gate 3 fires before any LLM call).

This is the structural fix for the 2026-05-19 EOD misfire where Dhamen
Hothi posted `<@Scott> <@Lou> Who controls my sub account?` and the
decision Haiku rationalized `acknowledge_and_escalate` despite the
explicit human-routing. See `docs/specs/ella-at-mention-routing-gate-and-advisor-context.md`.

To audit how often Gate 3 fires, query `/ella/runs` filtered by
`skip_reason='routed_to_humans'`, or directly:

```sql
select count(*) from agent_runs
 where trigger_metadata->>'skip_reason' = 'routed_to_humans'
   and started_at >= now() - interval '7 days';
```

If a legitimate "client wants Ella to weigh in on this thread too" gets
silently swallowed, the client (or an advisor) can re-trigger explicitly
by @-mentioning Ella — the classifier path takes precedence over the
routing gate.

## Initial validation rollout (post-deploy)

After Drake flips `ELLA_PASSIVE_MONITORING_ENABLED=true` in Vercel and redeploys, before broadening:

1. Enable a single channel — `#ella-test-drakeonly` is the working baseline:

   ```sql
   update slack_channels
      set passive_monitoring_enabled = true
    where slack_channel_id = 'C<DRAKE_TEST_CHANNEL>';
   ```

2. Drake posts a client-shaped message in `#ella-test-drakeonly`. Expected: `/ella/runs` shows a new `trigger_type='passive_monitor'` row within seconds. If the decision is `respond_substantive` or `respond_general_inquiry`, a `pending_ella_responses` row exists; ~1-2 minutes later, the cron drains it and posts to the channel.

3. Iterate until comfortable. Production rollout to other channels is post-validation work — not in the Batch 2.3 spec.

## Why per-minute cron (vs longer cadence)

Per the spec § Goal originally targeted a 3-5 min CSM-interjection window; Drake's 2026-05-11 call collapsed that to 1 min. The cron picks up rows at most ~60s after they become due (`respond_after_ts <= now()`). With a 1-minute insert-time delay, that lands the post 1-2 minutes after the triggering message.

Per-minute is the most aggressive cadence Vercel Cron supports on Pro. If the project plan ever loses Pro, fallback is 5-minute cadence with the delay window shifting to 5-6 minutes — document and surface to Drake before that change ships.

## Env vars (Vercel project)

| Var | Purpose | Default |
|-----|---------|---------|
| `ELLA_PASSIVE_MONITORING_ENABLED` | Global kill switch. `'true'` enables; anything else disables. | unset (= disabled) |
| `ESCALATION_RECIPIENT_SLACK_USER_ID` | Slack user_id of the head CSM (Scott) DMed on **reactive `digest_only`** escalations alongside the channel's primary CSM. No longer used on the passive path (passive doesn't escalate post-2026-05-18). | unset (= primary CSM only) |
| `ELLA_DAILY_DIGEST_CC_SLACK_USER_ID` | Optional CC for the daily digest cron (Drake). See `docs/runbooks/ella_daily_digest.md`. | unset (= head-CSM only) |
| `CRON_SECRET` | Bearer-token auth for the per-minute cron + the daily digest cron. Shared across all cron endpoints. | (set in Vercel) |
| `SLACK_WORKSPACE` | Optional. Subdomain used in escalation-DM + digest permalinks. | (omitted = clean fallback) |

`ELLA_PASSIVE_KB_RELEVANCE_THRESHOLD` was removed (2026-05-18) — KB
relevance is no longer a gate, so the threshold has no effect.

## Smoke testing in #ella-test-drakeonly

**As of the 2026-05-18 PM unified-path rewrite, `team_member` messages are ALWAYS evaluated** (CSMs @Ella too), so `test_mode` is no longer the gate that admits Drake-as-team_member — it's retained on the payload for compat but inert. `#ella-test-drakeonly` is still the smoke channel (it has `passive_monitoring_enabled=true`); use it to validate the three decisions (`respond` haiku/sonnet, `acknowledge_and_escalate`, `skip`) + the double-fire check before broader rollout. `ella`/`bot`/`workflow`/`unknown` still skip (with an audit row).

### To validate

1. Confirm test_mode is on for the test channel:
   ```sql
   SELECT slack_channel_id, name, passive_monitoring_enabled, test_mode
     FROM slack_channels
    WHERE slack_channel_id = 'C0AUWL20U8J';
   ```
   Both `passive_monitoring_enabled` and `test_mode` should be `true`.

2. Post test messages designed to exercise each Haiku outcome:
   - **`respond_substantive` test:** a question the channel-mapped client's KB clearly answers (e.g., "what's the best opener for cold calls" if the client has cold-call training content).
   - **`respond_general_inquiry` test:** a vague "anyone there?" or "hey, can someone help me with something" — general availability ping with no KB hook.
   - **`skip` test:** off-topic chatter ("lol that meeting was wild") — nothing for Ella to do.
   - **`escalate` test:** sensitive content phrasing — "I've been thinking about cancelling" or similar billing/cancellation language.

3. Watch the `/ella/runs` dashboard after each post. Within 1-2 minutes the decision row appears with `trigger_type='passive_monitor'` and the matching `haiku_decision` value in `trigger_metadata`. For `respond_*` decisions, a second row appears (the cron-drain row) with `trigger_type='passive_substantive'` or `'passive_general_inquiry'` when Ella actually posts.

### Filtering test traffic out of production metrics

Test-mode runs are tagged in `agent_runs.trigger_metadata.test_mode_run=true` so audit queries can split test from production:

```sql
-- Real production passive decisions only:
SELECT count(*) FROM agent_runs
 WHERE agent_name='ella' AND trigger_type='passive_monitor'
   AND (trigger_metadata->>'test_mode_run' IS NULL
     OR trigger_metadata->>'test_mode_run' != 'true');

-- Test-mode passive decisions only:
SELECT id, started_at, trigger_metadata->>'haiku_decision' AS decision,
       trigger_metadata->>'haiku_reasoning' AS reasoning
  FROM agent_runs
 WHERE agent_name='ella' AND trigger_type='passive_monitor'
   AND trigger_metadata->>'test_mode_run' = 'true'
 ORDER BY started_at DESC;
```

### Disabling test_mode

Leave on indefinitely for ongoing smoke testing, OR flip off when production rollout begins to keep the test channel clean for ad-hoc future testing. Drake's call. Either way, the `test_mode_run` flag on historic test runs means past test traffic stays cleanly filterable from production queries.

```sql
-- Disable test_mode (run when ready):
UPDATE slack_channels
   SET test_mode = false
 WHERE slack_channel_id = 'C0AUWL20U8J';
```
