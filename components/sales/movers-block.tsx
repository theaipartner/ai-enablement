import Link from 'next/link'
import {
  type FetchResult,
  type MetricEntry,
  SLUG_BY_SECTION,
  formatMetricValue,
  inferredFormat,
  isHigherBetter,
} from '@/lib/db/sales-dashboard-shared'
import { Sparkline } from './sparkline'

// Phase 2 — Overview movers.
//
// Surfaces the metrics most off-trend this period: top 3 directional-
// goods up + top 3 directional-bads down. "Directional" means
// magnitude scaled by isHigherBetter — a 30% drop in Cost Per Click is
// good; a 30% drop in Cash Collected is bad. Each tile shows the
// catalog title, the delta, the headline value, a sparkline, and
// links to the section page filtered to that metric for drill-down.

type Mover = {
  metric: MetricEntry
  result: Extract<FetchResult, { state: 'live' }>
  pct: number
  goodness: number  // positive = good move, negative = bad move
}

function computeMovers(
  data: Record<string, FetchResult>,
  metrics: MetricEntry[],
): { good: Mover[]; bad: Mover[] } {
  const all: Mover[] = []
  for (const m of metrics) {
    const r = data[m.id]
    if (!r || r.state !== 'live') continue
    if (typeof r.value !== 'number' || typeof r.prior !== 'number' || r.prior === 0) continue
    const pct = (r.value - r.prior) / r.prior
    if (!Number.isFinite(pct) || pct === 0) continue
    const higherBetter = isHigherBetter(m.title)
    // goodness: positive = moved in the "good" direction, magnitude in %.
    const goodness = higherBetter ? pct : -pct
    all.push({ metric: m, result: r, pct, goodness })
  }
  // Sort by signed goodness — most-good first for the "good" list,
  // most-bad first for the "bad" list.
  const good = [...all].sort((a, b) => b.goodness - a.goodness).slice(0, 3)
  const bad = [...all].sort((a, b) => a.goodness - b.goodness).slice(0, 3)
  return { good, bad }
}

export function MoversBlock({
  data,
  metrics,
}: {
  data: Record<string, FetchResult>
  metrics: MetricEntry[]
}) {
  const { good, bad } = computeMovers(data, metrics)
  return (
    <section
      aria-label="Movers"
      style={{
        marginTop: 28,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 18,
      }}
    >
      <MoverColumn label="MOVING UP" tone="pos" movers={good} />
      <MoverColumn label="MOVING DOWN" tone="neg" movers={bad} />
    </section>
  )
}

function MoverColumn({
  label,
  tone,
  movers,
}: {
  label: string
  tone: 'pos' | 'neg'
  movers: Mover[]
}) {
  const accentColor = tone === 'pos' ? 'var(--color-geg-pos)' : 'var(--color-geg-neg)'
  return (
    <div
      style={{
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        padding: '18px 20px 16px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 14,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: '50%',
            background: accentColor,
          }}
        />
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-3)',
          }}
        >
          {label}
        </span>
      </div>
      {movers.length === 0 ? (
        <div
          className="geg-serif"
          style={{
            padding: '12px 0',
            color: 'var(--color-geg-text-3)',
            fontStyle: 'italic',
            fontSize: 14,
          }}
        >
          No movers this period.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {movers.map((mv) => (
            <MoverTile key={mv.metric.id} mv={mv} tone={tone} />
          ))}
        </div>
      )}
    </div>
  )
}

function MoverTile({ mv, tone }: { mv: Mover; tone: 'pos' | 'neg' }) {
  const { metric, result, pct } = mv
  const sectionSlug = SLUG_BY_SECTION[metric.section]
  const href = sectionSlug ? `/sales-dashboard/${sectionSlug}` : '/sales-dashboard'
  const format = metric.format ?? inferredFormat(metric.title)
  const valueStr = formatMetricValue(result.value, format)
  const pctStr = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct * 100).toFixed(1)}%`
  const pctColor = tone === 'pos' ? 'var(--color-geg-pos)' : 'var(--color-geg-neg)'

  return (
    <Link
      href={href}
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto auto',
        alignItems: 'center',
        gap: 14,
        padding: '10px 12px',
        background: 'var(--color-geg-bg)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 8,
        textDecoration: 'none',
        transition: 'border-color 120ms',
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div
          className="geg-serif"
          style={{
            fontSize: 14,
            color: 'var(--color-geg-text)',
            letterSpacing: '-0.005em',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {metric.title}
        </div>
        <div
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-3)',
            marginTop: 2,
          }}
        >
          {metric.section}
        </div>
      </div>
      <div style={{ textAlign: 'right' }}>
        <div
          className="geg-numeric-serif"
          style={{ fontSize: 18, color: 'var(--color-geg-text)', lineHeight: '20px', letterSpacing: '-0.01em' }}
        >
          {valueStr}
        </div>
        <div
          className="geg-mono"
          style={{ fontSize: 11, color: pctColor, marginTop: 3, letterSpacing: '0.04em', fontWeight: 500 }}
        >
          {pctStr}
        </div>
      </div>
      {result.series && result.series.length > 1 ? (
        <Sparkline data={result.series} width={64} height={20} stroke={pctColor} />
      ) : (
        <div style={{ width: 64 }} />
      )}
    </Link>
  )
}
