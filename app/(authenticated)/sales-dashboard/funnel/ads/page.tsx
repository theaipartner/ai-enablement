import { StageDetailLayout, StageSection } from '@/components/sales/stage-detail'
import { Sparkline } from '@/components/sales/sparkline'
import {
  getAdsImpressionsLive,
  getAdsImpressionsTrend,
  getAdsAggregateLive,
  getAdsDaily,
  clampAdsRange,
  ADS_FLOOR_ET,
  type AdsAggMetric,
  type AdsDailyRow,
  type AdsRange,
} from '@/lib/db/funnel-ads'
import {
  compactCount,
  compactUsd,
  formatMetricValue,
} from '@/lib/db/sales-dashboard-shared'
import {
  parseEtDateString,
  todayEtDate,
} from '@/lib/db/funnel-window'
import { PersonPill } from '../../header-pills'
import { DateRangePicker } from '../landing-pages/date-range-picker'

// Funnel · Ads — LIVE from `meta_ad_daily`.
//
// Data floor: 2026-05-24 ET (when Zain's fixed source-sheet started
// landing usable data). Upper bound: yesterday ET (today's row lands
// the morning after, so the most recent complete day is always
// yesterday).
//
// URL contract: ?start=YYYY-MM-DD&end=YYYY-MM-DD. Empty → full
// available range (floor → today; data layer clamps end to yesterday).

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export default async function FunnelAdsPage({
  searchParams,
}: {
  searchParams?: {
    start?: string | string[]
    end?: string | string[]
  }
}) {
  const picker = resolvePickerRange(searchParams)
  const dataRange = clampAdsRange(picker.startEtDate, picker.endEtDate)
  const todayEt = todayEtDate()

  const [impressions, trend, metrics, daily] = await Promise.all([
    getAdsImpressionsLive(dataRange),
    getAdsImpressionsTrend(dataRange),
    getAdsAggregateLive(dataRange),
    getAdsDaily(dataRange),
  ])
  return (
    <StageDetailLayout
      eyebrow="FUNNEL · ADS"
      title="Ads."
      headline={{
        label: 'Total impressions',
        value: impressions,
        format: 'count',
        trend,
      }}
      windowSwitcher={
        <DateRangePicker
          startEtDate={picker.startEtDate}
          endEtDate={picker.endEtDate}
          todayEt={todayEt}
          minDate={ADS_FLOOR_ET}
        />
      }
      personPill={<PersonPill label="EST · Nabeel" />}
    >
      <AdsMetricsBlock metrics={metrics} />

      <StageSection eyebrow="PER DAY" title={dailyTitle(dataRange)}>
        {dataRange.isEmptyRange ? <EmptyDailyNote /> : <DailyTable rows={daily} />}
      </StageSection>

      <ComingSoonNote />
    </StageDetailLayout>
  )
}

// ---------------------------------------------------------------------------
// Date-range resolution
// ---------------------------------------------------------------------------

// Resolve the picker's visible range. This is NOT the data-fetch range
// — it's what the user picked / sees in the picker. The data layer
// clamps it further (floor + yesterday).
//
// Defaults: start = ADS_FLOOR_ET, end = today. So a fresh visit shows
// the full available window without preset clicks.
function resolvePickerRange(searchParams: {
  start?: string | string[]
  end?: string | string[]
} | undefined): { startEtDate: string; endEtDate: string } {
  const todayEt = todayEtDate()
  const start = parseEtDateString(searchParams?.start) ?? ADS_FLOOR_ET
  const end = parseEtDateString(searchParams?.end) ?? todayEt
  return { startEtDate: start, endEtDate: end }
}

function dailyTitle(range: AdsRange): string {
  if (range.isEmptyRange) return 'No completed days yet in this range — Meta\'s daily row lands the morning after.'
  if (range.startEtDate === range.endEtDate) return `${formatMonthDay(range.startEtDate)} only.`
  return `${formatMonthDay(range.startEtDate)} → ${formatMonthDay(range.endEtDate)}.`
}

function formatMonthDay(etDate: string): string {
  const [y, m, d] = etDate.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
  }).format(dt)
}

// ---------------------------------------------------------------------------
// AdsMetricsBlock — 3×2 grid of independent rounded tiles, each with
// a label / value / sparkline. Mirrors the visual of MetricsGrid but
// drops the shared-container look so 6 tiles fill cleanly with no
// blank cells, and adds a per-metric trend sparkline at the bottom.
// ---------------------------------------------------------------------------

function AdsMetricsBlock({ metrics }: { metrics: AdsAggMetric[] }) {
  return (
    <section
      style={{
        marginTop: 18,
        display: 'grid',
        gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        gap: 12,
      }}
    >
      {metrics.map((m) => (
        <AdsMetricCell key={m.id} metric={m} />
      ))}
    </section>
  )
}

