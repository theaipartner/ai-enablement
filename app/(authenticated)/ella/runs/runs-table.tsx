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
import { RelativeTime, RolePill, RunStatusPill } from './pills'

// Part 2 list-polish redesign:
// - "Input" column → "Output" column. The Run list scope is now
//   response-only (Ella actually attempted to speak); the meaningful
//   per-row content is what Ella said, not the triggering message.
//   Source: row.output_text (mention-rendered at the data layer; this
//   component stays dumb).
// - Outer `rounded-md border bg-white` wrapper removed. The table now
//   sits flush on the page surface; per-row border-bottom (shadcn's
//   default TableRow `border-b`) carries the visual separation.
// - Cell padding bumped via `py-3` className additive so the row
//   breathing room matches the metric cards above.
// - Empty-state framing kept (with its own bordered container) — that
//   reads cleanly as a one-shot "nothing to show" message.

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

const CELL_PADDING = 'py-3 px-2'

export function EllaRunsTable({ rows }: { rows: EllaRunsListRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-md border bg-white p-8 text-center text-sm text-muted-foreground">
        No Ella runs match the current filters.
      </div>
    )
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className={CELL_PADDING}>When</TableHead>
          <TableHead className={CELL_PADDING}>Channel</TableHead>
          <TableHead className={CELL_PADDING}>Who Ella responded to</TableHead>
          <TableHead className={CELL_PADDING}>Status</TableHead>
          <TableHead className={CELL_PADDING}>Output</TableHead>
          <TableHead className={`${CELL_PADDING} text-right`}>Tokens · Cost</TableHead>
          <TableHead className={`${CELL_PADDING} w-8`} />
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id} className="cursor-pointer hover:bg-zinc-50">
            <TableCell className={`${CELL_PADDING} whitespace-nowrap text-xs`}>
              <Link href={`/ella/runs/${r.id}`} className="block">
                <RelativeTime iso={r.started_at} />
              </Link>
            </TableCell>
            <TableCell className={`${CELL_PADDING} text-sm`}>
              <Link href={`/ella/runs/${r.id}`} className="block">
                <div className="font-medium">#{r.channel_name ?? '?'}</div>
              </Link>
            </TableCell>
            <TableCell className={`${CELL_PADDING} text-sm`}>
              <Link href={`/ella/runs/${r.id}`} className="block">
                <div>{r.real_author_name ?? <span className="text-muted-foreground">unresolved</span>}</div>
                <div className="mt-0.5">
                  <RolePill role={r.real_author_role} />
                </div>
              </Link>
            </TableCell>
            <TableCell className={CELL_PADDING}>
              <Link href={`/ella/runs/${r.id}`} className="block">
                <RunStatusPill status={r.status} />
              </Link>
            </TableCell>
            <TableCell className={`${CELL_PADDING} max-w-[360px] text-sm`}>
              <Link href={`/ella/runs/${r.id}`} className="block">
                {r.output_text ? (
                  <span>{truncate(r.output_text, 80)}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </Link>
            </TableCell>
            <TableCell className={`${CELL_PADDING} whitespace-nowrap text-right text-xs`}>
              <Link href={`/ella/runs/${r.id}`} className="block">
                <div className="font-mono">
                  {fmtTokens(r.llm_input_tokens, r.llm_output_tokens)}
                </div>
                <div className="font-mono text-muted-foreground">
                  {fmtCost(r.llm_cost_usd)}
                </div>
              </Link>
            </TableCell>
            <TableCell className={CELL_PADDING}>
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
  )
}
