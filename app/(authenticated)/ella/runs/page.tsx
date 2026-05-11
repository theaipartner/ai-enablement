import {
  getEllaRunsList,
  getEllaSummaryStats,
  listChannelsWithEllaRuns,
  type AnomalyFlag,
  type EllaRunsListFilters,
} from '@/lib/db/ella-runs'
import { EllaRunsFilterBar } from './filter-bar'
import { EllaRunsSummaryBand } from './summary-band'
import { EllaRunsTable } from './runs-table'

const ANOMALY_VALUES: ReadonlySet<AnomalyFlag> = new Set<AnomalyFlag>([
  'A',
  'B_prime',
  'C',
  'D',
  'E',
])

function readFilters(
  searchParams: Record<string, string | string[] | undefined>,
): EllaRunsListFilters {
  const get = (key: string): string | undefined => {
    const v = searchParams[key]
    return Array.isArray(v) ? v[0] : v
  }
  const list = (key: string): string[] => {
    const v = get(key)
    return v ? v.split(',').filter(Boolean) : []
  }

  const filters: EllaRunsListFilters = {
    from: get('from'),
    to: get('to'),
    channels: list('channel'),
    statuses: list('status'),
  }
  const roles = list('role') as Array<'client' | 'advisor' | 'unresolvable' | 'unknown'>
  if (roles.length) filters.speaker_roles = roles
  const anomalies = list('anomaly').filter((v): v is AnomalyFlag =>
    ANOMALY_VALUES.has(v as AnomalyFlag),
  )
  // The "Show anomalies only" toggle is a superset filter — when on,
  // ANY anomaly flag matches. We model that by adding every flag if
  // no specific anomalies are selected; otherwise the explicit
  // selection takes precedence.
  if (get('anomalies_only') === '1' && anomalies.length === 0) {
    filters.anomalies = ['A', 'B_prime', 'C', 'D', 'E']
  } else if (anomalies.length) {
    filters.anomalies = anomalies
  }
  return filters
}

export default async function EllaRunsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const filters = readFilters(searchParams)
  const [{ rows, total }, stats, channelOptions] = await Promise.all([
    getEllaRunsList(filters),
    getEllaSummaryStats(),
    listChannelsWithEllaRuns(),
  ])

  const channelDropdownOptions = channelOptions
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ value: c.slack_channel_id, label: c.name }))

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Ella runs</h1>
        <span className="text-sm text-muted-foreground">
          {total} {total === 1 ? 'run' : 'runs'}
        </span>
      </div>

      <EllaRunsSummaryBand stats={stats} />
      <EllaRunsFilterBar channelOptions={channelDropdownOptions} />
      <EllaRunsTable rows={rows} />
    </div>
  )
}
