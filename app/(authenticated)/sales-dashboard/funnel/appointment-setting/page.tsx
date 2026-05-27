import { StageDetailLayout, StageSection } from '@/components/sales/stage-detail'
import {
  getFmrTimeBlocks,
  getCallActivityMetrics,
  getCallActivityForUser,
  getSpeedToLeadCohort,
  type FmrTimeBlocksResult,
  type FmrTimeBlock,
  type CallActivityRepRow,
  type CallActivityDrillRow,
  type SpeedToLeadCohortResult,
  type SpeedToLeadCohortRow,
} from '@/lib/db/funnel-appointment-setting'
import { compactCount } from '@/lib/db/sales-dashboard-shared'
import {
  dateRangeFromExplicit,
  getDateRangeFromWindow,
  parseEtDateString,
  todayEtDate,
  daysInRange,
} from '@/lib/db/funnel-window'
import { PersonPill } from '../../header-pills'
import { DateRangePicker } from '../landing-pages/date-range-picker'
import { CallerFilter } from './caller-filter'
import {
  PerRepCallActivityTable,
  SpeedToLeadDrillTable,
} from './_components/sortable-tables'

// Funnel · Appointment Setting — consolidated detail page.
//
// Sections:
//   1. First Message Response — time-block bar chart with cohort avg
//   2. Speed to Lead — setters + closers stacked, per-rep avg
//      with click-to-drill into each rep's leads
//   3. Triage Calls — outcomes from airtable_setter_triage_calls
//      (Setter Triage Calls EOC Form), volume + calls-over-90s from
//      close_calls. Setters + closers stacked, per-rep stats with
//      click-to-drill into each rep's calls (prospect, time, result)
//
// All sections respect the date-range picker. Aman is routed to
// closers via PRIMARY_ROLE_OVERRIDE in the data layer.

export const dynamic = 'force-dynamic'

export default async function FunnelApptSettingPage({
  searchParams,
}: {
  searchParams?: {
    start?: string | string[]
    end?: string | string[]
    rep?: string | string[]
    speedCaller?: string | string[]
  }
}) {
  const range = resolveDateRange(searchParams)
  const todayEt = todayEtDate()
  const selectedRepRaw = Array.isArray(searchParams?.rep) ? searchParams?.rep[0] : searchParams?.rep
  const selectedRep = typeof selectedRepRaw === 'string' && selectedRepRaw.startsWith('user_') ? selectedRepRaw : null
  const speedCallerRaw = Array.isArray(searchParams?.speedCaller) ? searchParams?.speedCaller[0] : searchParams?.speedCaller
  const speedCaller = typeof speedCallerRaw === 'string' && speedCallerRaw.startsWith('user_') ? speedCallerRaw : null

  const [fmr, activity, drill, speedCohort] = await Promise.all([
    getFmrTimeBlocks(),
    getCallActivityMetrics(range),
    selectedRep ? getCallActivityForUser(range, selectedRep) : Promise.resolve([] as CallActivityDrillRow[]),
    getSpeedToLeadCohort(range, speedCaller),
  ])

  return (
    <StageDetailLayout
      eyebrow="FUNNEL · APPOINTMENT SETTING"
      title="Appointment setting."
      headline={null}
      windowSwitcher={
        <DateRangePicker
          startEtDate={range.startEtDate}
          endEtDate={range.endEtDate}
          todayEt={todayEt}
          minDate="2026-05-24"
        />
      }
      personPill={<PersonPill label="EST · Nabeel" />}
    >
      <StageSection eyebrow="FIRST MESSAGE RESPONSE · BY HOUR OF CREATION" title="">
        <FmrTimeBlockChart fmr={fmr} />
      </StageSection>

      <StageSection eyebrow="LEAD LIST" title={`Status of leads created during this window · ${rangeLabel(range.startEtDate, range.endEtDate)}.`}>
        <SpeedToLeadSection
          cohort={speedCohort}
          activeCaller={speedCaller}
        />
      </StageSection>

      <StageSection eyebrow="CALL ACTIVITY" title={`Per-rep call volume and outcomes · ${rangeLabel(range.startEtDate, range.endEtDate)}.`}>
        <CallActivityStacked
          setters={activity.setters}
          closers={activity.closers}
          settersAggregate={activity.settersAggregate}
          closersAggregate={activity.closersAggregate}
          totalFormsInWindow={activity.totalFormsInWindow}
          selectedRep={selectedRep}
          drill={drill}
        />
      </StageSection>
    </StageDetailLayout>
  )
}

// ---------------------------------------------------------------------------
// Date-range resolution (same pattern as the LP page)
// ---------------------------------------------------------------------------

// May 24, 2026 is the page-wide floor — anything earlier is pre-process.
const APPT_SETTING_FLOOR_ET = '2026-05-24'

