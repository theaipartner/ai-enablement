# Gregory — editable Primary CSM on client detail
**Slug:** gregory-editable-primary-csm
**Status:** in-flight

## Context

Drake's bug report yesterday — "make CSM editable again so Scott can play around" — was about **Primary CSM** (which team_member owns the client), not **CSM standing** (the happy / content / at_risk / problem dropdown). The warm-up fix spec yesterday solved CSM standing's affordance question; this spec solves the actual ask.

The Primary CSM today renders in the Details box on `/clients/[id]` as plain text (`client.active_primary_csm.team_member_name`). No edit affordance. CSMs cannot reassign clients from the dashboard.

Working branch is `main`.

The data model uses a historical join table — Primary CSM isn't a column on `clients`. Changing the assignment is a two-step write:

1. Close the existing active assignment (set `unassigned_at = now()` on the row with `client_id = X AND role = 'primary_csm' AND unassigned_at IS NULL`).
2. Insert a new assignment row (`client_id = X, team_member_id = new_id, role = 'primary_csm', assigned_at = now(), unassigned_at = null`).

History is preserved. The pattern matches the existing `client_team_assignments` model.

## Reference reads (in this order)

1. `app/(authenticated)/clients/[id]/page.tsx` — current Details box rendering the static `client.active_primary_csm.team_member_name`. Line ~287.
2. `app/(authenticated)/clients/editable-cell.tsx` — existing editable cells (Status, CSM Standing, Trustpilot, Journey Stage). The new Primary CSM cell follows this exact pattern.
3. `app/(authenticated)/clients/[id]/actions.ts` — existing server actions. New `reassignPrimaryCsmAction` lands here.
4. `lib/db/clients.ts` — `getClientById` returns `active_primary_csm` derived from `client_team_assignments`. Read to understand the read-side shape.
5. `docs/schema/team_members.md` — `is_csm = true` is the filter for CSM dropdown options. The Scott Chasing sentinel + four real CSMs (Scott Wilson, Nabeel Junaid, Lou Perez, Nico Sandoval) all carry `is_csm = true`.
6. `docs/schema/client_team_assignments.md` (if it exists; if not, `docs/schema/clients.md` for context) — assignment row shape.
7. `components/client-detail/editable-field.tsx` — the `<EditableField>` primitive the cells wrap. Same primitive, same `variant="enum"` shape.
8. `/clients` list page filter — the existing CSM dropdown there uses `is_csm = true`. Builder finds it and reuses the same `listActiveCsms()` helper (or equivalent) for option-list construction.

