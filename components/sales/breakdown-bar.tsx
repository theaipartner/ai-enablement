import { formatMetricValue, type MetricFormat } from '@/lib/db/sales-dashboard-shared'

// Generic horizontal-bar breakdown — used by section pages for cash-by-
// X composition (objections, call type, offer, expense subcategory).
// Each row: label · bar · value · optional share % / delta.

export type BreakdownRow = {
  id: string
  label: string
  value: number
  delta?: number
  share?: number  // 0..1
}

export type BreakdownBarProps = {
  rows: BreakdownRow[]
  format?: MetricFormat
  showShare?: boolean
  showDelta?: boolean
  labelWidth?: number
  accentColor?: string
}

export function BreakdownBar({
  rows,
  format = 'integer',
  showShare = false,
  showDelta = false,
  labelWidth = 200,
  accentColor = 'var(--color-geg-accent)',
}: BreakdownBarProps) {
  const max = rows.reduce((m, r) => Math.max(m, Math.abs(r.value)), 0) || 1
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {rows.map((r) => {
        const widthPct = (Math.abs(r.value) / max) * 100
        const isNegative = r.value < 0
        const valStr = formatMetricValue(r.value, format)
        return (
          <div
            key={r.id}
            style={{
              display: 'grid',
              gridTemplateColumns: `${labelWidth}px 1fr 110px ${showShare ? '60px ' : ''}${showDelta ? '70px' : ''}`,
              gap: 14,
              alignItems: 'center',
            }}
          >
            <span
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
              {r.label}
            </span>
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
                  background: isNegative ? 'var(--color-geg-neg)' : accentColor,
                  opacity: 0.75,
                }}
              />
            </div>
            <span
              className="geg-numeric-serif"
              style={{
                fontSize: 15,
                color: 'var(--color-geg-text)',
                letterSpacing: '-0.01em',
                textAlign: 'right',
              }}
            >
              {valStr}
            </span>
            {showShare && typeof r.share === 'number' ? (
              <span
                className="geg-mono"
                style={{
                  fontSize: 11,
                  color: 'var(--color-geg-text-faint)',
                  letterSpacing: '0.04em',
                  textAlign: 'right',
                }}
              >
                {Math.round(r.share * 100)}%
              </span>
            ) : null}
            {showDelta && typeof r.delta === 'number' ? (
              <span
                className="geg-mono"
                style={{
                  fontSize: 11,
                  color:
                    r.delta === 0
                      ? 'var(--color-geg-text-faint)'
                      : r.delta > 0
                        ? 'var(--color-geg-pos)'
                        : 'var(--color-geg-neg)',
                  letterSpacing: '0.04em',
                  fontWeight: 500,
                  textAlign: 'right',
                }}
              >
                {r.delta === 0 ? '·' : r.delta > 0 ? '▲' : '▼'} {Math.abs(r.delta * 100).toFixed(0)}%
              </span>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
