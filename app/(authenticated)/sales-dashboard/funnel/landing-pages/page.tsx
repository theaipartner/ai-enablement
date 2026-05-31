import {
  StageDetailLayout,
  MetricsGrid,
  StageSection,
} from '@/components/sales/stage-detail'
import { Sparkline } from '@/components/sales/sparkline'
import {
  getLpClarityMetrics,
  getVslMetrics,
  getTypVideoMetrics,
  VSL_OPTIONS,
  type VideoMetrics,
} from '@/lib/db/funnel-lp'
import {
  getAdsAggregateLive,
  getAdsUniqueClicksTrend7d,
  clampAdsRange,
} from '@/lib/db/funnel-ads'
import { getTypeformMetrics, type TypeformMetrics } from '@/lib/db/funnel-typeform'
import { getDirectBookings, type DirectBookings } from '@/lib/db/funnel-calendly'
import type { AggMetric } from '@/lib/db/funnel-mocks'
import { compactCount } from '@/lib/db/sales-dashboard-shared'
import {
  dateRangeFromExplicit,
  getDateRangeFromWindow,
  parseEtDateString,
  todayEtDate,
  daysInRange,
} from '@/lib/db/funnel-window'
import { PersonPill } from '../../header-pills'
import { DateRangePicker } from './date-range-picker'
import { PersistPageState } from '@/components/sales/persist-page-state'
import { VslSelector } from './vsl-selector'

// Funnel · Landing Page — consolidated detail page.
//
// One page for the entire LP stage. Sections, top to bottom:
//   1. Headline: LP visits + 14-day sparkline
//   2. Clarity: LP visits, avg time on page (windowed isolation)
//   3. VSL on LP: Wistia play rate + avg view duration + 14-day plays sparkline
//   4. Confirmation video (TYP): same metrics, different hashed_id
//   5. Typeform: submits, qualified vs non-qualified, avg time to complete
//   6. Calendly: closer bookings (round-robin "AI Partner Strategy Call" team URL)
//   7. Per-LP table: Clarity breakdown across all url_paths Clarity sees

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export default async function FunnelLandingPagesPage({
  searchParams,
}: {
  searchParams?: {
    start?: string | string[]
    end?: string | string[]
    vsl?: string | string[]
  }
}) {
  const range = resolveDateRange(searchParams)
  const vslHashedId = parseVslId(searchParams?.vsl)

  // LP visits = Meta unique link clicks (Drake 2026-05-27 — keeps
  // a single source of truth across Pulse + this LP detail page).
  // Clarity still drives the time-on-page section below.
  const adsRange = clampAdsRange(range.startEtDate, range.endEtDate)

  const [
    clarity,
    ads,
    visitsTrend7d,
    vsl,
    typVideo,
    typeform,
    calendly,
  ] = await Promise.all([
    getLpClarityMetrics(range),
    getAdsAggregateLive(adsRange),
    getAdsUniqueClicksTrend7d(),
    getVslMetrics(range, vslHashedId),
    getTypVideoMetrics(range),
    getTypeformMetrics(range),
    getDirectBookings(range),
  ])

  const todayEt = todayEtDate()

  const metaUniqueClicks =
    (() => {
      const m = ads.find((x) => x.id === 'unique-clicks')
      if (typeof m?.value === 'number' && Number.isFinite(m.value)) return m.value
      return 0
    })()

  return (
    <>
      <PersistPageState window filters={['vsl']} />
      <StageDetailLayout
        eyebrow="FUNNEL · LANDING PAGE"
        title="Landing page."
      backHref={`/sales-dashboard/funnel?start=${range.startEtDate}&end=${range.endEtDate}`}
      headline={{
        label: `Landing page visits  ·  Meta unique link clicks  ·  ${rangeLabel(range.startEtDate, range.endEtDate)}`,
        value: metaUniqueClicks,
        format: 'count',
        trend: visitsTrend7d,
      }}
      windowSwitcher={
        <DateRangePicker
          startEtDate={range.startEtDate}
          endEtDate={range.endEtDate}
          todayEt={todayEt}
        />
      }
      personPill={<PersonPill label="EST · Nabeel" />}
    >
      <MetricsGrid metrics={buildLpMetrics(clarity, metaUniqueClicks, typeform)} columns={3} />

      <VideoSection
        eyebrow="VSL ON LANDING PAGE"
        title="Wistia · play rate + average view duration."
        currentHashedId={vsl.hashedId}
        video={vsl}
      />

      <VideoSection
        eyebrow="CONFIRMATION VIDEO"
        title="Wistia · post-Typeform thank-you video."
        currentHashedId={typVideo.hashedId}
        video={typVideo}
      />

      <StageSection eyebrow="TYPEFORM · LEADS" title="Starts and completions on the SFedWelr coaching application.">
        <TypeformBlock typeform={typeform} />
      </StageSection>

      <StageSection eyebrow="CALENDLY · CLOSER BOOKINGS" title='Round-robin "AI Partner Strategy Call" team URL.'>
        <CalendlyBlock calendly={calendly} />
      </StageSection>
      </StageDetailLayout>
    </>
  )
}

