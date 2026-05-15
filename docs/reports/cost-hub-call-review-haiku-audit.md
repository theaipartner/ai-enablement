# Report: Cost hub — call review Haiku bucket audit and fix

**Slug:** cost-hub-call-review-haiku-audit
**Spec:** docs/specs/cost-hub-call-review-haiku-audit.md

## Files touched

**Modified:**
- `agents/call_reviewer/sentiment_classifier.py` — `classify_sentiment_tier` now opens its own `agent_runs` row (`agent_name='call_reviewer'`, `trigger_type='sentiment_classifier'`), threads `run_id` through `complete()` so the Haiku cost auto-writes, and closes via `end_agent_run`. Module docstring rewritten (the old "no run_id, no agent_runs telemetry" claim was the root cause).
- `lib/db/cost-hub.ts` — `call_review_haiku` bucket `earliestReliableDate` flipped from `NEVER_USED_SENTINEL` to `'2026-05-15'`. `neverUsed` auto-resolves to false for this bucket now; the sentinel infra stays for genuinely-unused future buckets.
- `docs/runbooks/cost_hub.md` — Call Review Haiku bucket section + caveat table row rewritten.
- `docs/agents/call_reviewer.md` — surface-area + Telemetry sections corrected.

## What I did, in plain English

**Task 1 — Diagnosis. Scenario 1: cost is real but invisible.**

`classify_sentiment_tier` called `shared.claude_client.complete()` with **no `run_id`**. `complete()` only writes the `agent_runs.llm_*` cost columns when `run_id is not None`, so the sentiment Haiku call — which fires on *every* call review write — never produced an `agent_runs` row at all. The module docstring even stated this as intentional ("The function is intentionally utility-shaped: no `run_id`, no agent_runs telemetry").

SQL inventory against cloud `agent_runs` confirmed it: the only Haiku-model rows in the trailing 7 days are `agent_name='ella'` (passive monitor, 36 runs). `call_reviewer` rows are 100% `claude-sonnet-4-6`. No `agent_name` containing 'sentiment' has ever existed. So the cost hub's Call Review Haiku bucket read $0 not because "call_reviewer is Sonnet-only" (the claim in my earlier cost-hub resume report — that was **wrong**) but because the sentiment Haiku spend was never recorded anywhere. ~84 invisible Haiku calls from today's backfill alone, plus every review since 2026-05-07.

Two call sites use `classify_sentiment_tier`: `agents/call_reviewer/persistence.py:upsert_call_review` (every review write) and `scripts/backfill_sentiment_tiers.py` (one-shot). Fixing inside the shared function covers both — no per-call-site edits needed.

**Task 2 — Fix (scenario 1 shape).** `classify_sentiment_tier` now:
1. Opens an `agent_runs` row via `start_agent_run("call_reviewer", "sentiment_classifier", ...)`. `agent_name='call_reviewer'` so bucket 4's existing filter (`agent_name='call_reviewer'` + `claude-haiku%`) catches it with zero cost-hub code change; `trigger_type='sentiment_classifier'` so audit queries can split sentiment runs from the Sonnet review pass within the same agent.
2. Passes `run_id` to `complete()` so the Haiku cost auto-writes.
3. Closes via `end_agent_run(status="success", output_summary="tier=<x>", duration_ms=...)`.

Telemetry is fail-soft, preserving the display-only / never-load-bearing contract: a `start_agent_run` failure leaves `run_id` None and the classification still happens (degrades exactly to the pre-fix behavior); a `complete()` failure closes the run as `error` then re-raises so the caller (`upsert_call_review`) keeps its existing write-without-`sentiment_tier` fallback. The fallback-to-`yellow` path is unchanged.

Forward-only — pre-2026-05-15 sentiment Haiku spend is not backfilled (not worth back-estimating from conflated rows; the `earliestReliableDate` caveat communicates the gap).

**Task 3 — Bucket caveat.** `call_review_haiku.earliestReliableDate` set to `'2026-05-15'` (the fix date). Because `neverUsed` is computed as `earliestReliableDate === NEVER_USED_SENTINEL`, this one change automatically: (a) makes `neverUsed` false for this bucket, (b) suppresses the "(no usage — Sonnet-only today)" string, (c) renders "(incomplete before 2026-05-15)" on the This month row instead, which ages out ~30 days post-fix. The `NEVER_USED_SENTINEL` constant + `neverUsed` flag + page handling stay intact for genuinely-unused future buckets — minimal, surgical change per spec.

## Verification

