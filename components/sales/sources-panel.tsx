import type { SourceRow } from '@/lib/db/sales-dashboard-mocks'
import { formatMetricValue } from '@/lib/db/sales-dashboard-shared'

// Pulse · sources — cash this period split by source. Bar widths show
// relative contribution; deltas show which sources are heating up.
// The video's "more before new" decision support: see which sources
// are driving revenue, then double down on the top ones.

export function SourcesPanel({ sources }: { sources: SourceRow[] }) {
  const max = sources.reduce((m, s) => Math.max(m, s.cash), 0) || 1
  const total = sources.reduce((s, r) => s + r.cash, 0)
  return (
    <section
      aria-label="Cash by source"
      style={{
        marginTop: 18,
        padding: '22px 26px 24px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 18,
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-3)',
            }}
          >
            CASH BY SOURCE
          </span>
          <span
            className="geg-serif"
            style={{ fontSize: 17, color: 'var(--color-geg-text)', letterSpacing: '-0.01em' }}
          >
            What&apos;s driving revenue this period.
          </span>
        </div>
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-3)',
          }}
        >
          TOTAL · {formatMetricValue(total, 'usd')}
        </span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {sources.map((s) => (
          <SourceBar key={s.id} row={s} max={max} />
        ))}
      </div>
    </section>
  )
}

function SourceBar({ row, max }: { row: SourceRow; max: number }) {
  const widthPct = (row.cash / max) * 100
  const deltaColor =
    row.delta === 0
      ? 'var(--color-geg-text-faint)'
      : row.delta > 0
        ? 'var(--color-geg-pos)'
        : 'var(--color-geg-neg)'
  const arrow = row.delta === 0 ? '·' : row.delta > 0 ? '▲' : '▼'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr 100px 70px', gap: 14, alignItems: 'center' }}>
      <div
        className="geg-serif"
        style={{
          fontSize: 13.5,
          color: 'var(--color-geg-text)',
          letterSpacing: '-0.002em',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {row.label}
      </div>
      <div
        style={{
          height: 10,
          borderRadius: 5,
          background: 'var(--color-geg-bg)',
          border: '1px solid var(--color-geg-border)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: `${widthPct}%`,
            background: 'var(--color-geg-accent)',
            opacity: 0.7,
          }}
        />
      </div>
      <div
        className="geg-numeric-serif"
        style={{ fontSize: 16, color: 'var(--color-geg-text)', textAlign: 'right', letterSpacing: '-0.01em' }}
      >
        {formatMetricValue(row.cash, 'usd')}
      </div>
      <div
        className="geg-mono"
        style={{ fontSize: 11, color: deltaColor, letterSpacing: '0.04em', fontWeight: 500, textAlign: 'right' }}
      >
        {arrow} {Math.abs(row.delta * 100).toFixed(0)}%
      </div>
    </div>
  )
}
