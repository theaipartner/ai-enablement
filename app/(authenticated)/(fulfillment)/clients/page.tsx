import { getClientsList, type ClientsListFilters, type ClientsListRow } from '@/lib/db/clients'
import { createAdminClient } from '@/lib/supabase/admin'
import { FilterBar } from './filter-bar'
import { ClientsTable } from './clients-table'

// Inline-edit cells on this list call revalidatePath('/clients') after
// every save, but the route's static-render cache otherwise serves stale
// data on a return navigation from a detail page (until the cache TTL
// expires). force-dynamic disables the static optimization so every
// navigation re-runs against fresh DB data. Cost: ~200ms per visit;
// acceptable at 197 clients.
export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Column layout per Scott's 2026-05-11 ask. Mirror of clients-table.tsx
// SORTABLE_COLUMNS — kept duplicated rather than imported because the
// table is a client-tree component and we don't want to drag its imports
// into the server bundle. Drift risk is low; both sets validated at
// `next build` type-check time via the SortKey type.
type SortKey =
  | 'full_name'
  | 'status'
  | 'journey_stage'
  | 'primary_csm_name'
  | 'csm_standing'
  | 'nps_standing'
  | 'trustpilot_status'
  | 'latest_health_score'
  | 'meetings_this_month'

const VALID_SORT_KEYS: SortKey[] = [
  'full_name',
  'status',
  'journey_stage',
  'primary_csm_name',
  'csm_standing',
  'nps_standing',
  'trustpilot_status',
  'latest_health_score',
  'meetings_this_month',
]

// Mirror of FilterBar's STATUS_DEFAULT_SELECTED. Kept duplicated rather
// than imported because the file boundary between Server Component
// (page) and Client Component (filter-bar) crosses a 'use client'
// boundary; keeping the constant local avoids accidentally pulling
// client-only code into the server bundle. Drift risk is low — both
// values are tested at the smoke checkpoint.
const STATUS_DEFAULT_SELECTED = ['active', 'paused', 'ghost']

function parseMulti(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return []
  return raw.split(',').filter(Boolean)
}

function readFilters(searchParams: Record<string, string | string[] | undefined>): ClientsListFilters {
  const get = (key: string): string | undefined => {
    const v = searchParams[key]
    return Array.isArray(v) ? v[0] : v
  }

  // Status sentinel: absent → default trio; explicit-empty → no filter
  // (show all statuses including churned/leave); else parse.
  const statusRaw = get('status')
  const status: string[] =
    statusRaw === undefined
      ? STATUS_DEFAULT_SELECTED
      : statusRaw === ''
        ? []
        : statusRaw.split(',').filter(Boolean)

  // M5.7 — accountability / nps_toggle are 'on' | 'off' multi-selects; the
  // data layer maps these to booleans before .in()-ing against the M5.6
  // accountability_enabled / nps_enabled columns. Junk values are dropped at
  // parse time so a crafted ?accountability=foo just no-ops.
  const accountability = parseMulti(get('accountability')).filter(
    (v): v is 'on' | 'off' => v === 'on' || v === 'off',
  )
  const npsToggle = parseMulti(get('nps_toggle')).filter(
    (v): v is 'on' | 'off' => v === 'on' || v === 'off',
  )

  return {
    status,
    primary_csm_ids: parseMulti(get('primary_csm')),
    csm_standing: parseMulti(get('csm_standing')),
    nps_standing: parseMulti(get('nps_standing')),
    trustpilot_status: parseMulti(get('trustpilot')),
    country: parseMulti(get('country')),
    accountability,
    nps_toggle: npsToggle,
    needs_review: get('needs_review') === '1',
    missing_slack: get('missing_slack') === '1',
    meetings_this_month: parseMulti(get('meetings')).filter(
      (v): v is 'gte2' | 'lt2' => v === 'gte2' || v === 'lt2',
    ),
    search: get('q'),
  }
}

function sortRows(
  rows: ClientsListRow[],
  sort: SortKey,
  dir: 'asc' | 'desc',
): ClientsListRow[] {
  // NULLs always sort to the bottom regardless of direction — matches
  // SQL's NULLS LAST idiom. Important for the V2 default
  // (latest_health_score asc, worst first): clients with no Gregory
  // eval yet have a null score and should not masquerade as "worst" —
  // they sink to the bottom regardless of direction.
  const sortVal = (row: ClientsListRow): string | number | null => {
    const value = row[sort]
    if (value === null || value === undefined) return null
    return value as string | number
  }
  const cmp = (a: ClientsListRow, b: ClientsListRow) => {
    const va = sortVal(a)
    const vb = sortVal(b)
    if (va === null && vb === null) return 0
    if (va === null) return 1 // a goes after b regardless of dir
    if (vb === null) return -1
    if (va < vb) return dir === 'asc' ? -1 : 1
    if (va > vb) return dir === 'asc' ? 1 : -1
    return 0
  }
  return [...rows].sort(cmp)
}