function AdsMetricCell({ metric }: { metric: AdsAggMetric }) {
  const display = metric.value == null ? '—' : renderMetricValue(metric.value, metric.format)
  return (
    <div
      style={{
        padding: '18px 20px 14px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        minHeight: 124,
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
          fontSize: 26,
          lineHeight: '30px',
          letterSpacing: '-0.02em',
          color: 'var(--color-geg-text)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {display}
      </div>
      <div style={{ marginTop: 'auto', display: 'flex', justifyContent: 'flex-end' }}>
        {metric.trend.length >= 2 ? (
          <Sparkline data={metric.trend} width={140} height={28} stroke="var(--color-geg-accent)" />
        ) : (
          <span
            className="geg-mono"
            style={{
              fontSize: 9.5,
              letterSpacing: '0.12em',
              color: 'var(--color-geg-text-faint)',
              fontStyle: 'italic',
            }}
          >
            {metric.trend.length === 1 ? 'single day' : 'no data yet'}
          </span>
        )}
      </div>
    </div>
  )
}

function renderMetricValue(value: number, format: AdsAggMetric['format']): string {
  if (format === 'usd') return compactUsd(value)
  if (format === 'count') return compactCount(value)
  if (format === 'integer' && Math.abs(value) >= 100_000) return compactCount(value)
  // CPM, adspend, and cost/click render as dollars-and-cents on this
  // page (the daily table values are typically $100-$5000 — compact
  // rounding to whole dollars was lossy).
  if (format === 'usd_precise') return formatUsdExact(value)
  return formatMetricValue(value, format)
}

// Exact dollars-and-cents ($X,XXX.XX). Drake's preference for adspend
// and cost-per-unique-click everywhere in the Meta Ads UI.
function formatUsdExact(value: number): string {
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function EmptyDailyNote() {
  return (
    <div
      className="geg-serif"
      style={{
        padding: '24px 0',
        textAlign: 'center',
        fontStyle: 'italic',
        color: 'var(--color-geg-text-3)',
        fontSize: 14,
      }}
    >
      No completed-day data in this window yet. Meta's daily row for today lands the morning after.
    </div>
  )
}

function ComingSoonNote() {
  return (
    <div
      className="geg-mono"
      style={{
        marginTop: 18,
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-faint)',
        textAlign: 'center',
      }}
    >
      Per-ad metrics coming soon.
    </div>
  )
}

function DailyTable({ rows }: { rows: AdsDailyRow[] }) {
  const COLS = '1.2fr 1fr 1fr 1fr 0.9fr 0.9fr 1fr'
  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: COLS,
          gap: 12,
          padding: '6px 0 12px',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        <ColH label="Day" align="left" />
        <ColH label="Spend" />
        <ColH label="Impressions" />
        <ColH label="Unique clicks" />
        <ColH label="CTR" />
        <ColH label="Freq" />
        <ColH label="$/click" />
      </div>
      {rows.length === 0 ? (
        <div
          className="geg-serif"
          style={{ padding: '20px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 14 }}
        >
          No rows yet in this range.
        </div>
      ) : (
        rows.map((r) => (
          <div
            key={r.day}
            style={{
              display: 'grid',
              gridTemplateColumns: COLS,
              gap: 12,
              padding: '13px 0',
              borderBottom: '1px dashed var(--color-geg-border)',
              alignItems: 'center',
            }}
          >
            <span
              className="geg-serif"
              style={{ fontSize: 14, color: 'var(--color-geg-text)', letterSpacing: '-0.002em' }}
            >
              {formatMonthDay(r.day)}
            </span>
            <Num value={r.spend != null ? formatUsdExact(r.spend) : '—'} />
            <Num value={r.impressions != null ? compactCount(r.impressions) : '—'} />
            <Num value={r.uniqueClicks != null ? compactCount(r.uniqueClicks) : '—'} />
            <Num value={r.ctr != null ? `${r.ctr.toFixed(2)}%` : '—'} />
            <Num value={r.frequency != null ? r.frequency.toFixed(2) : '—'} />
            <Num value={r.cpcUnique != null ? formatUsdExact(r.cpcUnique) : '—'} accent />
          </div>
        ))
      )}
    </div>
  )
}

function ColH({ label, align }: { label: string; align?: 'left' | 'right' }) {
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-faint)',
        textAlign: align ?? 'right',
      }}
    >
      {label}
    </span>
  )
}

function Num({ value, accent }: { value: string; accent?: boolean }) {
  return (
    <span
      className="geg-numeric-serif"
      style={{
        fontSize: 14,
        color: accent ? 'var(--color-geg-text)' : 'var(--color-geg-text-2)',
        letterSpacing: '-0.01em',
        textAlign: 'right',
      }}
    >
      {value}
    </span>
  )
}
