import type { EllaSummaryStats } from '@/lib/db/ella-runs'

// Part 2 redesign: 4-card strip (Runs / Cost / Errors / Surface). The
// V1 "Anomalies today" + "Status mix (30d)" cards are removed; the
// underlying anomaly + status_counts data is still computed by the
// data layer for future alert-source use.

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border bg-white px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
    </div>
  )
}

function fmtCost(c: number): string {
  return `$${c.toFixed(4)}`
}

export function EllaRunsSummaryBand({ stats }: { stats: EllaSummaryStats }) {
  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
      <Stat
        label="Runs"
        value={`${stats.total_today}`}
        hint={`${stats.total_week} this week · ${stats.total_month} this month`}
      />
      <Stat
        label="Cost"
        value={fmtCost(stats.cost_today)}
        hint={`${fmtCost(stats.cost_week)} this week · ${fmtCost(stats.cost_month)} this month · ${fmtCost(stats.skip_cost_today)} skip cost today`}
      />
      <Stat
        label="Errors"
        value={`${stats.errors_today}`}
        hint={`${stats.errors_week} this week · ${stats.errors_month} this month`}
      />
      <Stat
        label="Surface"
        value="Ella V2"
        hint="your personal assistant"
      />
    </div>
  )
}
