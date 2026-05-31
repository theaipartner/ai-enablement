import type { ReactNode } from 'react'
import { HeaderBand } from '@/components/gregory/header-band'
import { Sparkline } from './sparkline'
import {
  compactCount,
  compactUsd,
  formatMetricValue,
} from '@/lib/db/sales-dashboard-shared'
import type { AggMetric, MetricFormatExt } from '@/lib/db/funnel-mocks'

// Shared chrome for the Funnel stage detail pages.
//
// Three slots: HEADLINE (big number + delta + 14-day sparkline + sub
// nav back to Funnel), METRICS GRID (the AggMetric list), and CHILDREN
// (per-entity table / objection block / no-show list — page-specific).

export function StageDetailLayout({
  eyebrow,
  title,
  headline,
  windowSwitcher,
  personPill,
  children,
  backHref = '/sales-dashboard/funnel',
}: {
  eyebrow: string
  title: string
  // `null` skips the big-number headline tile and renders sections
  // directly under the header band.
  headline: HeadlineProps | null
  windowSwitcher: ReactNode
  personPill: ReactNode
  children: ReactNode
  // "Back to Funnel" target — pass the windowed href so the Funnel page keeps
  // its date range when you return from a stage detail page.
  backHref?: string
}) {
  return (
    <div>
      <HeaderBand
        eyebrow={eyebrow}
        title={title}
        backlink={{ href: backHref, label: 'BACK TO FUNNEL' }}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            {windowSwitcher}
            {personPill}
          </div>
        }
      />
      {headline ? <Headline {...headline} /> : null}
      {children}
    </div>
  )
}

export type HeadlineProps = {
  label: string
  value: number
  format: MetricFormatExt
  delta?: number
  trend: number[]
}

function Headline({ label, value, format, delta, trend }: HeadlineProps) {
  const display = renderValue(value, format)
  const deltaColor =
    delta === undefined || delta === 0
      ? 'var(--color-geg-text-faint)'
      : delta > 0
        ? 'var(--color-geg-pos)'
        : 'var(--color-geg-neg)'
  const arrow = delta === undefined || delta === 0 ? '·' : delta > 0 ? '▲' : '▼'
  return (
    <section
      style={{
        marginTop: 28,
        padding: '24px 28px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        display: 'grid',
        gridTemplateColumns: '1fr auto 1fr',
        gap: 28,
        alignItems: 'center',
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
          {label.toUpperCase()}
        </div>
        <div
          className="geg-numeric-serif"
          style={{ fontSize: 48, lineHeight: '50px', letterSpacing: '-0.025em', color: 'var(--color-geg-text)' }}
        >
          {display}
        </div>
      </div>
      {delta !== undefined ? (
        <div style={{ textAlign: 'right' }}>
          <div
            className="geg-mono"
            style={{
              fontSize: 9.5,
              letterSpacing: '0.16em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-faint)',
            }}
          >
            VS PRIOR PERIOD
          </div>
          <div
            className="geg-mono"
            style={{
              fontSize: 16,
              color: deltaColor,
              letterSpacing: '0.04em',
              fontWeight: 500,
              marginTop: 4,
            }}
          >
            {arrow} {Math.abs(delta * 100).toFixed(1)}%
          </div>
        </div>
      ) : <div />}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Sparkline data={trend} width={300} height={60} stroke="var(--color-geg-text-2)" />
      </div>
    </section>
  )
}

// ---------------------------------------------------------------------------
// AggMetric grid — used by every stage detail page for the metric
// block beneath the headline. 4-column responsive layout.
// ---------------------------------------------------------------------------

export function MetricsGrid({ metrics, columns = 4 }: { metrics: AggMetric[]; columns?: number }) {
  return (
    <section
      style={{
        marginTop: 18,
        display: 'grid',
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        gap: 1,
        background: 'var(--color-geg-border)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      {metrics.map((m) => (
        <MetricCell key={m.id} metric={m} />
      ))}
    </section>
  )
}

function MetricCell({ metric }: { metric: AggMetric }) {
  const display = metric.value === null ? '—' : renderValue(metric.value, metric.format)
  const deltaColor =
    metric.delta === undefined || metric.delta === 0
      ? 'var(--color-geg-text-faint)'
      : metric.delta > 0
        ? 'var(--color-geg-pos)'
        : 'var(--color-geg-neg)'
  return (
    <div
      style={{
        padding: '16px 18px 14px',
        background: 'var(--color-geg-bg-elev)',
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minHeight: 96,
      }}
    >
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
        }}
      >
        {metric.label}
      </div>
      <div
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
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 'auto' }}>
        {metric.delta !== undefined ? (
          <span
            className="geg-mono"
            style={{
              fontSize: 10.5,
              color: deltaColor,
              letterSpacing: '0.04em',
              fontWeight: 500,
            }}
          >
            {metric.delta >= 0 ? '▲' : '▼'} {Math.abs(metric.delta * 100).toFixed(1)}%
          </span>
        ) : null}
        {metric.note ? (
          <span
            className="geg-serif"
            style={{ fontSize: 11, fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}
          >
            {metric.note}
          </span>
        ) : null}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Generic section wrapper for stage detail child blocks (per-entity
// tables, no-show list, objection breakdown, etc.).
// ---------------------------------------------------------------------------

export function StageSection({
  eyebrow,
  title,
  children,
  marginTop = 24,
}: {
  eyebrow: string
  title: string
  children: ReactNode
  marginTop?: number
}) {
  return (
    <section
      style={{
        marginTop,
        padding: '22px 24px 24px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
      }}
    >
      <div style={{ marginBottom: 16, display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-3)',
          }}
        >
          {eyebrow}
        </span>
        <span
          className="geg-serif"
          style={{ fontSize: 17, color: 'var(--color-geg-text)', letterSpacing: '-0.01em' }}
        >
          {title}
        </span>
      </div>
      {children}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Value formatting — handles MetricFormatExt (the funnel-specific
// superset of MetricFormat, with `count` for compact-count and the
// rest delegating to formatMetricValue).
// ---------------------------------------------------------------------------

function renderValue(value: number, format: MetricFormatExt): string {
  if (format === 'usd') return compactUsd(value)
  if (format === 'count') return compactCount(value)
  if (format === 'integer' && Math.abs(value) >= 100_000) return compactCount(value)
  return formatMetricValue(value, format)
}
