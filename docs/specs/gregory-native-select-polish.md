# Gregory native select dropdown polish
**Slug:** gregory-native-select-polish
**Status:** in-flight
**Target branch:** `main`

## Context

Drake's first visual issue post-merge of the editorial reskin: native `<select>` elements (used by inline-edit on the clients list and on the client detail page) didn't pick up the new theme. Three specific symptoms from his screenshots:

1. **Closed state is light-themed** — white background, light text that's nearly invisible against the warm-dark page background. Stands out against the otherwise-coherent editorial-dark surfaces.
2. **Open state expands the cell** — the open dropdown is taller than the cell row, breaking row height consistency on `/clients` table.
3. **Focus ring persists after blur** — clicking into a cell's select then clicking away leaves a visible box outline on the cell. Compounds visually across multiple recently-touched rows.

The other dropdowns in Gregory (filter bar multi-selects, sort menus) use Radix/shadcn primitives that pick up the theme tokens cleanly. Those look fine and are not in scope.

**Scope: native `<select>` elements only.** These live in two places, both routed through `components/client-detail/editable-field.tsx`:

- Inline-edit cells on `/clients` table (Status, Journey stage, CSM Standing, Trustpilot) via `app/(authenticated)/clients/editable-cell.tsx`
- Section 2 (Lifecycle) and Section 6 (Adoption) on `/clients/[id]` detail page

One component fix cascades to all of them.

## Drake-confirmed scope

- **Path (a) — aggressive closed-state styling + best-effort open-state.** Style the `<select>` closed state to fully match the editorial-dark theme (background, text color, border, padding, height, focus ring). Style `<option>` elements as much as cross-browser support allows for the open menu. Path (b) — replacing native `<select>` with a custom Radix/shadcn Select component — is explicitly NOT in scope.
- **Fix the persistent focus ring.** The box outline not releasing after blur is a real bug, not just a styling miss. Either the focus state is incorrectly persisting on the underlying input, or the ring is on a wrapper that's not detecting blur correctly.
- **Fix the cell-expansion issue.** The open `<select>` shouldn't change the cell's rendered height. May require `appearance: none` + a custom chevron, OR explicit height locking on the closed state to prevent the browser's expanded-state rendering from affecting cell flow.
- **Single component fix.** Changes land in `components/client-detail/editable-field.tsx` for structural concerns, with theme-scoped CSS additions to `app/globals.css` under `[data-theme="gregory-editorial"]` for color tokens. No new components.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. `git status` shows clean working tree. `git checkout main && git pull origin main` to start from current main (post the editorial-skin merge).
2. Read `components/client-detail/editable-field.tsx` in full. Specifically the `renderEditor` branch for `variant="enum"` — that's where the `<select>` element is rendered. Note: this component has had a stale-closure bug history (M5.6) — be aware of the existing `commit(draftOverride)` pattern and don't touch it.
3. Read `app/(authenticated)/clients/editable-cell.tsx` to understand how the wrapper components (EditableStatusCell, EditableJourneyStageCell, etc.) pass props to EditableField. Confirm none of them override styling locally.
4. Read the `[data-theme="gregory-editorial"]` block in `app/globals.css` to know which tokens are available. Specifically need: card/elevated background, primary text color, muted text color, border color, accent (electric blue `#0066FF`), and any focus-ring tokens already defined.
5. Open a Gregory page in a dev server (`npm run dev`) and reproduce the three issues in the browser before changing anything. Take note of which browser you're testing in — Chrome and Safari render native `<select>` open states differently, and the fix needs to be acceptable in both.

## Work

### Step 1 — Fix the closed-state styling

Modify the `<select>` rendering in `EditableField`'s enum variant. Apply theme-aware styling:

