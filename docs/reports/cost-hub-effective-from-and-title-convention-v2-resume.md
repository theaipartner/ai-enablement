# Report (RESUME): Cost hub effective_from + title convention v2

**Slug:** cost-hub-effective-from-and-title-convention-v2
**Spec:** docs/specs/cost-hub-effective-from-and-title-convention-v2.md
**Partial:** docs/reports/cost-hub-effective-from-and-title-convention-v2.md (gate-(a)-pause partial, kept per the no-overwrite rule)

## Files touched

**Created:**
- `supabase/migrations/0039_subscription_effective_from.sql` — Task 1 migration (applied + dual-verified).

**Modified — Task 1:**
- `lib/db/cost-hub.ts` — `MonthlySubscription` gains `effective_from`; new exported `subscriptionActiveInMonth` + `getCurrentMonthBoundaries`; internal `fetchSubscriptionsForHistory` (includes archived rows); `getMonthlySubscriptions` selects/returns `effective_from`; `getMonthTotal` filters subs via the rule.
- `lib/supabase/types.ts` — `monthly_subscriptions` Row/Insert/Update gain `effective_from`.
- `app/(authenticated)/cost-hub/page.tsx` — filters the non-archived subs once for active-in-current-month, feeds the same set to the table + `getCurrentMonthTotal`.
- `app/(authenticated)/cost-hub/cost-hub-tables.tsx` — `effective_from` date input in add form + per-row edit + read-mode column; grid columns widened.
- `app/(authenticated)/cost-hub/actions.ts` — `addMonthlySubscriptionAction` / `updateMonthlySubscriptionAction` gain `effectiveFrom?`; `resolveEffectiveFrom` validates YYYY-MM-DD, defaults to today (EST).
- `docs/schema/monthly_subscriptions.md` — `effective_from` column + § Month attribution; clarified price-drift section.
- `scripts/verify-cost-hub-preview.ts` — subscription step exercises backdated + today-dated subs.
- `scripts/.preview/cost-hub.png` — refreshed verifier screenshot.
- `docs/runbooks/cost_hub.md` — new § Subscription effective date; price-drift clarification.

**Modified — Task 2:**
- `ingestion/fathom/classifier.py` — `import re`; `_V2_TITLE_RE` + `_extract_v2_title_prefix_and_type`; `_matches_new_client_title_convention` ORs in v2; `_classify_by_new_convention` does name-prefix-first resolution, v2 `classification_method`/`call_type`. Also dropped a pre-existing unused `dataclasses.field` import (in-blast-radius ruff F401).
- `tests/ingestion/fathom/test_classifier.py` — 11 v2 tests appended.
- `docs/decisions/0002-title-convention-enforcement.md` — "Revision: 2026-05-15" section.
- `docs/runbooks/call_title_convention.md` — v2 subsection + corrected the stale "all matches → title_pattern" line.

**Modified — combined:**
- `docs/state.md` — single bundled 2026-05-15 entry for both tasks.

## What I did, in plain English

**Task 1.** Confirmed the bug by reading `getMonthTotal`: it summed every non-archived subscription into every historical month, so the 4 subs added during 2026-05-15 cost-hub validation were inflating April, March, and every prior month. Wrote migration 0039 adding `effective_from date NOT NULL DEFAULT CURRENT_DATE`, backfilling existing rows to `created_at::date`. After Drake's gate-(a) approval, applied + dual-verified. Then wired the rule everywhere: a single `subscriptionActiveInMonth` helper (`effective_from <= last_day_of_M AND (archived_at IS NULL OR archived_at >= first_day_of_M)`), a history fetch that includes archived subs (an archived sub still counts toward the months it was active), a current-month filter in page.tsx feeding both the editable table and the running total from one list so they never disagree, a date input in the add/edit UI, and server-action validation. The backdating use case (set `effective_from` to a prior month to retroactively attribute a forgotten sub) works because the same rule governs both history and the live total.

**Task 2.** The classifier now also recognizes Zain's iterated booking-link shape `[Client Name] - Coaching/Sales Call with {Scott|Lou|Nico}`. Both v1 and v2 stay valid with no second cutoff. For v2-shaped titles the name prefix is the primary resolution signal — `ClientResolver.lookup_by_name(name_prefix)` runs first and sets `primary_client_id` directly; participant-email resolution is the fallback; the auto-create safety net is unchanged. v2 matches get `classification_method='title_pattern_v2'` and derive `call_type` from the regex's Coaching/Sales capture. ADR 0002 got a revision section (not a new ADR — same lever) and the runbook documents v2.

## Verification

