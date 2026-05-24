import { HeaderBand } from '@/components/gregory/header-band'
import {
  DASHBOARD_WINDOW_LABEL,
  FetchResult,
  METRICS,
  MetricEntry,
  MetricFormat,
  SECTION_ORDER,
  SectionId,
  fetchSalesDashboardData,
  formatMetricValue,
} from '@/lib/db/sales-dashboard'

// Admin-tier sales engine dashboard. Reads directly from the seven
// ingested mirror tables — no aggregation layer. Renders the Engine
// sheet's 9 sections as kanban columns; per-card status is one of
// live / pending / not-connected per the catalog in
// `lib/db/sales-dashboard.ts` METRICS.
//
// Spec: docs/specs/sales-dashboard-v1.md.

export const dynamic = 'force-dynamic'

export default async function SalesDashboardPage() {
  const data = await fetchSalesDashboardData()

  const liveCount = METRICS.filter((m) => m.status === 'live').length
  const pendingCount = METRICS.filter((m) => m.status === 'pending').length
  const ncCount = METRICS.filter((m) => m.status === 'not_connected').length

  return (
    <div style={{ padding: '32px 48px 80px', maxWidth: 1600, margin: '0 auto' }}>
      <HeaderBand
        eyebrow="SALES · ENGINE"
        title="Sales Engine."
        actions={
          <span
            className="geg-mono"
            style={{
              fontSize: 11,
              color: 'var(--color-geg-text-3)',
              textTransform: 'uppercase',
              letterSpacing: '0.16em',
            }}
          >
            Admin · {DASHBOARD_WINDOW_LABEL}
          </span>
        }
      />

      <Legend liveCount={liveCount} pendingCount={pendingCount} ncCount={ncCount} />

      <div
        style={{
          marginTop: 32,
          display: 'grid',
          gridTemplateColumns: 'repeat(9, minmax(280px, 1fr))',
          gap: 16,
          overflowX: 'auto',
        }}
      >
        {SECTION_ORDER.map((section) => (
          <SectionColumn
            key={section}
            section={section}
            metrics={METRICS.filter((m) => m.section === section)}
            data={data}
          />
        ))}
      </div>
    </div>
  )
}

function Legend({
  liveCount,
  pendingCount,
  ncCount,
}: {
  liveCount: number
  pendingCount: number
  ncCount: number
}) {
  return (
    <div
      className="geg-mono"
      style={{
        marginTop: 24,
        padding: '12px 16px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 6,
        display: 'flex',
        gap: 28,
        flexWrap: 'wrap',
        fontSize: 11,
        color: 'var(--color-geg-text-2)',
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
      }}
    >
      <LegendDot color="pos" label={`LIVE · ${liveCount}`} />
      <LegendDot color="warn" label={`PENDING · ${pendingCount}`} />
      <LegendDot color="dim" label={`NOT CONNECTED · ${ncCount}`} />
      <span style={{ marginLeft: 'auto', color: 'var(--color-geg-text-3)' }}>
        Live = single-source · Pending = cross-source or flagged · Not connected = no ingestion
      </span>
    </div>
  )
}

function LegendDot({ color, label }: { color: 'pos' | 'warn' | 'dim'; label: string }) {
  const fill =
    color === 'pos'
      ? 'var(--color-geg-pos)'
      : color === 'warn'
        ? 'var(--color-geg-warn)'
        : 'var(--color-geg-text-faint)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          display: 'inline-block',
          width: 8,
          height: 8,
          borderRadius: '50%',
          background: fill,
        }}
      />
      {label}
    </span>
  )
}

function SectionColumn({
  section,
  metrics,
  data,
}: {
  section: SectionId
  metrics: MetricEntry[]
  data: Record<string, FetchResult>
}) {
  const liveCount = metrics.filter((m) => m.status === 'live').length
  return (
    <div
      style={{
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 8,
        display: 'flex',
        flexDirection: 'column',
        minHeight: 320,
      }}
    >
      <div
        style={{
          padding: '14px 16px 12px',
          borderBottom: '1px solid var(--color-geg-border)',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
        }}
      >
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            color: 'var(--color-geg-text-3)',
          }}
        >
          {metrics.length} METRICS · {liveCount} LIVE
        </span>
        <span
          className="geg-serif"
          style={{
            fontSize: 18,
            lineHeight: '22px',
            color: 'var(--color-geg-text)',
            letterSpacing: '-0.01em',
          }}
        >
          {section}
        </span>
      </div>

      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {metrics.map((m) => (
          <MetricCard key={m.id} metric={m} result={data[m.id]} />
        ))}

        <PlaceholderGraphCard />
      </div>
    </div>
  )
}