**Acclimatization checkpoint:** before writing any code, confirm in 4–5 bullets in your first commit message: (a) the file path of the existing CSM-options helper on the `/clients` list (likely `listActiveCsms()` or similar in `lib/db/calls.ts` or `lib/db/clients.ts`) — Builder reuses this rather than rolling a new query, (b) the exact write sequence for the two-step reassign (close + open), (c) whether the existing M5.6 status cascade trigger reads or writes through this same surface (Drake's accepted that cascade may revert manual changes on negative-status clients; Builder confirms the trigger fires server-side on status changes only, not on direct assignment changes), (d) the file map you intend to touch, (e) any unexpected drift between this spec and what you find.

## Decisions locked in by Director

From Drake/Director conversation 2026-05-14.

1. **Filter dropdown options by `is_csm = true`.** Mirrors the existing `/clients` list filter. Scott Chasing sentinel appears alongside the four real CSMs. Order: alphabetical by `full_name`.

2. **CSMs can reassign on any client regardless of status.** Including ghost / paused / leave / churned. The M5.6 status cascade may auto-revert their change on a future status update — that's accepted. If a CSM cares enough to re-edit later, they re-edit. No UI warning needed; behavior is "what you click is what gets written."

3. **Historical action items / call ownership stay attached to the old CSM.** Reassignment changes the active Primary CSM, not the historical record. Action items with `owner_team_member_id = old_csm` keep their owner. Calls with the old CSM as participant retain the participant record. No cascade rewrites.

4. **Write is two-step in a single server action.** Close old assignment + insert new assignment in sequence. No transaction wrapper needed — the operations are independent and partial-apply (close but not insert) is recoverable manually if it ever happens. Mirror the pattern of `commitPendingActionItemChanges` from calls (multi-step, no transaction, returns success/error).

5. **Editable cell uses `<EditableField>` with `variant="enum"`.** Same primitive, same pattern as the four existing editable pill cells. The display value renders the CSM's full name in plain text (not a pill). The edit mode shows a dropdown of the active CSMs.

6. **No new design tokens, no new primitives.** Pure reuse.

## What success looks like

### A. Server action

Create `reassignPrimaryCsmAction(clientId: string, newCsmTeamMemberId: string | null)` in `app/(authenticated)/clients/[id]/actions.ts`. Signature returns `{ success: true } | { success: false; error: string }` matching the existing action shapes.

Logic:

1. If `newCsmTeamMemberId` is null, just close the existing active assignment. No insert. (Allows "no CSM" state — though in practice this won't be used much.)
2. If `newCsmTeamMemberId` is the same as the current active assignment's team_member_id, return `{ success: true }` without writing — no-op.
3. Otherwise: find the existing active assignment row for `(client_id, role='primary_csm', unassigned_at IS NULL)`. Set `unassigned_at = now()` on it. Then insert a new row with the new team_member_id, `role='primary_csm'`, `assigned_at = now()`, `unassigned_at = null`.
4. `revalidatePath('/clients/[id]', 'page')` and `revalidatePath('/clients', 'page')` (the list page surfaces CSM too).
5. Return `{ success: true }`.

If any DB error: catch, log, return `{ success: false, error: <message> }`.

### B. Editable cell component

Add `EditablePrimaryCsmCell` to `app/(authenticated)/clients/editable-cell.tsx`. Mirrors the existing `EditableCsmStandingCell` pattern but:

- Options come from `listActiveCsms()` (or whatever the existing helper is named — Builder verifies in acclimatization point a). Returned as `{ value: string (team_member_id), label: string (full_name) }[]`.
- Options need to be fetched at render time. Two real patterns:
  - **(i)** Fetch in the page (`page.tsx`), pass as a prop to `EditablePrimaryCsmCell`. Same approach as the existing list-page filter dropdown.
  - **(ii)** Fetch inside the cell via a `useEffect`. More self-contained but adds a client-side query.
  
  Builder uses (i) — consistent with how the page already passes data to other cells.
- Display value: plain text with the team_member's full_name. No pill. Empty/null displays as `—` muted.
- `onSave` calls `reassignPrimaryCsmAction(clientId, newValue)`.
- `router.refresh()` after success.

### C. Page integration

In `app/(authenticated)/clients/[id]/page.tsx`:

1. In the page component, call the CSM-options helper alongside the existing `getClientById` call. Pass the returned options as a prop to the new cell.
2. Replace the static `Primary CSM` `<DataRow>` (currently rendering `client.active_primary_csm.team_member_name` as plain text) with `<EditablePrimaryCsmCell clientId={client.id} value={client.active_primary_csm?.team_member_id ?? null} options={csmOptions} />`.

The Primary CSM row stays in the Details box, in the same position it occupies today (last row of the box). The visual change is: clicking the name opens a dropdown of CSMs.

### D. Visual + behavior verification

Per the design-handoff runbook, Builder verifies on the deploy preview before flipping to shipped:

1. Navigate to `/clients/[any client id]`.
2. Hover over the Primary CSM row's value. Expect: visible affordance (cursor + hover background per yesterday's fix).
3. Click Primary CSM. Expect: dropdown opens showing the CSMs.
4. Pick a different CSM. Expect: dropdown closes, the new name renders, no error.
5. Refresh the page. Expect: the new CSM persists.
6. Spot-check the `/clients` list — the CSM column for this client should reflect the new value.

Use Playwright per the existing harness pattern. Screenshots inline in the report.

## Hard stops

1. **If the existing CSM-options helper Builder finds in acclimatization point (a) doesn't filter by `is_csm = true`**, stop and surface. The schema explicitly calls out this filter; using an unfiltered helper would put non-CSM team_members (engineering, ops, sales) in the dropdown.

2. **If the existing `client_team_assignments` shape differs from the spec's assumed shape** (e.g. the table has a different role enum, or `unassigned_at` is named differently), surface before writing. The two-step write logic depends on the exact column names.

3. **If reassigning to the same team_member_id (the no-op case) produces a write anyway** when the early-return condition (B.2 above) is checked, that's a bug — confirm the equality check is on team_member_id, not on the assignment row's id.

## Think this through yourself — what could go wrong

- **The two-step write can partial-apply.** If the UPDATE succeeds but the INSERT fails, the client ends up with no active Primary CSM. **Mitigation:** the operations are sequential server-side; the failure window is small. If it ever happens, surfacing it via the error response gives the CSM a chance to retry. Worst case is a single client briefly has no CSM, which is recoverable.

- **The cascade trigger might fire between the close and the open.** If status changes during the write, the cascade could insert its own Scott Chasing row before our INSERT. **Mitigation:** unlikely (the cascade only fires on `clients.status` updates, not on assignment changes). If it happens, the new assignment row still inserts; the client just briefly has both. The active-assignment query filter (`unassigned_at IS NULL`) handles the rest. Order tie-breaker is `assigned_at` — most recent wins.

- **`router.refresh()` after the action may not pick up the new assignment immediately** if revalidation lags. **Mitigation:** the existing editable cells all use this pattern and don't show this problem in practice. If observed, switch to `revalidateTag` or harder cache invalidation; not Builder's concern in this spec.

- **The Primary CSM display is plain text, not a pill.** This breaks the visual rhythm of the Standing box (where everything is a pill). But Primary CSM lives in the Details box, where Email / Phone / Country are also plain text. Consistent within its box. **Mitigation:** none needed — placement is intentional.

- **CSMs reassigning churned clients away from Scott Chasing.** This is exactly the cascade-may-revert case Drake accepted. If a CSM reassigns a churned client to Lou Perez, and then a status update fires, Lou gets bumped back to Scott Chasing. **Mitigation:** none — Drake accepted this. Document in the report so the behavior is known.

- **The Scott Chasing sentinel showing up in the dropdown might confuse Scott Wilson.** Two people named Scott. **Mitigation:** the display is alphabetical by `full_name`; Scott Chasing and Scott Wilson sit next to each other. If confusion happens, Builder can append a `(sentinel)` suffix or similar — not blocking, add to Surprises if it surfaces.

## Mandatory doc-update list

- `docs/state.md` — no update needed; bug fix, not new shipped feature.
- `docs/known-issues.md` — no update needed unless something surfaces during build.
- `CLAUDE.md` — no update needed.
- `docs/agents/gregory.md` — no update needed.
- `docs/runbooks/design-handoff.md` — no update needed.

## Out of scope for this spec (explicit)

- Editing CSM standing (already shipped yesterday).
- Editing any other team_member field (full_name, email, etc.).
- Adding new CSMs to the team_members table (admin-tool surface, not Gregory).
- The M5.6 status cascade trigger logic (untouched).
- Backfilling historical action items to a new owner (not done — historical records stay attached to old CSM per Decision 3).
- Adding a UI warning for negative-status reassignment (Drake declined).
- Reassigning Primary CSM on `/clients` list (this spec is detail-page only; if list-page editing is wanted later, that's a separate spec).
- Tests — deferred.
