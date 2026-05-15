# Director task page + Slack column conditional rendering + sticky list filters

**Slug:** director-tasks-and-list-ux-polish
**Status:** in-flight

## Context

Three distinct UX/feature pieces bundled into one spec because they share the same risk profile (small, additive, no migrations to anything load-bearing) and ship together cleanly tonight.

**Piece 1 — Director task page.** A creator-tier-only page at `/tasks` with a single list of personal tasks. Title field, done checkbox, delete button. Drake's mental overhead is increasing as the role grows; "tasks living somewhere" is the V1 ask. Recurring tasks + categorization defer to future specs once usage patterns emerge.

**Piece 2 — Slack column conditional rendering.** The "Slack" column on `/clients` (shipped earlier today) renders always. Drake prefers the pre-Slack-column visual layout when no Slack-related filter is active. New behavior: render the column only when `needs_review` OR `missing_slack` filter is active. Detail page `/clients/[id]` keeps the badges unconditionally — when you're on a client's page, you always want to know about Slack hygiene.

**Piece 3 — Sticky list filters on `/clients` and `/calls`.** Current behavior: filter state lives in URL params, but `/clients/[id]` → "Back to clients" navigates to bare `/clients`, wiping filters. Same on `/calls/[id]` → "Back to calls". Fix: preserve the URL query string when navigating into detail pages, restore it on Back. Plus a "Clear filters" button beside the search bar on both list pages (renders only when at least one filter is active).

## Files Builder reads first (acclimatization)

1. `app/(authenticated)/clients/[id]/back-to-clients-button.tsx` — the Back button. Confirm its current implementation (probably a plain `<Link href="/clients">`). Same for the equivalent on Calls.
2. `app/(authenticated)/clients/page.tsx` + `filter-bar.tsx` + `clients-table.tsx` — list page chain. The conditional column lives in the table; the clear-filters button lives in the filter-bar (or beside it); the URL-param read happens in `page.tsx`.
3. `app/(authenticated)/calls/page.tsx` + whatever the equivalent filter-bar / table files are named — for parity. Builder finds these.
4. `app/(authenticated)/calls/[id]/page.tsx` + Calls detail page's Back button — for the sticky-filter fix.
5. `lib/auth/access-tier.ts` + `app/(authenticated)/ella/layout.tsx` — the gating primitive pattern. The new `/tasks` sub-layout mirrors the Ella one.
6. `components/top-nav.tsx` — to add a "Tasks" nav item.
7. `app/(authenticated)/clients/clients-table.tsx` — read carefully. The conditional column requires reading the filter state at render time (probably from URL searchParams passed down).

## Decisions baked in (do NOT re-litigate)

### Piece 1 — Tasks page

- **Route:** `/tasks`. Sub-layout gates to creator-tier (only Drake). Same pattern as Ella's Admin gate.
- **Schema:** new table `director_tasks` keyed by `team_member_id` (V1 = just Drake, but the primitive is reusable).
  - `id uuid PRIMARY KEY DEFAULT gen_random_uuid()`
  - `team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE`
  - `title text NOT NULL`
  - `done boolean NOT NULL DEFAULT false`
  - `created_at timestamptz NOT NULL DEFAULT now()`
  - `done_at timestamptz` — stamped when `done` flips to true; null otherwise
  - Index on `(team_member_id, created_at DESC)` for the page query.
- **Page behavior:**
  - List of tasks for the current user, ordered: open first (by `created_at DESC`), then done (by `done_at DESC`).
  - "Add task" input at the top — type, Enter to submit.
  - Each row: checkbox (toggle done) + title + delete button (×).
  - Done tasks strike through visually + dim slightly.
  - No edit-in-place for the title in V1 — delete + re-add if the wording's wrong.
- **Server actions** in `app/(authenticated)/tasks/actions.ts`:
  - `addTask(title: string)` — creates a row for the current user.
  - `toggleTaskDone(taskId: string)` — flips `done` + stamps/clears `done_at`.
  - `deleteTask(taskId: string)` — hard delete (no soft archive). It's a personal task list; soft-archive is overkill.
- **Server-side data fetch:** in the page, query `director_tasks` for the current user, ordered as above.
- **Visual style:** editorial skin, gold-accent on the add-task input, JetBrains Mono for the strikethrough completed text (matches the rest of the site).
- **Nav:** new "Tasks" link in TopNav. `requiredTier: 'creator'`. Only Drake sees it.

### Piece 2 — Slack column conditional

