# Gregory — health-scoring brain

The agent that computes a per-client **health score** (0–100), a **tier** (green/yellow/red), and
forward-looking **concerns**, writing one `client_health_scores` row per client per run. This doc covers
the brain agent; for where it sits in the system (dashboard surfaces, ingestion, crons) see
[`../fulfillment/architecture.md`](../fulfillment/architecture.md).

Code: `agents/gregory/`. Reads from Supabase; never calls external tools directly.

## Trigger

- **Cron:** `api/gregory_brain_cron.py`, daily at `0 9 * * *` (09:00 UTC), after the Fathom backfill. Calls `compute_health_for_all_active(trigger_type="cron")`.
- **Manual:** `scripts/run_gregory_brain.py --all` | `--client-id <uuid>` | `--email <email>`.

## The score

`scoring.py` combines signal contributions into the final score:

```
final_score = round( Σ(weight × contribution) / Σ(weight) ),  clamped 0–100
```

Each signal returns its own 0–100 `contribution`. Tiers: **green ≥ 70**, **yellow 40–69**, **red < 40**.
If *every* signal returns the neutral 50 (no real data anywhere), the score is forced to **50/yellow**
and flagged `insufficient_data` — the brain never ships a client green by accident. The math is fully
transparent in `factors.signals[]` so a reviewer can recompute by hand.

## Signals (`signals.py`, weights sum to 1.0)

| Signal | Weight | Logic |
|---|---|---|
| `ai_call_signal` | **0.50** | Dominant. Sonnet over recent call reviews — see below. Also emits the concerns. |
| `call_cadence` | 0.20 | Days since most recent call: `<14`→100, `14–30`→50, `>30`→0; no calls → 50 (neutral). |
| `overdue_action_items` | 0.10 | `100 − 15×(open past-due items)`, floored at 0; none overdue → 100. |
| `latest_nps` | 0.20 | From `clients.nps_standing`: promoter→100, neutral→50, at_risk→0, NULL/unexpected→50. |

Deterministic signals never raise — they return neutral 50 on missing data — so the score is always
computable.

## AI call signal (`ai_call_signal.py`)

The dominant signal. Model `claude-sonnet-4-6`, max 2048 output tokens, 30-day lookback over the client's
`call_review` documents (oldest-first for trajectory).

- **Input:** a prose rendering of each recent review — `started_at`, `title`, `call_id`, then `sentiment_arc`, `pain_points`, `wins`, `dodged_questions`.
- **Output (strict JSON):**
  ```json
  {
    "contribution": 0-100,
    "reasoning": "1-3 sentences",
    "concerns": [{"text": "...", "severity": "low|medium|high", "source_call_ids": ["<uuid>"]}]
  }
  ```
- **Concerns:** 0–3 forward-looking watchpoints surfaced on the dashboard. `source_call_ids` are filtered against the input call-id set to block hallucinated UUIDs.
- **Freshness skip:** if no new `call_review` documents exist since the last successful compute, the prior Signal + concerns are reused (note rewritten to flag the skip) and the Sonnet call is skipped — keeps the daily sweep within the cron ceiling.

## Orchestration & output (`agent.py`)

`compute_health_for_client(client_id, trigger_type)`:
1. Opens an `agent_runs` row.
2. `compute_ai_call_signal()` → `(Signal, concerns)`.
3. `compute_all_signals()` → `[call_cadence, overdue_action_items, latest_nps]`.
4. Composes `[ai_signal, *deterministic]` (AI first for the dashboard breakdown).
5. `score_signals()` → `{score, tier, insufficient_data}`.
6. Builds a one-sentence `overall_reasoning`.
7. Writes one `client_health_scores` row: `score`, `tier`, `computed_by_run_id`, and `factors = {signals, concerns, overall_reasoning}`.
8. Closes the `agent_runs` row with telemetry (tokens, cost, duration).

`compute_health_for_all_active()` sweeps every non-archived client, isolating per-client failures, and
returns a `SweepResult` with aggregates (succeeded / failed / insufficient_data / avg_per_client_ms).

## Concerns are not a separate gate

The V1.1 `concerns.py` module and the `GREGORY_CONCERNS_ENABLED` env gate are **retired** — no code reads
the gate. Concerns now flow directly out of `ai_call_signal` (the call reviews it reads are already the
LLM-distilled pain points / wins / dodged questions, so a second concerns pass was redundant).

## Related hook — CS call summaries

`cs_call_summary_post.py` lives in this package but is triggered by Fathom ingestion, not the brain cron:
on each new client-call review it posts a summary + sentiment pill (🟢/🟡/🔴, from
`documents.metadata.sentiment_tier`) to `#cs-call-summaries`.

## Tables

Writes `client_health_scores` and `agent_runs`. Reads `clients`, `documents` (call reviews),
`call_action_items`. See `../schema/` for column-level detail.