export default async function ClientsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const filters = readFilters(searchParams)
  const rows = await getClientsList(filters)

  // V2 default: latest_health_score asc (worst first) — surfaces
  // clients needing attention at the top now that V2 brain produces
  // reliable scores. Replaces the V1 default of last_call_date desc
  // (column removed in this commit). Pre-existing bookmarks with
  // ?sort=last_call_date or ?sort=open_action_items_count fall through
  // to this default via the validation below.
  const sortRaw = (Array.isArray(searchParams.sort) ? searchParams.sort[0] : searchParams.sort) ?? 'latest_health_score'
  const dirRaw = (Array.isArray(searchParams.dir) ? searchParams.dir[0] : searchParams.dir) ?? 'asc'
  const sort: SortKey = (VALID_SORT_KEYS as string[]).includes(sortRaw)
    ? (sortRaw as SortKey)
    : 'latest_health_score'
  const dir: 'asc' | 'desc' = dirRaw === 'asc' ? 'asc' : 'desc'

  const sorted = sortRows(rows, sort, dir)

  // Build the list of CSMs for the Primary CSM filter dropdown.
  // is_csm=true is the M5.6 cleanup gate — non-CSM team_members
  // (engineering, ops, sales) are excluded; the four real CSMs
  // (Lou, Nico, Scott Wilson, Nabeel) plus the Scott Chasing sentinel
  // surface here.
  const supabase = createAdminClient()
  const { data: teamMembers } = await supabase
    .from('team_members')
    .select('id, full_name')
    .eq('is_active', true)
    .eq('is_csm', true)
    .is('archived_at', null)
    .order('full_name')

  const primaryCsmOptions = (teamMembers ?? []).map((member) => ({
    id: member.id,
    label: member.full_name,
  }))

  // M5.7 — distinct country values for the new Country filter dropdown.
  // Sourced dynamically from current data (USA/AUS today, NULLs excluded
  // server-side) rather than a static vocab — country isn't CHECK-constrained
  // yet, so the DB is the only authority. When the column gets promoted to a
  // CHECK-constrained vocab in a later slice, this can move into client-vocab.
  const { data: countryRows } = await supabase
    .from('clients')
    .select('country')
    .is('archived_at', null)
    .not('country', 'is', null)
    .order('country')
  const countryOptions = Array.from(
    new Set((countryRows ?? []).map((r) => r.country as string)),
  )
    .filter((c) => c.length > 0)
    .sort()

  // Filter bar reads URL params directly via useSearchParams; we just
  // need to pass it the list of CSM options.
  // Pass the un-prefixed search params object as JSON so the table can
  // generate hrefs that preserve all current filters when sort changes.
  const baseSearchParamsObj: Record<string, string> = {}
  for (const [key, value] of Object.entries(searchParams)) {
    if (key === 'sort' || key === 'dir') continue
    if (Array.isArray(value)) {
      if (value[0] !== undefined) baseSearchParamsObj[key] = value[0]
    } else if (value !== undefined) {
      baseSearchParamsObj[key] = value
    }
  }
  const baseSearchParams = new URLSearchParams(baseSearchParamsObj)

  return (
    <div style={{ padding: '36px 48px 0' }}>
      <header
        className="flex items-end justify-between gap-6"
        style={{ paddingBottom: 24 }}
      >
        <div>
          <div className="geg-eyebrow">CSM · CLIENTS</div>
          <h1
            className="geg-serif"
            style={{
              fontWeight: 500,
              fontSize: 48,
              lineHeight: 1.05,
              letterSpacing: '-0.015em',
              color: 'var(--color-geg-text)',
              margin: '8px 0 0',
            }}
          >
            All clients.
          </h1>
        </div>
        <div
          className="geg-mono"
          style={{
            fontSize: 11,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-2)',
          }}
        >
          <b style={{ color: 'var(--color-geg-text)', fontWeight: 500 }}>
            {sorted.length}
          </b>{' '}
          {sorted.length === 1 ? 'CLIENT' : 'CLIENTS'}
        </div>
      </header>

      <FilterBar
        primaryCsmOptions={primaryCsmOptions}
        countryOptions={countryOptions}
      />

      <ClientsTable
        rows={sorted}
        sort={sort}
        dir={dir}
        baseSearchParams={baseSearchParams}
        csmOptions={teamMembers ?? []}
        showSlackColumn={
          filters.needs_review === true || filters.missing_slack === true
        }
      />
    </div>
  )
}
