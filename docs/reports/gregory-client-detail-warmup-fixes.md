# Report: Gregory — client detail page bug fixes (warm-up bundle)
**Slug:** gregory-client-detail-warmup-fixes
**Spec:** docs/specs/gregory-client-detail-warmup-fixes.md

## Files touched

**Modified:**

- `app/(authenticated)/clients/[id]/back-to-clients-button.tsx` — rewrote as a plain `<Link href="/clients">`. Dropped `router.back()` + `window.history.length` check + the `'use client'` directive (no longer needed without `useRouter`).
- `app/(authenticated)/clients/[id]/actions.ts` — added two dedicated Server Actions, `updateClientNpsEnabledAction` and `updateClientAccountabilityEnabledAction`. Each is a thin wrapper over `updateClient` with `revalidatePath` on the detail + list routes.
- `app/(authenticated)/clients/editable-cell.tsx` — added a small `PillToggle` base + two exports (`EditableNpsEnabledToggle`, `EditableAccountabilityEnabledToggle`). Optimistic flip on click, revert on save failure, `router.refresh()` on success.
- `app/(authenticated)/clients/[id]/page.tsx` — replaced the two static `<GegPill>` renders for `nps_enabled` and `accountability_enabled` with the new editable toggle components. Imports updated.
- `app/globals.css` — theme-scoped hover affordance for `.geg-editable-display` (gold-tinted background + accent border + chevron glyph appearing on hover) plus matching `.geg-pill-toggle` hover (brightness + active scale + focus-visible ring).

