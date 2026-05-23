# Ella warm-opener misfire + /ella/runs empty — diagnostic (read-only)
**Slug:** ella-warm-opener-and-runs-page-diagnostic
**Status:** shipped

**Target branch: ella-worktree**

> Specs live on `main` (Builder reads them from there). Execution targets the `ella-worktree` worktree at `~/projects/ai-enablement-ella`, NOT `main`. A Close-ingestion backfill is running on `main` in parallel — this work is Ella-only; do not touch anything Close-related (`ingestion/close/`, Close specs, Close schema).

## Why this exists

A production misfire surfaced today (2026-05-23). In a client channel, advisor Nico @-mentioned Ella twice with a substantive, in-scope coaching question ("rupahel is in the prospecting phase and is cold calling, can you give him some tips for success", then "i want some strateegies on cold calling"). **Both times Ella replied with the identical canned warm opener "Hey — what can I help with?"** instead of answering the question. A clear cold-calling coaching question is about the strongest `respond` signal that exists, so a `warm_opener` outcome — twice in a row, byte-identical — is wrong.

Separately, Drake reports `/ella/runs` is "broken — can't see any recent runs." We do not yet know whether this is the same root cause (runs not landing in `agent_runs`) or a separate dashboard-query bug. **The dashboard being down is also what's blinding the diagnosis** — normally the misfire would be read directly off `agent_runs.trigger_metadata.mention_classifier_shape` + `mention_classifier_reasoning`.

This is a **read-only diagnostic**. Do NOT write a fix. The output is a report Director scopes the actual fix from. This is deliberately light — Drake does not want a deep forensic sweep, just enough to distinguish the two competing hypotheses for each symptom.

## The two questions to answer

### Q1 — Why did the @-mention produce `warm_opener`?

Two competing hypotheses, completely different fixes:

- **(A) Classifier mis-classified.** `agents/ella/mention_classifier.py:classify_mention_response` ran successfully, returned a clean parse, and genuinely picked `warm_opener` for a substantive question. → fix is prompt/classification quality.
- **(B) Classifier errored / parsed-to-fallback.** The classifier Haiku call raised, timed out, or returned malformed/out-of-enum JSON, and the parser collapsed it to the `warm_opener` safer-fallback (per `ella.md` § @-Mention Handling — "parser collapses any malformed JSON / out-of-enum value … to the safer-fallback `warm_opener`"). The "byte-identical canned reply on two consecutive different questions" pattern is consistent with this. → fix is the failing call, NOT the prompt.

The deciding evidence is in the `agent_runs` rows for these two messages: `trigger_metadata.mention_classifier_shape`, `trigger_metadata.mention_classifier_reasoning`, `status`, and any error/exception captured. If `mention_classifier_reasoning` is present and coherent and the shape is genuinely `warm_opener`, that's (A). If the reasoning is empty/null/garbled, the shape is a fallback, the status is errored, or there's a captured exception, that's (B).

### Q2 — Why does `/ella/runs` show no recent runs?

Two competing hypotheses:

- **(C) Rows not landing.** Recent `agent_runs` rows for `agent_name='ella'` are missing or sparse → same family of cause as Q1(B), or an ingest/dispatch failure upstream of the `agent_runs` write.
- **(D) Dashboard query bug.** Rows ARE in `agent_runs` but the page renders empty — a query-layer issue in `lib/db/ella-runs.ts` (the EST-period boundary filter, the shape-adapter `extractChannelId`/`extractAuthorRole`/`extractAuthorName`, a status/anomaly filter, pagination, or a schema-drift mismatch). Drake could not confirm whether the page errors outright or renders-but-empty; check for both.

If Q2 resolves to (C) and Q1 resolves to (B), the two symptoms are one root cause and the report should say so explicitly.

## Acclimatization checklist

Read these first, confirm understanding in 4-5 bullets before running anything:

- `docs/agents/ella/ella.md` § Trigger + § @-Mention Handling (Structural) — the classifier path, the four-shape enum, the parser-collapses-to-`warm_opener` fallback contract.
- `agents/ella/mention_classifier.py` — the classifier call, the parse, what it writes on failure. **This is the load-bearing file for Q1.**
- `agents/ella/passive_dispatch.py` `_dispatch_mention` — how each shape is dispatched and what lands in `agent_runs.trigger_metadata`.
- `lib/db/ella-runs.ts` — the dashboard query layer; the EST-period boundary filter and the shape-agnostic `extract*` adapters. **Load-bearing for Q2(D).**
- `docs/specs/ella-duplicate-webhook-delivery-diagnostic.md` + `docs/reports/ella-duplicate-webhook-delivery-diagnostic.md` — the precedent for a read-only psycopg2-against-cloud diagnostic; match its shape and discipline.
- Confirm: cloud access is via the pooler URL in `supabase/.temp/pooler-url` + `SUPABASE_DB_PASSWORD` from `.env.local` (quoted — contains a `#`), through psycopg2 (psql not installed). This is the established read path.

## What to do

All queries are **read-only SELECTs against cloud Supabase** via psycopg2 on the pooler URL. No writes, no migrations, no code changes, no fix. Match the `ella-duplicate-webhook-delivery-diagnostic` approach — a small throwaway diagnostic script under `scripts/` is fine, or inline psycopg2; either way it only reads.

The screenshot context for locating the rows: channel maps to client whose Slack channel is `ruphael-getahun` (an external/guest-containing channel — "1 external person is from Ruphael's Workspace"); advisor is Nico; the two triggering messages are the cold-calling questions at ~16:22 and ~16:23 channel-local time, with Ella's two identical "Hey — what can I help with?" replies at 16:23. Resolve the channel + client first, then pull the runs around that window.

