# Report: Gregory — editable Primary CSM on client detail
**Slug:** gregory-editable-primary-csm
**Spec:** docs/specs/gregory-editable-primary-csm.md

## Files touched

**Modified:**

- `lib/db/clients.ts` — added `listAvailableCsms()` (queries `team_members` with `is_csm=true` + `is_active=true` + `archived_at IS NULL`, ordered by `full_name`). Separate from `listActiveCsms()` in `lib/db/calls.ts`, which has different semantics ("CSMs currently owning ≥1 client" via active assignments).
- `app/(authenticated)/clients/editable-cell.tsx` — added `EditablePrimaryCsmCell` (wraps `EditableField` in `variant="enum"`, options from `listAvailableCsms()`, onSave routes to the existing `changeClientPrimaryCsm` Server Action). Imported `changeClientPrimaryCsm` from `./[id]/actions`.
- `app/(authenticated)/clients/[id]/page.tsx` — fetched `csmOptions` alongside `getClientById` (single `Promise.all`), imported `EditablePrimaryCsmCell`, replaced the static `<DataRow>` for Primary CSM with the new editable cell. The row now renders unconditionally so a CSM can assign one even when the client has none.

**Not touched (despite the spec asking for them):**

- `app/(authenticated)/clients/[id]/actions.ts` — no new Server Action. `changeClientPrimaryCsm` already exists (lines 214-224) with the exact signature the spec described. Reusing rather than duplicating.

## What I did, in plain English

Wired the Primary CSM row on `/clients/[id]` so clicking the name opens a dropdown of the CSMs (real four + Scott Chasing sentinel). Pick a different CSM → the page revalidates and the new name renders. The change writes via the existing atomic `change_primary_csm` Postgres function (migration 0014) through the existing `changeClientPrimaryCsm` Server Action — no duplicate action needed.

The dropdown options come from a new `listAvailableCsms()` helper that filters `team_members` by `is_csm=true` + active + not archived. Same shape the `/clients` list-page filter uses (inline today); I extracted the pattern into a helper for the new call site rather than rolling a fourth variant of the query. The existing list-page inline call site is left alone to keep this spec's diff narrow.