function resolveDateRange(searchParams: { start?: string | string[]; end?: string | string[] } | undefined) {
  const start = parseEtDateString(searchParams?.start)
  const end = parseEtDateString(searchParams?.end)
  let range
  if (start && end) range = dateRangeFromExplicit(start, end)
  else if (start && !end) range = dateRangeFromExplicit(start, todayEtDate())
  else range = getDateRangeFromWindow('1d')
  // Clamp the lower bound. The data layer also clamps internally,
  // but doing it here aligns the displayed range label + picker.
  if (range.startEtDate < APPT_SETTING_FLOOR_ET) {
    const clampedEnd = range.endEtDate < APPT_SETTING_FLOOR_ET ? APPT_SETTING_FLOOR_ET : range.endEtDate
    range = dateRangeFromExplicit(APPT_SETTING_FLOOR_ET, clampedEnd)
  }
  return range
}

function rangeLabel(startEtDate: string, endEtDate: string): string {
  if (startEtDate === endEtDate) return formatMonthDay(startEtDate)
  return `${formatMonthDay(startEtDate)} → ${formatMonthDay(endEtDate)} · ${daysInRange({ startEtDate, endEtDate, startUtcIso: '', endUtcIso: '' })} days`
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
// FMR time-block bar chart
//
// 6 time-of-day blocks × 2 bars each (ever-replied + within-24h).
// Pure SVG so it renders server-side without a chart lib dependency.
// ---------------------------------------------------------------------------

function FmrTimeBlockChart({ fmr }: { fmr: FmrTimeBlocksResult }) {
  // Bar geometry — fits comfortably in the page's content column.
  const PAD_X = 36
  const PAD_TOP = 18
  const PAD_BOTTOM = 50
  const CHART_W = 720
  const CHART_H = 280

  // Cohort-wide ever-replied rate (used as a dashed reference line
  // across the chart so each block's bar reads against it).
  const cohortEverRate =
    fmr.cohortSize > 0 ? fmr.cohortEverReplied / fmr.cohortSize : null
  const cohortWithin24hRate =
    fmr.cohortSize > 0 ? fmr.cohortWithin24h / fmr.cohortSize : null
  const groupGap = 14
  const blockCount = fmr.blocks.length
  const groupWidth = (CHART_W - PAD_X * 2 - groupGap * (blockCount - 1)) / blockCount
  const barWidth = (groupWidth - 8) / 2
  const usableH = CHART_H - PAD_TOP - PAD_BOTTOM

  function y(rate: number | null): number {
    if (rate === null) return CHART_H - PAD_BOTTOM
    return PAD_TOP + usableH * (1 - rate)
  }
  function h(rate: number | null): number {
    if (rate === null) return 0
    return usableH * rate
  }

  // Y-axis gridlines at 25/50/75/100%
  const gridlines = [0.25, 0.5, 0.75, 1]

  return (
    <div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width="100%" style={{ maxWidth: CHART_W, display: 'block', margin: '0 auto' }}>
        {/* Y-axis labels + gridlines */}
        {gridlines.map((g) => {
          const yPos = PAD_TOP + usableH * (1 - g)
          return (
            <g key={g}>
              <line
                x1={PAD_X}
                x2={CHART_W - PAD_X}
                y1={yPos}
                y2={yPos}
                stroke="var(--color-geg-border)"
                strokeDasharray="2 4"
                strokeWidth="1"
              />
              <text
                x={PAD_X - 8}
                y={yPos + 3}
                textAnchor="end"
                className="geg-mono"
                style={{ fontSize: 9, letterSpacing: '0.04em', fill: 'var(--color-geg-text-faint)' }}
              >
                {Math.round(g * 100)}%
              </text>
            </g>
          )
        })}

        {/* Cohort-average reference line (ever-replied rate) */}
        {cohortEverRate !== null ? (
          <g>
            <line
              x1={PAD_X}
              x2={CHART_W - PAD_X}
              y1={y(cohortEverRate)}
              y2={y(cohortEverRate)}
              stroke="var(--color-geg-accent)"
              strokeDasharray="4 4"
              strokeWidth="1.2"
              opacity="0.55"
            />
            <text
              x={CHART_W - PAD_X - 4}
              y={y(cohortEverRate) - 4}
              textAnchor="end"
              className="geg-mono"
              style={{ fontSize: 9, letterSpacing: '0.06em', fill: 'var(--color-geg-accent)' }}
            >
              cohort avg {Math.round(cohortEverRate * 100)}%
            </text>
          </g>
        ) : null}

        {fmr.blocks.map((b, idx) => {
          const groupX = PAD_X + idx * (groupWidth + groupGap)
          const barAx = groupX
          const barBx = groupX + barWidth + 8
          return (
            <g key={b.blockIndex}>
              {/* Ever-replied bar (gold) */}
              <rect
                x={barAx}
                y={y(b.everRepliedRate)}
                width={barWidth}
                height={h(b.everRepliedRate)}
                fill="var(--color-geg-accent)"
                rx="2"
              />
              {/* Within-24h bar (muted) */}
              <rect
                x={barBx}
                y={y(b.within24hRate)}
                width={barWidth}
                height={h(b.within24hRate)}
                fill="var(--color-geg-text-3)"
                opacity="0.65"
                rx="2"
              />
              {/* Rate labels above each bar */}
              <text
                x={barAx + barWidth / 2}
                y={y(b.everRepliedRate) - 6}
                textAnchor="middle"
                className="geg-mono"
                style={{ fontSize: 9, letterSpacing: '0.04em', fill: 'var(--color-geg-text-2)' }}
              >
                {b.everRepliedRate !== null ? `${Math.round(b.everRepliedRate * 100)}%` : '—'}
              </text>
              <text
                x={barBx + barWidth / 2}
                y={y(b.within24hRate) - 6}
                textAnchor="middle"
                className="geg-mono"
                style={{ fontSize: 9, letterSpacing: '0.04em', fill: 'var(--color-geg-text-faint)' }}
              >
                {b.within24hRate !== null ? `${Math.round(b.within24hRate * 100)}%` : '—'}
              </text>
              {/* Block label */}
              <text
                x={groupX + groupWidth / 2}
                y={CHART_H - PAD_BOTTOM + 18}
                textAnchor="middle"
                className="geg-mono"
                style={{ fontSize: 10, letterSpacing: '0.06em', fill: 'var(--color-geg-text-2)' }}
              >
                {b.label}
              </text>
              {/* Block N */}
              <text
                x={groupX + groupWidth / 2}
                y={CHART_H - PAD_BOTTOM + 32}
                textAnchor="middle"
                className="geg-mono"
                style={{ fontSize: 9, letterSpacing: '0.04em', fill: 'var(--color-geg-text-faint)' }}
              >
                {b.cohortSize} leads
              </text>
            </g>
          )
        })}
      </svg>

      {/* Legend + cohort footer */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, marginTop: 14 }}>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          <LegendSwatch color="var(--color-geg-accent)" label="Ever responded" />
          <LegendSwatch color="var(--color-geg-text-3)" label="Responded within 24h" opacity={0.65} />
        </div>
        <div
          className="geg-mono"
          style={{
            fontSize: 11,
            letterSpacing: '0.06em',
            color: 'var(--color-geg-text-faint)',
          }}
          title="A response is an inbound SMS OR the first outbound dial answered (>= 90s) — either channel counts."
        >
          {fmr.cohortSize} leads · {fmr.cohortEverReplied} responded · {fmr.cohortWithin24h} within 24h · since May 24 ET
        </div>
      </div>
    </div>
  )
}