Suggested query set (adapt as needed — the goal is to answer Q1 and Q2, not to run exactly these):

1. **Resolve the channel + client.** Find the `slack_channels` row for the `ruphael-getahun` channel (by name pattern) → its `client_id` → the `clients` row (name, `passive_monitoring_enabled`, `test_mode`). Confirms which channel id to filter `agent_runs` on. Note `passive_monitoring_enabled` state — if it's `true`, both paths are live in this channel.

2. **Pull the @-mention runs for the misfire window.** `agent_runs WHERE agent_name='ella'` for that channel id (check both `trigger_metadata->>'triggering_slack_channel_id'` and `trigger_metadata->>'channel'` — the metadata shape varies between passive and reactive paths per the 2026-05-11 adapter note) in the last ~24h. For each row surface: `started_at`, `trigger_type`, `status`, `input_summary`, `trigger_metadata->>'is_ella_mentioned'`, `trigger_metadata->>'mention_classifier_shape'`, `trigger_metadata->>'mention_classifier_reasoning'`, `trigger_metadata->>'haiku_decision'` (in case it routed through the decision path instead), `output_summary`, `llm_cost_usd`, and any error/exception column present on `agent_runs`. **This is the Q1-deciding query.** Quote the actual `mention_classifier_reasoning` text verbatim in the report (it's our own agent's output, not copyrighted material) so Director can judge (A) vs (B) independently.

3. **Count + recency of Ella runs overall.** `SELECT count(*), max(started_at), min(started_at)` on `agent_runs WHERE agent_name='ella'` over the last 24h / 7d, plus a status breakdown (`GROUP BY status`) and an error-rate read. Answers Q2(C) — are rows landing at all, and at what error rate?

4. **If rows ARE landing (Q2 → likely D): inspect the dashboard query path.** Read `lib/db/ella-runs.ts` and identify what the list query filters on — specifically the EST-period boundary computation and whether a recent schema/shape change could make the filter exclude today's rows (e.g. a `started_at` vs `created_at` column mismatch, a timezone-window off-by-one, an anomaly/status filter defaulting to exclude). Do NOT fix — just identify the most likely culprit line(s) and name them. A `tsc --noEmit` / `next lint` run to surface any compile error on that file is fine (read-only signal).

5. **Classifier failure-mode confirmation (only if Q1 → likely B).** Look at whether OTHER recent `mention_classifier`-path runs across all channels also show empty/null reasoning or fallback shapes — i.e. is this channel-specific or fleet-wide? A quick `GROUP BY mention_classifier_shape` over the last 7d of mention-path runs tells us whether `warm_opener` is anomalously dominant (consistent with a systemic parse/erroring failure) vs normally distributed (consistent with a one-off mis-classification).

## What success looks like

A report at `docs/reports/ella-warm-opener-and-runs-page-diagnostic.md` that states, with evidence:

- **Q1 verdict: (A) mis-classified or (B) errored/fallback** — with the verbatim `mention_classifier_shape` + `mention_classifier_reasoning` + `status` for the two misfire runs as the evidence, and the fleet-wide shape distribution (step 5) as corroboration.
- **Q2 verdict: (C) rows not landing or (D) dashboard query bug** — with the run counts/recency/status-breakdown as evidence, and if (D), the named suspect line(s) in `lib/db/ella-runs.ts`.
- **Whether Q1 and Q2 share a root cause** — explicit yes/no.
- A short "what a fix would touch" pointer for each (NOT the fix itself) so Director can scope the follow-up specs. Keep this to a few bullets — Drake wants this light.

## Hard stops

- **Read-only.** No writes to any cloud table, no migrations, no code fix, no prompt edit. If you find yourself wanting to fix the bug mid-diagnostic — stop, write the finding, leave the fix for the follow-up spec. (This is the same discipline as the duplicate-webhook diagnostic.)
- This is the `ella-worktree`. Confirm you're operating in the worktree, not `main`.
- Do not touch anything Close-related — a backfill is running on `main` in parallel.
- If the diagnostic surfaces a third symptom beyond Q1/Q2, log it in the report's Surprises section; do not chase it.

## What could go wrong — think this through yourself

A few seeds, but surface anything else you spot: the metadata channel-id key differs between the reactive and passive paths (`channel` vs `triggering_slack_channel_id`) — query both or you'll get a false "no rows" (this exact key-mismatch already burned a prior diagnostic, see the 2026-05-21 EOD arc). The two consecutive identical replies might be TWO separate runs OR one run that posted twice — distinguish them by `agent_runs` row count for the window. The channel has an external guest — confirm the author-type resolution on Nico's messages didn't misfire (advisor mis-resolving as `unknown` would itself be a finding). And consider: if `/ella/runs` filters on an EST calendar boundary and today's rows are timestamped in a way that falls outside the computed window, that's a (D) that looks like a (C) until you query `agent_runs` directly.

## Mandatory doc updates

- Write the report to `docs/reports/ella-warm-opener-and-runs-page-diagnostic.md`.
- Flip this spec's `Status:` to `shipped` in the same commit that lands the report (read-only diagnostic, no gate).
- No other doc updates — this is a diagnostic, not a change. If a known-issues entry seems warranted from the findings, NAME it in the report's "Out of scope / deferred" section for Director to spec; do not edit `docs/known-issues.md` directly in this pass.
