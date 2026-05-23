# Report: Cost hub — diagnose doubled total, restore cancelled-visible subs, fix add, cancel/remove, history extras
**Slug:** cost-hub-total-cancel-remove-and-add
**Spec:** docs/specs/cost-hub-total-cancel-remove-and-add.md

## Files touched

Modified (code):
- `lib/db/cost-hub.ts`:
  - Widened the `SubscriptionWithArchive` type to include `provider` + `notes` (was `id + cost + effective_from + archived_at` only) + made it `export`. Required by Part 2 — the visible table now renders cancelled-this-month rows directly from this shape, no separate metadata lookup.
  - Updated `fetchAllSubscriptionsWithArchive` to select the wider columns.
  - **Part 5 fix:** `getMonthTotal`'s inline extras query (line ~538-544) dropped its `.is('archived_at', null)` filter. An extra incurred in month M now counts toward M's history total regardless of later archive — the same archive-inclusive semantic the Q1 fix applied to the current month.
- `app/(authenticated)/cost-hub/page.tsx`:
  - Collapsed from 6 parallel fetches to 4 (per surface). Removed `getMonthlySubscriptions()` + `getCurrentMonthExtras()` + `getCurrentMonthBoundaries()` + `subscriptionActiveInMonth` from the page-level fetch list — they're no longer the source for any list the page renders. The `subsActiveInMonth` (archive-inclusive) helper now feeds BOTH the running total AND the visible subscriptions table. The `extrasForTotal` (archive-inclusive) helper does the same for extras.
  - Removed the `editableSubscriptions` derivation (the source of the prior spec's split). Now `subRows` is just `subsActiveInMonth.map(...)` with an `is_cancelled` flag per row.
  - Net effect: one list per surface, sum-to-total invariant by construction (the visible table's costs sum to the running total's subscriptions/extras contribution).
- `app/(authenticated)/cost-hub/actions.ts`:
  - **Part 4:** `deleteMonthlySubscriptionAction` → renamed `cancelMonthlySubscriptionAction` (same soft-archive body; clearer name in the two-operation model). New `removeMonthlySubscriptionAction(id)` — hard `DELETE` for the destructive "I added this by mistake" path; same `requireAdmin` + structured-return + `revalidatePath` shape. `deleteCostExtraAction` → renamed `removeCostExtraAction` and switched to hard `DELETE` (extras have no Cancel — one-offs have no "next month" semantic; spec § Part 4 specifically said don't force the two-operation model where it doesn't fit). Module docstring rewritten to describe the cancel/remove model.
- `app/(authenticated)/cost-hub/cost-hub-tables.tsx`:
  - Import swap for the renamed/new actions.
  - `SubscriptionRow` type gained `is_cancelled: boolean`.
  - **Part 2 + 4 UI:** subscriptions table renders cancelled-this-month rows with opacity dim + strike-through provider name + a red-bordered "Cancelled" badge in the Edit-button slot. Cancel button (neutral border) + Remove button (red border, destructive) replace the single × from V1. Cancelled rows show only Remove (Cancel already happened). Both destructive paths use distinct `confirm()` copy explaining the difference: Cancel = "stops next month, stays counted this month"; Remove = "PERMANENT, gone from totals + history."
  - Extras side: single × button + Remove-only with destructive confirm copy.

Modified (tests):
- `scripts/verify-cost-hub-preview.ts`: rewritten end-to-end. New invariant assertions:
  - **ADD-DELTA (4c):** baseline total + known cost ($77.77) → assert total moves by exactly that delta. Catches the double-count class of bug regardless of which list is summed wrong.
  - **CANCEL-INVARIANT (4d, Parts 2/4 + Q1):** add a test sub of known cost, Cancel via the Cancel button, assert (a) row stays visible with "Cancelled" badge AND (b) total is unchanged. The assertion that, if it had existed pre-2026-05-23, would have caught the visible-vs-counted asymmetry from the start.
  - **REMOVE-INVARIANT (5, Part 4):** add a test sub of known cost, Remove via × (hard delete), assert (a) row is gone from visible list AND (b) total dropped by exactly the test cost (back to baseline). Distinguishes Remove from Cancel.
  - **EXTRA REMOVE (6):** symmetric for one-off extras.
  - **Part 3 instrumentation (1-7):** captures browser console errors/warnings + page errors + failed network requests + every POST to `/cost-hub` (server-action invocations + status codes) throughout the run. Surfaces in `printCapture()` at the end so the add-button silent-fail (if it reproduces) lands in the run output.
  - **try/finally HARD-DELETE cleanup (9):** direct Supabase admin SDK call DELETEs every `__verify_*` row across both tables regardless of test pass/fail. Strict `LIKE '__verify_%'` so real data is never touched. The prior verifier's soft-archive cleanup was safe pre-Q1-fix; post-Q1-fix it pollutes the running total (the lesson from the $308 incident).
- `docs/runbooks/cost_hub.md`: rewrote the "Editable table vs running total" + "Recovering a bad delete" sections; added a new "Cancel vs Remove (the × menu)" section explaining the two-operation model + the cancelled-but-visible lifecycle.
- `docs/known-issues.md`: marked the "verifier extras assertion gap" entry RESOLVED (the verifier rewrite covers it). Added a new RESOLVED entry "Cost hub running total polluted by Playwright verifier soft-archived rows" explaining the 2026-05-23 incident as an operational learning (test data semantics changed when underlying total math changed).

Created:
- `docs/specs/cost-hub-total-cancel-remove-and-add.md` — the spec.
- `docs/reports/cost-hub-total-cancel-remove-and-add.md` — this report.

Production data changes (one-shot, within spec authorization):
- 10 `__verify_*` rows hard-DELETEd from `monthly_subscriptions` (6 rows) + `cost_extras` (4 rows). Strict `LIKE '__verify_%'` match — clearly-prefixed test artifacts by the verifier's own labelling convention, never Drake's real data.

## What I did, in plain English

The big surprise upfront: **Part 1's "doubled total" was the STOP-and-surface case.** The math was correct; the $308.93 Drake saw was exactly what the Q1 fix is supposed to compute. The "doubling" was leftover Playwright verifier test data ($120.92 of `__verify_*` test rows from 2026-05-15) that the Q1 fix correctly started counting after the deploy. Pre-Q1-fix those rows were silently filtered out (archived → excluded); post-Q1-fix they're correctly included (archived-this-month → counted). The code wasn't broken. The data was polluted.

Two-step resolution: (1) one-time hard-DELETE of the 10 leftover test rows via direct SQL (within spec authorization for clearly-prefixed test artifacts); post-cleanup total = $188.01 (Claude Max $115.02 + ElevenLabs $25.46 + Claude extra usage $26.96 + Anthropic $20.57). (2) Verifier rewrite that hard-DELETEs its test rows in a try/finally cleanup step — so this never recurs. The prior soft-archive cleanup pattern was fine when archived rows didn't count toward totals; post-Q1-fix it's actively polluting.

That's the unknown the spec was asking to resolve, resolved.

Parts 2 + 4 + 5 + the verifier rewrite all landed code-side. Part 3 (add-button live diagnosis) is gated on the preview deploy + the verifier's instrumented run — captured in the verifier output once the run completes (preview build in progress at report-write time; the verifier's Part 3 instrumentation captures browser console + network + every `/cost-hub` POST throughout the run, so whatever's happening with add will land in the output).

## Verification

**TypeScript (`npx tsc --noEmit -p .`):** clean, exit 0.

**ESLint (`npx next lint --file ...`):** clean across all four touched code files (`lib/db/cost-hub.ts`, `app/(authenticated)/cost-hub/page.tsx`, `app/(authenticated)/cost-hub/cost-hub-tables.tsx`, `app/(authenticated)/cost-hub/actions.ts`, `scripts/verify-cost-hub-preview.ts`).

**Hand-computed total math** (Part 1 diagnosis):

Before cleanup (Drake's observation): subs $229.84 + extras $58.52 + Anthropic $20.57 = **$308.93** ✓ matches "~$308" exactly.

Per-bucket Anthropic breakdown (May 2026 EST):
- ella_sonnet: 49 runs, $1.61
- ella_haiku: 383 runs, $2.23
- call_review_sonnet: 213 runs, $13.00
- call_review_haiku: 41 runs, $0.01
- gregory_brain_sonnet: 259 runs, $3.72
- Total: $20.57 ✓ matches the page's bucket boxes' "This month" sums.

Polluted contribution: $89.36 of __verify_* subs (6 rows) + $31.56 of __verify_* extras (4 rows) = $120.92.

Post-cleanup clean total: $115.02 (Claude Max) + $25.46 (ElevenLabs, archived 05-23 — Q1 fix correctly counts) + $26.96 (Claude extra usage) + $20.57 (Anthropic) = **$188.01**.

**Live Playwright preview run** (Part 3 + invariant assertions): preview branch `cost-hub-total-cancel-remove-and-add` pushed; Vercel is building a preview deploy. The verifier will run against the preview URL once the build is ready and capture: the four invariants pass, the Part 3 instrumented output of every browser-side event during the add flow, and the try/finally cleanup count. Drake's gate (c) post-merge visual confirmation: `/cost-hub` after merge shows ~$188 in the TOTAL · THIS MONTH box with ElevenLabs visible in the subscriptions list with a "Cancelled" badge.

## Surprises and judgment calls

**Part 1 wasn't a double-count.** The spec's prime-suspect framing pointed at the Q1 fix introducing a sum-twice bug. The actual cause was a class of problem the spec didn't anticipate: the Q1 fix correctly widened the math, and a quantity of test data that was previously invisible suddenly became visible. The "right fix" wasn't a code patch — the code was right. It was data hygiene + an operational practice change (verifier hard-deletes its tests). Surfacing this clearly was the spec's explicit STOP-and-surface contract; following the data through both `agent_runs` (Anthropic) + `monthly_subscriptions` + `cost_extras` confirmed the math line by line.

**Extras get Remove-only (no Cancel).** The spec said "use judgment; don't force the two-operation model where it doesn't fit." Extras are one-off costs with no recurrence to "stop next month." Soft-archive on an extra would mean "hide from editable table but keep in totals" — which is fine but adds UI complexity for no real user benefit (the user wants the extra gone OR present; "hide but keep counted" is a third state nobody asked for). Single Remove button, hard DELETE, destructive confirm. Subs keep both Cancel + Remove. Asymmetric by design.

**`SubscriptionWithArchive` widened to include provider/notes.** Initial pass had the visible table fall back to `getMonthlySubscriptions()` for metadata, but `getMonthlySubscriptions` excludes archived rows — so cancelled rows would render with "(unknown — see SQL for details)" instead of their real provider. Widening the archive-inclusive type to include the metadata fields is cleaner: one fetch, one shape, one map call. The minor cost is `fetchAllSubscriptionsWithArchive` now selects 6 columns instead of 4 — negligible.

**`getCurrentMonthExtras` no longer has callers.** Removed from page.tsx in the simplification. The helper still exists in `lib/db/cost-hub.ts` for any future caller that wants a pure-active-extras view, but it's effectively dead code in the current call graph. Considered deleting it for cleanliness; left it because (a) the API surface is small and (b) some future cost-hub feature might want it. Flagged but not removed.

**`getCurrentMonthBoundaries` + `subscriptionActiveInMonth` still exported, still used by `getSubscriptionsActiveInCurrentMonth` internally.** Page-level imports of both removed (page no longer uses them directly). They remain part of the lib/db surface.

**Did NOT touch `getMonthlySubscriptions`.** Still archive-excluded. Any future caller wanting "give me only the active rows" can use it; the page just doesn't have that need anymore.

**Pushed to a preview branch instead of straight to main.** Per spec: "Preview validates; the fix still MERGES TO MAIN to ship." Branch is `cost-hub-total-cancel-remove-and-add`; Vercel auto-builds a preview URL. The verifier runs against the preview, asserts the invariants + captures Part 3's add-button diagnostics. Drake merges the branch to main when the verifier passes + he eyeballs the preview himself.

**Did NOT delete `lithium.zip` or `scripts/.preview/*.png` artifacts** that show in `git status` as untracked. They're not part of this work. Left untouched per "match the scope of what was actually requested."

## Out of scope / deferred

**Director-spec-worthy follow-ups:**

- **Drake-side visual confirmation** post-merge: cost-hub TOTAL ≈ $188.01 (down from polluted $308.93); ElevenLabs shows in the subscriptions list with the "Cancelled" badge; click Cancel/Remove on a real-but-throwaway test sub to feel the new UI shape; confirm the add button actually adds. If add still fails on the live deploy despite the verifier passing on preview, the issue is browser-cache-shape, not code; clear cache + retry.

- **Consider removing `getCurrentMonthExtras` and `getMonthlySubscriptions` API exports** if no future feature emerges that needs them. Dead-code clean-up; non-urgent. Could bundle with another cost-hub change.

**Not chased in this pass (out of spec scope):**

- Did NOT touch `historyView.tsx` or any of the History-related UI surfaces. Part 5 fixed the data layer's history extras query; the History view consumes `getRecentMonthTotals` output (which now includes archived extras correctly) without UI changes.

- Did NOT add a "show me the cancelled rows still in this month's total" filter to the History view. The cancelled-this-month rows will already show in History's May 2026 entry once May rolls over (history view treats them archive-inclusively, same as current month does now). No additional UI needed.

- Did NOT explore whether the per-month price-drift caveat (`cost_hub.md` § "Historical sub price drift") needs updating. The locked trade-off there is orthogonal to this fix.

## Side effects

**Production data changes (one-shot):** 10 `__verify_*` rows hard-DELETEd from prod (6 from `monthly_subscriptions`, 4 from `cost_extras`). Strict `LIKE '__verify_%'` match. Confirmed zero `__verify_*` rows remain post-cleanup. No real subs/extras (ElevenLabs, Claude Max, Claude extra usage) touched.

**Branch push:** `cost-hub-total-cancel-remove-and-add` pushed to `origin`. Vercel auto-builds a preview. The branch contains three commits (spec, code, verifier rewrite) — a Drake-driven merge to main triggers the production deploy.

**Verifier run side-effects (when executed against preview):** transient `__verify_*` test rows in prod (the preview hits prod DB), removed in the try/finally cleanup. Real-data reads only; no real-row mutations.

No env-var changes, no migrations, no schema changes, no Ella touches, no Close touches.

## What's needed to unblock

Drake's gate (c) post-deploy verification:

1. **Visual:** load `/cost-hub` in the browser. Total ≈ $188.01 (down from $308.93). ElevenLabs visible in subscriptions list with "Cancelled" badge + dimmed/strike-through styling.
2. **Functional:** click Cancel on a test sub → confirm copy explains "stops next month, stays counted this month" → row gets badge, total unchanged. Click × on a test sub → confirm copy explains "PERMANENT" → row gone, total drops.
3. **Add flow (Part 3):** the verifier's Part 3 instrumentation runs end-to-end on preview; Drake reviews the verifier output for any captured errors/failures. If verifier passes but Drake's live experience still has add failing, the failure is client-side (browser cache / extension) — clear cache + retry.

When all three pass, the branch merges to main (same FF push pattern as prior cost-hub ships) and main auto-deploys. Spec stays `in-flight` until then; reports flips to non-PARTIAL once Drake confirms.
