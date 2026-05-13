# Gregory — action items transfer between /calls and /clients
**Slug:** gregory-action-items-transfer-fix
**Status:** in-flight

## Context

Action items created on `/calls/[id]` should appear in the Action items box on the call's primary client's `/clients/[id]` page. After yesterday's redesign, this transfer isn't working. Drake's behavior report: edit action items on `/calls/[id]`, click "Confirm," get redirected to `/clients/[id]`, the Action items box says "no open action items."

The data model is in place — `call_action_items` rows are owned by calls, calls are owned by clients via `primary_client_id`, and `getClientById` already joins through and returns `client.all_action_items`. The bug is somewhere in the read/write/revalidate path, not in the schema.

Working branch: same `gregory-csm-visual-fixes` branch as the active CSM visual fixes (or whichever branch is current — Builder confirms in acclimatization). Preview URL: `https://ai-enablement-git-gregory-csm-visual-fixes-drakeynes-projects.vercel.app`. Auth is bypassed on Preview, so Builder can visually verify.

## Reference reads (in this order)

1. `app/(authenticated)/calls/[id]/action-item-actions.ts` — the three server actions including `commitPendingActionItemChanges` (the Confirm flow). Trace what it actually writes and what it returns.
2. `app/(authenticated)/calls/[id]/action-items-box.tsx` — UI that calls the Confirm action and does the post-success redirect. Verify the redirect actually fires and lands on the right URL.
3. `lib/db/clients.ts` — `getClientById`. Find the JOIN producing `all_action_items`. Verify the predicate (filter by status, by date, by call_category, etc. — any filter dropping items).
4. `app/(authenticated)/clients/[id]/page.tsx` — Action items box. Confirm the filter `status === 'open'` is the only filter on the rendered set. Confirm `revalidatePath` is being called by the Confirm action on the right path.
5. `lib/db/calls.ts` — search for any logic that might intercept action items on Confirm (e.g. soft-deleting, marking as done, archiving).

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message: (a) the precise data flow from "user clicks Confirm on /calls/[id]" to "row exists in DB" to "row appears in client.all_action_items on /clients/[id]" — name every function and table touched, (b) your diagnosis of where the break is — be specific (e.g. "the Confirm action runs but `revalidatePath('/clients/[id]')` doesn't include the dynamic segment correctly" or "the JOIN in getClientById filters by something it shouldn't"), (c) the file map you intend to touch, (d) screenshots from the preview showing the bug reproducing, (e) any unexpected drift between this spec's assumptions and the reality you find.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-14.

1. **Diagnose first, fix second.** This is a debugging spec. Don't refactor anything that isn't broken. Don't add new tests, new infrastructure, new patterns. Find the actual bug, fix it minimally, ship.

2. **Items completed on `/clients/[id]` flip to `status='done'`** (soft, not deleted). Already implemented yesterday. This spec confirms it still works after any fix; doesn't change the contract.

