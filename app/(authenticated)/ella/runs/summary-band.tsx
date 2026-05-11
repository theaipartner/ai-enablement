import type { EllaSummaryStats } from '@/lib/db/ella-runs'

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
  const statusOrder = ['success', 'escalated', 'error', 'skipped'] as const
  const statusSummary = statusOrder
    .map((s) => (stats.status_counts[s] ? `${s}: ${stats.status_counts[s]}` : null))
    .filter(Boolean)
    .join(' · ')

  return (
    <div className="grid grid-cols-2 gap-2 md:grid-cols-5">
      <Stat
        label="Today"
        value={`${stats.total_today}`}
        hint={`${stats.total_week} this week · ${stats.total_month} this month`}
      />
      <Stat
        label="Status mix (30d)"
        value={`${stats.total_month}`}
        hint={statusSummary || '—'}
      />
      <Stat
        label="Cost today"
        value={fmtCost(stats.cost_today)}
        hint={`${fmtCost(stats.cost_week)} this week`}
      />
      <Stat
        label="Anomalies today"
        value={`${stats.anomaly_count_today}`}
        hint="Any of checks A / B' / C / D / E"
      />
      <Stat
        label="Surface"
        value="Ella V2"
        hint="agent_name='ella' only"
      />
    </div>
  )
}
