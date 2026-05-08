import Link from 'next/link'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import {
  JourneyStagePill,
  NpsStandingPill,
  StatusPill,
  TrustpilotPill,
} from './pills'
import type { ClientsListRow } from '@/lib/db/clients'

// V2 column layout (2026-05-08): NPS standing + Trustpilot + Meetings
// this month replaced Tags + Last call + Open action items. All eight
// columns sortable now (was seven sortable + one Tags column outside
// the sort map).
type SortKey =
  | 'full_name'
  | 'status'
  | 'journey_stage'
  | 'primary_csm_name'
  | 'nps_standing'
  | 'latest_health_score'
  | 'trustpilot_status'
  | 'meetings_this_month'

const SORTABLE_COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'full_name', label: 'Full name' },
  { key: 'status', label: 'Status' },
  { key: 'journey_stage', label: 'Journey stage' },
  { key: 'primary_csm_name', label: 'Primary CSM' },
  { key: 'nps_standing', label: 'NPS standing' },
  { key: 'latest_health_score', label: 'Health score' },
  { key: 'trustpilot_status', label: 'Trustpilot' },
  { key: 'meetings_this_month', label: 'Meetings this mo' },
]

function SortableHeader({
  column,
  currentSort,
  currentDir,
  baseSearchParams,
}: {
  column: { key: SortKey; label: string }
  currentSort: string
  currentDir: 'asc' | 'desc'
  baseSearchParams: URLSearchParams
}) {
  const params = new URLSearchParams(baseSearchParams)
  const nextDir =
    currentSort === column.key && currentDir === 'desc' ? 'asc' : 'desc'
  params.set('sort', column.key)
  params.set('dir', nextDir)
  const href = `?${params.toString()}`
  const indicator =
    currentSort === column.key ? (currentDir === 'desc' ? '↓' : '↑') : ''
  return (
    <Link
      href={href}
      className="hover:underline underline-offset-4 inline-flex items-center gap-1"
    >
      {column.label}
      {indicator ? <span className="text-muted-foreground">{indicator}</span> : null}
    </Link>
  )
}

function MeetingsThisMonthCell({ count }: { count: number }) {
  // Zero is meaningful (no meetings this calendar month), not missing
  // data — render "0", not "—". Tabular-nums so the column reads as a
  // tidy stack of right-aligned numerals.
  return (
    <span className="tabular-nums text-sm">{count}</span>
  )
}

function HealthScoreCell({
  score,
  tier,
}: {
  score: number | null
  tier: string | null
}) {
  if (score === null) {
    return (
      <span className="text-muted-foreground text-sm">—</span>
    )
  }
  const tierCls =
    tier === 'green'
      ? 'bg-emerald-100 text-emerald-900 border-emerald-200'
      : tier === 'yellow'
        ? 'bg-amber-100 text-amber-900 border-amber-200'
        : tier === 'red'
          ? 'bg-rose-100 text-rose-900 border-rose-200'
          : 'bg-zinc-100 text-zinc-700 border-zinc-200'
  return (
    <span className="inline-flex items-center gap-2">
      <span className="font-medium">{score}</span>
      <span className={cn('rounded-full border px-2 py-0.5 text-xs', tierCls)}>
        {tier ?? '—'}
      </span>
    </span>
  )
}

export function ClientsTable({
  rows,
  sort,
  dir,
  baseSearchParams,
}: {
  rows: ClientsListRow[]
  sort: SortKey
  dir: 'asc' | 'desc'
  baseSearchParams: URLSearchParams
}) {
  if (rows.length === 0) {
    return (
      <div className="border rounded-md p-8 text-center text-muted-foreground">
        No clients match your filters.
      </div>
    )
  }

  return (
    <div className="border rounded-md">
      <Table>
        <TableHeader>
          <TableRow>
            {SORTABLE_COLUMNS.map((col) => (
              <TableHead key={col.key}>
                <SortableHeader
                  column={col}
                  currentSort={sort}
                  currentDir={dir}
                  baseSearchParams={baseSearchParams}
                />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.id} className="cursor-pointer hover:bg-muted/50">
              <TableCell>
                <Link
                  href={`/clients/${row.id}`}
                  className="font-medium hover:underline underline-offset-4 block"
                >
                  {row.full_name}
                </Link>
              </TableCell>
              <TableCell>
                <Link href={`/clients/${row.id}`} className="block">
                  <StatusPill status={row.status} />
                </Link>
              </TableCell>
              <TableCell>
                <Link href={`/clients/${row.id}`} className="block">
                  <JourneyStagePill stage={row.journey_stage} />
                </Link>
              </TableCell>
              <TableCell>
                <Link href={`/clients/${row.id}`} className="block">
                  {row.primary_csm_name ?? (
                    <span className="text-muted-foreground">Unassigned</span>
                  )}
                </Link>
              </TableCell>
              <TableCell>
                <Link href={`/clients/${row.id}`} className="block">
                  <NpsStandingPill standing={row.nps_standing} />
                </Link>
              </TableCell>
              <TableCell>
                <Link href={`/clients/${row.id}`} className="block">
                  <HealthScoreCell
                    score={row.latest_health_score}
                    tier={row.latest_health_tier}
                  />
                </Link>
              </TableCell>
              <TableCell>
                <Link href={`/clients/${row.id}`} className="block">
                  <TrustpilotPill status={row.trustpilot_status} />
                </Link>
              </TableCell>
              <TableCell>
                <Link href={`/clients/${row.id}`} className="block">
                  <MeetingsThisMonthCell count={row.meetings_this_month} />
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
