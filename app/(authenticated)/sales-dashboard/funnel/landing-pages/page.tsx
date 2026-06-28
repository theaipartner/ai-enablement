import {
  StageDetailLayout,
  MetricsGrid,
  StageSection,
} from '@/components/sales/stage-detail'
import { Sparkline } from '@/components/sales/sparkline'
import {
  getVslMetrics,
  getTypVideoMetrics,
  type VideoMetrics,
} from '@/lib/db/funnel-lp'
import {
  getAdsAggregateLive,
  getAdsUniqueClicksTrend7d,
  clampAdsRange,
} from '@/lib/db/funnel-ads'
import { getTypeformMetrics, type TypeformMetrics } from '@/lib/db/funnel-typeform'
import { getLandingPage } from '@/lib/db/landing-pages'
import type { AggMetric } from '@/lib/db/funnel-mocks'
import { compactCount } from '@/lib/db/sales-dashboard-shared'
import {
  dateRangeFromExplicit,
  getDateRangeFromWindow,
  parseEtDateString,
  todayEtDate,
  daysInRange,
} from '@/lib/db/funnel-window'
import { resolveSalesWindow } from '@/lib/db/sales-window-cookie'
import { PersonPill } from '../../header-pills'
import { DateRangePicker } from './date-range-picker'
import { PersistPageState } from '@/components/sales/persist-page-state'
import { VslSelector } from './vsl-selector'

// Funnel · Landing Page — consolidated detail page.
//
// One page for the selected landing page. Sections, top to bottom:
//   1. Headline: LP visits (Meta unique link clicks) + 14-day sparkline
//   2. LP conversion: Typeform submits ÷ LP visits
//   3. VSL on LP: Wistia play rate + avg view duration + 14-day plays sparkline
//   4. Confirmation / thank-you video: same metrics, different hashed_id
//   5. Typeform: submits, qualified vs non-qualified, avg time to complete
//
// Clarity (time-on-page) and Calendly (closer bookings) were removed
// 2026-06-16 — we've stopped using Clarity and are moving off Calendly.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export default async function FunnelLandingPagesPage({
  searchParams,
}: {
  searchParams?: {
    start?: string | string[]
    end?: string | string[]
    vsl?: string | string[]
    lp?: string | string[]
  }
}) {
  const win = resolveSalesWindow(searchParams)
  const range = resolveDateRange({ start: win.start ?? undefined, end: win.end ?? undefined })
  // Which landing page's stats we're showing (registry-driven, DB-backed).
  const lp = await getLandingPage(searchParams?.lp)
  const vslHashedId = parseVslId(searchParams?.vsl, lp.vsl.map((o) => o.hashedId))

  // LP visits = Meta unique link clicks (Drake 2026-05-27 — keeps
  // a single source of truth across Pulse + this LP detail page).
  const adsRange = clampAdsRange(range.startEtDate, range.endEtDate)

  const [
    ads,
    visitsTrend7d,
    vsl,
    typVideo,
    typeform,
  ] = await Promise.all([
    getAdsAggregateLive(adsRange),
    getAdsUniqueClicksTrend7d(),
    getVslMetrics(range, lp.vsl, vslHashedId),
    getTypVideoMetrics(range, lp.confirmVideoHashedId, lp.confirmVideoLabel),
    getTypeformMetrics(range, lp.typeformFormId),
  ])

  const todayEt = todayEtDate()

  const metaUniqueClicks =
    (() => {
      const m = ads.find((x) => x.id === 'unique-clicks')
      if (typeof m?.value === 'number' && Number.isFinite(m.value)) return m.value
      return 0
    })()

  const backHref =
    `/sales-dashboard/funnel?start=${range.startEtDate}&end=${range.endEtDate}` +
    (searchParams?.lp ? `&lp=${lp.slug}` : '')

  return (
    <>
      <PersistPageState window filters={['vsl', 'lp']} />
      <StageDetailLayout
        eyebrow={`FUNNEL · LANDING PAGE · ${lp.label}`}
        title="Landing page."
      backHref={backHref}
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
      <MetricsGrid metrics={buildLpMetrics(metaUniqueClicks, typeform)} columns={1} />

      <VideoSection
        eyebrow="VSL ON LANDING PAGE"
        title="Wistia · the five key metrics + average view duration."
        currentHashedId={vsl.hashedId}
        video={vsl}
        vslOptions={lp.vsl}
      />

      <VideoSection
        eyebrow="CONFIRMATION VIDEO"
        title="Wistia · post-Typeform thank-you video."
        currentHashedId={typVideo.hashedId}
        video={typVideo}
      />

      <StageSection eyebrow="TYPEFORM · LEADS" title={`Starts and completions on the ${lp.typeformLabel}.`}>
        <TypeformBlock typeform={typeform} />
      </StageSection>
      </StageDetailLayout>
    </>
  )
}

function parseVslId(
  raw: string | string[] | undefined,
  allowed: string[],
): string | undefined {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (!v) return undefined
  return allowed.includes(v) ? v : undefined
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
// LP conversion metric
// ---------------------------------------------------------------------------

// LP-detail metric grid — LP conversion (Meta unique-clicks → Typeform
// submits). The headline tile above shows LP visits (Meta unique link
// clicks) so we don't repeat it here. Drake 2026-05-27 — conversion is
// submits/visits, not bookings/visits (bookings come later in the
// funnel and have their own conversion view). The two Clarity
// time-on-page tiles were removed 2026-06-16 (Clarity retired).
function buildLpMetrics(
  metaUniqueClicks: number,
  typeform: TypeformMetrics,
): AggMetric[] {
  const lpConversion =
    metaUniqueClicks > 0 ? (typeform.submits / metaUniqueClicks) * 100 : null
  return [
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
  vslOptions,
}: {
  eyebrow: string
  title: string
  currentHashedId: string
  video: VideoMetrics
  vslOptions?: { hashedId: string; label: string }[]
}) {
  return (
    <StageSection eyebrow={eyebrow} title={title}>
      {vslOptions && vslOptions.length > 1 ? (
        <VslSelector options={vslOptions} currentHashedId={currentHashedId} />
      ) : null}
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
        <VideoMetricCell label="Visits" value={compactCount(video.visits)} />
        <VideoMetricCellTrend label="Plays (14-day trend)" total={video.totalPlays} trend={video.trendPlays} />
        <VideoMetricCell label="Play rate" value={video.playRate !== null ? `${(video.playRate * 100).toFixed(1)}%` : '—'} />
        <VideoMetricCell label="Time played" value={formatWatchTime(video.timePlayedSec)} />
        <VideoMetricCell label="Engagement" value={video.engagementRate !== null ? `${(video.engagementRate * 100).toFixed(1)}%` : '—'} />
        <VideoMetricCell label="Avg view duration" value={video.avgViewDurationSec !== null ? formatDuration(video.avgViewDurationSec) : '—'} />
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

// Total watch time ("Time played") — can run to hours across a window,
// so roll up to h/m above an hour rather than spilling minutes.
function formatWatchTime(sec: number): string {
  if (sec <= 0) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) return `${Math.round(sec / 60)}m`
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec - h * 3600) / 60)
  return `${h}h ${m.toString().padStart(2, '0')}m`
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

