# Gregory — Primary CSM visual polish + list-page editability
**Slug:** gregory-csm-visual-and-list
**Status:** in-flight

## Context

Yesterday's spec shipped the Primary CSM cell as editable on `/clients/[id]`. Two problems with the result:

1. **Visual is broken.** The Primary CSM row in the Details box is significantly taller than its siblings (Email, Phone, Country, Timezone, Start date — all ~17px tall plain-text rows; the new editable cell uses `EditableField`'s `min-h-9` 36px click target). The asymmetry makes the row read as an error state, not interactive content. Builder flagged this in Surprises and called it a "useful affordance"; Drake disagrees on review — the visual breaks the Details box's coherence.

2. **The list page (`/clients`) still shows Primary CSM as static text in the table column**, not editable. The yesterday spec was scoped detail-page-only; Drake wants list editability too.

Plus a procedural fix:

3. **Builder skipped Playwright on the last two specs.** The runbook requires it; Builder couldn't run it because production-pushes-with-auth-on don't have a previewable URL Playwright can hit without credentials. **Now solved.** Drake created branch `gregory-csm-visual-fixes` with a Vercel preview at `https://ai-enablement-git-gregory-csm-visual-fixes-drakeynes-projects.vercel.app`. Preview-scope `NEXT_PUBLIC_DISABLE_AUTH=true` is set; Playwright can hit the preview without auth. **This spec works on that branch, not on `main`.**

## Reference reads (in this order)

1. `app/(authenticated)/clients/[id]/page.tsx` — current Details box, Primary CSM row at the bottom. The fix: re-style so the row matches sibling height + visual rhythm.
2. `app/(authenticated)/clients/editable-cell.tsx` — `EditablePrimaryCsmCell` from yesterday. Likely needs adjustment for the height issue (or the underlying `EditableField` does).
3. `components/client-detail/editable-field.tsx` — the `EditableField` primitive. Specifically the `min-h-9` and any inline padding/border that's making the cell tall. Builder identifies whether the fix is a prop on `EditableField` (e.g. `compact` mode) or a wrapper-level override.
4. `app/(authenticated)/clients/page.tsx` — current list. Find where Primary CSM is rendered as a column value. Make it inline-editable matching the existing Status / CSM Standing inline-edit pattern in the same table.
5. `app/(authenticated)/clients/editable-cell.tsx` — verify the existing list-row editable cells (Status, CSM Standing) — what pattern are they using on the list specifically? Reuse it for Primary CSM list editability.
6. `lib/db/clients.ts` — `listAvailableCsms()` from yesterday. Used on detail; same data feeds the list. Already exists, reuse.

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message: (a) the actual rendered height of the Primary CSM row vs. its siblings on the live preview (open in your headless browser via Playwright, measure or screenshot), (b) the precise CSS or component-level change you'll make to bring the row's height back in line with siblings — naming the file + selector, (c) the existing list-page pattern for inline-editing CSM Standing or Status (which cell component renders today, where it sits in the table), (d) the file map you intend to touch, (e) any unexpected drift between this spec and what you find. Hard stop if the height fix requires touching `EditableField` in a way that ripples to other surfaces — surface before committing.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-14.

1. **Work on branch `gregory-csm-visual-fixes`.** Not `main`. All commits push to that branch. When work is done and visual verification passes, Drake merges to main. **Do not push directly to main on this spec.**

2. **Visual goal for the Primary CSM row on detail page:** match the height and styling of the sibling rows (Email, Phone, Country, Timezone, Start date) exactly. Plain text rendering for the value, with the editable affordance (hover background + cursor + chevron glyph from yesterday's affordance work) appearing on hover. Click reveals the dropdown. The row should look like "another data row that happens to be editable," not "a separate interactive element awkwardly placed in a list of static rows."

3. **List-page Primary CSM becomes inline-editable.** Use the same `<EditablePrimaryCsmCell>` from yesterday (or factor a list-compatible variant if the detail-cell doesn't fit the table-cell width constraint — Builder's call). Same dropdown options, same server action (`changeClientPrimaryCsm`). When a CSM picks a new value, `router.refresh()` updates the row.

4. **The `—` empty-option pothole stays for this spec.** Builder flagged yesterday that picking the leading `—` option from `EditableField` triggers a friendly error because the RPC doesn't accept null. Builder's lean was to add an `omitEmptyOption` prop on `EditableField`. **Do it in this spec.** Single small prop addition, suppresses the pothole, doesn't ripple. Pass `omitEmptyOption={true}` from both the detail and list Primary CSM cells.

5. **Playwright visual verification is REQUIRED, not optional.** This spec exists partly because Builder couldn't visually verify the last two — and shipped visual-grade bugs as a result. With the preview URL accessible without auth, the gap is gone. **Hard stop: do not flip the spec to shipped without Playwright screenshots in the report showing both surfaces (detail page Details box + list page table row).** No deferring to gate (c) this time.

6. **Detail-page editable row stays in the Details box, same position.** Bottom row of the box. Not promoted to a separate Standing-style section. The point is to match its siblings visually, not to relocate it.

## What success looks like

### A. Detail page — visual fix on the Primary CSM row

The Primary CSM row's height + visual rhythm matches the other Details box rows (Email, Phone, Country, Timezone, Start date).

Most likely fix path (Builder verifies and adjusts):

1. The `EditableField` primitive's `min-h-9` (or whatever similar class is producing the height) is what's making the cell tall. Add a `compact` (or `dense`) prop to `EditableField` that drops the min-height when set. Apply on the detail page's Primary CSM cell.
2. Padding around the value also likely needs to be reduced. The `min-h-9` is wrapper-level; cell content padding is its own thing. Builder spot-checks both.
3. The hover affordance (gold-tinted background, chevron) should still apply — just on a row-height-matched cell. The affordance is the right visual cue; the bug is just that the cell is too big.

Acceptance: the Details box rendered on the preview reads like 6 plain-text rows (Email, Phone, Country, Timezone, Start date, Primary CSM) where the bottom one has a subtle gold hover state when the cursor enters it. Click reveals the dropdown.

### B. List page — Primary CSM inline-editable

In `app/(authenticated)/clients/page.tsx`, the Primary CSM column shows the team_member name. Today it's plain text (or a Link to their profile, if anywhere — confirm). Make it editable inline using the same dropdown pattern from the detail page.

Two paths Builder picks between (verify which fits the table):

1. **Use `EditablePrimaryCsmCell` directly** in the table cell. If the detail-cell fits visually within a table-row constraint (cell width, alignment), use as-is. Simplest path.
2. **Factor a `EditablePrimaryCsmCellCompact` variant** if the detail-cell's width or padding clashes with table layout. Same server action, same options, just visually adjusted for table density.

Acceptance: hover any row's Primary CSM cell on `/clients` → hover affordance. Click → dropdown opens within the table cell. Pick a CSM → row updates, dropdown closes. Refresh page → change persists.

### C. EditableField — `omitEmptyOption` prop

Add an `omitEmptyOption?: boolean` prop (default `false` to preserve existing behavior across all other editable cells). When `true`, the leading `{ value: '', label: '—' }` option is suppressed from the dropdown render. Pass `omitEmptyOption` on both the detail-page and list-page Primary CSM cells.

Acceptance: the dropdown on Primary CSM cells (both surfaces) shows only the four real CSMs + Scott Chasing. No `—` option. The other editable cells (Status, CSM Standing, Journey Stage, Trustpilot) continue to show `—` as before.

### D. Playwright visual verification — REQUIRED

Write or extend `scripts/verify-csm-visual-fixes.ts` (or similar — match existing harness conventions). Script must:

1. Navigate to `https://ai-enablement-git-gregory-csm-visual-fixes-drakeynes-projects.vercel.app/clients` and screenshot.
2. Screenshot the Primary CSM column in particular — visible per-row dropdown affordance on hover.
3. Click into a known client (Builder picks one with stable test data — first row works). Screenshot the Details box.
4. Confirm via screenshot: Primary CSM row's height matches sibling rows.
5. Hover the Primary CSM value, screenshot the affordance state.
6. Click the value, screenshot the open dropdown.
7. Pick a different CSM, screenshot the row after selection.
8. Refresh the page (or call `page.reload()`), screenshot to confirm persistence.

Include all screenshots in the report. The report must explicitly confirm that visual acceptance criteria from § A and § B passed by referencing the screenshots.

If any screenshot reveals a remaining issue (still-too-tall row, dropdown alignment off, hover affordance not showing), iterate before shipping. Don't ship visual work that doesn't visually verify.

## Hard stops

1. **Do not push to `main`.** Push commits to `gregory-csm-visual-fixes`. Drake merges manually after review.

2. **Do not flip Status to shipped without Playwright screenshots demonstrating both surfaces.** This is the procedural fix the spec exists for.

3. **If the height fix requires changes to `EditableField` that ripple to other editable cells** (Status, CSM Standing, Trustpilot, Journey Stage in the Standing box, the list-page filter dropdowns), surface before committing. The `compact` prop should be opt-in, not a behavior change.

4. **If the existing list-page editable cells (Status, CSM Standing) for some reason aren't inline-editable** (i.e. the editable infrastructure isn't already plumbed to the table cells), surface. Spec assumes the pattern is established.

## Think this through yourself — what could go wrong

- **The height fix might cascade.** If `EditableField`'s `min-h-9` is doing meaningful work elsewhere (e.g., keeping the click target accessibility-compliant at 44px-ish minimum tap target), removing it via a `compact` prop on Primary CSM might fail accessibility expectations there. **Mitigation:** keep `compact` opt-in. On compact-mode cells, accessibility is still served — the row's not a tap-target in the strict mobile sense; this is a desktop dashboard. If Drake later wants compact-mode on other surfaces, that's a separate spec.

- **List-page table row height with editable cell.** Tables have their own row-height rhythm. Adding an interactive cell may force the row to grow if `EditableField` insists on `min-h-9` even within a table context. **Mitigation:** `compact` prop solves this here too. Or the list-cell variant Builder factors.

- **`omitEmptyOption` defaulting to `false` is intentional.** Other cells (Status, CSM Standing) actually need the `—` option because their fields are nullable. Don't switch the default; only Primary CSM and any future non-nullable enum cell pass `true`.

- **Visual verification reveals an unexpected issue Builder can't fix in this spec.** E.g. the gold accent looks washed out at the new compact size, or the chevron glyph is misaligned. **Mitigation:** Builder surfaces in the report — doesn't ship blind. Drake decides whether the fix is in scope or a followup.

- **Playwright auth might still trip up.** The preview branch alias should work with the env-var-disabled bypass, but Vercel sometimes has stale cache issues. **Mitigation:** if Playwright hits an auth wall, Builder verifies the env var status with Drake before continuing. Don't fall back to "I'll just trust the code."

- **Scott Chasing in the alphabetical dropdown still sits next to Scott Wilson.** Yesterday's spec accepted this. Not relitigating here unless a CSM specifically reports confusion in the dropdown. Not in scope to add a `(sentinel)` suffix or similar.

## Mandatory doc-update list

- `docs/state.md` — no update needed unless something material shifts during build.
- `docs/known-issues.md` — possibly. If the visual fix surfaces an interesting underlying tension in `EditableField`'s default styling, log it. Otherwise no entry.
- `CLAUDE.md` — no update needed.
- `docs/agents/gregory.md` — no update needed.
- `docs/runbooks/design-handoff.md` — possibly small. If this spec's procedure (work on a feature branch, push to preview, Playwright visually verifies before merging to main) becomes the durable visual-work loop, the runbook should call this out. Builder's call whether to add a one-paragraph note; surface in Surprises either way.

## Out of scope for this spec (explicit)

- Reassigning Primary CSM from any third surface (e.g. /calls/[id] — not happening here).
- Bulk reassignment workflow (e.g. swap all of one CSM's clients to another CSM at once).
- Changing the dropdown filter logic beyond `is_csm=true` + active (already correct).
- Visual disambiguation of the two Scotts.
- Backfilling action items to a new owner.
- Status cascade trigger logic.
- Tests beyond Playwright screenshots — deferred.
- Refactoring `app/(authenticated)/clients/page.tsx:152-159`'s inline query to use `listAvailableCsms()` (cleanup-grade; not blocking).
