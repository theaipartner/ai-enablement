# Report: Gregory Redesign Part 2 — Calls data layer (pre-design)
**Slug:** gregory-redesign-part-2-calls-data-layer
**Spec:** docs/specs/gregory-redesign-part-2-calls-data-layer.md

## Files touched

**Created**
- `agents/call_reviewer/sentiment_classifier.py` — Haiku-backed `classify_sentiment_tier`; max_tokens=10; yellow-fallback on unexpected output.
- `scripts/backfill_sentiment_tiers.py` — idempotent one-shot backfill; dry-run / --smoke / --apply / --limit; Drake runs this.
- `app/(authenticated)/calls/[id]/action-item-actions.ts` — three server actions for the Confirm-flow data layer.
- `docs/agents/call_reviewer.md` — new top-level agent doc (not a subdir; promote later if the agent grows).

**Modified**
- `agents/call_reviewer/persistence.py` — hooked `classify_sentiment_tier` into `upsert_call_review` before `validate_document_metadata`; classifier failures log and proceed without the field.
- `shared/ingestion/validate.py` — `('fathom', 'call_review')` now accepts `sentiment_tier` in the optional set.
- `lib/db/calls.ts` — nested `client_team_assignments` join under `primary_client`; derived `csm_team_member_id` / `csm_team_member_name` on `CallsListRow`; `csm_team_member` object on `CallDetail`; `csm_id?: string` filter (in-JS post-fetch); `category='client'` default when no category filter is set.
- `docs/schema/documents.md` — `call_review` added to `document_type` enum; `metadata.sentiment_tier` documented inline on the metadata row.
- `tests/agents/call_reviewer/test_persistence.py` — autouse fixture mocks the classifier; two metadata-match fixtures include `sentiment_tier`.

## What I did, in plain English

Shipped the non-visual half of the Calls redesign. The work splits cleanly into three pieces:

1. **Sentiment classifier** — a small Haiku-backed function that buckets a `sentiment_arc` string into green/yellow/red. It runs once when a call review is generated (hooked inside `upsert_call_review` so both production callers — the Fathom pipeline and the one-shot backfill — pick it up without their own changes), and a paired backfill script lets Drake classify the ~hundreds of existing reviews in one pass.

2. **CSM extensions to the calls data layer** — adds the active primary_csm on both list and detail, and a `csm_id` filter on the list. Implemented per Drake's Option A unblock: mirrors the `client_team_assignments` join-table pattern from `lib/db/clients.ts`. Same pass also lands the client-only category default Drake requested separately.

3. **Action-item server actions** — three functions (`updateActionItemDescription`, `deleteActionItem`, `commitPendingActionItemChanges`) the eventual Confirm-button UI will call. Hard delete per Decision 6, no transaction wrapper per Decision 7, redirect target returned as a string per Decision 7.

Doc updates and the sample-5 classifier sanity check round out the work. Nothing visual touched.

## Verification

