import type { Pacing } from '@/lib/db/sales-dashboard-mocks'
import { formatMetricValue } from '@/lib/db/sales-dashboard-shared'

// Trajectory · cumulative MTD chart. Two lines — actual (revenue
// accumulated so far this month) and expected (linear pace to target).
// SVG inline; no chart library.

const WIDTH = 720
const HEIGHT = 260
const PAD_L = 64
const PAD_R = 16
const PAD_T = 16
const PAD_B = 36

export function MtdChart({ pacing }: { pacing: Pacing }) {
  const usd = (n: number) => formatMetricValue(n, 'usd')
  const xMax = pacing.daysInMonth
  const yMax = Math.max(pacing.monthTarget, pacing.projectedEom) * 1.05
  const innerW = WIDTH - PAD_L - PAD_R
  const innerH = HEIGHT - PAD_T - PAD_B
  const xFor = (day: number) => PAD_L + ((day - 1) / (xMax - 1)) * innerW
  const yFor = (v: number) => PAD_T + (1 - v / yMax) * innerH

  const expectedPath = pacing.series
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(p.day)} ${yFor(p.expected)}`)
    .join(' ')
  const actualPoints = pacing.series.filter((p) => p.actual !== null)
  const actualPath = actualPoints
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(p.day)} ${yFor(p.actual as number)}`)
    .join(' ')

  const yTicks = 4
  const yTickValues = Array.from({ length: yTicks + 1 }, (_, i) => (yMax / yTicks) * i)

  return (
    <section
      aria-label="Cumulative month-to-date revenue"
      style={{
        marginTop: 24,
        padding: '24px 26px 20px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span
            className="geg-mono"
            style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}
          >
            CUMULATIVE CASH · MTD
          </span>
          <span
            className="geg-serif"
            style={{ fontSize: 17, color: 'var(--color-geg-text)', letterSpacing: '-0.01em' }}
          >
            Actual vs pace required to hit target.
          </span>
        </div>
        <Legend />
      </div>

      <svg width="100%" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img">
        {/* Y gridlines + labels */}
        {yTickValues.map((v, i) => (
          <g key={i}>
            <line
              x1={PAD_L}
              x2={WIDTH - PAD_R}
              y1={yFor(v)}
              y2={yFor(v)}
              stroke="var(--color-geg-border)"
              strokeDasharray={i === 0 ? '' : '2 4'}
            />
            <text
              x={PAD_L - 8}
              y={yFor(v) + 4}
              textAnchor="end"
              fontSize="10"
              fontFamily="var(--font-geg-mono), monospace"
              fill="var(--color-geg-text-faint)"
            >
              {usd(v).replace('.00', '')}
            </text>
          </g>
        ))}

        {/* X labels — every 5 days */}
        {pacing.series.filter((p) => p.day % 5 === 0 || p.day === 1 || p.day === pacing.daysInMonth).map((p) => (
          <text
            key={p.day}
            x={xFor(p.day)}
            y={HEIGHT - PAD_B + 18}
            textAnchor="middle"
            fontSize="10"
            fontFamily="var(--font-geg-mono), monospace"
            fill="var(--color-geg-text-faint)"
          >
            {p.day}
          </text>
        ))}

        {/* Target line at month-target */}
        <line
          x1={PAD_L}
          x2={WIDTH - PAD_R}
          y1={yFor(pacing.monthTarget)}
          y2={yFor(pacing.monthTarget)}
          stroke="var(--color-geg-accent)"
          strokeDasharray="4 4"
          strokeWidth={1}
          opacity={0.6}
        />
        <text
          x={WIDTH - PAD_R - 4}
          y={yFor(pacing.monthTarget) - 6}
          textAnchor="end"
          fontSize="10"
          fontFamily="var(--font-geg-mono), monospace"
          fill="var(--color-geg-accent)"
        >
          TARGET · {usd(pacing.monthTarget)}
        </text>

        {/* Expected pace line */}
        <path d={expectedPath} stroke="var(--color-geg-text-3)" strokeWidth={1.5} fill="none" strokeDasharray="3 4" />

        {/* Actual line — colored by on/off pace */}
        <path
          d={actualPath}
          stroke={pacing.mtdActual >= pacing.mtdExpected ? 'var(--color-geg-pos)' : 'var(--color-geg-warn)'}
          strokeWidth={2}
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Today dot */}
        {actualPoints.length > 0 && (
          <circle
            cx={xFor(actualPoints[actualPoints.length - 1].day)}
            cy={yFor(actualPoints[actualPoints.length - 1].actual as number)}
            r={4}
            fill={pacing.mtdActual >= pacing.mtdExpected ? 'var(--color-geg-pos)' : 'var(--color-geg-warn)'}
          />
        )}
      </svg>
    </section>
  )
}

function Legend() {
  return (
    <div className="geg-mono" style={{ display: 'flex', gap: 18, fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-geg-pos)' }}>
        <span style={{ width: 12, height: 2, background: 'var(--color-geg-pos)' }} /> ACTUAL
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-geg-text-3)' }}>
        <span style={{ width: 12, height: 2, background: 'var(--color-geg-text-3)' }} /> PACE
      </span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--color-geg-accent)' }}>
        <span style={{ width: 12, height: 2, background: 'var(--color-geg-accent)' }} /> TARGET
      </span>
    </div>
  )
}
