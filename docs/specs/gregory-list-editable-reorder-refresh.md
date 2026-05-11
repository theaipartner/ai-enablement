# Gregory clients list: editable cells, column reorder, refresh + back-nav fixes
**Slug:** gregory-list-editable-reorder-refresh
**Status:** in-flight

## Context

Scott's 2026-05-11 morning feedback flagged Gregory's clients list as "way too slow and manual admin work compared to spreadsheet." Three concrete asks plus Drake's refresh-rate investigation:

1. **Back-nav filter loss (urgent).** Clicking into a client then back to `/clients` drops all filter state. The "← Back to Clients" link on the detail page is a hardcoded `Link href="/clients"` with no searchParams; even browser-back can be unreliable depending on cache.
2. **Column reorder.** Scott's order: `Name / Status / Journey stage / Owner (Primary CSM) / CSM Standing / NPS Standing / Trustpilot / Health score / Meetings this month`. Current order has Primary CSM → NPS standing → Health score → Trustpilot → Meetings, and no CSM Standing column at all.
3. **Inline-editable cells.** Scott called out CSM Standing + Trustpilot. Drake extended scope to also include Status + Journey stage — all four edits route through the existing detail-page Server Actions, three of which write history rows.
4. **Refresh feels clunky (Drake's note).** Edits don't visually update until navigation; navigating back to `/clients` after an edit shows stale data until the router cache TTL expires.

**Drake-confirmed design calls:**
- **Editable cells use `EditableField` directly** (the existing component, not a new compact primitive). Visual ugly is acceptable for V1; iterate later if needed.
- **Refresh fix is both `router.refresh()` after each inline save AND `export const dynamic = 'force-dynamic'` on `/clients/page.tsx`.** Belt-and-suspenders — `router.refresh()` covers the current-page case, `force-dynamic` covers the after-navigation case.
- **Back nav uses `router.back()` with `/clients` fallback** — Client Component button replacing the current `Link`. When history exists, browser back restores the previous URL including filters/sort; when it doesn't (direct link, Slack share), fall through to `/clients` clean.
- **Column headers keep current names** (no "Program stage" rename). Pure reorder + add CSM Standing.
- **Four editable fields, three different action paths.** Status / journey_stage / csm_standing route through their dedicated history-writing actions (`updateClientStatusAction`, `updateClientJourneyStageAction`, `updateClientCsmStandingAction`); trustpilot_status routes through the generic `updateClientField`. Per-cell wiring, not blanket dispatch.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. `app/(authenticated)/clients/clients-table.tsx` — current column order is `full_name / status / journey_stage / primary_csm_name / nps_standing / latest_health_score / trustpilot_status / meetings_this_month`. The `SORTABLE_COLUMNS` array in that file AND the mirror `VALID_SORT_KEYS` / `SortKey` union in `app/(authenticated)/clients/page.tsx` both need to be updated when adding the new `csm_standing` column. Per the page.tsx comment, the duplication is intentional (server-client boundary). Keep that pattern.
2. `components/client-detail/editable-field.tsx` is the existing inline-edit primitive. Its `variant` prop supports `'enum'` and other types via `renderEditor`; the post-M5.6 fix added `commit(draftOverride)` to dodge the stale-closure bug. Read the file before importing — confirm the public API and the variants needed for status / journey_stage / csm_standing / trustpilot_status.
3. `app/(authenticated)/clients/[id]/actions.ts` already exports the four Server Actions the list cells need: `updateClientStatusAction`, `updateClientJourneyStageAction`, `updateClientCsmStandingAction`, and the generic `updateClientField`. All four already `revalidatePath('/clients')` AND `revalidatePath(\`/clients/${client_id}\`)`. No new actions to write — just import.
4. `app/(authenticated)/clients/[id]/page.tsx` line 47 — the back-nav link is `<Link href="/clients" className="text-sm text-muted-foreground hover:underline">← Back to Clients</Link>`. This is the surface to replace with the Client Component back-button.
5. `lib/client-vocab.ts` is the single source of truth for status / csm_standing / nps_standing / trustpilot_status option lists with labels. Import the `*_OPTIONS` arrays for the inline-edit dropdowns — don't redefine. `JOURNEY_STAGE_OPTIONS` was added 2026-05-08 (migration 0028) — confirm it's exported.

## Work

### Step 1 — Column reorder + add CSM Standing column

In `app/(authenticated)/clients/clients-table.tsx`:

Update `SortKey` union to add `csm_standing`.

Update `SORTABLE_COLUMNS` to Scott's order, with the new column:

```ts
const SORTABLE_COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'full_name', label: 'Full name' },
  { key: 'status', label: 'Status' },
  { key: 'journey_stage', label: 'Journey stage' },
  { key: 'primary_csm_name', label: 'Primary CSM' },
  { key: 'csm_standing', label: 'CSM Standing' },
  { key: 'nps_standing', label: 'NPS standing' },
  { key: 'trustpilot_status', label: 'Trustpilot' },
  { key: 'latest_health_score', label: 'Health score' },
  { key: 'meetings_this_month', label: 'Meetings this mo' },
]
```

In `app/(authenticated)/clients/page.tsx`:

Update the mirror `SortKey` union and `VALID_SORT_KEYS` array to match. Per the existing comment, keep both in sync manually; the type-check at `next build` time catches drift.

Default sort stays `latest_health_score asc` — Scott didn't ask for a default change, and the V2 brain rationale (worst-first surfacing) still holds.

### Step 2 — Inline-editable cells: status, journey_stage, csm_standing, trustpilot_status

Add a new Client Component file `app/(authenticated)/clients/editable-cell.tsx`. This wraps `EditableField` and the relevant Server Action per cell type. Four variants:

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { EditableField } from '@/components/client-detail/editable-field'
import {
  updateClientStatusAction,
  updateClientJourneyStageAction,
  updateClientCsmStandingAction,
  updateClientField,
} from './[id]/actions'
import {
  CSM_STANDING_OPTIONS,
  TRUSTPILOT_OPTIONS,
} from '@/lib/client-vocab'
import { STATUS_OPTIONS, JOURNEY_STAGE_OPTIONS } from '@/lib/client-vocab'
// (Confirm exact import paths during implementation — STATUS_OPTIONS may
// live in client-vocab; JOURNEY_STAGE_OPTIONS was added 2026-05-08.)

export function EditableStatusCell({
  clientId,
  value,
}: {
  clientId: string
  value: string
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  return (
    <EditableField
      label=""  // No label inside a table cell
      value={value}
      variant="enum"
      options={STATUS_OPTIONS}
      onSave={async (newValue) => {
        const result = await updateClientStatusAction(clientId, newValue as string)
        if (result.success) {
          startTransition(() => router.refresh())
        }
        return result
      }}
    />
  )
}

// Three more components: EditableJourneyStageCell, EditableCsmStandingCell,
// EditableTrustpilotCell — same shape, different action + options + variant.
```

Notes on the per-cell wiring:

- **Status:** the cascade trigger (migration 0022) fires on negative transitions (status → churned / leave / problem). This is the same behavior as the detail page; the list edit produces identical history rows + cascade side effects.
- **Journey stage:** enum dropdown sourced from `JOURNEY_STAGE_OPTIONS`. Migration 0028's CHECK constraint enforces the six-value taxonomy; the Server Action narrows via `updateClientJourneyStageAction`'s wrapper.
- **CSM Standing:** value is `'happy' | 'content' | 'at_risk' | 'problem' | null`. Wrapper action `updateClientCsmStandingAction` handles the type signature.
- **Trustpilot:** generic path via `updateClientField(clientId, 'trustpilot_status', newValue)`. No history table for this column.

In `clients-table.tsx`, replace the four current static cells with their editable counterparts:

```tsx
// Status cell — was: <Link><StatusPill /></Link>
// Now:
<TableCell>
  <EditableStatusCell clientId={row.id} value={row.status} />
</TableCell>
```

The other six cells (`full_name`, `primary_csm_name`, `nps_standing`, `latest_health_score`, `meetings_this_month`) stay as Link-wrapped navigation to `/clients/${row.id}`.

**Important:** the four editable cells must NOT be wrapped in `<Link>`. Click-to-navigate and click-to-edit are mutually exclusive on the same cell. Scott will navigate via the other six cells (especially `full_name`, which is the obvious row-entry point).

### Step 3 — Back-nav button replacement

In `app/(authenticated)/clients/[id]/page.tsx` line 47, replace:

```tsx
<Link href="/clients" className="text-sm text-muted-foreground hover:underline">
  ← Back to Clients
</Link>
```

with a new Client Component `<BackToClientsButton />` at `app/(authenticated)/clients/[id]/back-to-clients-button.tsx`:

```tsx
'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'

export function BackToClientsButton() {
  const router = useRouter()

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    // If there's history in the current tab, use it — preserves filter
    // state cleanly via the browser's native history stack. Falls
    // through to the Link's href otherwise (direct entry from Slack
    // share, deep link, etc.).
    if (typeof window !== 'undefined' && window.history.length > 1) {
      e.preventDefault()
      router.back()
    }
  }

  return (
    <Link
      href="/clients"
      onClick={handleClick}
      className="text-sm text-muted-foreground hover:underline"
    >
      ← Back to Clients
    </Link>
  )
}
```

**Why this shape over `router.back()` always:** `window.history.length > 1` is the conservative test. When a CSM opens a Slack share that goes directly to `/clients/<id>`, `history.length` is 1 and the Link's `/clients` fallback fires — they land on the clean list, not somewhere unexpected. When a CSM navigates list → detail, history length is ≥2 and `router.back()` restores the filtered URL.

Edge case: if a CSM landed on a detail page via a direct link, navigated around the dashboard, and ended up back at a detail page, `history.length > 1` is true but `router.back()` takes them to the previous internal page (not necessarily `/clients`). This is acceptable — the back button preserves real navigation history; the fallback only catches the cold-start case.

### Step 4 — Refresh fix

Two changes:

**4a:** Add `export const dynamic = 'force-dynamic'` at the top of `app/(authenticated)/clients/page.tsx`. Disables full-route caching for the list page; every navigation re-runs the server component against fresh DB data. Cost: ~200ms per visit. Acceptable at 197 clients.

**4b:** In each of the four editable cells (Step 2), after a successful inline save, call `router.refresh()` (wrapped in `startTransition` per React 19 patterns). This refreshes the *current* page's server-rendered content without a full navigation. The Server Action already calls `revalidatePath('/clients')` and `revalidatePath(\`/clients/${client_id}\`)` — `router.refresh()` makes the current page actually consume those invalidations immediately rather than waiting for the next navigation.

Sanity check before shipping: confirm `router.refresh()` doesn't lose the current scroll position or close the editable dropdown mid-save. The dropdown closes naturally on `EditableField`'s post-save state transition; scroll preservation is React Router's default for `router.refresh()`.

### Step 5 — Verification

- `npm run build` clean (0 type errors, route bundle sizes sensible).
- Smoke pass at the URL level — visit `/clients?status=active,paused&primary_csm=<id>&sort=csm_standing&dir=asc`. Confirm:
  1. Page loads with filter chips selected, sort indicator on CSM Standing column ↑, rows in CSM Standing ascending order.
  2. Click a row's name → detail page loads.
  3. Click "← Back to Clients" → returns to the filtered list (URL still has all params, rows still filtered).
  4. From the list, click directly into a status cell on a visible row → dropdown opens, no navigation. Change value → dropdown closes, value updates in place within ~1s.
  5. Repeat for journey_stage / csm_standing / trustpilot_status cells.
  6. Navigate to a detail page, edit a field in section 1, navigate back → list shows the new value without a manual refresh.
- Direct-entry smoke — open `/clients/<some-id>` in a fresh tab (no history). Click "← Back to Clients" → lands on `/clients` (clean, no filters). Confirms the fallback path.

## Hard stops

- **`EditableField` doesn't expose a variant the inline-edit-on-list needs.** Look at `editable-field.tsx`'s `renderEditor` switch before designing. If a needed variant is missing, surface — do NOT add new variants to `EditableField` opportunistically; that's a different scope. (Expected variants: `'enum'` covers all four. If one of these uses a different variant on the detail page, match the detail-page choice exactly.)
- **`STATUS_OPTIONS` / `JOURNEY_STAGE_OPTIONS` not exported from `lib/client-vocab.ts`.** Read the file first; if either is missing, surface — do not invent a new vocab export. State.md confirms `JOURNEY_STAGE_OPTIONS` was added 2026-05-08; verify by reading the file.
- **A Server Action call fails on the list view.** Each editable cell must surface the error to the user (the `EditableField` `StatusBadge` mechanism handles this). The cell must not silently swallow failures or leave the row in a "saving forever" state.
- **`force-dynamic` causes a Vercel build issue.** Vercel's Next.js 14 build should handle it cleanly — the route just opts out of static optimization. If it surfaces an unexpected build error, surface to Drake; don't paper over by removing the directive.
- **`router.refresh()` causes the editable dropdown to flicker or visually re-mount.** If the post-save UX is visibly worse than the detail-page equivalent, surface — Drake will decide whether to keep `router.refresh()` or revert to plain `revalidatePath`-only behavior.

## What could go wrong

- **Cell layout breaks at typical viewport widths.** `EditableField` was sized for section cards (~400px wide). In a table cell at ~120-180px, the dropdown trigger may overflow or wrap awkwardly. Drake's preference is to accept V1 visual rough edges; if it's *unusable* (overlapping rows, can't click) surface as a hard stop, otherwise ship and iterate.
- **Row click vs cell click confusion.** Cells stay as Link → row navigates; cells become editable → click opens dropdown. Users may try to click an editable cell and expect navigation. The `cursor-pointer hover:bg-muted/50` on `TableRow` may need to disable on the editable cells' hover states to avoid signaling "clickable to navigate." Use judgment — if it feels wrong during smoke, adjust the hover treatment per-cell.
- **`router.back()` lands on a non-`/clients` page.** Acceptable per Step 3's edge-case note. If Drake's smoke surfaces a real confusion case, iterate — but don't preempt.
- **The cascade trigger fires unexpectedly from a list edit.** Editing status to a negative value on the list fires migration 0022's cascade — same as the detail page. Expected behavior; the list edit isn't special-casing. If a CSM is surprised that editing status from the list also flipped csm_standing + accountability_enabled + nps_enabled + reassigned primary CSM, that's an education gap, not a bug.
- **History rows get written multiple times if the cell re-renders mid-save.** `EditableField`'s post-M5.6 `commit(draftOverride)` pattern handles this. Confirm by reading the file — the stale-closure fix is the relevant precedent.

## Mandatory doc updates

- **`docs/state.md`** — append one paragraph under the M5 Gregory entries noting the editable cells + reorder + back-nav fix + force-dynamic. One-line summary for each of the four changes; reference this spec's slug. Keep it tight.
- **No CLAUDE.md change.** Operational dashboard slice, not a system-state shift.
- **No new runbook.** The /clients page behavior is documented in `docs/agents/gregory.md` § Dashboard — that file's M5.5 / M5.6 / M5.7 entries already carry the filter-bar + columns vocabulary. A single follow-up entry there would be welcome; format matches the existing M5.x section structure. If the file gets unwieldy, defer that doc-hygiene work to a separate spec.

## Commit + report

Per CLAUDE.md § Commits, one logical change per commit. Suggested:

- `app/clients: reorder columns and add CSM Standing column`
- `app/clients: add inline-editable cells for status, journey_stage, csm_standing, trustpilot`
- `app/clients/[id]: replace back link with router.back() Client Component`
- `app/clients: force-dynamic on list page to defeat client cache staleness`
- `docs: log Gregory list editable + reorder + refresh shipment in state.md`
- `docs: add report for gregory-list-editable-reorder-refresh`

Builder may bundle the first two commits if the editable-cell wiring lives in the same file edit as the reorder (acceptable; one-logical-change is the principle, not a rigid count).

Report at `docs/reports/gregory-list-editable-reorder-refresh.md`. Include:

- Screenshots or descriptions of the before/after column order.
- A summary of each editable cell's wiring (which action it calls, which vocab options it pulls).
- Confirmation that the four edits write history rows correctly (spot-check one status edit + one csm_standing edit via `client_status_history` / `client_standing_history` reads).
- The Step 5 smoke results — each numbered check pass/fail.
- Any visual rough edges from the `EditableField`-in-cell rendering that Drake should know about (V1 acceptable but flag for future iteration).
- Any surprises with `force-dynamic` (build-time warnings, route-bundle-size shifts).