- **pytest tests/** — 512 passed (full suite). Includes the modified `test_persistence.py` with its new autouse classifier mock + two updated metadata-match fixtures.
- **npx tsc --noEmit** — clean. Two iterations: once after the calls data-layer changes, once after the server actions landed.
- **Sample-5 classifier sanity check (spec § Hard stops point 3)** — ran `classify_sentiment_tier` against 5 real `call_review.sentiment_arc` values fetched directly from production. 5/5 returned valid green/yellow/red outputs; no refusals, no empty strings, no multi-word responses. Distribution: 1 green + 4 yellow, which read plausibly against the arc text. Classifier ships.
- **Backfill script** — syntax-checked via `ast.parse`; not executed. Drake runs `--apply` himself per spec § Hard stops point 1.

## Surprises and judgment calls

- **CSM data model drift** — the spec assumed `clients.csm_team_member_id` (a direct FK); the actual model is a join through `client_team_assignments` with `role='primary_csm' AND unassigned_at IS NULL`. Surfaced as a hard stop in the partial report; Drake cleared via Option A. Implementation mirrors `lib/db/clients.ts:240-302` — the nested `client_team_assignments` select hangs under the `primary_client` join, and the active CSM is derived in JS via the same `find(a => a.role === 'primary_csm' && a.unassigned_at === null)` predicate. Both list and detail paths use the same predicate so future "primary_csm" semantics changes land in one place.

- **`call_reviewer` doc location** — spec § G referenced `docs/agents/call_reviewer/` (subdir), but `docs/agents/` only contained `ella/` and `gregory.md`. Drake's call: a single top-level file. Created `docs/agents/call_reviewer.md`. If the agent grows (multiple build phases, runbooks, retrieval-rules subdocs), promote to a directory.

- **Classifier-failure handling on the hook** — the spec specified "if the classifier call fails (network error, Haiku timeout, malformed response), log a warning and proceed without the field." Implemented as a try/except around `classify_sentiment_tier` inside `upsert_call_review`. The catch is narrow on purpose — `classify_sentiment_tier` itself already handles malformed-response with the yellow fallback, so the only path that reaches the outer try is a real exception (network, auth). The `_logger.warning` carries the `call_id` so a pattern of failures is greppable.

- **Pipeline test mocking** — `test_persistence.py` previously had no `complete()` mock because the hook didn't exist. Adding the autouse fixture lets the existing tests keep their fake-DB scaffolding without each one knowing about the classifier. The two metadata-match fixtures (`test_..._no_op_when_existing_matches`, `test_..._flips_is_active_back_to_false`) needed `sentiment_tier: _MOCK_TIER` added to stay no-op-equal to what the hook now writes. Test-impact analysis was the surprise — three tests in the file, two needed updates; the others were tolerant.

- **`category` filter shape on `getCallsList`** — landed the client-only default by collapsing the old `if (filters.category)` branch into an `effectiveCategory = filters.category ?? 'client'` line that always applies. There is no "show all categories" escape hatch in this commit. If the UI eventually needs one, the cleanest path is a sentinel (e.g. `category === '__all__'` → skip filter); flagged in case the follow-up UI spec wants it.

- **csm_id filter location (in-JS)** — spec § E sanctioned in-JS at 560-call volume. Implemented alongside the existing `search` filter (also in-JS) and added the same scale-revisit note in code (`~5000`). The team_members(id, full_name) shape comes back nested under each assignment row, so the filter just compares `row.csm_team_member_id === filters.csm_id`.

- **Backfill script reuses `backfill_call_reviews.py`'s CLI shape** — flags (`--smoke`, `--apply`, `--limit`), summary block, even the dry-run-as-default behavior. The classifier path is utility-scoped per spec § A so there's no `agent_runs` telemetry to roll up; the summary tracks tier-count distribution + failure count instead of cost.

- **Sample-5 distribution skew** — the 5 sampled arcs leaned yellow (4/5). Not a classifier defect — re-reading the arcs, only one read as a clear "green relationship momentum"; the other four were genuinely mixed-signal. Worth keeping an eye on the production distribution after Drake's `--apply` run; if 95%+ land yellow across hundreds of reviews, that's a prompt-tightening signal. Logging the prompt verbatim in the file's module docstring makes future iteration cheap.

## Out of scope / deferred

- **All visual surface changes** — `/calls`, `/calls/[id]`, no JSX touched. Reserved for the follow-up UI spec.
- **Filter-by-CSM UI control** — data layer ships here; the dropdown ships in the follow-up.
- **Confirm-button UI** — server actions ship here; the UI invokes them later.
- **Inline-editable action-item rendering** — same split.
- **Migration of calls list/detail to Part 1 primitives** — out of scope.
- **TS tests** — deferred to `gregory-ts-test-infra` per spec § Out of scope.
- **Show-all-categories escape hatch** — not required by the spec; future-spec material if the UI needs it.
- **Removing auth bypass** — Drake-side env-var toggle, not a code change.

## Side effects

- **5 Anthropic API calls** during the sample-5 sanity check against `claude-haiku-4-5-20251001`. Cost trivially small (~$0.005 total). No DB writes — the sanity check used a read-only Python REPL that called `classify_sentiment_tier` directly without going through the backfill's persist path.
- **No production DB writes.** No new rows in any table. No metadata mutations. The hook is plumbed but only fires when `upsert_call_review` is called, which doesn't happen during this spec's execution.
- **No Slack posts, no emails, no shared-system touches** beyond the 5 Anthropic calls.
- **No CI runs touched** — backfill script is committed but not invoked.