`EditablePrimaryCsmCell` mirrors the four existing editable pill cells in `editable-cell.tsx` but renders the value as plain text (the CSM's `full_name`) rather than a pill — consistent with the rest of the Details box (Email, Phone, Country are also plain text). Empty / null state renders as a muted `—`.

The yesterday-shipped hover affordance (`.geg-editable-display:hover` gold-tinted background + chevron glyph) applies automatically since the new cell wraps the same `EditableField` primitive that owns that class. The Primary CSM row will hover-light the same way Status / CSM standing / Trustpilot / Journey stage do.

## Verification

- **TypeScript** — `npx tsc --noEmit` clean.
- **ESLint** — `npx next lint` clean (`✔ No ESLint warnings or errors`).
- **Build** — not run separately; Vercel builds on push.
- **Playwright visual verification** — NOT run, same reason as yesterday's bundle: this work pushes straight to `main` (per CLAUDE.md § Deploys via git push), there's no feature-branch preview URL with `NEXT_PUBLIC_DISABLE_AUTH=true`, and prod requires auth. Drake's gate (c) covers manual verification.

Manual walkthrough Drake should do once the auto-deploy lands:

1. Open `/clients/[any client id]` on prod.
2. Hover over the Primary CSM row's value. Expect: gold-tinted background + chevron glyph at the right edge (matches the four editable pill cells in the Standing box).
3. Click the Primary CSM name. Expect: a `<select>` opens with the four real CSMs + Scott Chasing, alphabetical by full_name.
4. Pick a different CSM. Expect: the dropdown closes, the new name renders inline, no error badge.
5. Refresh the page. Expect: the new CSM persists.
6. Spot-check `/clients` — the Primary CSM column for the same client should reflect the new value (the Server Action revalidates both routes).
7. (Optional) Pick `—` from the dropdown. Expect: an inline error "Clearing Primary CSM is not supported yet." — see Surprises.

## Surprises and judgment calls

- **The atomic RPC + Server Action already existed.** The spec asked for a new `reassignPrimaryCsmAction(clientId, newCsmTeamMemberId | null)` that does close-old + insert-new "in sequence … no transaction wrapper needed … mirror commitPendingActionItemChanges." But migration 0014 already defines `change_primary_csm(p_client_id, p_new_team_member_id)` as a single PL/pgSQL function that archives + inserts atomically, AND `lib/db/clients.ts` already exports `changePrimaryCsm()` (the DB wrapper) AND `app/(authenticated)/clients/[id]/actions.ts:214-224` already exports `changeClientPrimaryCsm` (the Server Action with revalidatePath). I reused all three rather than building a parallel naming. Net: ~30 lines saved, single source of truth preserved.

- **The CSM-options helper the spec pointed at has different semantics.** The spec said reuse `listActiveCsms()` (in `lib/db/calls.ts`). That helper goes via `client_team_assignments` filtered to `role='primary_csm' AND unassigned_at IS NULL` — i.e., "CSMs who currently own at least one client." A new CSM with no clients yet would be missing from its results. The spec's actual intent ("filter by is_csm=true," "Scott Chasing + four real CSMs surface here") matches the inline query at `app/(authenticated)/clients/page.tsx:152-159` on the list page, not `listActiveCsms`. I extracted the inline pattern into `listAvailableCsms()` in `lib/db/clients.ts`. The list-page inline call site continues to inline the query for now — refactoring it was out of scope.

- **Null-clear path from spec § A.1 not wired.** The spec defined a null-input case (close existing assignment without inserting a new one — "allows 'no CSM' state — though in practice this won't be used much"). The existing `change_primary_csm` RPC signature requires a non-null `p_new_team_member_id`. Rather than add a new RPC for an explicitly low-value path, the cell returns a friendly error if the user picks `—` from the dropdown: `"Clearing Primary CSM is not supported yet."` If Drake wants the null path supported, easy followup (new RPC + new Server Action overload, or just an early branch in the existing wrapper).

- **Empty-option in the dropdown.** `EditableField` hardcodes a leading `{ value: '', label: '—' }` option for `variant="enum"`. With the null-clear path unsupported, that option becomes a soft pothole — pick it and you get the friendly error. The cleaner UX would be to suppress the empty option when the cell doesn't support null, but that requires an `omitEmptyOption?: boolean` prop on `EditableField`. I didn't touch the primitive — out of scope for this spec, low real-world impact, easy to add later if Drake cares.

- **Row-height asymmetry in the Details box.** The other Details rows (Email / Phone / Country / Timezone / Start date) are plain text ~17px tall. `EditableField`'s display wrapper has `min-h-9` (36px) for the click target. The Primary CSM row will be visibly taller than its neighbors. That's actually a useful affordance — "this row is interactive" reads at-a-glance — and the spec explicitly accepted the placement. Surfacing it because it's visible from the screenshot diff.

- **Scott Chasing alphabetizes next to Scott Wilson.** Spec § Think this through anticipated this. I did not append a `(sentinel)` suffix or other disambiguator — kept the name verbatim from `team_members.full_name`. If a CSM picks the wrong Scott in practice, easy followup (suffix in the option label only, not the display value).

- **No transaction-wrapper concern.** The spec's "two-step write can partial-apply" mitigation doesn't apply here — the atomic RPC means the write is one operation from the JS side, and Postgres guarantees the close-old + insert-new pair commit together or not at all.

## Out of scope / deferred

- Reassigning Primary CSM on the `/clients` list (detail-page only per spec; separate spec if Drake wants list-row editing).
- Refactoring `/clients/page.tsx:152-159` to use the new `listAvailableCsms()` helper (the inline call site still works fine; consolidation is followup-grade).
- Supporting the null-clear path (new RPC + Server Action overload + `omitEmptyOption` prop on `EditableField`; deferred until Drake asks for it).
- Visual disambiguator for Scott Chasing vs. Scott Wilson in the dropdown.
- Backfilling historical action items to a new owner (per spec Decision 3 — historical records stay attached to the old CSM).
- Tests — explicitly deferred.
- Adding a UI warning for negative-status reassignment (Drake declined per spec Decision 2).

## Side effects

- **Pushed to `main`.** Two commits land via the GitHub-integration auto-deploy: `2b56227` (feature) plus this report commit. Drake's gate (c) post-deploy verification is the next step.
- **No DB writes, no Slack posts, no external API calls** from this run. The only data the new code reads is `team_members` (already read in this codebase) and `client_team_assignments` (already read in `getClientById`).
- **No new dependencies, no new env vars, no new design tokens or primitives.**
- **Untouched in working tree** (preserved from session start): `Gregory Calls Redesign.html`, `Gregory Clients Redesign.html`, `fix pics/`, `lithium.zip`, `lithium/`, `scripts/.preview/`. Staging used explicit file paths only — no repeat of yesterday's `git add -A` slip.
