import type { FmrTimeBlocksResult } from '@/lib/db/funnel-appointment-setting'

// First Message Response — time-block bar chart with cohort avg.
//
// 6 time-of-day blocks × 2 bars each (ever-replied + within-24h). Pure
// SVG so it renders server-side without a chart-lib dependency. The cohort is
// the page's window cohort (range-scoped, bucketed by ET opt-in hour); the
// footer shows the window label (fmr.cohortStart).

export function FmrTimeBlockChart({ fmr }: { fmr: FmrTimeBlocksResult }) {
  // Bar geometry — fits comfortably in the page's content column.
  const PAD_X = 36
  const PAD_TOP = 18
  const PAD_BOTTOM = 50
  const CHART_W = 720
  const CHART_H = 280

  // Cohort-wide ever-replied rate (used as a dashed reference line
  // across the chart so each block's bar reads against it).
  const cohortEverRate =
    fmr.cohortSize > 0 ? fmr.cohortEverReplied / fmr.cohortSize : null
  const groupGap = 14
  const blockCount = fmr.blocks.length
  const groupWidth = (CHART_W - PAD_X * 2 - groupGap * (blockCount - 1)) / blockCount
  const barWidth = (groupWidth - 8) / 2
  const usableH = CHART_H - PAD_TOP - PAD_BOTTOM

  function y(rate: number | null): number {
    if (rate === null) return CHART_H - PAD_BOTTOM
    return PAD_TOP + usableH * (1 - rate)
  }
  function h(rate: number | null): number {
    if (rate === null) return 0
    return usableH * rate
  }

  // Y-axis gridlines at 25/50/75/100%
  const gridlines = [0.25, 0.5, 0.75, 1]

  return (
    <div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width="100%" style={{ maxWidth: CHART_W, display: 'block', margin: '0 auto' }}>
        {/* Y-axis labels + gridlines */}
        {gridlines.map((g) => {
          const yPos = PAD_TOP + usableH * (1 - g)
          return (
            <g key={g}>
              <line
                x1={PAD_X}
                x2={CHART_W - PAD_X}
                y1={yPos}
                y2={yPos}
                stroke="var(--color-geg-border)"
                strokeDasharray="2 4"
                strokeWidth="1"
              />
              <text
                x={PAD_X - 8}
                y={yPos + 3}
                textAnchor="end"
                className="geg-mono"
                style={{ fontSize: 9, letterSpacing: '0.04em', fill: 'var(--color-geg-text-faint)' }}
              >
                {Math.round(g * 100)}%
              </text>
            </g>
          )
        })}

        {/* Cohort-average reference line (ever-replied rate) */}
        {cohortEverRate !== null ? (
          <g>
            <line
              x1={PAD_X}
              x2={CHART_W - PAD_X}
              y1={y(cohortEverRate)}
              y2={y(cohortEverRate)}
              stroke="var(--color-geg-accent)"
              strokeDasharray="4 4"
              strokeWidth="1.2"
              opacity="0.55"
            />
            <text
              x={CHART_W - PAD_X - 4}
              y={y(cohortEverRate) - 4}
              textAnchor="end"
              className="geg-mono"
              style={{ fontSize: 9, letterSpacing: '0.06em', fill: 'var(--color-geg-accent)' }}
            >
              cohort avg {Math.round(cohortEverRate * 100)}%
            </text>
          </g>
        ) : null}

        {fmr.blocks.map((b) => {
          const groupX = PAD_X + b.blockIndex * (groupWidth + groupGap)
          const barAx = groupX
          const barBx = groupX + barWidth + 8
          return (
            <g key={b.blockIndex}>
              {/* Ever-replied bar (gold) */}
              <rect
                x={barAx}
                y={y(b.everRepliedRate)}
                width={barWidth}
                height={h(b.everRepliedRate)}
                fill="var(--color-geg-accent)"
                rx="2"
              />
              {/* Within-24h bar (muted) */}
              <rect
                x={barBx}
                y={y(b.within24hRate)}
                width={barWidth}
                height={h(b.within24hRate)}
                fill="var(--color-geg-text-3)"
                opacity="0.65"
                rx="2"
              />
              {/* Rate labels above each bar */}
              <text
                x={barAx + barWidth / 2}
                y={y(b.everRepliedRate) - 6}
                textAnchor="middle"
                className="geg-mono"
                style={{ fontSize: 9, letterSpacing: '0.04em', fill: 'var(--color-geg-text-2)' }}
              >
                {b.everRepliedRate !== null ? `${Math.round(b.everRepliedRate * 100)}%` : '—'}
              </text>
              <text
                x={barBx + barWidth / 2}
                y={y(b.within24hRate) - 6}
                textAnchor="middle"
                className="geg-mono"
                style={{ fontSize: 9, letterSpacing: '0.04em', fill: 'var(--color-geg-text-faint)' }}
              >
                {b.within24hRate !== null ? `${Math.round(b.within24hRate * 100)}%` : '—'}
              </text>
              {/* Block label */}
              <text
                x={groupX + groupWidth / 2}
                y={CHART_H - PAD_BOTTOM + 18}
                textAnchor="middle"
                className="geg-mono"
                style={{ fontSize: 10, letterSpacing: '0.06em', fill: 'var(--color-geg-text-2)' }}
              >
                {b.label}
              </text>
              {/* Block N */}
              <text
                x={groupX + groupWidth / 2}
                y={CHART_H - PAD_BOTTOM + 32}
                textAnchor="middle"
                className="geg-mono"
                style={{ fontSize: 9, letterSpacing: '0.04em', fill: 'var(--color-geg-text-faint)' }}
              >
                {b.cohortSize} leads
              </text>
            </g>
          )
        })}
      </svg>

      {/* Legend + cohort footer */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          <LegendSwatch color="var(--color-geg-accent)" label="Ever responded" />
          <LegendSwatch color="var(--color-geg-text-3)" label="Responded within 24h" opacity={0.65} />
        </div>
        <div
          className="geg-mono"
          style={{
            fontSize: 11,
            letterSpacing: '0.06em',
            color: 'var(--color-geg-text-faint)',
          }}
          title="A response is an inbound SMS OR the first outbound dial answered (>= 90s) — either channel counts."
        >
          {fmr.cohortSize} leads · {fmr.cohortEverReplied} responded · {fmr.cohortWithin24h} within 24h · {fmr.cohortStart}
        </div>
      </div>
    </div>
  )
}

function LegendSwatch({ color, label, opacity = 1 }: { color: string; label: string; opacity?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          background: color,
          opacity,
          display: 'inline-block',
        }}
      />
      <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--color-geg-text-2)' }}>
        {label}
      </span>
    </span>
  )
}