- Background: matches the surrounding cell/card (use `var(--color-gregory-bg-elev)` or whatever the existing cell bg is — should be the warm-dark elevated surface, not pure black).
- Text color: `var(--color-gregory-text)` for the selected value.
- Border: subtle, matching other elevated surfaces (`var(--color-gregory-border)` or similar).
- Border radius: matches other form inputs in Gregory (likely 6px or 8px — check what existing buttons / cards use).
- Padding: matches the cell's content padding so the select doesn't change the cell's vertical alignment.
- Font: inherit from parent (the system stack Gregory uses for body text — should already be Inter via the editorial reskin).
- Height: explicit, locked. Don't let browser default the height.
- `appearance: none` + a custom chevron SVG positioned via background-image or `::after` pseudo-element. This is what prevents the browser's native chevron from appearing AND prevents the open-state height shift in most browsers.

Apply via inline Tailwind classes on the `<select>` element if Tailwind utilities reach (`bg-[var(--color-gregory-bg-elev)]` style), OR via a theme-scoped CSS rule in `globals.css` if utilities feel hacky.

### Step 2 — Fix the focus ring

The persistent box outline is most likely one of:

- A `:focus` style on the `<select>` that doesn't have a matching `:focus-visible` or `:not(:focus-visible)` rule, so the focus ring stays even after the element technically loses focus (CSS focus state can be sticky if not reset).
- A wrapper element receiving focus styling via `:focus-within` that doesn't release when focus moves outside.
- The Tailwind utility `focus:ring` or `focus:outline` being applied without a corresponding `focus-visible:` modifier (Tailwind's default focus styles in some configurations don't reset on click-based interactions).

Fix path:

- Use `focus-visible:` instead of `focus:` for ring/outline styles where applicable.
- Explicitly set `&:not(:focus-visible) { outline: none; }` if the issue is browser default focus ring lingering.
- Test by clicking into a cell, then clicking *outside* the table entirely — ring should disappear.

Replace with the electric-blue accent ring: `focus-visible:ring-2 focus-visible:ring-[var(--color-gregory-accent)]` or equivalent theme-scoped CSS.

### Step 3 — Fix cell-expansion

When the `<select>` opens, the cell shouldn't grow. Two paths:

- **Path 3a — `appearance: none` + custom chevron** (already covered in Step 1). This usually fixes the height shift because the browser stops rendering its own dropdown trigger inside the select element.
- **Path 3b — explicit height + overflow handling.** If 3a doesn't fully solve it, add `height: <fixed-px>` and ensure the parent cell has `overflow: visible` so the open menu can extend outside the cell without affecting layout.

Builder picks based on what works in dev testing. Both paths are reversible.

### Step 4 — Style the `<option>` elements for the open menu (best effort)

Native `<option>` elements have limited CSS support:

- Chrome (macOS): respects `background-color` and `color` on `<option>` in most cases.
- Safari: very limited — often ignores option styling entirely.
- Firefox: respects most styling.

Apply theme-matched colors:

```css
[data-theme="gregory-editorial"] select option {
  background: var(--color-gregory-bg-elev);
  color: var(--color-gregory-text);
}
```

Test in Chrome and Safari. Surface in the report which browsers respect the styling. If Safari is bad, accept it — the open menu is brief and the rest of the experience is the main win.

### Step 5 — Verify across all touch points

After the changes, exercise every native `<select>` in Gregory:

- `/clients` table: click into a Status cell, Journey stage cell, CSM Standing cell, Trustpilot cell. Confirm: opens cleanly, doesn't expand the row, blur removes the focus ring.
- `/clients/[id]`: Section 2 status/journey_stage/csm_standing/nps_standing selects. Section 6 trustpilot select. Same checks.
- Confirm clicking into a cell, opening the dropdown, clicking outside (NOT picking an option) leaves the cell in a clean state — no lingering ring, original value preserved.
- Confirm clicking into a cell, opening the dropdown, picking a new option saves correctly (the existing onSave path — should be unaffected, but verify).

### Step 6 — Verify Promethean is unaffected

Same check as the reskin spec: navigate to `/promethean` and any sub-route. The data-theme scope should isolate Gregory's changes. If Promethean's selects look different after this work, something leaked — surface immediately.

