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
import { RepLinkPreservingParams } from './rep-link'
import { SeeMoreToggle } from './see-more-toggle'
import { CallerFilter } from './caller-filter'

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
    showAllSpeed?: string | string[]
    showAllTriage?: string | string[]
    speedCaller?: string | string[]
  }
}) {
  const range = resolveDateRange(searchParams)
  const todayEt = todayEtDate()
  const selectedRepRaw = Array.isArray(searchParams?.rep) ? searchParams?.rep[0] : searchParams?.rep
  const selectedRep = typeof selectedRepRaw === 'string' && selectedRepRaw.startsWith('user_') ? selectedRepRaw : null
  const showAllSpeed = !!(Array.isArray(searchParams?.showAllSpeed) ? searchParams.showAllSpeed[0] : searchParams?.showAllSpeed)
  const showAllTriage = !!(Array.isArray(searchParams?.showAllTriage) ? searchParams.showAllTriage[0] : searchParams?.showAllTriage)
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
      <StageSection eyebrow="FIRST MESSAGE RESPONSE · BY HOUR OF CREATION" title="Bucketed by ET hour-of-day the lead opted in. Gold = ever replied. Muted = first reply within 24h of creation.">
        <FmrTimeBlockChart fmr={fmr} />
      </StageSection>

      <StageSection eyebrow="SPEED TO LEAD" title={`Avg time from lead creation to first outbound call · ${rangeLabel(range.startEtDate, range.endEtDate)}.`}>
        <SpeedToLeadSection
          cohort={speedCohort}
          activeCaller={speedCaller}
          showAllRows={showAllSpeed}
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
          showAllCalls={showAllTriage}
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
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width="100%" style={{ maxWidth: CHART_W, display: 'block' }}>
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
          <LegendSwatch color="var(--color-geg-accent)" label="Ever replied" />
          <LegendSwatch color="var(--color-geg-text-3)" label="Replied within 24h" opacity={0.65} />
        </div>
        <div
          className="geg-mono"
          style={{
            fontSize: 11,
            letterSpacing: '0.06em',
            color: 'var(--color-geg-text-faint)',
          }}
        >
          {fmr.cohortSize} leads · {fmr.cohortEverReplied} ever replied · {fmr.cohortWithin24h} within 24h · since May 24 ET
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
  showAllCalls,
}: {
  setters: CallActivityRepRow[]
  closers: CallActivityRepRow[]
  settersAggregate: CallActivityRepRow
  closersAggregate: CallActivityRepRow
  totalFormsInWindow: number
  selectedRep: string | null
  drill: CallActivityDrillRow[]
  showAllCalls: boolean
}) {
  return (
    <div>
      <div style={{ display: 'grid', gap: 14 }}>
        <CallActivityTable
          label="Setters"
          aggregate={settersAggregate}
          rows={setters}
          selectedRep={selectedRep}
          drill={drill}
          showAllCalls={showAllCalls}
        />
        <CallActivityTable
          label="Closers"
          aggregate={closersAggregate}
          rows={closers}
          selectedRep={selectedRep}
          drill={drill}
          showAllCalls={showAllCalls}
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
        Volume + calls over 90s from <code>close_calls</code>. Outcomes (Books / DQs /
        Downsell / Follow-up) from <code>airtable_setter_triage_calls</code>,
        attributed to whoever filled the form. Speed-to-lead = avg of each rep's
        earliest call to each lead minus lead creation (24h cap on outliers).
        {totalFormsInWindow > 0
          ? ` ${totalFormsInWindow} form${totalFormsInWindow === 1 ? '' : 's'} filled in this range — adoption is still ramping.`
          : ' No Airtable form rows yet in this range.'}
      </div>
    </div>
  )
}

