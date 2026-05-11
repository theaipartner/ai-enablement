# Runbook: Ella passive monitoring

Operational guide for Ella V2 Batch 2.3 passive monitoring. Covers what it is, how to enable / disable, how to verify the path is flowing, and the failure / recovery procedures.

## What it is

Passive monitoring flips Ella from "reactive only" (responds when @-mentioned) to "passively observing every client message in passive-monitoring-enabled channels, deciding whether to respond, and acting on a 1-minute delay." (Original spec wrote this as a 3-5 min CSM-interjection window; Drake's 2026-05-11 call dropped the delay to 1 min because CSMs are structurally in meetings and don't respond inside any realistic window. The queue + cron + intervention-check machinery stays in place pending production data; if `cancelled_csm_intervened` stays at ~0 after meaningful traffic, Batch 2.4 will rip the queue and move to synchronous response from the ingest fork.)

Pipeline (one entry per client-authored message):

1. **Realtime ingest** (`ingestion/slack/realtime_ingest.py:ingest_message_event`) — every Slack `message` event lands here; passive fork attaches after the existing client-channel + subtype gates and the message upsert.
2. **Passive decision** (`agents/ella/passive_monitor.py:evaluate_passive_trigger`) — runs six gates in order: global kill switch → author-type gate → CSM-directed auto-skip → KB-relevance gate → firm-after-first gate → Haiku decision call. Returns one of four outcomes.
3. **Persistence + side effects** (`agents/ella/passive_dispatch.py:persist_passive_evaluation`) — writes the `agent_runs` row (always), and: for `respond_*` outcomes inserts a `pending_ella_responses` row with `respond_after_ts = now() + 1 minute`; for `escalate` fires a backend DM to the primary CSM; for `skip` does nothing further.
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

UPDATE the boolean in Postgres. Default is `false` on every channel (existing + new).

**Enable a specific channel:**

```sql
update slack_channels
   set passive_monitoring_enabled = true
 where slack_channel_id = 'C09JYRAENPJ';  -- or whatever
```

**Disable a specific channel:**

```sql
update slack_channels
   set passive_monitoring_enabled = false
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

### Backend escalation DMs (no client-facing post)

```sql
select id, processed_at, processing_status, processing_error,
       payload->>'slack_channel_id' as channel,
       payload->>'haiku_reasoning' as reasoning
  from webhook_deliveries
 where source = 'ella_passive_escalation_dm'
 order by processed_at desc
 limit 20;
```

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

### Sensitive-topic miss

Symptom: a billing / refund / crisis message gets `decision='respond_substantive'` or `'respond_general_inquiry'` instead of `'escalate'`.

Mitigation: the audit dashboard (`/ella/runs`) surfaces every Haiku decision with the input message text + reasoning. Drake reviews post-hoc; iterate the Haiku system prompt's auto-escalate fence in `_HAIKU_SYSTEM_PROMPT`. Add the missed pattern to the explicit list.

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
| `ELLA_PASSIVE_KB_RELEVANCE_THRESHOLD` | Pre-Haiku KB-relevance cutoff (cosine similarity). | `0.3` |
| `CRON_SECRET` | Bearer-token auth for the per-minute cron. Shared across all cron endpoints (single-var pattern per M6.2). | (set in Vercel) |
| `SLACK_WORKSPACE` | Optional. Subdomain used in escalation-DM permalinks. | (omitted = clean fallback) |
