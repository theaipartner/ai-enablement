import { getCallsList, listActiveCsms, type CallsListFilters, type CallsListRow } from '@/lib/db/calls'
import { listMergeCandidates } from '@/lib/db/merge'
import { CallsFilterBar } from './calls-filter-bar'
import { CallsTable } from './calls-table'

// Calls redesign · § 1 — list page (/calls).
//
//   - Header: geg-eyebrow → serif H1 "All calls." → right-aligned count.
//   - Filter bar: search + client select + CSM select.
//   - Table: Date · Title · Primary client · CSM · Sentiment · Duration.
//   - Pre-filtered server-side to category='client' (data-layer default).

type SortKey =
  | 'started_at'
  | 'title'
  | 'primary_client_name'
  | 'csm_team_member_name'
  | 'duration_seconds'

const VALID_SORT_KEYS: SortKey[] = [
  'started_at',
  'title',
  'primary_client_name',
  'csm_team_member_name',
  'duration_seconds',
]

function readFilters(
  searchParams: Record<string, string | string[] | undefined>,
): CallsListFilters {
  const get = (key: string): string | undefined => {
    const v = searchParams[key]
    return Array.isArray(v) ? v[0] : v
  }
  return {
    // No `category` param — list scope is always client (data-layer default).
    primary_client_id: get('client'),
    search: get('q'),
    csm_id: get('csm'),
  }
}

function sortRows(
  rows: CallsListRow[],
  sort: SortKey,
  dir: 'asc' | 'desc',
): CallsListRow[] {
  const sortVal = (row: CallsListRow): string | number | null => {
    const value = row[sort]
    if (value === null || value === undefined) return null
    return value as string | number
  }
  const cmp = (a: CallsListRow, b: CallsListRow) => {
    const va = sortVal(a)
    const vb = sortVal(b)
    if (va === null && vb === null) return 0
    if (va === null) return 1
    if (vb === null) return -1
    if (va < vb) return dir === 'asc' ? -1 : 1
    if (va > vb) return dir === 'asc' ? 1 : -1
    return 0
  }
  return [...rows].sort(cmp)
}

export default async function CallsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const filters = readFilters(searchParams)
  const [rows, clientOptions, csmOptions] = await Promise.all([
    getCallsList(filters),
    listMergeCandidates('00000000-0000-0000-0000-000000000000'),
    listActiveCsms(),
  ])

  const sortRaw = Array.isArray(searchParams.sort)
    ? searchParams.sort[0]
    : searchParams.sort
  const dirRaw = Array.isArray(searchParams.dir)
    ? searchParams.dir[0]
    : searchParams.dir
  const sort: SortKey = (VALID_SORT_KEYS as string[]).includes(sortRaw ?? '')
    ? (sortRaw as SortKey)
    : 'started_at'
  const dir: 'asc' | 'desc' = dirRaw === 'asc' ? 'asc' : 'desc'

  const sortedRows = sortRows(rows, sort, dir)

  // Echo every non-sort param into the sort URLs so toggling sort keeps
  // the active filter state.
  const baseSearchParams = new URLSearchParams()
  for (const [key, raw] of Object.entries(searchParams)) {
    if (key === 'sort' || key === 'dir') continue
    const value = Array.isArray(raw) ? raw[0] : raw
    if (value) baseSearchParams.set(key, value)
  }

  return (
    <div style={{ padding: '36px 48px 0' }}>
      <header
        className="flex items-end justify-between gap-6"
        style={{ paddingBottom: 24 }}
      >
        <div>
          <div className="geg-eyebrow">CSM · CALLS</div>
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
            All calls.
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
            {sortedRows.length}
          </b>{' '}
          CLIENT CALLS
        </div>
      </header>

      <CallsFilterBar
        clientOptions={clientOptions}
        csmOptions={csmOptions}
      />

      <CallsTable
        rows={sortedRows}
        sort={sort}
        dir={dir}
        baseSearchParams={baseSearchParams}
      />
    </div>
  )
}
