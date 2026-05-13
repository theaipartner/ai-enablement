import type { EllaSummaryStats } from '@/lib/db/ella-runs'

// Editorial 4-card metric strip — Runs / Cost / Errors / Surface.
// Mirrors the gold-bordered translucent-fill treatment from the Calls +
// Clients redesigns; each card carries a mono caps label, a serif
// tabular-num value, and an optional mono hint with this-week /
// this-month rollups. Errors > 0 paints the value in --color-geg-neg
// per the design handoff (Gregory Ella Redesign.html § 1).

function fmtCost(c: number): string {
  return `$${c.toFixed(2)}`
}

function MetricCard({
  label,
  value,
  unit,
  hint,
  variant,
}: {
  label: string
  value: string | number
  unit?: string
  hint?: string
  variant?: 'value' | 'surface' | 'neg'
}) {
  const isSurface = variant === 'surface'
  const isNeg = variant === 'neg'
  return (
    <div
      style={{
        background: 'var(--color-geg-accent-fill)',
        border: '1px solid var(--color-geg-accent-border)',
        borderRadius: 8,
        padding: '16px 18px',
      }}
    >
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-2)',
        }}
      >
        {label}
      </div>
      <div
        className="geg-serif"
        style={{
          fontWeight: 500,
          fontSize: isSurface ? 24 : 36,
          lineHeight: 1.05,
          letterSpacing: isSurface ? '-0.01em' : '-0.015em',
          color: isNeg
            ? 'var(--color-geg-neg)'
            : 'var(--color-geg-text)',
          fontVariantNumeric: 'tabular-nums',
          marginTop: 6,
        }}
      >
        {value}
        {unit ? (
          <span
            className="geg-mono"
            style={{
              fontSize: 14,
              color: 'var(--color-geg-text-faint)',
              marginLeft: 4,
              letterSpacing: '0.02em',
            }}
          >
            {unit}
          </span>
        ) : null}
      </div>
      {hint ? (
        <div
          className="geg-mono"
          style={{
            fontSize: 11,
            color: 'var(--color-geg-text-faint)',
            marginTop: 8,
            letterSpacing: '0.02em',
            lineHeight: 1.5,
          }}
        >
          {hint}
        </div>
      ) : null}
    </div>
  )
}

export function EllaRunsSummaryBand({ stats }: { stats: EllaSummaryStats }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 16,
        marginBottom: 6,
      }}
    >
      <MetricCard
        label="Runs · today"
        value={stats.total_today}
        hint={`${stats.total_week} this week · ${stats.total_month} this month`}
      />
      <MetricCard
        label="Cost · today"
        value={fmtCost(stats.cost_today)}
        unit="USD"
        hint={`${fmtCost(stats.cost_week)} this week · ${fmtCost(stats.cost_month)} this month`}
      />
      <MetricCard
        label="Errors · today"
        value={stats.errors_today}
        variant={stats.errors_today > 0 ? 'neg' : 'value'}
        hint={`${stats.errors_week} this week · ${stats.errors_month} this month`}
      />
      <MetricCard
        label="Surface"
        value="Ella V2"
        variant="surface"
        hint="your personal assistant"
      />
    </div>
  )
}
