# Gregory — client detail page bug fixes (warm-up bundle)
**Slug:** gregory-client-detail-warmup-fixes
**Status:** in-flight

## Context

Three small bugs on the redesigned `/clients/[id]` page surfaced after yesterday's wrap. All three are small, scoped to the one page, easy to ship as a bundle. Working branch is `main`.

The bugs:

1. **CSM standing editable verification + fix if broken.** The page renders `<EditableCsmStandingCell>` for CSM standing today (`app/(authenticated)/clients/[id]/page.tsx` line ~244) — it's wired to `updateClientCsmStandingAction` and uses the same `<EditableField>` primitive as Status / Journey stage / Trustpilot, which all work. Drake's report ("CSM standing not editable") doesn't match what's in the code. **Two real possibilities:**
   - The cell is editable but the affordance isn't visually obvious enough — clicking on the pill might look like it just navigates rather than opens an editor.
   - There's an actual runtime bug — the click handler, the underlying primitive, or the server action breaks for CSM specifically.

   Builder investigates first (run the page, click the CSM standing pill, observe). If it works, the fix is "make the editable affordance visually obvious" (cursor change, subtle hover state, pencil icon, whatever reads as edit-me). If broken, fix the actual bug.

2. **NPS-enabled and Accountability-enabled toggles aren't editable.** These render as static `<GegPill tier="pos" label="On" />` in `page.tsx` (lines ~285-300). No click handler, no edit affordance, no server action. They were always read-only — never wired. The fix is to make both toggleable with on-blur persist matching the inline-edit contract from Part 1 § 1.5.

3. **"Back to clients" / "Back to calls" navigation goes to browser history, not the list page.** `app/(authenticated)/clients/[id]/back-to-clients-button.tsx` uses `router.back()` when `window.history.length > 1`. If you came from `/clients/[other_id]` (e.g. opening multiple clients in tabs, navigating between client details), `back()` goes to that other client, not to `/clients`. Same issue likely exists for the call detail page's back button.

These are all warm-up grade — small, surface-bounded, fast Code spec, fast Builder execution. Bundle as one ship.

## Reference reads (in this order)

1. `app/(authenticated)/clients/[id]/page.tsx` — the client detail page. All three bugs surface here.
2. `app/(authenticated)/clients/[id]/back-to-clients-button.tsx` — the back-button component with `router.back()`.
3. `app/(authenticated)/clients/editable-cell.tsx` — existing editable cells for Status / CSM Standing / Journey Stage / Trustpilot. Pattern to mirror for the new toggle cells.
4. `app/(authenticated)/clients/[id]/actions.ts` — server actions for the client detail page. The new toggle work needs server actions here.
5. `components/client-detail/editable-field.tsx` — the `<EditableField>` primitive the existing cells wrap. The toggle work will use a new variant ("toggle" / "boolean") or compose differently.
6. `app/(authenticated)/calls/[id]/` — find the back-button component for calls (likely a sibling pattern). Same `router.back()` bug there.
7. `lib/client-vocab.ts` — context only, no toggle vocab needed (toggles are boolean).

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message: (a) the state of CSM standing editing — does it work, is it visually obvious, what's actually wrong (paste your observation), (b) the file path of the calls back-button component (likely something like `app/(authenticated)/calls/[id]/back-to-calls-button.tsx` if it exists, or wherever the back-to-calls link is rendered), (c) the pattern you'll use for the toggle cells — extending `<EditableField>` with a boolean variant vs. building a small `<EditableToggle>` component vs. some other approach, (d) the file map you intend to touch, (e) any unexpected drift between this spec and what you find.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-14.

1. **CSM standing is investigation-first.** Code path looks correct. Builder runs the page, clicks, observes. If broken, fix the bug. If working but the affordance is invisible, improve the affordance. Don't refactor what's not broken.

2. **NPS-enabled and Accountability-enabled become editable inline toggles.** Click the pill, it flips. Optimistic update + on-blur persist per the inline-edit contract. Server actions write `nps_enabled` / `accountability_enabled` boolean columns on `clients`. The visual stays as a `<GegPill>` showing "On" or "Off" — the editability is the click affordance, not a new visual treatment.

3. **Back-button uses an explicit `<Link href="/clients">` for clients detail, `<Link href="/calls">` for calls detail.** Drop `router.back()` and the `window.history.length` check entirely. The component becomes a plain Link with the back-arrow styling. Always goes to the list page. If a CSM wants to return to a specific filter view, the URL state on the list page handles that — but the back button is for "leave the detail, return to the index," not "undo the last navigation."

4. **No new design tokens, no new primitives.** The toggle cells reuse `<EditableField>` if a `variant="toggle"` makes sense, or compose a small `<EditableToggle>` if not. Builder's call. Either is fine if it matches the existing inline-edit contract (optimistic, on-blur, no Save button).

## What success looks like

### A. CSM standing affordance (or fix if broken)

If CSM standing IS already editable when Builder clicks the pill on the live preview:

- The affordance is the gap. Builder makes the editable pills (CSM standing, Status, Journey stage, Trustpilot — they all share the issue if it exists) visually signal "click to edit." Options:
  - Subtle hover state — background brightens, cursor changes to text/pointer
  - A small pencil-icon glyph appearing on hover at the right edge of the pill
  - A thin dashed underline under the pill on hover
  - Builder picks within the existing design tokens. No new tokens.
- Apply to all four editable pill cells, not just CSM standing — consistency matters.

If CSM standing IS broken when Builder clicks:

- Identify the actual bug (server action error, primitive misfire, conditional render gap).
- Fix it.
- Document the root cause in Surprises.

### B. NPS-enabled and Accountability-enabled editable toggles