function LegendSwatch({ color, label, opacity = 1 }: { color: string; label: string; opacity?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: 3,
          background: color,
          opacity,
          display: 'inline-block',
        }}
      />
      <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--color-geg-text-2)' }}>
        {label}
      </span>
    </span>
  )
}
// ---------------------------------------------------------------------------
// Call Activity — merged per-rep table (volume + outcomes + speed).
// Stacked setters then closers. Each section: aggregate row at top,
// per-rep rows, click-to-drill expander with prospect/time/speed/
// duration/outcome.
// ---------------------------------------------------------------------------

function CallActivityStacked({
  setters,
  closers,
  settersAggregate,
  closersAggregate,
  totalFormsInWindow,
  selectedRep,
  drill,
}: {
  setters: CallActivityRepRow[]
  closers: CallActivityRepRow[]
  settersAggregate: CallActivityRepRow
  closersAggregate: CallActivityRepRow
  totalFormsInWindow: number
  selectedRep: string | null
  drill: CallActivityDrillRow[]
}) {
  return (
    <div>
      <div style={{ display: 'grid', gap: 14 }}>
        <PerRepCallActivityTable
          label="Setters"
          aggregate={settersAggregate}
          rows={setters}
          selectedRep={selectedRep}
          drill={drill}
        />
        <PerRepCallActivityTable
          label="Closers"
          aggregate={closersAggregate}
          rows={closers}
          selectedRep={selectedRep}
          drill={drill}
        />
      </div>
      <div
        className="geg-mono"
        style={{
          marginTop: 12,
          fontSize: 10,
          letterSpacing: '0.08em',
          color: 'var(--color-geg-text-faint)',
          lineHeight: 1.5,
        }}
      >
        Volume + calls over 90s from <code>close_calls</code>. Outcomes (Books /
        Downsell / Reconfirms / Follow-up / DQs) from
        <code>airtable_setter_triage_calls</code>, attributed to whoever filled
        the form. Speed-to-lead = avg of each rep's earliest call to each lead
        minus lead creation (24h cap on outliers).
        {totalFormsInWindow > 0
          ? ` ${totalFormsInWindow} form${totalFormsInWindow === 1 ? '' : 's'} filled in this range — adoption is still ramping.`
          : ' No Airtable form rows yet in this range.'}
      </div>
    </div>
  )
}

