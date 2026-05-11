import Link from 'next/link'
import { ChevronRightIcon } from 'lucide-react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import type { EllaRunsListRow } from '@/lib/db/ella-runs'
import { AnomalyFlagsRow, RelativeTime, RolePill, RunStatusPill } from './pills'

function fmtCost(c: number | null): string {
  if (c == null) return '—'
  return `$${c.toFixed(4)}`
}

function fmtTokens(inTok: number | null, outTok: number | null): string {
  if (inTok == null && outTok == null) return '—'
  return `${(inTok ?? 0).toLocaleString()} / ${(outTok ?? 0).toLocaleString()}`
}

function truncate(s: string | null, n: number): string {
  if (!s) return '—'
  return s.length > n ? s.slice(0, n) + '…' : s
}

export function EllaRunsTable({ rows }: { rows: EllaRunsListRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border bg-zinc-50/50 p-8 text-center text-sm text-muted-foreground">
        No Ella runs match the current filters.
      </div>
    )
  }
  return (
    <div className="rounded-md border bg-white">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>When</TableHead>
            <TableHead>Channel</TableHead>
            <TableHead>Real author</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Anomalies</TableHead>
            <TableHead>Input</TableHead>
            <TableHead className="text-right">Tokens · Cost</TableHead>
            <TableHead className="w-8" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => (
            <TableRow key={r.id} className="cursor-pointer hover:bg-zinc-50">
              <TableCell className="whitespace-nowrap text-xs">
                <Link href={`/ella/runs/${r.id}`} className="block">
                  <RelativeTime iso={r.started_at} />
                </Link>
              </TableCell>
              <TableCell className="text-sm">
                <Link href={`/ella/runs/${r.id}`} className="block">
                  <div className="font-medium">#{r.channel_name ?? '?'}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.channel_client_name ?? '—'}
                  </div>
                </Link>
              </TableCell>
              <TableCell className="text-sm">
                <Link href={`/ella/runs/${r.id}`} className="block">
                  <div>{r.real_author_name ?? <span className="text-muted-foreground">unresolved</span>}</div>
                  <div className="mt-0.5">
                    <RolePill role={r.real_author_role} />
                  </div>
                </Link>
              </TableCell>
              <TableCell>
                <Link href={`/ella/runs/${r.id}`} className="block">
                  <RunStatusPill status={r.status} />
                </Link>
              </TableCell>
              <TableCell>
                <Link href={`/ella/runs/${r.id}`} className="block">
                  <AnomalyFlagsRow flags={r.anomaly_flags} />
                </Link>
              </TableCell>
              <TableCell className="max-w-[320px] text-sm">
                <Link href={`/ella/runs/${r.id}`} className="block">
                  <span className="text-muted-foreground">
                    {truncate(r.input_summary, 80)}
                  </span>
                </Link>
              </TableCell>
              <TableCell className="whitespace-nowrap text-right text-xs">
                <Link href={`/ella/runs/${r.id}`} className="block">
                  <div className="font-mono">
                    {fmtTokens(r.llm_input_tokens, r.llm_output_tokens)}
                  </div>
                  <div className="font-mono text-muted-foreground">
                    {fmtCost(r.llm_cost_usd)}
                  </div>
                </Link>
              </TableCell>
              <TableCell>
                <Link
                  href={`/ella/runs/${r.id}`}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <ChevronRightIcon className="h-4 w-4" />
                </Link>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