function MetricCard({ metric, result }: { metric: MetricEntry; result: FetchResult | undefined }) {
  const state = result?.state ?? metric.status

  const accentColor =
    state === 'live'
      ? 'var(--color-geg-pos)'
      : state === 'live_error'
        ? 'var(--color-geg-neg)'
        : state === 'pending'
          ? 'var(--color-geg-warn)'
          : 'var(--color-geg-text-faint)'

  return (
    <div
      style={{
        padding: '10px 12px',
        background: 'var(--color-geg-bg)',
        border: '1px solid var(--color-geg-border)',
        borderLeft: `3px solid ${accentColor}`,
        borderRadius: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
      }}
    >
      <div
        style={{
          fontSize: 12,
          color: 'var(--color-geg-text)',
          lineHeight: '16px',
        }}
      >
        {metric.title}
      </div>

      <ValueRow metric={metric} result={result} />

      <div
        className="geg-mono"
        style={{
          fontSize: 9.5,
          color: 'var(--color-geg-text-3)',
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
        }}
      >
        {metric.source}
      </div>

      {metric.note ? (
        <div
          className="geg-mono"
          style={{
            fontSize: 9.5,
            color: 'var(--color-geg-text-faint)',
            fontStyle: 'italic',
          }}
        >
          {metric.note}
        </div>
      ) : null}
    </div>
  )
}

function ValueRow({ metric, result }: { metric: MetricEntry; result: FetchResult | undefined }) {
  if (!result) {
    return <StateBadge label="LOADING" color="dim" />
  }
  if (result.state === 'pending') {
    return <StateBadge label="PENDING" color="warn" />
  }
  if (result.state === 'not_connected') {
    return <StateBadge label="NOT CONNECTED" color="dim" />
  }
  if (result.state === 'live_error') {
    return (
      <span
        className="geg-mono"
        title={result.message}
        style={{ fontSize: 12, color: 'var(--color-geg-neg)' }}
      >
        ERROR
      </span>
    )
  }
  // live
  return (
    <span
      className="geg-numeric-serif"
      style={{
        fontSize: 22,
        lineHeight: '26px',
        color: 'var(--color-geg-text)',
      }}
    >
      {formatLiveValue(result.value, metric.format)}
    </span>
  )
}

function formatLiveValue(value: number | null, format: MetricFormat | undefined): string {
  return formatMetricValue(value, format)
}

function StateBadge({ label, color }: { label: string; color: 'warn' | 'dim' }) {
  const fill = color === 'warn' ? 'var(--color-geg-warn)' : 'var(--color-geg-text-faint)'
  const bg =
    color === 'warn' ? 'var(--color-geg-warn-fill)' : 'rgba(237, 234, 227, 0.04)'
  const border =
    color === 'warn'
      ? 'var(--color-geg-warn-border)'
      : 'var(--color-geg-border-strong)'
  return (
    <span
      className="geg-mono"
      style={{
        alignSelf: 'flex-start',
        padding: '2px 6px',
        fontSize: 10,
        letterSpacing: '0.14em',
        color: fill,
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: 3,
        textTransform: 'uppercase',
      }}
    >
      {label}
    </span>
  )
}

// Placeholder graph card — v1 ships frames only. Each column gets one
// at the bottom so Nabeel sees the visual slot we'll fill in v2.
function PlaceholderGraphCard() {
  return (
    <div
      style={{
        marginTop: 6,
        padding: '12px',
        background: 'var(--color-geg-bg)',
        border: '1px dashed var(--color-geg-border-strong)',
        borderRadius: 4,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        minHeight: 96,
      }}
    >
      <div
        className="geg-mono"
        style={{
          fontSize: 9.5,
          color: 'var(--color-geg-text-3)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
        }}
      >
        Trend chart — coming soon
      </div>
      <div
        style={{
          flex: 1,
          minHeight: 60,
          background:
            'linear-gradient(180deg, transparent 0%, var(--color-geg-border) 100%)',
          borderRadius: 2,
          opacity: 0.4,
        }}
      />
    </div>
  )
}
