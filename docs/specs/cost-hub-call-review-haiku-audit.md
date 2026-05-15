# Cost hub: call review Haiku bucket — audit and fix
**Slug:** cost-hub-call-review-haiku-audit
**Status:** in-flight

Investigation + small fix for a discrepancy noticed during cost hub validation.

## Context Builder needs

Read these first, confirm understanding in 3-4 bullets:

- `agents/call_reviewer/sentiment_classifier.py` — the Haiku classifier. Called from `agents/call_reviewer/persistence.py:upsert_call_review` for every call review write. Every review = one Haiku classification call.
- `agents/call_reviewer/reviewer.py` — opens an `agent_runs` row via `start_agent_run("call_reviewer", ...)` for the Sonnet pass. Does the sentiment classifier also open its own `agent_runs` row, or does it share the call_reviewer row?
- `lib/db/cost-hub.ts` — the `BUCKET_DEFINITIONS` for the five Anthropic buckets. The `call_review_haiku` bucket filters on `agent_name='call_reviewer'` + model prefix `claude-haiku-*`.
- `shared/claude_client.py` and `shared/logging.py:start_agent_run` — how cost-tracking writes attribute to `agent_runs`.

## What's happening

The cost hub Call Review Haiku bucket reads as 0 runs / $0.00 for today/this week/this month. Builder's resume report flagged this as expected ("call_reviewer is Sonnet-only today") and added a "no usage — Sonnet-only today" caveat string. But the sentiment classifier IS a Haiku call, and it fires on every call review write — so we should see ~84 Haiku runs from today's backfill alone, plus all prior reviews going back to 2026-05-07.

The bucket reading zero means one of three things:

1. **The sentiment classifier doesn't open its own `agent_runs` row at all.** Cost is being made via `shared.claude_client.complete()` but `run_id` isn't being passed, so no cost-tracking row is written. **Cost is real but invisible.**
2. **The sentiment classifier opens a row under a different `agent_name`.** Maybe `agent_name='sentiment_classifier'` or similar, in which case bucket 4's filter (`agent_name='call_reviewer'`) misses it. **Cost is tracked but bucketed elsewhere.**
3. **The sentiment classifier shares the `call_reviewer` row.** Both the Sonnet review pass and the Haiku sentiment classification use the same `agent_runs.run_id`. The row's `model` field reflects the Sonnet model (because that's the dominant call), so the cost shows up under bucket 3 (Call Review Sonnet) even though some of those tokens are Haiku. **Cost is tracked but conflated.**

Each scenario has a different fix. Builder figures out which one is happening.

## Task 1: Diagnose

Read `agents/call_reviewer/sentiment_classifier.py` and trace the LLM call. Specifically:

- Does it call `shared.claude_client.complete()`? If yes, is a `run_id` passed?
- If a `run_id` is passed, is it a new run (own `start_agent_run` call) or the parent call_reviewer's run_id?
- What `agent_name` (if any) is used for any new run?

Also run a SQL query against cloud `agent_runs` to count rows by `agent_name` + `model` for the trailing 7 days. Look for any rows with Haiku model strings, regardless of `agent_name`. This locates where the sentiment Haiku spend actually is.

Surface findings in the report.

## Task 2: Fix based on diagnosis

The fix depends on what Builder finds:

- **If scenario 1 (no cost tracking):** add cost tracking. Open an `agent_runs` row in the sentiment classifier with `agent_name='call_reviewer'` (matching the parent agent's name so bucket 4's existing filter catches it) and `trigger_type='sentiment_classifier'` (so audit queries can distinguish sentiment runs from review runs within the same agent). Pass `run_id` to `complete()`. Update or write the row with the cost result. Backfill is NOT in scope — only forward-only fix; the historical Haiku spend is invisible.