function parseVslId(raw: string | string[] | undefined): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (!v) return undefined
  return VSL_OPTIONS.some((o) => o.hashedId === v) ? v : undefined
}

// Decode the page's date-range from search params.
// Defaults: today only (matches what most users expect when they
// land on the page without picking a range).
function resolveDateRange(searchParams: { start?: string | string[]; end?: string | string[] } | undefined) {
  const start = parseEtDateString(searchParams?.start)
  const end = parseEtDateString(searchParams?.end)
  if (start && end) return dateRangeFromExplicit(start, end)
  if (start && !end) return dateRangeFromExplicit(start, todayEtDate())
  // Default — "since start of today" (the 1d preset).
  return getDateRangeFromWindow('1d')
}

// Friendly label for the headline, e.g. "today" / "since Mon May 19"
// / "May 12 → May 25".
function rangeLabel(startEtDate: string, endEtDate: string): string {
  if (startEtDate === endEtDate) return `${formatMonthDay(startEtDate)}`
  return `${formatMonthDay(startEtDate)} → ${formatMonthDay(endEtDate)} · ${daysInRange({ startEtDate, endEtDate, startUtcIso: '', endUtcIso: '' })} days`
}

function formatMonthDay(etDate: string): string {
  // etDate is YYYY-MM-DD — parse as ET-anchored.
  const [y, m, d] = etDate.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
  }).format(dt)
}

// ---------------------------------------------------------------------------
// Clarity metrics block
// ---------------------------------------------------------------------------

// LP-detail metric grid — time-on-page (Clarity) + LP conversion
// (Meta unique-clicks → Typeform submits). The headline tile above
// shows LP visits (Meta unique link clicks) so we don't repeat it
// here. LP conversion fills the 3rd slot of the 3-column grid,
// directly under the headline. Drake 2026-05-27 — conversion is
// submits/visits, not bookings/visits (bookings come later in the
// funnel and have their own conversion view).
function buildLpMetrics(
  c: {
    avgTimeOnLpSec: number | null
    avgTimeOnTypSec: number | null
    canonicalPath: string
    canonicalTypPath: string
  },
  metaUniqueClicks: number,
  typeform: TypeformMetrics,
): AggMetric[] {
  const lpConversion =
    metaUniqueClicks > 0 ? (typeform.submits / metaUniqueClicks) * 100 : null
  return [
    {
      id: 'avg-time',
      label: 'Average time on landing page',
      value: c.avgTimeOnLpSec,
      format: 'duration_seconds',
      note: `Clarity active-time ÷ sessions · path ${c.canonicalPath}`,
    },
    {
      id: 'avg-time-typ',
      label: 'Average time on thank-you page',
      value: c.avgTimeOnTypSec,
      format: 'duration_seconds',
      note: `Clarity active-time ÷ sessions · path ${c.canonicalTypPath}`,
    },
    {
      id: 'lp-conversion',
      label: 'LP conversion',
      value: lpConversion,
      format: 'percent_0_100',
      note: `Typeform submits ÷ Meta unique link clicks`,
    },
  ]
}

// ---------------------------------------------------------------------------
// Video section — used for both VSL and the confirmation video.
// ---------------------------------------------------------------------------

function VideoSection({
  eyebrow,
  title,
  currentHashedId,
  video,
}: {
  eyebrow: string
  title: string
  currentHashedId: string
  video: VideoMetrics
}) {
  return (
    <StageSection eyebrow={eyebrow} title={title}>
      {eyebrow === 'VSL ON LANDING PAGE' ? (
        <VslSelector options={VSL_OPTIONS} currentHashedId={currentHashedId} />
      ) : null}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1.2fr',
          gap: 1,
          background: 'var(--color-geg-border)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        <VideoMetricCell label="Play rate" value={video.playRate !== null ? `${(video.playRate * 100).toFixed(1)}%` : '—'} />
        <VideoMetricCell label="Avg view duration" value={video.avgViewDurationSec !== null ? formatDuration(video.avgViewDurationSec) : '—'} />
        <VideoMetricCellTrend label="Plays (14-day trend)" total={video.totalPlays} trend={video.trendPlays} />
      </div>
      <div
        className="geg-mono"
        style={{ fontSize: 10, letterSpacing: '0.12em', color: 'var(--color-geg-text-faint)', marginTop: 10 }}
      >
        {video.label}  ·  hashed_id  {video.hashedId}
        {video.lastSyncedAt ? `  ·  data as of ${formatSyncStamp(video.lastSyncedAt)}` : ''}
      </div>
    </StageSection>
  )
}

// Format an ISO sync timestamp as a friendly "ET" stamp for the
// freshness footer.  E.g. "May 25, 2:31 AM ET".
function formatSyncStamp(iso: string): string {
  const d = new Date(iso)
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(d) + ' ET'
}

function VideoMetricCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: '16px 18px 14px', background: 'var(--color-geg-bg-elev)' }}>
      <div
        className="geg-mono"
        style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 8 }}
      >
        {label}
      </div>
      <div
        className="geg-numeric-serif"
        style={{ fontSize: 22, lineHeight: '26px', letterSpacing: '-0.02em', color: 'var(--color-geg-text)' }}
      >
        {value}
      </div>
    </div>
  )
}

