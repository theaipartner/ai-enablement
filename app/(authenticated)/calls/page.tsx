import { getCallsList, type CallsListFilters, type CallsListRow } from '@/lib/db/calls'
import { listMergeCandidates } from '@/lib/db/merge'
import { CallsFilterBar } from './calls-filter-bar'
import { CallsTable } from './calls-table'

type SortKey =
  | 'started_at'
  | 'title'
  | 'call_category'
  | 'primary_client_name'
  | 'duration_seconds'
  | 'classification_confidence'

const VALID_SORT_KEYS: SortKey[] = [
  'started_at',
  'title',
  'call_category',
  'primary_client_name',
  'duration_seconds',
  'classification_confidence',
]

function readFilters(
  searchParams: Record<string, string | string[] | undefined>,
): CallsListFilters {
  const get = (key: string): string | undefined => {
    const v = searchParams[key]
    return Array.isArray(v) ? v[0] : v
  }
  return {
    category: get('category'),
    primary_client_id: get('client'),
    needs_review: get('needs_review') === '1',
    search: get('q'),
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
  const rows = await getCallsList(filters)

  const sortRaw = Array.isArray(searchParams.sort)
    ? searchParams.sort[0]
    : searchParams.sort
  const dirRaw = Array.isArray(searchParams.dir)
    ? searchParams.dir[0]
    : searchParams.dir

  // Default sort: started_at desc. When the needs_review toggle is on
  // and the user hasn't explicitly chosen a sort, surface the lowest-
  // confidence calls first by re-sorting on confidence ascending —
  // matches the gregory.md spec.
  const defaultSort: SortKey =
    filters.needs_review && !sortRaw ? 'classification_confidence' : 'started_at'
  const defaultDir: 'asc' | 'desc' =
    filters.needs_review && !sortRaw ? 'asc' : 'desc'

  const sort: SortKey = (VALID_SORT_KEYS as string[]).includes(sortRaw ?? '')
    ? (sortRaw as SortKey)
    : defaultSort
  const dir: 'asc' | 'desc' =
    dirRaw === 'asc' ? 'asc' : dirRaw === 'desc' ? 'desc' : defaultDir

  const sorted = sortRows(rows, sort, dir)

  // Client list for the "Filter by client" picker. Reuses the same
  // candidate-list shape the merge dialog uses (M3.2). The "exclude"
  // arg is a meaningless placeholder UUID — we want every active
  // client. 134 rows today; fetch-all is cheap.
  const clientOptions = await listMergeCandidates(
    '00000000-0000-0000-0000-000000000000',
  )

  // baseSearchParams strips sort/dir so column-header links generate
  // hrefs that preserve filters but replace the sort.
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
    <div className="px-8 py-8 space-y-6">
      <header
        className="flex items-end justify-between gap-6"
        style={{
          paddingBottom: 24,
          borderBottom: '1px solid var(--color-geg-border-strong)',
        }}
      >
        <div>
          <div className="geg-eyebrow">CSM · CALLS</div>
          <h1
            className="geg-display"
            style={{ fontSize: 52, lineHeight: '54px', marginTop: 8 }}
          >
            All calls.
          </h1>
        </div>
        <div
          className="geg-eyebrow geg-numeric"
          style={{ paddingBottom: 6 }}
        >
          {sorted.length} {sorted.length === 1 ? 'CALL' : 'CALLS'}
        </div>
      </header>

      <CallsFilterBar clientOptions={clientOptions} />

      <CallsTable
        rows={sorted}
        sort={sort}
        dir={dir}
        baseSearchParams={baseSearchParams}
      />
    </div>
  )
}