function CallActivityTable({
  label,
  aggregate,
  rows,
  selectedRep,
  drill,
  showAllCalls,
}: {
  label: string
  aggregate: CallActivityRepRow
  rows: CallActivityRepRow[]
  selectedRep: string | null
  drill: CallActivityDrillRow[]
  showAllCalls: boolean
}) {
  const COLS = '1.7fr 0.8fr 0.8fr 0.8fr 0.8fr 0.9fr 0.9fr 0.9fr'
  return (
    <div style={{ padding: '18px 22px', background: 'var(--color-geg-bg-elev)', border: '1px solid var(--color-geg-border)', borderRadius: 10 }}>
      <SectionHeading>{label}</SectionHeading>
      <div style={{ marginTop: 12 }}>
        <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '6px 0 8px', borderBottom: '1px solid var(--color-geg-border)' }}>
          <ColH label="Rep" align="left" />
          <ColH label="Calls" />
          <ColH label=">90s" />
          <ColH label="Books" />
          <ColH label="DQs" />
          <ColH label="Downsell" />
          <ColH label="Follow-up" />
          <ColH label="Missing" />
        </div>

        {/* Aggregate row — italicized, at the top */}
        <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '11px 0', borderBottom: '1px solid var(--color-geg-border)', alignItems: 'center' }}>
          <span className="geg-serif" style={{ fontSize: 14, color: 'var(--color-geg-text-2)', fontStyle: 'italic', letterSpacing: '-0.002em' }}>
            All {label.toLowerCase()}
          </span>
          <Num value={aggregate.totalCalls.toString()} accent />
          <Num value={aggregate.totalOver90s.toString()} />
          <Num value={aggregate.bookings.toString()} />
          <Num value={aggregate.dqs.toString()} />
          <Num value={aggregate.downsells.toString()} />
          <Num value={aggregate.followUps.toString()} />
          <Num value={aggregate.missing.toString()} />
        </div>

        {rows.length === 0 ? (
          <BlankNote>No {label.toLowerCase()} activity in this range.</BlankNote>
        ) : (
          <>
            {rows.slice(0, 10).map((r) => {
              const isSelected = selectedRep === r.userId
              return (
                <div key={r.userId ?? 'agg'}>
                  <RepLinkPreservingParams userId={isSelected ? null : r.userId}>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: COLS,
                        gap: 10,
                        padding: '11px 12px',
                        margin: '0 -12px',
                        borderBottom: '1px dashed var(--color-geg-border)',
                        alignItems: 'center',
                        background: isSelected ? 'var(--color-geg-bg)' : 'transparent',
                        borderRadius: isSelected ? 6 : 0,
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        className="geg-serif"
                        style={{
                          fontSize: 14,
                          color: 'var(--color-geg-text)',
                          letterSpacing: '-0.002em',
                          fontWeight: isSelected ? 600 : 400,
                        }}
                      >
                        {isSelected ? '▼ ' : '▸ '}{r.name ?? (r.userId ? r.userId.slice(0, 13) + '…' : '—')}
                      </span>
                      <Num value={r.totalCalls.toString()} accent />
                      <Num value={r.totalOver90s.toString()} />
                      <Num value={r.bookings.toString()} />
                      <Num value={r.dqs.toString()} />
                      <Num value={r.downsells.toString()} />
                      <Num value={r.followUps.toString()} />
                      <Num value={r.missing.toString()} />
                    </div>
                  </RepLinkPreservingParams>
                  {isSelected ? (
                    <CallActivityDrillExpander
                      calls={drill}
                      repName={r.name ?? (r.userId ? r.userId.slice(0, 13) + '…' : '—')}
                      showAll={showAllCalls}
                    />
                  ) : null}
                </div>
              )
            })}
            {rows.length > 10 ? (
              <div
                className="geg-mono"
                style={{ marginTop: 10, fontSize: 10, letterSpacing: '0.08em', color: 'var(--color-geg-text-faint)', textAlign: 'right' }}
              >
                Showing top 10 of {rows.length} reps. See more in the People page (TBD).
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}

function CallActivityDrillExpander({
  calls,
  repName,
  showAll,
}: {
  calls: CallActivityDrillRow[]
  repName: string
  showAll: boolean
}) {
  const slice = showAll ? calls : calls.slice(0, 10)
  const hasMore = calls.length > 10
  return (
    <div
      style={{
        margin: '0 -12px 8px',
        padding: '14px 16px 16px',
        background: 'var(--color-geg-bg)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 8,
      }}
    >
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
        {repName} · per-call detail · calls over 90s · showing {slice.length} of {calls.length} (most recent first)
      </div>
      {calls.length === 0 ? (
        <BlankNote>No calls over 90s in this range for this rep.</BlankNote>
      ) : (
        <div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.6fr 0.8fr 1.4fr 1.2fr',
              gap: 10,
              padding: '6px 0 8px',
              borderBottom: '1px solid var(--color-geg-border)',
            }}
          >
            <ColH label="Prospect" align="left" />
            <ColH label="Duration" />
            <ColH label="Outcome" align="left" />
            <ColH label="Time called (ET)" align="left" />
          </div>
          {slice.map((c) => (
            <div
              key={c.callId}
              style={{
                display: 'grid',
                gridTemplateColumns: '1.6fr 0.8fr 1.4fr 1.2fr',
                gap: 10,
                padding: '8px 0',
                borderBottom: '1px dashed var(--color-geg-border)',
                alignItems: 'center',
              }}
            >
              <span
                className="geg-serif"
                style={{ fontSize: 13, color: 'var(--color-geg-text-2)', letterSpacing: '-0.002em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-flex', alignItems: 'center', gap: 6 }}
                title={c.leadId}
              >
                {c.prospectName ?? <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>(no name)</span>}
                {c.noMatchingCall ? (
                  <span
                    className="geg-mono"
                    title="No call to match — EOC was filled but no over-90s call by this rep is in Close for this lead in this window"
                    style={{
                      fontSize: 9,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      padding: '1px 6px',
                      borderRadius: 4,
                      border: '1px solid var(--color-geg-border)',
                      color: 'var(--color-geg-text-faint)',
                      background: 'var(--color-geg-bg)',
                      cursor: 'help',
                    }}
                  >
                    no call
                  </span>
                ) : null}
              </span>
              <Num value={c.noMatchingCall ? '—' : formatDuration(c.durationSec)} accent />
              <span
                className="geg-mono"
                style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}
              >
                {c.bookingStatus ?? <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>Missing</span>}
              </span>
              <span
                className="geg-mono"
                style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}
              >
                {formatEtTimestamp(c.callAt)}
              </span>
            </div>
          ))}
          {hasMore ? (
            <div style={{ marginTop: 10, textAlign: 'right' }}>
              <SeeMoreToggle
                paramKey="showAllTriage"
                isExpanded={showAll}
                label={showAll ? '✕ Show top 10' : `See all ${calls.length} →`}
              />
            </div>
          ) : null}
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Speed-to-Lead section — per-lead, NOT split by caller. Top stats
// + caller filter dropdown + drill list. Per-rep aggregates live
// in the Call Activity section instead.
// ---------------------------------------------------------------------------

function SpeedToLeadSection({
  cohort,
  activeCaller,
  showAllRows,
}: {
  cohort: SpeedToLeadCohortResult
  activeCaller: string | null
  showAllRows: boolean
}) {
  const slice = showAllRows ? cohort.rows : cohort.rows.slice(0, 10)
  const hasMore = cohort.rows.length > 10
  return (
    <div>
      {/* Top-line stats + filter */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, minmax(0, 1fr)) auto',
          gap: 1,
          background: 'var(--color-geg-border)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 10,
          overflow: 'hidden',
          alignItems: 'stretch',
        }}
      >
        <StatCell
          label="Avg speed to lead"
          value={cohort.avgSpeedToLeadSec !== null ? formatDuration(cohort.avgSpeedToLeadSec) : '—'}
          subtext={`${cohort.leadsCalled} leads called${activeCaller ? ' (filtered)' : ''}`}
        />
        <StatCell
          label="Over 90s rate"
          value={cohort.over90sRate !== null ? `${(cohort.over90sRate * 100).toFixed(0)}%` : '—'}
          subtext={`${cohort.leadsOver90s} / ${cohort.leadsCalled} first calls over 90s`}
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

      {/* Drill table */}
      <div style={{ marginTop: 14 }}>
        {cohort.rows.length === 0 ? (
          <BlankNote>No leads in cohort{activeCaller ? ' for this caller' : ''}.</BlankNote>
        ) : (
          <div style={{ padding: '14px 16px', background: 'var(--color-geg-bg-elev)', border: '1px solid var(--color-geg-border)', borderRadius: 10 }}>
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
              showing {slice.length} of {cohort.rows.length} leads · most recent first call first
            </div>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: '1.5fr 1.1fr 0.9fr 0.8fr 1.2fr',
                gap: 10,
                padding: '6px 0 8px',
                borderBottom: '1px solid var(--color-geg-border)',
              }}
            >
              <ColH label="Prospect" align="left" />
              <ColH label="Created (ET)" align="left" />
              <ColH label="Time to call" align="left" />
              <ColH label="Over 90s" align="left" />
              <ColH label="Caller" align="left" />
            </div>
            {slice.map((r) => (
              <div
                key={r.leadId}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '1.5fr 1.1fr 0.9fr 0.8fr 1.2fr',
                  gap: 10,
                  padding: '8px 0',
                  borderBottom: '1px dashed var(--color-geg-border)',
                  alignItems: 'center',
                }}
              >
                <span
                  className="geg-serif"
                  style={{ fontSize: 13, color: 'var(--color-geg-text-2)', letterSpacing: '-0.002em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  title={r.leadId}
                >
                  {r.prospectName ?? <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>(no name)</span>}
                </span>
                <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>
                  {formatEtTimestamp(r.leadCreatedAt)}
                </span>
                <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>
                  {r.speedSec !== null ? formatDuration(r.speedSec) : <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>not yet called</span>}
                </span>
                <span
                  className="geg-mono"
                  style={{
                    fontSize: 11,
                    letterSpacing: '0.04em',
                    color: r.firstCallOver90s
                      ? 'var(--color-geg-pos)'
                      : r.firstCallAt
                        ? 'var(--color-geg-neg)'
                        : 'var(--color-geg-text-faint)',
                  }}
                >
                  {r.firstCallAt ? (r.firstCallOver90s ? 'Yes' : 'No') : '—'}
                </span>
                <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>
                  {r.callerName ?? (r.callerUserId ? r.callerUserId.slice(0, 13) + '…' : <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>—</span>)}
                </span>
              </div>
            ))}
            {hasMore ? (
              <div style={{ marginTop: 10, textAlign: 'right' }}>
                <SeeMoreToggle
                  paramKey="showAllSpeed"
                  isExpanded={showAllRows}
                  label={showAllRows ? '✕ Show top 10' : `See all ${cohort.rows.length} →`}
                />
              </div>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}

function StatCell({ label, value, subtext }: { label: string; value: string; subtext?: string }) {
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

function formatEtTimestamp(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso))
}

// ---------------------------------------------------------------------------
// Shared cells
// ---------------------------------------------------------------------------

function UserCell({ userId, name }: { userId: string | null; name?: string | null }) {
  if (userId === null) {
    return (
      <span className="geg-serif" style={{ fontSize: 14, color: 'var(--color-geg-text-2)', fontStyle: 'italic' }}>
        aggregate
      </span>
    )
  }
  if (name) {
    return (
      <span className="geg-serif" style={{ fontSize: 14, color: 'var(--color-geg-text)', letterSpacing: '-0.002em' }}>
        {name}
      </span>
    )
  }
  // Fallback for users whose raw_payload didn't surface a full name
  // (typically users that haven't made calls in the window).
  const short = userId.startsWith('user_') ? userId.slice(0, 13) + '…' : userId
  return (
    <span className="geg-mono" style={{ fontSize: 12, color: 'var(--color-geg-text-3)', letterSpacing: '0.02em' }}>
      {short}
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

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}>
      {children}
    </div>
  )
}

function BlankNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="geg-serif" style={{ padding: '20px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 14 }}>
      {children}
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