function VideoMetricCellTrend({ label, total, trend }: { label: string; total: number; trend: number[] }) {
  return (
    <div style={{ padding: '16px 18px 14px', background: 'var(--color-geg-bg-elev)' }}>
      <div
        className="geg-mono"
        style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 6 }}
      >
        {label}
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span
          className="geg-numeric-serif"
          style={{ fontSize: 22, lineHeight: '26px', letterSpacing: '-0.02em', color: 'var(--color-geg-text)' }}
        >
          {compactCount(total)}
        </span>
        <Sparkline data={trend} width={120} height={26} stroke="var(--color-geg-text-3)" />
      </div>
    </div>
  )
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  const s = Math.round(sec - m * 60)
  return `${m}m ${s.toString().padStart(2, '0')}s`
}

// ---------------------------------------------------------------------------
// Typeform block
// ---------------------------------------------------------------------------

function TypeformBlock({ typeform }: { typeform: TypeformMetrics }) {
  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
          gap: 1,
          background: 'var(--color-geg-border)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        <TypeformHeadlineCell
          label="Starts"
          primary={typeform.starts !== null ? compactCount(typeform.starts) : '—'}
          subtext={
            typeform.starts === null
              ? 'No bracketing snapshots yet — cron is collecting'
              : typeform.startsPartial
                ? `Partial — anchored to first snapshot ${typeform.startsAnchorIso ? formatStampShort(typeform.startsAnchorIso) : ''}`
                : null
          }
        />
        <TypeformHeadlineCell
          label="Completions"
          primary={compactCount(typeform.submits)}
          subtext={renderCompletionsSubtext(typeform)}
        />
      </div>
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.12em',
          color: 'var(--color-geg-text-faint)',
          marginTop: 10,
          lineHeight: 1.5,
        }}
      >
        Qualified rule: budget answer ≥ $2,000 ($2k+).
        {typeform.unknownQualification > 0
          ? `  ·  ${typeform.unknownQualification} response${typeform.unknownQualification === 1 ? '' : 's'} skipped the budget question`
          : ''}
      </div>
    </div>
  )
}

function renderCompletionsSubtext(t: TypeformMetrics): string {
  const parts: string[] = []
  if (t.completionRate !== null) parts.push(`${t.completionRate.toFixed(1)}% completion rate`)
  parts.push(`${t.qualified} qualified`)
  parts.push(`${t.nonQualified} non-qualified`)
  return parts.join('  ·  ')
}

function TypeformHeadlineCell({
  label,
  primary,
  subtext,
}: {
  label: string
  primary: string
  subtext: string | null
}) {
  return (
    <div style={{ padding: '20px 22px 18px', background: 'var(--color-geg-bg-elev)' }}>
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
          marginBottom: 10,
        }}
      >
        {label}
      </div>
      <div
        className="geg-numeric-serif"
        style={{
          fontSize: 36,
          lineHeight: '40px',
          letterSpacing: '-0.025em',
          color: 'var(--color-geg-text)',
        }}
      >
        {primary}
      </div>
      {subtext ? (
        <div
          className="geg-mono"
          style={{
            fontSize: 10.5,
            letterSpacing: '0.08em',
            color: 'var(--color-geg-text-faint)',
            marginTop: 8,
          }}
        >
          {subtext}
        </div>
      ) : null}
    </div>
  )
}

function formatStampShort(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso)) + ' ET'
}

// ---------------------------------------------------------------------------
// Calendly closer-bookings block
// ---------------------------------------------------------------------------

function CalendlyBlock({ calendly }: { calendly: DirectBookings }) {
  return (
    <div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
          gap: 1,
          background: 'var(--color-geg-border)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 10,
          overflow: 'hidden',
        }}
      >
        {/* Direct bookings = the "Ai Partner Strategy Call" funnel link
            only. Total spans the row; the day-out split (today / +1 / +2,
            the only options Calendly offers) replaced active/canceled
            per Drake 2026-05-29. */}
        <div style={{ gridColumn: '1 / -1' }}>
          <VideoMetricCellTrend label="Direct bookings created (14-day)" total={calendly.total} trend={calendly.trend} />
        </div>
        <VideoMetricCell label="Booked today" value={compactCount(calendly.today)} />
        <VideoMetricCell label="Booked 1 day out" value={compactCount(calendly.oneDayOut)} />
        <VideoMetricCell label="Booked 2 days out" value={compactCount(calendly.twoDaysOut)} />
      </div>
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.12em',
          color: 'var(--color-geg-text-faint)',
          marginTop: 10,
        }}
      >
        Direct = the funnel self-book link “Ai Partner Strategy Call”
        (event type <code>8f6795d3…</code>). Excludes the Aman-solo
        “AI Partner Strategy Call”, the period variant, and setter-led
        “Partnership Call w/ …” bookings. Live via the Calendly webhook.
      </div>
    </div>
  )
}