### Step 7 — Verify build + push

```bash
npm run build
git add -A
git commit -m "gregory: polish native select dropdowns (closed-state styling, focus ring, cell expansion)"
git push origin main
```

Vercel auto-deploys main. Drake smokes production after.

## Hard stops

- **Do NOT replace the native `<select>` with a Radix or shadcn Select component.** Path (b) is explicitly out of scope. If the structural issues can't be fully solved with CSS + inline styles, document what couldn't be fixed and surface for Drake's call on whether to escalate to a component swap.
- **Do NOT modify `EditableField`'s save/commit logic, the `draftOverride` pattern, or any of the onSave wiring.** This is purely visual + the focus-ring bug. The M5.6 stale-closure history is a real warning — don't refactor the working parts.
- **Do NOT touch the wrapper components in `editable-cell.tsx`.** They pass props to EditableField; changes happen inside EditableField, not in the wrappers.
- **Do NOT add theme tokens outside `[data-theme="gregory-editorial"]`.** All new CSS rules are scoped under that selector. Promethean's `[data-theme="promethean"]` scope must remain unaffected.
- **Do NOT push to a feature branch.** This is a small, low-risk visual fix. Push directly to `main`. Vercel auto-deploys production.
- **Do NOT touch Promethean files** (`components/promethean/`, `app/(authenticated)/promethean/`) for any reason.
- **Do NOT introduce new dependencies.** This is pure CSS + minor JSX adjustments on an existing component.

## What could go wrong

- **The focus ring fix breaks accessibility.** Keyboard users rely on visible focus indicators. The fix should preserve `:focus-visible` rings (keyboard navigation) while removing `:focus` rings (mouse interactions that should clear on blur). Test by tabbing through cells with the keyboard — ring should appear for keyboard focus, disappear when blurred.
- **`appearance: none` + custom chevron looks worse than the browser default.** If the custom chevron treatment looks janky compared to the browser's native one, fall back to the browser default chevron and just style the closed state's background/border. Surface the choice.
- **Safari's native `<option>` styling is so limited that the open menu still looks bad.** Acceptable per scope. The closed state is what's visible 99% of the time.
- **The fix accidentally breaks click-to-edit on the cells.** Edge case: if the new styling somehow interferes with the click event (e.g., a chevron overlay catching clicks), inline-edit could fail. Test every editable cell type after the change.
- **A user is mid-edit when the deploy lands.** They click a dropdown, deploy happens, the page re-renders with new styling. Worst case: visual flicker. The data layer is untouched so saves continue working. Acceptable.

## Mandatory doc updates

- **`docs/state.md`** — one-line entry under the recent Gregory work noting the dropdown polish shipped 2026-05-12. No CLAUDE.md change.
- **No new known-issues entries** unless something legitimately can't be fixed (e.g., "Safari `<option>` styling has limits") — log those for awareness.

## Commit + report

Per CLAUDE.md § Commits, one logical change per commit. This work is small enough to land in a single commit, or split into two if cleaner:

- `gregory: polish native select dropdowns (closed state, focus ring, cell expansion)`
- `docs: log Gregory dropdown polish in state.md` (if it warrants a separate commit)
- `docs: add report for gregory-native-select-polish`

Report at `docs/reports/gregory-native-select-polish.md` on main. Include:

- The exact CSS/JSX changes (paste the relevant before/after blocks).
- Which path was taken for the cell-expansion fix (3a vs 3b).
- Browser testing results: Chrome closed state ✅/❌, Chrome open menu ✅/❌, Safari closed state ✅/❌, Safari open menu ✅/❌ (best-effort acknowledged).
- Confirmation that all six native `<select>` surfaces (4 cells + 2 detail-page sections) were exercised and work correctly.
- Confirmation that Promethean is unaffected.
- `npm run build` status.
- Vercel deployment URL for production.
- A reminder for Drake: smoke the four cell types on `/clients` + the Section 2 + Section 6 selects on a client detail page to confirm the fixes landed.
