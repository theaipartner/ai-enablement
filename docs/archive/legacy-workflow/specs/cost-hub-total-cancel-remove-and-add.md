# Cost hub — diagnose doubled total, restore cancelled-visible subs, fix add, cancel/remove, history extras
**Slug:** cost-hub-total-cancel-remove-and-add
**Status:** in-flight

**Target branch: main**

> NOT Ella-worktree work — cost hub is `app/(authenticated)/cost-hub/` + `lib/db/cost-hub.ts` + `actions.ts`. Run from the MAIN checkout. Close backfill is a separate local OS process; unaffected. This is a multi-part cost-hub spec; the FIRST part is a diagnosis that gates the rest. Test via a PREVIEW deploy with Playwright (details in § Testing). The fix MERGES TO MAIN after preview validation — preview validates, main ships.

## Context

Follows `docs/reports/cost-hub-current-month-total-fix.md` (the Q1 mid-month-archived fix, just shipped). After that deploy, Drake observed five things. This spec addresses all five. **Part 1 is diagnose-first** — it may be a regression from the Q1 fix.

## Part 1 — DIAGNOSE FIRST: the current-month total nearly doubled to ~$308

After the Q1 fix deployed, the "TOTAL · THIS MONTH" box jumped to ~$308 — roughly DOUBLE the prior value. Adding one $25.46 archived sub back should have moved it UP ~$25, not doubled it. **This strongly suggests the Q1 fix introduced a double-count.**

Diagnose before changing anything. The prime suspect: the Q1 fix added `getSubscriptionsActiveInCurrentMonth()` (archive-inclusive) alongside the existing `getMonthlySubscriptions()` (archive-excluding), and the page now derives two lists (`editableSubscriptions`, `subsActiveInMonth`). If the total sums BOTH lists, OR if `getCurrentMonthTotal` is being passed a list that overlaps another summed list, OR if subs are counted in both the archive-inclusive AND editable paths feeding the total — that doubles the subscription contribution. Same possibility for extras (`extras` vs `extrasForTotal`).

Read `app/(authenticated)/cost-hub/page.tsx` (the `Promise.all` + the two derived lists + what gets passed to `getCurrentMonthTotal`) and `lib/db/cost-hub.ts:getCurrentMonthTotal`. Determine EXACTLY what's being summed. Confirm with data: query `monthly_subscriptions` (non-archived + the active-this-month set), sum their `monthly_cost_usd`, add the Anthropic month buckets + this-month extras by hand, and compare to ~$308. Pinpoint the double-count (or whatever the real cause is) with the specific line.

Then execute the fix in the same run — Drake has authorized fixing the diagnosed cause without a round-trip, FOR THE EXPECTED CLASS of bug (a double-count / wrong list summed). The total should equal: Anthropic-this-month + each active-this-month subscription counted ONCE + this-month extras counted ONCE.

STOP-and-surface exception: if the diagnosis finds the total is NOT a double-count — e.g. the $308 is actually correct and the prior lower number was wrong, or there's a cause that implies a different/larger problem — do NOT force a fix to make the number look like the old value. Surface the finding. "Execute on findings" applies to the expected double-count class; a genuinely surprising finding gets flagged, not patched.

## Part 2 — Cancelled subs stay VISIBLE in the list with a "cancelled" badge

Drake wants the monthly-subscriptions LIST to show cancelled subs (that are still in their paid month) with a "cancelled" label/badge — NOT hide them. Rationale: the page's visible line items should visually sum to the "this month" total. If ElevenLabs is counted in the total but invisible in the list, the page doesn't add up. So:

