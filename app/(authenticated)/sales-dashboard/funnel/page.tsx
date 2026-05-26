import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import {
  getFunnelActivity,
  resolveFunnelRange,
  type FunnelBox,
} from '@/lib/db/funnel-stages'
import {
  compactCount,
  compactUsd,
  formatMetricValue,
} from '@/lib/db/sales-dashboard-shared'
import {
  parseEtDateString,
  todayEtDate,
} from '@/lib/db/funnel-window'
import type { AggMetric, MetricFormatExt } from '@/lib/db/funnel-mocks'
import { PersonPill } from '../header-pills'
import { DateRangePicker } from './landing-pages/date-range-picker'

// Sales Dashboard — Funnel (Pulse-style activity view).
//
// Four stacked boxes — Ads, Landing Page, Appointment Setting,
// Closing — each an INDEPENDENT activity snapshot for the selected
// range. No funnel shape, no cross-stage conversion percentages, no
// bottleneck calculation. Stages are activity-in-period (today's
// shows are leads who booked days ago) so cross-stage rates would
// mix cohorts. Cohort attribution is future work.
//
// Default range = yesterday ET. Meta lands the morning after, so
// yesterday is the most-recent fully-populated day across every
// source.

export const dynamic = 'force-dynamic'

export default async function SalesDashboardFunnelPage({
  searchParams,
}: {
  searchParams?: {
    start?: string | string[]
    end?: string | string[]
  }
}) {
  const start = parseEtDateString(searchParams?.start)
  const end = parseEtDateString(searchParams?.end)
  const range = resolveFunnelRange(start ?? undefined, end ?? undefined)
  const todayEt = todayEtDate()

  const result = await getFunnelActivity(range)

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · FUNNEL"
        title="Pulse."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <DateRangePicker
              startEtDate={range.startEtDate}
              endEtDate={range.endEtDate}
              todayEt={todayEt}
            />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 28 }}>
        {result.boxes.map((box) => (
          <ActivityBox key={box.id} box={box} />
        ))}
      </div>

      <FooterNote adSpend={result.adSpend} />
    </div>
  )
}

function ActivityBox({ box }: { box: FunnelBox }) {
  const wrapperStyle: React.CSSProperties = {
    padding: '22px 26px 24px',
    background: 'var(--color-geg-bg-elev)',
    border: '1px solid var(--color-geg-border)',
    borderRadius: 10,
    display: 'block',
    textDecoration: 'none',
    color: 'inherit',
    transition: 'border-color 120ms ease',
  }

  const content = (
    <>
      <BoxHeader eyebrow={box.eyebrow} title={box.title} clickable={!!box.href} />
      {box.status === 'stub' ? (
        <StubBody footer={box.footer} />
      ) : (
        <LiveBody metrics={box.metrics} footer={box.footer} />
      )}
    </>
  )

  if (box.href) {
    return (
      <Link href={box.href} style={wrapperStyle}>
        {content}
      </Link>
    )
  }
  return <div style={wrapperStyle}>{content}</div>
}

function BoxHeader({ eyebrow, title, clickable }: { eyebrow: string; title: string; clickable: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 18, gap: 14 }}>
      <div>
        <div
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-3)',
          }}
        >
          {eyebrow}
        </div>
        <div
          className="geg-serif"
          style={{
            marginTop: 6,
            fontSize: 22,
            color: 'var(--color-geg-text)',
            letterSpacing: '-0.012em',
          }}
        >
          {title}
        </div>
      </div>
      {clickable ? (
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-faint)',
          }}
        >
          detail →
        </span>
      ) : null}
    </div>
  )
}

function LiveBody({ metrics, footer }: { metrics: AggMetric[]; footer?: string }) {
  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 12,
        }}
      >
        {metrics.map((m) => (
          <MetricTile key={m.id} metric={m} />
        ))}
      </div>
      {footer ? (
        <div
          className="geg-mono"
          style={{
            marginTop: 14,
            fontSize: 10,
            letterSpacing: '0.12em',
            color: 'var(--color-geg-text-faint)',
            lineHeight: 1.5,
          }}
        >
          {footer}
        </div>
      ) : null}
    </>
  )
}

function StubBody({ footer }: { footer?: string }) {
  return (
    <div
      style={{
        padding: '36px 0 24px',
        textAlign: 'center',
        border: '1px dashed var(--color-geg-border)',
        borderRadius: 8,
        background: 'var(--color-geg-bg)',
      }}
    >
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-faint)',
          marginBottom: 10,
        }}
      >
        Coming soon
      </div>
      <div
        className="geg-serif"
        style={{
          fontSize: 14,
          color: 'var(--color-geg-text-3)',
          letterSpacing: '-0.005em',
          fontStyle: 'italic',
          maxWidth: 540,
          margin: '0 auto',
          lineHeight: 1.5,
          padding: '0 24px',
        }}
      >
        {footer ?? 'Detail view coming soon.'}
      </div>
    </div>
  )
}

function MetricTile({ metric }: { metric: AggMetric }) {
  const display = metric.value == null ? '—' : renderValue(metric.value, metric.format)
  return (
    <div
      style={{
        padding: '14px 16px 12px',
        background: 'var(--color-geg-bg)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        minHeight: 84,
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
          marginTop: 4,
        }}
      >
        {display}
      </div>
    </div>
  )
}

function FooterNote({ adSpend }: { adSpend: number }) {
  return (
    <div
      className="geg-mono"
      style={{
        marginTop: 22,
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-faint)',
        textAlign: 'center',
      }}
    >
      Independent activity snapshots — no cross-stage rates. Adspend $
      {adSpend.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} drives cost-per math.
    </div>
  )
}

function renderValue(value: number, format: MetricFormatExt): string {
  if (format === 'usd') return compactUsd(value)
  if (format === 'count') return compactCount(value)
  if (format === 'integer' && Math.abs(value) >= 100_000) return compactCount(value)
  // CPM as $XX.XX (dollars-and-cents) instead of the engine-sheet
  // 4-decimal "per-impression" rendering.
  if (format === 'usd_precise') {
    return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }
  return formatMetricValue(value, format)
}
