import {
  type FetchResult,
  type MetricEntry,
  type SectionId,
  SECTION_LEAD_INDICATOR,
  formatMetricValue,
  inferredFormat,
  isHigherBetter,
} from '@/lib/db/sales-dashboard-shared'
import { Sparkline } from './sparkline'

// Phase 2 — Section page trend strip.
//
// One wide row at the top of the section page anchored on the
// section's lead indicator (cls_closed_total for CLOSING,
// fun_typeform_submits for FUNNELS, etc.). Shows the headline value,
// delta vs prior, and a larger sparkline of the 14-day daily series.
// When the section has no designated lead indicator (e.g. CONTENT —
// all NC), the component renders nothing so the page stays clean.

export function SectionTrend({
  sectionId,
  metrics,
  data,
}: {
  sectionId: SectionId
  metrics: MetricEntry[]
  data: Record<string, FetchResult>
}) {
  const leadId = SECTION_LEAD_INDICATOR[sectionId]
  if (!leadId) return null
  const metric = metrics.find((m) => m.id === leadId)
  if (!metric) return null
  const result = data[leadId]
  if (!result || result.state !== 'live' || typeof result.value !== 'number') return null

  const format = metric.format ?? inferredFormat(metric.title)
  const valueStr = formatMetricValue(result.value, format)
  let deltaStr: string | null = null
  let deltaColor = 'var(--color-geg-text-3)'
  if (typeof result.prior === 'number' && result.prior !== 0) {
    const pct = (result.value - result.prior) / result.prior
    const higherBetter = isHigherBetter(metric.title)
    const good = (pct >= 0) === higherBetter
    deltaColor = pct === 0
      ? 'var(--color-geg-text-faint)'
      : good
        ? 'var(--color-geg-pos)'
        : 'var(--color-geg-neg)'
    deltaStr = `${pct >= 0 ? '▲' : '▼'} ${Math.abs(pct * 100).toFixed(1)}%`
  }

  return (
    <section
      aria-label="Section trend"
      style={{
        marginTop: 24,
        padding: '22px 26px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        display: 'grid',
        gridTemplateColumns: 'auto auto 1fr',
        alignItems: 'center',
        gap: 28,
      }}
    >
      <div>
        <div
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-3)',
            marginBottom: 6,
          }}
        >
          LEAD INDICATOR · {metric.title}
        </div>
        <div
          className="geg-numeric-serif"
          style={{
            fontSize: 44,
            lineHeight: '46px',
            color: 'var(--color-geg-text)',
            letterSpacing: '-0.025em',
          }}
        >
          {valueStr}
        </div>
      </div>
      {deltaStr ? (
        <div
          className="geg-mono"
          style={{
            fontSize: 13,
            letterSpacing: '0.06em',
            color: deltaColor,
            fontWeight: 500,
            paddingTop: 22,
          }}
        >
          {deltaStr}
          <div
            className="geg-mono"
            style={{
              fontSize: 9,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-faint)',
              marginTop: 4,
              fontWeight: 400,
            }}
          >
            VS PRIOR PERIOD
          </div>
        </div>
      ) : <div />}
      {result.series && result.series.length > 1 ? (
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Sparkline
            data={result.series}
            width={300}
            height={64}
            stroke="var(--color-geg-text-2)"
          />
        </div>
      ) : <div />}
    </section>
  )
}