3. **The Calls detail page is the historical record.** When an action item is marked done on `/clients/[id]`, the calls page can still show it (the call's action items reflect what came out of the call, untouched by downstream events). This means no change to the `/calls/[id]` action items view. **Calls page is read-only for completion state from this spec's perspective.**

4. **The transfer goes one direction: calls → clients.** Items created on a call surface on the client. Items completed on the client don't propagate back to the call view (per #3). Edits on the call should propagate to the client. Deletions on the call should remove from the client.

5. **Edge case — calls without `primary_client_id` — not in scope.** All calls in production have a `primary_client_id` per Drake. If Builder finds calls without one during diagnostics, surface but don't try to handle.

6. **Playwright visual verification REQUIRED.** Same hard requirement as the previous spec. Builder reproduces the bug visually, fixes it, verifies the fix visually, screenshots in the report.

7. **Send-to-Slack is out of scope.** Separate spec.

## What success looks like

### A. Bug diagnosis in the acclimatization commit

Builder's first commit names the actual break. Four likely candidates, ordered by suspicion:

1. **`revalidatePath` mis-target.** The Confirm action calls `revalidatePath` on a path that doesn't match the dynamic `/clients/[id]` route. Result: the client page renders cached data from before the action items existed. Fix: correct the revalidate call to match the actual route shape (likely `revalidatePath('/clients/[id]', 'page')` or `revalidatePath(\`/clients/\${primaryClientId}\`)`).

2. **JOIN filter dropping items.** `getClientById`'s `all_action_items` query filters by something subtle — `calls.archived_at IS NULL`, `calls.category = 'client'`, a date range. If any of these filters exclude the action items' source call, items don't surface. Fix: relax or correct the filter.

3. **The Confirm action isn't writing what it claims.** The server action runs without error but the DB row isn't actually being inserted/updated. Could be a silent constraint violation, a transaction issue, a race condition with the redirect. Fix: trace the actual SQL or Supabase call, find where the write drops.

4. **Status semantics mismatch.** Items written by Confirm might land with a status other than `'open'` (e.g. `'pending'`, `null`, `'draft'`). The client page filters to `status === 'open'`, so anything else disappears. Fix: align the write and the read on the same status value.

Builder doesn't have to commit to one path at acclimatization — it should name what it FOUND when investigating. Acclimatization point (b) is "your diagnosis of where the break is."

### B. The actual fix

Once diagnosed, the fix is targeted to that one issue. Don't refactor adjacent code, don't add new abstractions. The transfer either works or it doesn't; make it work.

**Expected size:** 1-5 lines of code, possibly one server-action signature change, possibly one query predicate adjustment. If the fix grows beyond ~20 lines, Builder surfaces — the bug is probably bigger than the spec assumed.

### C. Visual verification

Playwright script `scripts/verify-action-items-transfer.ts` or equivalent. Walks:

1. Navigate to `/calls/[id]` for a known call with action items (Builder picks one from production data with stable test items).
2. Screenshot the action items list in the box.
3. Make a small edit to one action item's text (or note current state).
4. Click "Confirm."
5. Wait for the redirect to `/clients/[id]`.
6. Screenshot the Action items box.
7. Confirm visually: the items from step 2 are now visible in step 6's screenshot.

If the screenshots show items NOT transferring, the fix didn't take — iterate. Report includes the before/after screenshots inline.

### D. Regression check on the completion checkbox

Yesterday's shipped behavior: completing an item on `/clients/[id]` via the checkbox flips its status to `'done'` and removes it from the rendered list. Builder confirms this still works post-fix:

1. On `/clients/[id]`, click the completion checkbox on a visible action item.
2. Item disappears from the list (still in DB as `status='done'`).
3. Refresh the page. Item stays hidden (status persisted).

Screenshot before-and-after. If this regresses, the fix introduced a new bug — back to diagnosis.

## Hard stops

1. **Do not push to `main`.** Push commits to `gregory-csm-visual-fixes` (or whichever branch is the active visual-work branch — Builder confirms with Drake if uncertain).

2. **Do not flip Status to shipped without Playwright screenshots.** Per the procedural fix from the previous spec, visual verification is required.

3. **If the diagnosis reveals the bug isn't in the four candidate paths from § A** — e.g. it's a deeper schema issue, a Supabase config issue, a Next.js framework issue — surface before committing a fix. Don't try to patch around an architectural problem with a workaround.

4. **If the fix turns out to require more than ~20 lines or touches more than 3 files**, surface. The spec assumes a localized debug; broader scope means the spec is wrong and we re-spec.

## Think this through yourself — what could go wrong

- **The bug might already be fixed by yesterday's CSM visual fixes branch work.** If Builder pulled the latest branch and the action items now transfer correctly, surface immediately — no fix needed, just verify and ship the report. (Unlikely but possible.)

- **`revalidatePath` with dynamic segments.** Next.js's `revalidatePath` has quirks with `[id]` dynamic routes — sometimes you need to pass `'page'` as the second arg, sometimes you need to use `revalidateTag` instead. **Mitigation:** Builder tests the actual fix on the preview rather than assuming the syntax is correct.

- **The fix works in dev but not on Vercel's edge cache.** Vercel sometimes holds onto stale page renders longer than dev. **Mitigation:** Playwright on the preview tests against the real cache layer. If items still don't appear after the fix, that's the signal.

- **JOIN filter assumptions.** `getClientById`'s `all_action_items` query may filter by `calls.archived_at IS NULL` (or similar) and there might be a subtle case where new action items live on calls that don't pass the filter. **Mitigation:** Builder reads the actual query, doesn't assume the shape.

- **Completion checkbox regression risk.** If the fix changes how items are read or filtered, the completion checkbox flow could break. **Mitigation:** § D explicit regression check.

- **The "fix" might just be a Vercel build cache issue.** Sometimes a redeploy fixes things that look like code bugs. **Mitigation:** Builder tries a redeploy as a sanity check before assuming the code is broken. If the bug clears with a clean rebuild and no code change, surface that finding — it's a Vercel/Next caching insight worth knowing.

## Mandatory doc-update list

- `docs/state.md` — no update needed; bug fix, not new shipped feature.
- `docs/known-issues.md` — possibly. If the root cause is something worth documenting (e.g. "Next.js revalidatePath quirks with dynamic segments" or "Supabase JOIN filter on archived_at gotcha"), log it. Builder's call.
- `CLAUDE.md` — no update needed.
- `docs/agents/gregory.md` — no update needed.
- `docs/runbooks/design-handoff.md` — no update needed.

## Out of scope for this spec (explicit)

- Send-to-Slack server action (separate spec).
- Any change to `/calls/[id]` action items UI beyond what's required to fix the bug.
- Deduplication of identical action items across calls (CSMs handle manually).
- Notification when action items appear on a client page (not in scope, possible future).
- Reassigning action items to a different owner.
- Adding new action item fields (due date, priority, etc.).
- Tests beyond Playwright screenshots — deferred.