Two new editable cells matching the pattern of `<EditableStatusCell>`:

- **`<EditableNpsEnabledToggle>`** — wraps `<EditableField>` (or a new small `<EditableToggle>` primitive). Display: `<GegPill tier={enabled ? 'pos' : 'muted'} label={enabled ? 'On' : 'Off'} />`. Click flips the boolean. Optimistic update. Calls a new server action `updateClientNpsEnabledAction(clientId, enabled: boolean)`.
- **`<EditableAccountabilityEnabledToggle>`** — same pattern, server action `updateClientAccountabilityEnabledAction`.

New server actions in `app/(authenticated)/clients/[id]/actions.ts`:

- `updateClientNpsEnabledAction(clientId: string, enabled: boolean): Promise<{ success: true } | { success: false; error: string }>`
- `updateClientAccountabilityEnabledAction(clientId: string, enabled: boolean): Promise<{ success: true } | { success: false; error: string }>`

Both write directly to the corresponding boolean column on `clients`. No history row needed (these are operational toggles, not customer data). Mirror the structure of existing actions in this file.

In `page.tsx`, replace the static `<GegPill>` renders for `nps_enabled` and `accountability_enabled` with the new editable toggle components.

### C. Back-button rewrites

**`back-to-clients-button.tsx`** — replace the `router.back()` logic with a plain `<Link href="/clients">`. Keep the visual styling (gold accent, arrow, uppercase mono label). Result: clicking always goes to `/clients`.

**Calls equivalent** — find the calls-detail back button (likely `app/(authenticated)/calls/[id]/back-to-calls-button.tsx` if it exists as a separate file, or inline in `app/(authenticated)/calls/[id]/page.tsx`). Same treatment. Plain Link to `/calls`.

If the calls back button doesn't exist as a separate component yet (inline rendered), Builder's call whether to extract it or fix inline. Match the codebase's existing convention.

### D. Visual verification

Per the new design-handoff runbook, Builder verifies on the deploy preview before flipping to shipped:

- Navigate to `/clients/[any client id]` on the Vercel preview URL.
- Click the CSM standing pill. Confirm it opens the editor (or that the affordance fix makes editability obvious).
- Click the NPS toggle. Confirm it flips and persists (refresh the page; toggle state should match the new value).
- Click the Accountability toggle. Same verification.
- Click "← BACK TO CLIENTS". Confirm it navigates to `/clients`, not browser history.
- Repeat the back-button test from `/calls/[any call id]`.

Use the existing Playwright harness at `scripts/verify-calls-preview.ts` as a template. Builder writes a small `scripts/verify-client-detail-fixes.ts` or extends the existing one. Screenshots inline in the report.

## Hard stops

1. **If CSM standing is broken in a way that requires touching the `<EditableField>` primitive itself** (rather than just the wrapping cell or the server action), stop and surface. The primitive is shared across multiple surfaces; changing it ripples.

2. **If the toggle pattern needs a new design token or new primitive** beyond extending `<EditableField>` or composing existing parts, stop and surface. The bundle is supposed to be small — anything that grows the surface area of Part 1 primitives is out of scope.

3. **If Builder finds the calls back button is structured fundamentally differently** (e.g. it's part of a HeaderBand prop now, not a standalone component), surface the structure before refactoring.

## Think this through yourself — what could go wrong

- **CSM standing might actually work and Drake just missed it.** That's why investigation comes first. Builder runs the page, clicks, reports what it sees. If working, the fix is the affordance.

- **Toggle on-blur is tricky for boolean inputs.** Most inline-edit patterns are click-to-edit, blur-to-save. A boolean toggle is click-to-flip — there's no separate "save" step. **Mitigation:** the toggle's click event IS the save action. No need for blur handling. Optimistic update happens immediately, server action fires, revert on failure. This is simpler than the text-edit case.

- **Removing `router.back()` may upset CSMs who liked returning to a filtered view.** **Mitigation:** the filtered view's state lives in URL params on `/clients`. As long as the list page persists filter state in the URL (it does, per the calls list pattern), navigating to `/clients` shows whatever the user had selected last. They don't lose context.

- **The `<EditableField>` primitive may not accept a `variant="toggle"` cleanly.** Reading the existing variants ("enum", "text", etc.), boolean might not fit the same shape. **Mitigation:** Builder's call — extend the primitive OR build a tiny `<EditableToggle>` wrapper. Either works.

- **`router.refresh()` after a toggle flip might cause visible flicker** if the page re-renders the whole right column. **Mitigation:** the existing cells all do this and don't flicker. If the toggle flickers when others don't, investigate; probably fine.

- **Visual verification might require the auth bypass.** Preview should still have `NEXT_PUBLIC_DISABLE_AUTH=true` set from yesterday. If it's been turned off, Builder asks Drake to flip it back on for verification, then off again after.

## Mandatory doc-update list

- `docs/state.md` — no update needed. Bug fixes, not new shipped features.
- `docs/known-issues.md` — possibly. If Builder finds the CSM standing bug has a deeper root cause worth documenting (e.g. the `<EditableField>` primitive has a subtle bug affecting one cell type), log it. Otherwise no entry.
- `CLAUDE.md` — no update needed.
- `docs/agents/gregory.md` — no update needed.
- `docs/runbooks/design-handoff.md` — no update needed.

## Out of scope for this spec (explicit)

- Action items transfer fix (next spec).
- Send-to-Slack server action (next spec).
- Ella redesign (separate workflow).
- Any other client-detail visual changes.
- Refactoring the `<EditableField>` primitive itself unless absolutely required for the toggle support.
- Adding new pill tiers or design tokens.
- Tests — deferred to `gregory-ts-test-infra`.