**Deleted (separate doc-hygiene commit at Drake's request):**

- `docs/specs/gregory-redesign-wrapup.md`
- `docs/reports/gregory-redesign-wrapup.md`
- `docs/specs/promethean-preview-auth-bypass.md`
- `docs/specs/promethean-v0-shell-mock-data.md`

## What I did, in plain English

Three small fixes on `/clients/[id]`, shipped as one bundle plus a doc-hygiene commit Drake asked for in the same turn.

**Back button.** Replaced the `router.back()` + history-length probe with a plain `<Link href="/clients">`. The back arrow now always goes to the list. Filter / sort state lives in URL params on the list page so a CSM returning from a detail still sees their last filter view. The calls-side back button (at `app/(authenticated)/calls/[id]/page.tsx:88-101`) is already a plain inline `<Link href="/calls">` — no fix needed there; the spec's premise that it had the same bug was wrong.

**Editable toggles.** Wired the NPS-enabled and Accountability-enabled pills as click-to-flip. Two new dedicated Server Actions (`updateClientNpsEnabledAction`, `updateClientAccountabilityEnabledAction`) write directly to `clients.nps_enabled` / `clients.accountability_enabled` via the existing `updateClient` whitelist — both columns were already in `UPDATABLE_FIELDS` + `FIELD_TYPES` from M5.6, so no schema or whitelist changes were needed. The toggle UI is a small `PillToggle` base (a `<button>` wrapping `<GegPill>`) with optimistic state, revert-on-failure, and `router.refresh()` after a successful save to pick up any cascade side effects.

**Click-to-edit affordance.** Drake's report ("CSM standing not editable") didn't match the code — `EditableCsmStandingCell` is structurally identical to the three other editable pill cells, all of which work. The likely gap was the affordance: the `geg-editable-display` wrapper relies on Tailwind's `hover:bg-muted/50` + `hover:border-input` tokens, which on the dark editorial theme render too faintly to read as interactive. Theme-scoped overrides now paint a gold-tinted hover background, an accent border, and a small chevron-down glyph at the right edge of the cell (mirroring the `<select>` affordance the cell switches to on click). The override applies to all four editable pill cells (Status / CSM standing / Trustpilot / Journey stage) for consistency. The new `PillToggle` gets a matching hover treatment (brightness lift + focus-visible ring + active scale).

## Verification

- **TypeScript** — `npx tsc --noEmit` clean.
- **ESLint** — `npx next lint` clean ("✔ No ESLint warnings or errors").
- **Build** — not run separately; the lint + typecheck pipeline covers the layers this work touched and Vercel will build on push.
- **Playwright visual verification** — NOT run; see Surprises. Drake's gate (c) (post-deploy testing on real surfaces) covers the manual walkthrough on the prod deploy.

Per spec § Visual verification, the manual click-through Drake should do once the auto-deploy lands:

1. Open `/clients/[any client id]` on prod.
2. Hover over the CSM standing / Status / Trustpilot / Journey-stage pills. Expect: gold-tinted background appears, chevron glyph appears at the right edge of the cell.
3. Click the CSM standing pill. Expect: the cell switches to a `<select>` with the standing options; pick one; the page revalidates.
4. Click the NPS-enabled pill. Expect: it flips between On (green) and Off (muted). Refresh the page; the toggle reflects the new value.
5. Same for the Accountability-enabled pill.
6. Click the "← BACK TO CLIENTS" link. Expect: navigates to `/clients`, not the previous page in history.

## Surprises and judgment calls

- **Calls back button didn't need fixing.** The spec said "Same issue likely exists for the call detail page's back button." But `app/(authenticated)/calls/[id]/page.tsx:88-101` already renders a plain inline `<Link href="/calls">`. There's no `router.back()` and no separate `back-to-calls-button.tsx`. Only the clients side had the bug. Reported clean and moved on.

- **Server-action shape — dedicated vs. generic.** The spec asked for two new dedicated Server Actions (`updateClientNpsEnabledAction`, `updateClientAccountabilityEnabledAction`) with a `(client_id, enabled: boolean)` signature, but the existing generic `updateClientField` already handles these columns via the `boolean_toggle` FIELD_TYPE. I went with the dedicated-action path per the spec's explicit ask — the signatures are stricter (no string-form `'true'`/`'false'` fallback), the call sites are clearer, and the wrappers are 5 lines each. If you'd rather collapse to `updateClientField`, easy followup.

- **Toggle pattern — dedicated component, not a new EditableField variant.** I chose `PillToggle` (a small dedicated `<button>` wrapping `<GegPill>`) over threading a 7th variant through `EditableField`. Click-to-flip doesn't fit the click→enter-edit-mode→blur-to-save state machine — there's no edit mode, no draft state, no blur dance. The dedicated component is ~50 lines including optimistic + revert + refresh; a `'toggle'` variant on `EditableField` would have needed a parallel non-edit-mode path that bypasses every other state branch. The spec gave Builder this call.

- **CSM standing investigation was code-only, not live-click.** I didn't run the page in a browser to verify the affordance is the gap (vs. a real runtime bug) — the prod URL requires auth and there's no feature-branch preview for this push. The conclusion ("affordance, not a bug") is based on reading the code: `EditableCsmStandingCell` is structurally identical to the other three editable pill cells that demonstrably work. If Drake clicks CSM standing post-deploy and it still doesn't open the editor, the bug is somewhere I didn't read — flag it and I'll dig deeper.

- **Visual verification didn't run.** The design-handoff runbook expects a feature-branch preview URL where `NEXT_PUBLIC_DISABLE_AUTH=true` lets Playwright screenshot without auth. This work pushed straight to `main` (per CLAUDE.md § Deploys via git push), so there's no preview branch URL to point Playwright at, and prod requires auth. The screenshots-in-report step from the runbook doesn't apply cleanly to this bundle. Drake's gate (c) covers the manual verification on prod post-deploy.

- **Affordance treatment used `!important`.** The two `.geg-editable-display:hover` overrides use `!important` to win against Tailwind's `hover:bg-muted/50` / `hover:border-input` utility classes applied inline on the wrapper. The `!important` is scoped to the editorial theme selector and to the hover pseudo-class — it doesn't leak. Cleaner alternative is to drop those Tailwind hover utilities from the component and own hover entirely in theme CSS; deferred since the override is narrow.

## Out of scope / deferred

- Action items transfer fix between `/calls/[id]` and `/clients/[id]` (next session priority).
- Send-to-Slack server action wiring (next session priority).
- Ella redesign (separate workflow).
- Any other client-detail visual changes.
- Tests — explicitly deferred to `gregory-ts-test-infra` per the spec.
- Refactoring `<EditableField>` — not needed; the dedicated `PillToggle` sidesteps it.
- Collapsing the dedicated NPS/Accountability actions into the generic `updateClientField` — followup-grade simplification, see Surprises.

## Side effects

- **Pushed to `main`.** Four commits land via the GitHub-integration auto-deploy: `2a0bd79`, `a128a33`, `15f166f`, `dc84fbf`. Drake's gate (c) post-deploy verification on prod is the next step.
- **No DB writes, no Slack posts, no external API calls** from this run.
- **No new env vars, no new dependencies, no new tokens / primitives** beyond reusing `--color-geg-accent-fill` / `--color-geg-accent-border` for the affordance.
- **Doc-hygiene commit deleted 4 files** Drake confirmed in chat: the shipped `gregory-redesign-wrapup` spec/report pair and the two abandoned `promethean-*` specs. Verified all four were intended deletions before staging.
- **Untouched in working tree** (preserved from session start): `Gregory Calls Redesign.html`, `Gregory Clients Redesign.html`, `fix pics/`, `lithium.zip`, `lithium/`, `scripts/.preview/`. After an early `git add -A` slip on commit 2 (caught immediately, soft-reset, re-staged with explicit path), all four spec commits stage only their intended files.