- **Reads URL searchParams in `clients-table.tsx`** (or via prop drilling from `page.tsx`) and conditionally renders the Slack column.
- **Condition:** `searchParams.needs_review === '1' || searchParams.missing_slack === '1'`.
- **When neither is active:** the Slack column is absent — the table reverts to the pre-Slack visual layout. The COLUMNS array filters out the `slack` entry before iteration.
- **When either or both are active:** Slack column appears as it does today.
- **The filter chip itself stays always-visible** in the filter bar. The conditional is only the table column.
- **Detail page `/clients/[id]` unchanged** — Slack badges always render when applicable.

### Piece 3 — Sticky filters

- **Mechanism:** "Back to clients" / "Back to calls" buttons preserve the URL query string from where the user navigated.
  - Implementation: detail page reads `searchParams.from` (a path-with-query passed from the list page's row links) and the Back button links to it.
  - List page row links append `?from=/clients?<current-query>` (URL-encoded) to each row's link target.
  - Empty `from` falls back to bare `/clients` or `/calls`.
- **Clear-filters button:**
  - Renders beside the search bar.
  - Visible only when at least one filter param is set (the existing `hasAnyFilter` predicate in `filter-bar.tsx` is the gate).
  - Clicking clears every filter param from the URL while preserving the search query if one is present. (Or wipe everything — Builder picks; my lean is preserve search since search is a different concern from filters.)
- **Calls list parity:** same treatment. Builder reads the Calls list code to identify the equivalent filter-bar + row-link components.

## Implementation plan

### Piece 1 — Tasks page

**1.1 — Migration `0036_director_tasks.sql`** — new table per § Decisions. SQL review hard stop.

**1.2 — Schema doc:** new `docs/schema/director_tasks.md`.

**1.3 — Sub-layout `app/(authenticated)/tasks/layout.tsx`** — creator-tier gate. Mirror Ella's pattern. Preview-bypass branch preserved.

**1.4 — Page `app/(authenticated)/tasks/page.tsx`** — fetches tasks, renders the add input + list, passes server actions down to client components.

**1.5 — Server actions `app/(authenticated)/tasks/actions.ts`** — three actions per § Decisions. Each calls `getCurrentUserAccessTier()` first to confirm creator-tier; rejects otherwise (defense in depth — the layout already gates, but server actions should self-check).

**1.6 — Client component `task-list.tsx`** — renders rows + the add input. Optimistic UI on add/toggle/delete (form state in React, refresh on server response).

**1.7 — TopNav update** — new "Tasks" item with `requiredTier: 'creator'`.

**1.8 — Tests** — no TS test infrastructure for this; Drake validates via gate (c). The server actions are simple enough that bugs would surface immediately.

### Piece 2 — Slack column conditional

**2.1 — `clients-table.tsx`** — read the filter state (passed from `page.tsx` as a prop or via the existing searchParams plumbing). Filter the COLUMNS array conditionally:

```typescript
const showSlackColumn = filters.needs_review || filters.missing_slack
const visibleColumns = showSlackColumn 
  ? COLUMNS 
  : COLUMNS.filter(c => c.key !== 'slack')
```

Render `visibleColumns` instead of `COLUMNS`.

**2.2 — `page.tsx`** — pass the relevant filter flags down to the table component.

**2.3 — No data layer changes.** The query already fetches the join data; we just stop rendering the cell when no filter requires it. Slight over-fetch but negligible (one nested join per row, ~134 rows max).

### Piece 3 — Sticky filters

**3.1 — Detail page Back buttons.**

In `app/(authenticated)/clients/[id]/back-to-clients-button.tsx`:

```typescript
'use client'
import { useSearchParams } from 'next/navigation'
import Link from 'next/link'

export function BackToClientsButton() {
  const searchParams = useSearchParams()
  const from = searchParams.get('from')
  const href = from && from.startsWith('/clients') ? from : '/clients'
  return <Link href={href}>← Back to clients</Link>
}
```

Note: server-side rendering can also read `searchParams` from page props if the Back button is a server component. Builder picks the cleanest path; both work.

Equivalent for Calls detail page.

**3.2 — List page row links.** In `clients-table.tsx`, the row link currently looks like `<Link href={`/clients/${client.id}`}>`. Update to include the current query string:

```typescript
const fromParam = currentSearchString 
  ? `?from=${encodeURIComponent(`/clients${currentSearchString}`)}` 
  : ''
<Link href={`/clients/${client.id}${fromParam}`}>
```

`currentSearchString` comes from the page's filter state — Builder threads it through.

Same treatment in the Calls list.

**3.3 — Clear-filters button.**

In `filter-bar.tsx` (or a new component next to it), add:

```typescript
{hasAnyFilter && (
  <button onClick={clearAllFilters} className="...">
    Clear filters
  </button>
)}
```

`clearAllFilters` navigates to the list page with no filter params (preserving search if present). Use `router.replace('/clients?search=...')` or `router.replace('/clients')` depending on search state.

Equivalent in the Calls filter-bar.

### Doc updates

- `docs/schema/director_tasks.md` — new schema doc.
- `docs/state.md` — entry describing all three pieces.
- `docs/runbooks/director_tasks.md` — short note: what the table is, how to query Drake's tasks via SQL if Drake ever loses dashboard access, where the access tier gate lives.

### Commit shape

- Migration commit (`0036_director_tasks.sql`).
- Tasks feature commit (page + layout + actions + nav + schema doc + runbook).
- List UX commit (Piece 2 + Piece 3, both lists).
- Docs commit (`state.md` etc.).
- Report commit.

## What success looks like

1. **Migration 0036 dual-verifies.** `director_tasks` table exists with the right shape.
2. **Drake visits `/tasks`** — sees an empty list (no tasks yet), an add-task input.
3. **Adds three tasks** — they appear ordered by created_at desc.
4. **Checks the first task** — strikes through, moves below the open tasks.
5. **Deletes one** — disappears.
6. **Non-creator users visiting `/tasks`** redirect to `/clients?error=insufficient_access`. Tasks link doesn't appear in their TopNav.
7. **Slack column on `/clients` is hidden when no filter active.** Apply the "Missing Slack" filter → column appears. Remove the filter → column disappears.
8. **Detail page Slack badges always render** when applicable, regardless of filter state on the previous list view.
9. **`/clients` with filters applied + click into a client + click "Back to clients"** lands on `/clients` with the same filters active.
10. **Same flow on `/calls`** works.
11. **"Clear filters" button appears beside search when any filter is set.** Clicking clears the filters but preserves the search input if any.
12. **All tests pass.** `pytest tests/` green. `tsc --noEmit` clean. Lint clean.

## Hard stops

- **SQL review before migration apply.** Standard gate.
- **Don't make tasks shared.** This is Drake-only. The table primitive supports multi-user but the V1 page doesn't.
- **Don't add edit-in-place for task titles.** Delete + re-add is the V1 path.
- **Don't change filter behavior on first visit to the list page.** Sticky filters preserve state across navigation; a fresh browse-to `/clients` is still a clean list.
- **Don't make the Slack column conditional on `/clients/[id]`.** Detail page always shows badges when applicable.
- **Don't preserve filters across browser sessions.** No localStorage. URL params only. Closing the tab resets state — that's correct behavior.

## What could go wrong

- **The `from` URL parameter could be abused** to redirect to arbitrary URLs (open redirect vulnerability). Mitigation: Back button code validates `from.startsWith('/clients')` or `'/calls')` before honoring it — a malicious `?from=https://evil.com` falls back to bare `/clients`.
- **A Drake-typed task accidentally contains URL-encoded values that break the page.** Mitigation: server action takes the title verbatim; React renders it as text node (auto-escaped). No injection risk.
- **The conditional Slack column causes layout shift** when toggling the filter. Mitigation: the layout shift IS the intended behavior — table widens when more columns appear. Worth noting in the UI so Drake doesn't think it's a bug.
- **The "Clear filters" button + sticky filters together create a confusing flow** ("I cleared filters, then navigated to a client, then Back — are the filters back?"). Behavior: Back goes to wherever the `from` param said. If `from` had no filters (because user cleared them before clicking into the client), Back goes to bare `/clients`. Correct + matches mental model.
- **Calls list might have different filter-bar shape than Clients.** Builder reads first to confirm parity; if the Calls list has materially different filter UX, surface to Drake before duplicating broken patterns.

## Mandatory doc-update list

- `supabase/migrations/0036_director_tasks.sql` — new.
- `app/(authenticated)/tasks/layout.tsx` — new.
- `app/(authenticated)/tasks/page.tsx` — new.
- `app/(authenticated)/tasks/actions.ts` — new.
- `app/(authenticated)/tasks/task-list.tsx` — new.
- `app/(authenticated)/clients/clients-table.tsx` — conditional Slack column.
- `app/(authenticated)/clients/page.tsx` — pass filter flags to table.
- `app/(authenticated)/clients/filter-bar.tsx` — Clear-filters button.
- `app/(authenticated)/clients/[id]/back-to-clients-button.tsx` — read `from` param.
- Same Calls list trio — Builder finds the file paths.
- `components/top-nav.tsx` — Tasks nav item.
- `lib/supabase/types.ts` — `director_tasks` Row/Insert/Update interfaces.
- `docs/schema/director_tasks.md` — new.
- `docs/runbooks/director_tasks.md` — new.
- `docs/state.md` — entry.

## Commit shape

- One migration commit (`feat: add director_tasks table`).
- One tasks-feature commit (`feat: /tasks page for Director task tracking`).
- One list-UX commit (`feat: conditional Slack column, sticky filters, clear-filters button on /clients and /calls`).
- One docs commit.
- One report commit.
- Push at end.
