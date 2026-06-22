# Cost hub — fix current-month total to count mid-month-archived rows (Q1 display bug)
**Slug:** cost-hub-current-month-total-fix
**Status:** shipped

**Target branch: main**

> NOT Ella-worktree work — cost hub is in `app/(authenticated)/cost-hub/` + `lib/db/cost-hub.ts`. Run from the MAIN checkout. The Close backfill is a separate local OS process; unaffected. This fixes ONLY Q1 from `docs/reports/cost-hub-monthly-cost-and-add-investigation.md`. Q2 (add button) needs reproduction first — NOT in scope. Q3 (cancel/remove split) is a SEPARATE follow-up spec — NOT in scope. Resist bundling.

## Why this exists

`docs/reports/cost-hub-monthly-cost-and-add-investigation.md` Q1 confirmed a DISPLAY bug (data is intact): a monthly subscription archived MID-MONTH (e.g. ElevenLabs — active 2026-05-15, archived 2026-05-23, $25.46) wrongly disappears from the CURRENT-MONTH total box, even though it was active for most of the month and Drake paid for it this month. The history view computes this correctly; the current-month box doesn't. The asymmetry IS the bug.

Drake's intent (and the original delete-action docstring's intent): archiving/cancelling a sub should stop it counting NEXT month but keep it counted in months it was active — including the current month if archived mid-month. The fix makes the current-month total honor that.

## Root cause (confirmed in the investigation + Director's read — verify, don't re-derive)

The data layer is already correct; the current-month PAGE path bypasses it:

- `lib/db/cost-hub.ts:subscriptionActiveInMonth(sub, monthStart, monthEnd)` — the CORRECT overlap predicate: active in month M when `effective_from < monthEnd AND (archived_at IS NULL OR archived_at >= monthStart)`. Already handles archived rows correctly.
- `lib/db/cost-hub.ts:fetchSubscriptionsForHistory()` (internal) — fetches ALL subs INCLUDING archived, with real `archived_at`. The history path (`getMonthTotal`) uses this + `subscriptionActiveInMonth` → correct.
- `lib/db/cost-hub.ts:getMonthlySubscriptions()` — filters `.is('archived_at', null)` → returns ONLY non-archived. Correct for the editable table; WRONG as the source for the month total.
- **THE BUG — `app/(authenticated)/cost-hub/page.tsx:71-84`:** the current-month path calls `getMonthlySubscriptions()` (archived already excluded), then filters with `subscriptionActiveInMonth({ effective_from: s.effective_from, archived_at: null }, ...)` — HARDCODING `archived_at: null`. So (a) archived rows never arrive (excluded by the getter), and (b) even if they did, the hardcoded null would defeat the overlap check. That single `activeSubscriptions` list then feeds BOTH the total (`getCurrentMonthTotal`, line 86) AND the editable table (`subRows`, line 92) — which is why the fix must split those two uses.

Symmetric bug for extras: `getCurrentMonthExtras()` filters `.is('archived_at', null)` + `.gte('incurred_on', monthStart)`, so an extra archived mid-month also vanishes from the current-month total. Same class; fix symmetrically.

## What to do

The fix: make the current-month total use the SAME correct logic the history path already uses (include archived rows, check real `archived_at` via `subscriptionActiveInMonth`), while keeping the editable table showing only non-archived rows. Two derived lists from the data, one correct total.

### Subscriptions (the main fix)

1. **In `lib/db/cost-hub.ts`:** the current-month total needs all subs (incl. archived) with their real `archived_at`, filtered by `subscriptionActiveInMonth` for the CURRENT month. Cleanest approach — add a small exported helper, e.g. `getSubscriptionsActiveInCurrentMonth()`, that:
   - fetches all subs with real `archived_at` (reuse/rename `fetchSubscriptionsForHistory` — it currently fetches exactly the right shape but is named for "history"; either export it under a clearer name like `fetchAllSubscriptionsWithArchive()` and keep an alias, or add the new helper that calls it),
   - filters via `subscriptionActiveInMonth(sub, monthStart, monthEnd)` using `getCurrentMonthBoundaries()`,
   - returns the rows (with cost) that count toward the current month.
   Use your judgment on the exact helper shape, but: reuse `subscriptionActiveInMonth` (do NOT write a second overlap predicate — co-edit risk), and don't break the existing `getMonthlySubscriptions()` / `fetchSubscriptionsForHistory()` callers.

2. **In `app/(authenticated)/cost-hub/page.tsx`:** split the one `activeSubscriptions` list into TWO derived lists:
   - **`editableSubscriptions`** — non-archived, active-this-month → feeds the editable `MonthlySubscriptionsTable` (`subRows`). This is the CURRENT behavior (keep it: the editable table should NOT show archived rows as if editable). Today's `getMonthlySubscriptions()` + the active-in-month filter (with real `archived_at: null` since these are genuinely non-archived) is fine for this list.
   - **`activeInMonthSubscriptions`** — includes archived-mid-month rows → feeds `getCurrentMonthTotal`. This is the new correct list from step 1.
   Remove the hardcoded `archived_at: null` from whatever feeds the TOTAL. The editable-table list can keep it (those rows ARE non-archived).

3. **`getCurrentMonthTotal`** already just sums whatever subscription list it's handed — so passing it `activeInMonthSubscriptions` (instead of the table list) fixes the total with no change to that function.

### Extras (symmetric fix)