- A sub that is cancelled (soft-archived) BUT still active in the current month (archived_at is this month, effective_from <= now): SHOWS in the subscriptions list with a "cancelled" badge, its cost still displayed, still counted in the current-month total.
- A sub that is cancelled and whose paid month has PASSED (archived before this month started): does NOT show in the current list (it's no longer counted this month, so showing it would break the sum-to-total property). It remains in history.
- A sub that is active / not cancelled: shows normally, editable.

So the subscriptions list = active subs (editable) + cancelled-but-still-counted-this-month subs (badged, NOT editable — they're on their way out). The list's visible costs should sum to the subscriptions portion of the total. This supersedes the prior Q3 proposal that hid cancelled subs — visible+badged is the chosen design.

## Part 3 — FIX the add button (with live Playwright diagnosis)

The investigation (`docs/reports/cost-hub-monthly-cost-and-add-investigation.md` Q2) found NO code-level bug in the add path and zero `/cost-hub` server-action traffic in Vercel logs — suggesting the add request never reached the server (stale cache / client-side issue / never actually attempted against the live deploy). Drake confirms add STILL doesn't work.

This time, diagnose it live via Playwright on the preview deploy (auth disabled there — see § Testing). Drive the add form: fill provider + cost, click Add, observe. Determine which:
- The server action fires and succeeds but the UI doesn't reflect it (refresh/revalidation bug) — fix the client-side refresh.
- The server action fires and returns `{success:false, error}` but the UI swallows the error — surface it / fix the rejection cause.
- The server action throws (check the preview's function logs / browser console) — fix the throw.
- The submit handler never calls the action (client-side wiring / disabled-button / event-handler bug in `cost-hub-tables.tsx`) — fix the wiring.

Playwright can read the browser console + network tab + the DOM, so the failure mode is observable live. Fix the diagnosed cause in the same run. Capture in the report exactly what was wrong (this is the thing we couldn't see without live interaction).

## Part 4 — Cancel-vs-Remove on the × button (the two-operation model)

Today the × button → `deleteMonthlySubscriptionAction` → soft-archive. Drake wants the × to offer a CHOICE:

- Click × → a small confirm/menu appears with two options:
  - Cancel — soft-archive (`archived_at = now()`). Stops counting NEXT month; STAYS counted + visible-with-badge this month (per Part 2). For "we cancelled the sub but already paid this month."
  - Remove — hard `DELETE` the row. Gone from everything including this month. For "I added this by mistake." Destructive — the confirm must clearly warn "permanent, removed from all totals/history."

Implementation:
- Keep `deleteMonthlySubscriptionAction`'s soft-archive but rename to `cancelMonthlySubscriptionAction` for clarity (update callers same-commit).
- Add `removeMonthlySubscriptionAction(id)` — hard DELETE, same `requireAdmin` + structured-return + `revalidatePath` shape.
- `cost-hub-tables.tsx`: the × opens the two-option choice (a small inline menu or a confirm dialog with two buttons — your judgment on the cleanest UI; the Remove path needs a distinct destructive confirm).
- Sequencing: Part 1 (correct total) must be sound first, or cancel-vs-remove behave indistinguishably (the whole reason Q1 came first). Since Part 1 is in this same spec, just ensure the total logic is fixed before/with these actions.
- Apply the same model to `cost_extras` rows ONLY if it's clean to do so symmetrically — but extras are one-offs (no "next month"), so for extras "cancel" doesn't really mean anything; extras likely just need "remove" (hard delete) + the existing archive. Use judgment; don't force the two-operation model where it doesn't fit. Flag the decision in the report.

## Part 5 — Fix the history extras bug (same shape as Q1, for extras, in history)

The Q1 report flagged: `lib/db/cost-hub.ts:getMonthTotal` (the HISTORY path) computes extras via an inline query filtering `.is('archived_at', null)` — so a one-off extra archived in a past month is wrongly dropped from THAT month's history total. Same bug class Q1 fixed for the current month. Fix history's extras query to include archived extras whose `incurred_on` falls in the month being totalled (an incurred cost counts for its month regardless of later archival — same semantic as Part 2's current-month extras). Subscriptions in history are already correct (they use the archive-inclusive helper); this is extras-only.

## Acclimatization checklist

Read first, confirm in 5 bullets:
- `app/(authenticated)/cost-hub/page.tsx` — the two derived lists + what feeds `getCurrentMonthTotal` (Part 1 prime suspect) + how the subscriptions list renders (Part 2).
- `lib/db/cost-hub.ts` — `getCurrentMonthTotal`, `getSubscriptionsActiveInCurrentMonth`, `getMonthlySubscriptions`, `subscriptionActiveInMonth`, `getCurrentMonthExtras` / `getCurrentMonthExtrasForTotal`, `getMonthTotal` (Part 5 history extras), `getCurrentMonthBoundaries`.
- `app/(authenticated)/cost-hub/actions.ts` — the six actions; `deleteMonthlySubscriptionAction` (→ rename cancel) + where `removeMonthlySubscriptionAction` (Part 4) slots in; the add actions (Part 3).
- `app/(authenticated)/cost-hub/cost-hub-tables.tsx` — the add form (Part 3) + the × button + row rendering (Parts 2, 4).
- `scripts/verify-cost-hub-preview.ts` — the existing Playwright verifier (extend it for the new assertions; it's the live-test surface).

## Testing — Playwright on a PREVIEW deploy

Drake's directive: test live via Playwright against a preview deploy (auth disabled there, so the page is reachable + interactive). The existing `scripts/verify-cost-hub-preview.ts` is the harness — extend it.

- Push to a preview deploy (a branch push or `vercel deploy` produces a preview URL with `NEXT_PUBLIC_DISABLE_AUTH=true` per the existing preview pattern). Point the verifier at it via `PREVIEW_URL`.
- CRITICAL — use disposable, clearly-labelled test rows and CLEAN THEM UP. The preview deploy hits the REAL production Supabase (previews are not DB-branched). So Playwright "playing around" writes to live cost data. Use the `__verify_*` prefix convention the verifier already uses; soft-archive or hard-delete every test row created, in a cleanup step that runs even on assertion failure (try/finally). Do NOT mutate Drake's real subscription rows (ElevenLabs, etc.) during testing — only create/manipulate/clean up clearly-prefixed test rows. The diagnosis reads of real rows are fine (read-only); the interactive testing uses test rows only.
- What to test live:
  - Part 1: after the total fix, total = hand-computed expected (no double-count). Add a test sub of known cost → total moves by exactly that. (Don't assert against the real $308 — assert the delta math with test rows.)
  - Part 2: cancel a test sub dated this month → it stays in the list with a "cancelled" badge AND stays in the total; a test sub archived-as-of-before-this-month does NOT show in the current list.
  - Part 3: the add button actually adds (this is the live diagnosis + fix — capture what was wrong).
  - Part 4: × → Cancel (soft-archive, badge, still counted) vs × → Remove (hard delete, gone from total). Two distinct outcomes on test rows.
  - Part 5: history extras — harder to test live (needs past-month data); a unit-style assertion or a documented manual check is acceptable if live testing isn't clean.
- tsc + lint clean.

## Hard stops

- Part 1 is diagnose-first. Execute the fix on the diagnosed double-count (or expected-class cause) WITHOUT a round-trip — but STOP-and-surface if the finding is genuinely surprising (total is actually correct / a different larger problem). Don't patch a number you don't understand.
- Do NOT mutate real subscription/extra rows during Playwright testing. Test rows only (`__verify_*`), cleaned up in try/finally. Read-only on real rows.
- Remove is a hard DELETE — gate it behind a clear destructive confirm. Don't make × → Remove a single-click; it's irreversible.
- Preview validates; the fix still MERGES TO MAIN to ship. Note in the report that main-merge is the deploy step (Drake does it).
- No Close touches, no Ella touches. MAIN-checkout work.
- No migration expected (all columns exist: `archived_at`, `effective_from`, `incurred_on`). If you think one's needed, STOP and surface (gate a).

## What could go wrong — think this through yourself

Seeds: Part 1's double-count is the most likely story but VERIFY against hand-computed data before "fixing" — if you just subtract until it matches the old number you might hide a real cost that SHOULD be there now (e.g. ElevenLabs legitimately adds $25). Part 2's "still counted this month vs dropped after month passes" hinges on `subscriptionActiveInMonth` + `getCurrentMonthBoundaries` — reuse them, don't hand-roll. Part 2 + Part 4 interact: a cancelled sub shows badged THIS month, so the cancel action must NOT also remove it from the visible list immediately — it stays till month rollover; make sure the list-render logic (which subs to show) includes "archived this month" not just "not archived." The badge requires the render path to KNOW a sub is archived — but the current editable list excludes archived rows entirely, so you'll need the list that feeds the TABLE to also include archived-this-month rows (badged, non-editable) while still excluding archived-before-this-month — that's a render-list change, not just a total change. Part 3: the add bug showed no server traffic, so the cause is plausibly client-side (the submit handler, a disabled button, a Next-action wiring issue) — Playwright's console + network capture is how you SEE it; don't assume it's server-side. Part 4 cost_extras: don't force "cancel" onto one-offs where it's meaningless. Part 5: history extras fix must match the per-month `incurred_on` semantic, and must NOT break the subscription history logic that's already correct. And the big one: Playwright on preview writes to PROD DB — a test run that doesn't clean up leaves junk in Drake's real cost data; try/finally cleanup is mandatory.

## Mandatory doc updates

- `docs/runbooks/cost_hub.md` — cancelled-but-visible subs + the cancel/remove distinction + the corrected total semantics + history extras fix.
- `docs/known-issues.md` — resolve the Part 5 history-extras entry (the open one the Q1 report logged) + the verifier-extras-assertion entry if Part 2/4 testing covers it; log Part 1's root cause (if it was a regression from the Q1 fix, note that honestly — a same-week regression is worth recording).
- `docs/reports/cost-hub-total-cancel-remove-and-add.md` — the report. Lead with Part 1's diagnosis (what made it $308) and Part 3's diagnosis (what was actually wrong with add) — those are the two unknowns this spec resolves.
- Flip Status to shipped when preview-tested + tsc/lint clean; note the main-merge is Drake's deploy step.