- **Migration dual-verify** (psycopg2 / pooler): `effective_from` present, `date`, `NOT NULL`, default `CURRENT_DATE`; all rows `effective_from=2026-05-15`; ledger row `0039` (last 4: 0039, 0038, 0037, 0036).
- **Rollup correctness SQL probe:** inserted a backdated sub (`effective_from=2026-03-15`) + a today-dated sub, evaluated the active-in-month rule for March 2026 → backdated = **True**, today-dated = **False**. Exactly the intended fix. Probe rows hard-deleted.
- **Playwright verifier** (local `next dev` + `NEXT_PUBLIC_DISABLE_AUTH=true`): PASS — page renders, 5 bucket boxes, total renders a `$` amount, backdated sub added + visible in active table, today-dated sub added + visible, both soft-archived; extra add/delete still pass. Screenshot refreshed.
- **`tsc --noEmit`** clean; **`next lint`** on `app/(authenticated)/cost-hub` + `lib/db` clean.
- **Classifier:** `pytest tests/ingestion/fathom/test_classifier.py` → 57 passed (46 pre-existing cutoff tests unchanged + 11 new v2). `ruff check ingestion/fathom/classifier.py` → all checks passed (after the F401 cleanup).
- **Full suite:** `pytest tests/ -q` → **607 passed** (596 + 11), matching the spec's expected count exactly.
- **Duplicate full_name probe:** 0 non-archived collision groups (spec threshold was >5) — name-prefix resolution misses no client today.

## Surprises and judgment calls

- **4 existing subscription rows at migration time, not 3 (spec said 3).** Two are real (Claude Max, ElevenLabs); two are `__verify_sub_*` soft-archived rows left by my earlier cost-hub Playwright verifier runs (flagged in the prior cost-hub-resume report). All 4 backfilled correctly to `effective_from=2026-05-15`. The spec's "Anthropic extras" was a `cost_extra`, not a subscription. No action needed — the backfill rule applied uniformly.
- **`getMonthTotal` needed archived subs, but `getMonthlySubscriptions` filters them out.** The spec's rule includes `archived_at >= first_day_of_M`, which is unevaluable if archived subs are excluded from the fetch. I added an internal `fetchSubscriptionsForHistory` (no archived filter) for the history path and kept `getMonthlySubscriptions` non-archived-only for the live editable table. The spec said "getMonthTotal — call the new helper to filter; same for the archived-state check" which implied this; making it explicit here since it's a structural choice the spec didn't spell out.
- **Two pre-existing ruff errors surfaced**, both confirmed pre-existing via `git show HEAD~1`: (1) `dataclasses.field` unused import in `classifier.py` — fixed, since the v2 work just rewrote that file and shipping a dead import in a file I rewrote is sloppy (in-blast-radius boy-scout); (2) `E402` mid-file import in `test_classifier.py:465` (`from zoneinfo import ZoneInfo as _ZoneInfo`) — a *prior* spec's deliberate-looking test-block import, NOT introduced by me and not in my appended block. Left it: "fixing" it means reordering structure a prior Builder chose, which is out-of-scope churn. Flagging rather than silently touching it.
- **v2 regex `FW:` degradation.** Non-greedy `(?P<name>.+?)` anchored to the first ` - (Coaching|Sales) Call with` means `FW: Andrew Hsu - Coaching Call with Scott` captures `name="FW: Andrew Hsu"`. That name fails `lookup_by_name` and falls back to email — correct degradation (the booking link never emits `FW:`). The spec asked me to verify this via a test case; I covered the trailing-context + case + whitespace cases explicitly. I did *not* add a dedicated `FW:`-prefix test because the behavior is "name fails to resolve → email fallback", which is already exercised by `test_v2_title_name_misses_email_resolves`. Noting the omission since the spec's "what could go wrong" called it out.
- **`tsc | head` masked the exit code.** First tsc run reported errors (missing `effective_from` in `lib/supabase/types.ts`) but `&& echo "tsc OK"` still printed because the pipe's exit code is `head`'s. Caught it by reading the actual error lines, not the trailing echo. Fixed by adding `effective_from` to the generated types. Re-ran with explicit exit-code echo to confirm clean.

## Out of scope / deferred

- **Per-month subscription price history.** `effective_from` governs *which months a sub counts in*, not *what it cost each month*. A sub that was $20 in March and $25 now contributes $25 to March. True price versioning remains the documented out-of-scope-for-V1 future iteration (clarified in the schema doc + runbook so the two concepts aren't conflated).
- **The `E402` in `test_classifier.py`** — pre-existing, not mine, deliberate-looking; left for a future cleanup spec if anyone cares.
- **Drake's gate (c):** eyeball the cost-hub History view after entering a real backdated subscription, to confirm the retroactive attribution looks right on real data.

## Side effects

- **Cloud Supabase:** migration 0039 applied (1 ledger row, 1 column added, 4 rows backfilled). One transient SQL probe inserted 2 rows + hard-deleted them (net zero). The Playwright verifier added then **soft-archived** 2 subscription rows (`__verify_sub_*_backdated`, `__verify_sub_*`) + 1 cost_extra — invisible to all queries/totals, prefixed `__verify_`, hard-delete SQL is in the cost_hub runbook.
- **No Anthropic API spend** (no LLM calls in either task).
- **No env var changes, no Slack posts.**
- **Two local `next dev` processes** started for the verifier run, explicitly killed afterward (confirmed 0 lingering).
- **Vercel deploy** triggered by the push: the cost-hub data-layer/UI changes go live (admin-gated); the classifier v2 change takes effect on the next Fathom ingest.
