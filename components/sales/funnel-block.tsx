import { Fragment } from 'react'
import {
  type FetchResult,
  type MetricEntry,
  type FunnelStage,
  FUNNEL_STAGES,
  compactCount,
  compactUsd,
  formatMetricValue,
  inferredFormat,
} from '@/lib/db/sales-dashboard-shared'

// Phase 2 — Overview funnel.
//
// Renders the conversion path in a single horizontal row: each stage's
// headline value sits in its own cell, and the gap between adjacent
// stages shows the stage-to-stage conversion rate. The narrowest
// conversion (the bottleneck) is highlighted so the eye finds the
// leak in one glance.
//
// Stages are catalog-id-driven (FUNNEL_STAGES) so the funnel never
// drifts from the cards beneath it; if a stage's metric is missing or
// not LIVE, the cell renders an em-dash and the conversion to/from it
// renders as N/A.

type Resolved = {
  stage: FunnelStage
  metric: MetricEntry | undefined
  result: FetchResult | undefined
  value: number | null
}

function resolveStages(
  data: Record<string, FetchResult>,
  metricsById: Map<string, MetricEntry>,
): Resolved[] {
  return FUNNEL_STAGES.map((stage) => {
    const metric = metricsById.get(stage.id)
    const result = data[stage.id]
    const value =
      result && result.state === 'live' && typeof result.value === 'number'
        ? result.value
        : null
    return { stage, metric, result, value }
  })
}

function conversionRate(from: number | null, to: number | null): number | null {
  if (from === null || to === null || from <= 0) return null
  return to / from
}

export function FunnelBlock({
  data,
  metrics,
}: {
  data: Record<string, FetchResult>
  metrics: MetricEntry[]
}) {
  const metricsById = new Map(metrics.map((m) => [m.id, m]))
  const stages = resolveStages(data, metricsById)

  // Conversion rates between each adjacent stage.
  const conversions: (number | null)[] = []
  for (let i = 1; i < stages.length; i++) {
    conversions.push(conversionRate(stages[i - 1].value, stages[i].value))
  }

  // Find the bottleneck (smallest non-null conversion that isn't the
  // Closed→Cash step — that step is "$ per deal", not a rate, so
  // excluding it keeps the comparison apples-to-apples).
  let bottleneckIndex = -1
  let bottleneckValue = Infinity
  for (let i = 0; i < conversions.length - 1; i++) {
    const r = conversions[i]
    if (r === null) continue
    if (r < bottleneckValue) {
      bottleneckValue = r
      bottleneckIndex = i
    }
  }

  return (
    <section
      aria-label="Sales funnel"
      style={{
        marginTop: 36,
        padding: '24px 28px 28px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
      }}
    >
      <FunnelEyebrow bottleneckLabel={bottleneckIndex >= 0 ? stages[bottleneckIndex + 1].stage.label : null} />
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 0 }}>
        {stages.map((s, i) => (
          <Fragment key={s.stage.id}>
            <StageCell resolved={s} />
            {i < stages.length - 1 && (
              <ConversionGap
                rate={conversions[i]}
                isBottleneck={i === bottleneckIndex}
                fromValue={s.value}
                toValue={stages[i + 1].value}
                isMonetary={i === conversions.length - 1}
              />
            )}
          </Fragment>
        ))}
      </div>
    </section>
  )
}

function FunnelEyebrow({ bottleneckLabel }: { bottleneckLabel: string | null }) {
  return (
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
          FUNNEL
        </span>
        <span
          className="geg-serif"
          style={{ fontSize: 17, color: 'var(--color-geg-text)', letterSpacing: '-0.01em' }}
        >
          Where this period is leaking.
        </span>
      </div>
      {bottleneckLabel ? (
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-warn)',
          }}
        >
          BOTTLENECK · {bottleneckLabel.toUpperCase()}
        </span>
      ) : null}
    </div>
  )
}

function StageCell({ resolved }: { resolved: Resolved }) {
  const { stage, metric, value } = resolved
  const format = metric?.format ?? (metric ? inferredFormat(metric.title) : 'integer')
  // Compact-format large currency values so the cell doesn't overrun:
  // $1,234,567 → $1.23M, $84,320 → $84.3K. Counts stay un-abbreviated;
  // they're rarely > 6 digits and the comma reads cleanly at this size.
  // Always compact USD in the funnel; compact integer counts only at
  // 1M+ where comma-separated values clip in narrow cells (impressions
  // can run into millions per week). Everything else uses the standard
  // formatter.
  const display =
    value === null
      ? '—'
      : format === 'usd'
        ? compactUsd(value)
        : format === 'integer' && Math.abs(value) >= 1_000_000
          ? compactCount(value)
          : formatMetricValue(value, format)
  return (
    <div
      style={{
        flex: '1 1 0',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '4px 0',
      }}
      title={`${metric?.title ?? stage.label}${value !== null ? ` · ${formatMetricValue(value, format)}` : ''}`}
    >
      <span
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
        }}
      >
        {stage.label}
      </span>
      <span
        className="geg-numeric-serif"
        style={{
          fontSize: 22,
          lineHeight: '26px',
          letterSpacing: '-0.02em',
          color: 'var(--color-geg-text)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {display}
      </span>
    </div>
  )
}

function ConversionGap({
  rate,
  isBottleneck,
  isMonetary,
  fromValue,
  toValue,
}: {
  rate: number | null
  isBottleneck: boolean
  isMonetary: boolean
  fromValue: number | null
  toValue: number | null
}) {
  let display: string
  if (rate === null) {
    display = '—'
  } else if (isMonetary) {
    if (fromValue && fromValue > 0 && toValue !== null) {
      display = `${compactUsd(toValue / fromValue)}/deal`
    } else {
      display = '—'
    }
  } else {
    display = `${(rate * 100).toFixed(rate < 0.1 ? 1 : 0)}%`
  }

  const color = isBottleneck
    ? 'var(--color-geg-warn)'
    : 'var(--color-geg-text-3)'

  return (
    <div
      aria-hidden="true"
      style={{
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 8px',
        minWidth: 64,
      }}
    >
      <Chevron color={color} />
      <span
        className="geg-mono"
        style={{
          marginTop: 6,
          fontSize: 11,
          letterSpacing: '0.04em',
          color,
          fontWeight: isBottleneck ? 600 : 400,
          whiteSpace: 'nowrap',
        }}
      >
        {display}
      </span>
    </div>
  )
}

function Chevron({ color }: { color: string }) {
  return (
    <svg width="14" height="22" viewBox="0 0 14 22" aria-hidden="true">
      <path
        d="M2 3 L11 11 L2 19"
        stroke={color}
        strokeWidth="1.4"
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