4. **`getCurrentMonthExtras()`** currently filters `.is('archived_at', null)`, dropping mid-month-archived extras from the total. Fix so the current-month TOTAL includes extras that were incurred this month even if since archived — mirror the subscription approach: the editable extras table shows non-archived, but the total counts archived-this-month extras. NOTE the difference from subs: extras use `incurred_on` (a one-off date), not an `effective_from`/`archived_at` active-window — so "counts this month" means `incurred_on` is in the current month, regardless of `archived_at`. Confirm the exact semantic: an extra incurred this month then archived this month — does Drake want it in the total? Per the Q1 logic (archiving shouldn't retroactively remove a cost already incurred this month), YES. So the total should include extras with `incurred_on` in-month regardless of archived state; the editable table still hides archived. If this requires a second extras fetch (one archived-inclusive for the total, one archived-exclusive for the table), that's fine.

### Important — do NOT change history

The history path (`getMonthTotal` / `getRecentMonthTotals` / `fetchSubscriptionsForHistory`) is ALREADY CORRECT. Don't touch its logic. If you rename `fetchSubscriptionsForHistory`, update its caller in `getMonthTotal` in the same commit, but don't change WHAT it does.

## Acclimatization checklist

Read first, confirm in 4 bullets:
- `app/(authenticated)/cost-hub/page.tsx:60-95` — the `Promise.all` fetch + the `activeSubscriptions` derivation (lines 71-84) + how it feeds both `getCurrentMonthTotal` and `subRows`. THE edit site.
- `lib/db/cost-hub.ts` — `subscriptionActiveInMonth` (168-177, the correct predicate, REUSE), `getMonthlySubscriptions` (archived-excluding getter), `fetchSubscriptionsForHistory` (archived-inclusive internal fetch), `getCurrentMonthBoundaries`, `getCurrentMonthTotal` (just sums what it's given), `getCurrentMonthExtras` (the symmetric extras bug), `getMonthTotal` (the history path — CORRECT, do not change its logic).
- The ElevenLabs row is the live test fixture: archived 2026-05-23, effective 2026-05-15, $25.46 — should appear in May's current-month total after the fix.
- `docs/reports/cost-hub-monthly-cost-and-add-investigation.md` Q1 — the full diagnosis.

## Tests

- Unit-test the new current-month-subscriptions helper: a sub archived mid-current-month IS included; a sub archived BEFORE this month is NOT; a future-dated (effective_from next month) sub is NOT; a non-archived active sub IS.
- Test that the editable-table list still EXCLUDES archived rows (the ElevenLabs row should NOT render as an editable row) while the total INCLUDES it.
- Symmetric extras test: an extra incurred this month then archived this month is still in the current-month total; the editable extras table excludes it.
- If the existing cost-hub test suite has total-computation tests, extend them rather than duplicating.
- `tsc --noEmit` + `next lint` clean (this IS TypeScript — confirm both pass).

## What success looks like

- The current-month total box includes a subscription archived mid-month (ElevenLabs's $25.46 reappears in May's total).
- The editable subscriptions table still does NOT show archived rows.
- History view unchanged (was already correct).
- Extras fixed symmetrically.
- Full suite green; tsc + lint clean.

## Hard stops

- **Q1 ONLY.** Do NOT add the cancel/remove split (Q3) — separate spec. Do NOT touch the add-button path (Q2) — needs reproduction first. If you find yourself adding a `removeMonthlySubscriptionAction` or editing `actions.ts`, STOP — out of scope.
- **Do NOT change the history path's logic.** It's correct. Renames must preserve behavior + update callers same-commit.
- **Reuse `subscriptionActiveInMonth`** — do not write a second overlap predicate (that's the exact co-edit-divergence that caused this bug).
- No schema change, no migration, no data change, no Close touches.
- MAIN-checkout work.

## What could go wrong — think this through yourself

Seeds: the trap that CAUSED this bug is one filter feeding two surfaces with different needs — make sure the editable table keeps excluding archived rows (you don't want an archived sub showing as editable) while ONLY the total includes them; splitting into two clearly-named lists is the safeguard. Don't accidentally double-count: ensure a sub appears in exactly one of the two lists' PURPOSES (the total uses the archived-inclusive list, the table uses the archived-exclusive list — they overlap for non-archived active subs, which is fine, they're different surfaces). For extras, the semantic is `incurred_on`-in-month not an active-window — don't copy the subscription overlap logic literally onto extras; an extra is "in this month" if incurred this month, full stop. Watch the boundary helpers: `getCurrentMonthBoundaries()` returns UTC instants representing EST month edges — use it, don't hand-roll month math. And confirm the ElevenLabs row actually reappears in the total after the fix (it's the live fixture) — but since this is main and the row is real, that's a post-deploy visual check for Drake, not a live-write test.

## Mandatory doc updates

- `docs/runbooks/cost_hub.md` — note the current-month total counts mid-month-archived rows (active-in-month semantics), matching the history view; the editable tables show non-archived only.
- `docs/known-issues.md` — add the two entries the investigation named: (1) "current-month sub total used a different code path from history total — co-edit risk" (now resolved by this fix; log as resolved with the fix reference), (2) "Playwright verifier (`scripts/verify-cost-hub-preview.ts`) doesn't assert archived-this-month-row-still-counts-this-month" (open — the missing assertion that would've caught this).
- `docs/reports/cost-hub-current-month-total-fix.md` — the report.
- Flip this spec's Status to shipped in the same commit as the report IF tests green + tsc/lint clean; the live confirmation (ElevenLabs reappears in May total) is a Drake post-deploy visual check, so note in the report whether it's fully shipped or pending that glance.