// CallActivityTable + CallActivityDrillExpander moved to
// ./_components/sortable-tables.tsx (client component) so column sort
// + scrollable list could land. Server-side now just forwards the
// already-fetched rows + drill into PerRepCallActivityTable.

// ---------------------------------------------------------------------------
// Speed-to-Lead section — per-lead, NOT split by caller. Top stats
// + caller filter dropdown + drill list. Per-rep aggregates live
// in the Call Activity section instead. "Connected" = first call to
// the lead landed over 90s (the same engagement proxy used elsewhere
// on the page; relabeled away from ">90s" so non-engineers don't
// have to decode the unit).
// ---------------------------------------------------------------------------

function SpeedToLeadSection({
  cohort,
  activeCaller,
}: {
  cohort: SpeedToLeadCohortResult
  activeCaller: string | null
}) {
  return (
    <div>
      {/* Top-line stats + filter */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr)) auto',
          gap: 1,
          background: 'var(--color-geg-border)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 10,
          overflow: 'hidden',
          alignItems: 'stretch',
        }}
      >
        <StatCell
          label="Avg speed to lead (< 3h)"
          value={cohort.avgSpeedToLeadSecUnder3h !== null ? formatDuration(cohort.avgSpeedToLeadSecUnder3h) : '—'}
          subtext={
            <>
              <div>
                {`${cohort.leadsCalled} leads called${activeCaller ? ' (filtered)' : ''}`}
              </div>
              {cohort.avgSpeedToLeadSec !== null ? (
                <div
                  title={`All-time avg includes every called lead in the cohort, with a 24h outlier cap on individual contributions. ${cohort.leadsCalled - cohort.leadsUnder3h} leads were first-called more than 3 hours after creation.`}
                >
                  All-time STL: {formatDuration(cohort.avgSpeedToLeadSec)}{' '}
                  <span style={{ color: 'var(--color-geg-text-faint)' }}>
                    · {cohort.leadsCalled - cohort.leadsUnder3h} outside 3h
                  </span>
                </div>
              ) : null}
            </>
          }
        />
        <StatCell
          label="Avg intensity"
          value={cohort.avgIntensity !== null ? `${cohort.avgIntensity.toFixed(1)}×` : '—'}
          subtext={`mean dials per called lead`}
        />
        <StatCell
          label="Connected rate"
          value={cohort.connectedRate !== null ? `${(cohort.connectedRate * 100).toFixed(0)}%` : '—'}
          subtext={`${cohort.leadsConnected} / ${cohort.leadsCalled} leads reached (any dial)`}
        />
        <StatCell
          label="Cohort size"
          value={cohort.cohortSize.toString()}
          subtext={activeCaller ? 'leads matching filter' : 'leads in window'}
        />
        <div style={{ padding: '16px 18px 14px', background: 'var(--color-geg-bg-elev)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <CallerFilter callers={cohort.callers} currentCallerId={activeCaller} />
        </div>
      </div>

      <div style={{ marginTop: 14 }}>
        <SpeedToLeadDrillTable rows={cohort.rows} activeCaller={activeCaller} />
      </div>
    </div>
  )
}

function StatCell({
  label,
  value,
  subtext,
}: {
  label: string
  value: string
  // ReactNode (not string) so callers can render multiple lines —
  // Avg speed to lead uses this to surface the <3h outlier-filtered
  // avg directly under "X leads called" without occupying the top-
  // right corner.
  subtext?: React.ReactNode
}) {
  return (
    <div style={{ padding: '16px 18px 14px', background: 'var(--color-geg-bg-elev)' }}>
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        className="geg-numeric-serif"
        style={{
          fontSize: 28,
          lineHeight: '32px',
          letterSpacing: '-0.02em',
          color: 'var(--color-geg-text)',
        }}
      >
        {value}
      </div>
      {subtext ? (
        <div
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.08em',
            color: 'var(--color-geg-text-faint)',
            marginTop: 6,
          }}
        >
          {subtext}
        </div>
      ) : null}
    </div>
  )
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) {
    const m = Math.floor(sec / 60)
    const s = Math.round(sec - m * 60)
    return `${m}m ${s.toString().padStart(2, '0')}s`
  }
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec - h * 3600) / 60)
  return `${h}h ${m}m`
}