- **Diagnosis SQL** (cloud `agent_runs`, trailing 7d): only `ella` has Haiku rows; `call_reviewer` is all Sonnet; no `sentiment`-named agent. Conclusively scenario 1.
- **Post-fix live trigger:** called `classify_sentiment_tier(...)` once against the real Haiku API + DB. Returned `'yellow'`. The resulting `agent_runs` row:
  - `agent_name = call_reviewer` ✓
  - `trigger_type = sentiment_classifier` ✓
  - `status = success` ✓
  - `llm_model = claude-haiku-4-5-20251001` ✓ (matches bucket 4's `claude-haiku%` filter)
  - `llm_input_tokens = 130`, `llm_output_tokens = 4`, `llm_cost_usd = 0.0002` ✓ (nonzero, real cost recorded)
  - `output_summary = tier=yellow`, `ended_at` set ✓

  This row satisfies bucket 4's exact filter with nonzero cost — confirming the cost hub Call Review Haiku bucket will now show nonzero Today / This week / This month for any review written after the fix.
- **`pytest tests/agents/call_reviewer/`** — 22 passed. `test_persistence.py` mocks `classify_sentiment_tier` at the import site so the telemetry change doesn't touch it; there's no direct unit test of the function (none added — the live-trigger verification covers the new row shape end-to-end, which a mock-DB unit test could not).
- **`pytest tests/ -q`** — 596 passed (unchanged, as the spec's acceptance criteria require).
- **`tsc --noEmit`** + **`next lint`** (`lib/db`, `app/(authenticated)/cost-hub`) — clean.

## Surprises and judgment calls

- **My earlier cost-hub resume report was wrong.** It asserted "call_reviewer is Sonnet-only today" and I added a "(no usage — Sonnet-only today)" caveat. The sentiment classifier IS a Haiku call on every review write; the bucket read zero because the spend was untracked, not absent. Director caught this during validation and specced the correction. This is exactly the "catch Builder's confident-but-wrong output" case — flagging it prominently here so the record is straight.
- **No direct unit test added for `classify_sentiment_tier`.** The spec said "no Python tests touched unless Builder adds one for the new agent_runs row shape." A mock-DB unit test would only assert that `start_agent_run`/`end_agent_run` were called with certain args — it wouldn't verify the row actually lands with the right `agent_name`/`model`/cost (the thing that was broken). The live-trigger verification against real DB + API does verify that, end to end. Judgment: the integration check is the higher-value evidence here; a mock unit test would be cargo-cult coverage. Surfaced for visibility.
- **Verification cost a real $0.0002 + one real `agent_runs` row** in cloud. The row is a legitimate sentiment-classifier run (it classified a real sentiment-arc string) — not test pollution that needs cleanup. It's correctly bucketed and dated; it just happens to have been triggered by the verification rather than a review write. Left in place; noted under Side effects.
- **`NEVER_USED_SENTINEL` is now referenced by zero buckets** but still used in the `buildPeriodSummary` comparison logic, so tsc/lint don't flag it as dead. Kept per spec ("infrastructure for the sentinel stays — it's still useful for genuinely-never-used future buckets").
- **Historical conflation note.** This was scenario 1 (untracked), not scenario 3 (shared row), so there's no retroactive cost shift on the Call Review Sonnet bucket — the Sonnet rows never included Haiku cost. The historical gap is cleanly "missing" rather than "misattributed," which is the better failure mode. Documented in the runbook.

## Out of scope / deferred

- **Backfilling pre-2026-05-15 sentiment Haiku spend** — explicitly out of scope per spec. Would require estimating the Haiku portion from rows that never recorded it; not worth it. The `earliestReliableDate` caveat communicates the gap until it ages out.
- **No state.md entry** — per spec, this is a small fix, not a feature ship.
- **The verification `agent_runs` row** is a real classifier run; no cleanup needed or done.

## Side effects

- **Cloud Supabase writes:** one real `agent_runs` row from the post-fix verification trigger (`agent_name='call_reviewer'`, `trigger_type='sentiment_classifier'`, `status=success`, cost $0.0002). Legitimate telemetry, not test pollution — left in place. Going forward, every call review write produces one such row (this is the intended behavior the fix enables).
- **Anthropic API spend:** one real Haiku call during verification (~$0.0002, 130 in / 4 out tokens). Negligible.
- **No env var changes, no migrations, no Slack posts, no other external calls.**
- **Push triggers a Vercel deploy** of the cost-hub.ts bucket change + the sentiment_classifier.py telemetry. The TS change is display-only (caveat string); the Python change starts populating bucket 4 on the next review write in production.
