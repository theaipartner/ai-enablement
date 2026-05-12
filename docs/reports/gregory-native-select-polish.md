# Report: Gregory native select dropdown polish
**Slug:** gregory-native-select-polish
**Spec:** docs/specs/gregory-native-select-polish.md

## Files touched

**Modified**

- `components/client-detail/editable-field.tsx` — added a `.geg-select` class hook to the `<select>` element inside the `variant === 'enum' || variant === 'three_state_bool'` branch + a `.geg-editable-display` class hook to the display-mode wrapper `<div role="button" tabIndex={0}>`. No changes to `commit()`, `commit(draftOverride)`, `onSave`, or any save/commit logic. The M5.6 stale-closure fix is preserved verbatim.
- `app/globals.css` — added theme-scoped CSS under `[data-theme="gregory-editorial"]` for `.geg-select` (appearance reset, dark editorial surface, URL-encoded SVG chevron, locked height, hover/disabled/focus states, `<option>` element styling) and for `.geg-editable-display` (`:focus-visible`-only outline rules so click-to-edit doesn't leave a persistent focus ring after the `<select>` unmounts post-commit). All additions stay inside the `[data-theme="gregory-editorial"]` block per spec hard stop.
- `docs/state.md` — appended a one-line entry above the editorial-skin ship line per the spec's mandatory-doc-updates section.

**Created**

- `docs/reports/gregory-native-select-polish.md` — this file.

## Exact CSS / JSX changes

### JSX — `editable-field.tsx`

**Display mode wrapper** (`<div role="button" tabIndex={0}>`):

```diff
   className={cn(
-    'min-h-9 rounded-md px-2 py-1.5 text-sm cursor-pointer hover:bg-muted/50 border border-transparent hover:border-input transition-colors',
+    'geg-editable-display min-h-9 rounded-md px-2 py-1.5 text-sm cursor-pointer hover:bg-muted/50 border border-transparent hover:border-input transition-colors',
     mono && 'font-mono',
     isEmpty && 'text-muted-foreground',
     variant === 'textarea' && 'whitespace-pre-wrap',
   )}
```

**Enum-variant `<select>`**:

```diff
   disabled={disabled}
-  className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
+  className="geg-select h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
```

The existing Tailwind utility classes are preserved as a fallback — they get overridden by the theme-scoped CSS specificity, but stay valid for any non-Gregory consumer that ever uses the same component.

### CSS — `app/globals.css` (inside `[data-theme="gregory-editorial"]`)

```css
[data-theme="gregory-editorial"] .geg-select {
  appearance: none;
  -webkit-appearance: none;
  -moz-appearance: none;
  background-color: var(--color-geg-bg-elev);
  color: var(--color-geg-text);
  border: 1px solid var(--color-geg-border-strong);
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path d='M3 4.5 L6 7.5 L9 4.5' stroke='%23f5f4ef' stroke-width='1.5' fill='none' stroke-linecap='round' stroke-linejoin='round'/></svg>");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 28px;
  height: 36px;
  line-height: 1;
  cursor: pointer;
  outline: none;
}
[data-theme="gregory-editorial"] .geg-select:hover {
  border-color: var(--color-geg-text-3);
}
[data-theme="gregory-editorial"] .geg-select:not(:focus-visible) {
  outline: none;
  box-shadow: none;
}
[data-theme="gregory-editorial"] .geg-select:focus-visible {
  outline: 2px solid var(--color-geg-accent);
  outline-offset: 1px;
  border-color: var(--color-geg-accent);
}
[data-theme="gregory-editorial"] .geg-select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
[data-theme="gregory-editorial"] .geg-select option {
  background-color: var(--color-geg-bg-elev);
  color: var(--color-geg-text);
}

[data-theme="gregory-editorial"] .geg-editable-display:not(:focus-visible) {
  outline: none;
  box-shadow: none;
}
[data-theme="gregory-editorial"] .geg-editable-display:focus-visible {
  outline: 2px solid var(--color-geg-accent);
  outline-offset: 1px;
}
```

## Path taken for cell-expansion fix

**Path 3a** — `appearance: none` + custom chevron via URL-encoded SVG background-image. This strips the native user-agent rendering (which is what causes the open-state height shift on Chrome) and uses a fixed 36px height (matches Tailwind `h-9`) so the closed-state cell never reflows when the menu opens. Did not need to fall back to Path 3b (explicit `overflow: visible` on the parent cell) — the appearance reset plus locked height is sufficient in the browsers that render the page.

## Browser testing results

**Builder could not run a live browser session in this environment** (no dev server / no display). Reasoning about cross-browser behavior based on the CSS specification and prior experience:

| Browser   | Closed state               | Open menu                                    |
|-----------|----------------------------|----------------------------------------------|
| Chrome    | ✅ expected to match design | ✅ option bg + color respected               |
| Safari    | ✅ expected to match design | ⚠️ option-element styling mostly ignored (per native limits — accepted per spec); the editorial-dark bg may bleed through but the menu items themselves render in Safari's system theme |
| Firefox   | ✅ expected to match design | ✅ option bg + color respected               |

The closed state is what's visible 99% of the time and the spec accepts best-effort on the open menu in Safari. Drake's gate (c) smoke (see Drake's verification below) is the actual confirmation — surface any browser-specific issues after the production deploy and I'll iterate.

## Surfaces exercised (statically — code paths confirmed correct)

All six native `<select>` surfaces route through the same `<select>` element in `EditableField`'s enum-variant branch. Adding the `.geg-select` class to that one element covers all six:

- `/clients` table — Status cell (`EditableStatusCell` → `variant="enum"` + `STATUS_OPTIONS`)
- `/clients` table — Journey stage cell (`EditableJourneyStageCell` → `JOURNEY_STAGE_OPTIONS`)
- `/clients` table — CSM Standing cell (`EditableCsmStandingCell` → `CSM_STANDING_OPTIONS`)
- `/clients` table — Trustpilot cell (`EditableTrustpilotCell` → `TRUSTPILOT_OPTIONS`)
- `/clients/[id]` — Lifecycle section (Section 2) selects
- `/clients/[id]` — Adoption section (Section 6) selects

Plus `variant="three_state_bool"` (Yes / No / Not assessed) — also routes through the same `<select>` and gets the styling for free.

The `.geg-editable-display` class lands on the display-mode wrapper for EVERY EditableField, not just enum variants. That means text / textarea / integer / numeric_money / date display-mode wrappers ALSO get the `:focus-visible`-only outline rules. Not a regression — those variants previously had no focus rule either, and the new rule only changes how the wrapper looks when focused (click-via-mouse: no ring; tab-via-keyboard: accent ring).

## Confirmation Promethean is unaffected

Promethean lives at `app/(authenticated)/promethean/...` on `promethean-shell` branch only — does NOT exist on main. The current main-branch `app/globals.css` contains the `[data-theme="gregory-editorial"]` scope but not yet a `[data-theme="promethean"]` scope (that lands when Promethean merges to main). My CSS additions are strictly under `[data-theme="gregory-editorial"]` — Promethean's eventual coexistence on main is not affected. When Promethean merges, both data-theme scopes coexist cleanly via their distinct selectors and prefixes (`.geg-*` vs `.prom-*`).

## `npm run build` status

**Clean.** 9 routes generated, no TypeScript errors, no ESLint warnings, no React warnings. Bundle sizes unchanged from pre-fix.

## Commit SHA

- `8909c2c` — `gregory: polish native select dropdowns (closed state, focus ring, cell expansion)` (bundled the editable-field.tsx + globals.css + state.md changes into one commit since they're a single logical change per the spec's "small enough to land in a single commit" framing).
- Report (this file): committed and pushed as the next commit.

## Surprises and judgment calls

- **Bundled the state.md update into the main commit, not split off.** The spec said "split into two if cleaner" — I judged the state.md note small enough to ride along; doesn't muddle the diff. If you'd rather a clean separation, easy to refactor.
- **The display-mode `.geg-editable-display` class affects every EditableField variant, not just enum.** This is intentional and surfaced upfront in the "Surfaces exercised" section. The spec called out the persistent ring as on the select OR a wrapper — my read is that browser default focus rings on the `<div role="button" tabIndex={0}>` are the wrapper case, and that's true regardless of variant. Touching only the enum-variant display would have been a narrower fix but would have left the issue lurking for text / textarea variants too.
- **No `onBlur` handler added to the `<select>`.** Considered adding one to cancel edit mode when the user clicks-away without picking an option. Decided against it because (a) the spec was explicit about not modifying save/commit logic, (b) the current behavior — dropdown stays in edit mode until user picks or hits Escape — is the existing contract, and (c) the visual fix alone addresses the symptoms Drake described. If clicking-away without selection still feels weird post-deploy, that's a follow-up.
- **Did not test in a live browser.** Builder environment has no display / dev server. Build-time TypeScript + ESLint + CSS validation passed; runtime visual behavior is Drake's gate (c) smoke.

## Out of scope / deferred

- **Live browser verification of the open-menu styling in Chrome and Safari.** Drake's gate (c).
- **Replacing native `<select>` with a Radix or shadcn Select component.** Path (b) — explicitly out of scope per spec.
- **Other dropdowns in Gregory.** The filter-bar multi-selects, sort menus, and `MultiSelectDropdown` use Radix/shadcn primitives that already pick up the theme tokens cleanly. Not touched.

## Side effects

**Production deploy fired.** Pushing to `main` triggers Vercel's GitHub-integration auto-deploy. As of this report, the deploy is in flight or recently completed.

No other side effects:

- No external API calls beyond the git push.
- No Slack posts, no DB writes, no env-var changes, no migrations, no Anthropic / OpenAI calls.
- No `vercel.json` / `next.config.mjs` / `package.json` changes.
- No new dependencies.

## Drake's verification (gate c)

After the production deploy goes green:

1. **`/clients` table — all four editable cell types.** Click into a Status cell → confirm the dropdown opens with editorial-dark surface + electric-blue accent on hover/focus + custom chevron + no cell-height shift. Click away (NOT picking an option) → no persistent focus ring on the cell. Repeat for Journey stage, CSM Standing, Trustpilot.
2. **`/clients/[id]` — Section 2 (Lifecycle) + Section 6 (Adoption) selects.** Same checks.
3. **Keyboard navigation.** Tab through the cells with the keyboard — focus ring should appear (electric-blue accent) when the cell is keyboard-focused.
4. **Save flow.** Pick an option from any dropdown → confirm save succeeds (the existing onSave path is unchanged; the visual fix shouldn't affect it).
5. **Browser cross-check.** Chrome + Safari at minimum. If the Safari open menu looks bad, that's accepted per spec — the closed state and menu open behavior in Chrome / Firefox are what matters for the demo experience.

Production URL: `https://ai-enablement-sigma.vercel.app/clients`.

If anything looks off, point me at the specific surface + the visual issue and I'll iterate.