- **If scenario 2 (different agent_name):** Builder's call on whether to (a) rename the `agent_name` in the classifier to `'call_reviewer'` so it joins bucket 4, OR (b) add a sixth bucket "Sentiment classifier Haiku" to the cost hub. My (Director's) lean: **(a)** — sentiment classification is conceptually part of the call review pipeline, not its own subsystem. Use `trigger_type='sentiment_classifier'` to retain the distinction.

- **If scenario 3 (shared row):** The sentiment classifier should open its own agent_runs row instead of sharing. Same shape as scenario 1's fix. The shared-row pattern conflates Sonnet + Haiku costs which makes the cost hub bucketing imprecise.

In all scenarios: post-fix, the next call review write should produce one row under bucket 3 (call_review_sonnet) AND one row under bucket 4 (call_review_haiku). Builder verifies this by triggering one manual review write after the fix and checking the result.

## Task 3: Update the "no usage" caveat handling

Once the bucket is correctly receiving sentiment classifier runs:

- Remove the `NEVER_USED_SENTINEL` / `neverUsed` flag handling from `lib/db/cost-hub.ts` for the `call_review_haiku` bucket specifically — it will now have real usage.
- The "(no usage — Sonnet-only today)" caveat string in the page should not render for this bucket once data flows.
- The infrastructure for the sentinel stays (it's still useful for genuinely-never-used future buckets) — just doesn't apply to call_review_haiku anymore.
- Bucket's `earliestReliableDate` should be set to **today's date** (the fix date) since pre-fix Haiku runs are invisible/missing. The "(incomplete before YYYY-MM-DD)" caveat will then show, accurately, until ~30 days after the fix.

## Doc updates

- `docs/runbooks/cost_hub.md` — bucket filter strings section: update the call_review_haiku description if the fix changes how the bucket resolves. Note the `earliestReliableDate` change.
- `docs/agents/call_reviewer.md` — if it documents the sentiment classifier surface area, note that it now opens its own `agent_runs` row.
- No state.md entry needed — small fix, not a feature ship.

## Hard stops

None. The fix is small and the migration-free shape means there's no irreversible step. Builder uses standard commit hygiene + the post-fix verification trigger.

## What could go wrong

- **The sentiment classifier might be called from multiple places** (not just `upsert_call_review`). Builder greps for usage before editing — the fix should cover every call site.
- **If scenario 3 turns out to be the case, splitting into a separate row changes the cost rollup for Call Review Sonnet** retroactively (it gets less expensive, since some of its cost was really Haiku). Forward-only fix; historical rows stay conflated. Note this in the runbook.
- **Backfilling historical Haiku spend** would require parsing the existing `call_reviewer` rows to estimate the Haiku portion — not worth it. Accept the historical gap; the `earliestReliableDate` caveat communicates it.

## Mandatory doc-update list

- `docs/runbooks/cost_hub.md` — bucket section if anything changes.
- `docs/agents/call_reviewer.md` — sentiment classifier surface note.

## Acceptance criteria

- Builder's diagnosis surfaces which scenario applies — clearly stated in the report.
- Fix lands; the next call review write produces an entry in bucket 4.
- Cost hub `call_review_haiku` bucket shows nonzero Today/This week/This month for any reviews written after the fix.
- `earliestReliableDate` for the bucket reflects today's date; "(incomplete before …)" caveat renders.
- `tsc --noEmit` + `npm run lint` clean. `pytest` still 596 passing (no Python tests touched unless Builder adds one for the new agent_runs row shape).

## Sequence

1. Diagnosis (read + SQL inventory).
2. Surface findings — if it's scenario 2/3 and Builder wants to bundle the bucket addition (scenario 2 option b) into this spec, surface and ask. Otherwise proceed with the lean (scenario 2 option a / scenario 1 / scenario 3) fixes.
3. Fix.
4. Trigger one manual call review write to populate the bucket.
5. Verify cost hub renders the bucket with the new data + the fix-date caveat.
6. Doc updates.
