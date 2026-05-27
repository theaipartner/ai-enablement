import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import {
  getClosingActivity,
  getClosingScheduledList,
  CLOSING_FLOOR_ET,
  type CalendlyBookingActivity,
  type CloserScheduledAggregate,
  type CloserScheduledDrillRow,
  type ClosingMoney,
} from '@/lib/db/funnel-closing'
import {
  parseEtDateString,
  todayEtDate,
  dateRangeFromExplicit,
} from '@/lib/db/funnel-window'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import { PersonPill } from '../../header-pills'
import { DateRangePicker } from '../landing-pages/date-range-picker'

// Funnel · Closing — three sections:
//   1. Calendly bookings · AI Partner Strategy Call (new / resched / cancel)
//   2. Per-closer leaderboard with click-to-drill (mirrors the setter
//      page's pattern but with closing-side metrics)
//   3. Cash produced (upfront / contract / AOV) — links out to Revenue

export const dynamic = 'force-dynamic'

// Default = TODAY (single-day window). Drake's call 2026-05-27 — the
// closing page is now organized around scheduled-calls-for-today, so
// the picker opens on today and the user can broaden the range
// manually via the calendar picker. Earlier default was the full
// since-floor window (cumulative); that's now achievable by clicking
// "from May 22" in the picker.
function resolveClosingRange(start: string | null, end: string | null) {
  const today = todayEtDate()
  const s = start ?? today
  const e = end ?? today
  const sClamped = s < CLOSING_FLOOR_ET ? CLOSING_FLOOR_ET : s
  return dateRangeFromExplicit(sClamped, e)
}

export default async function FunnelClosedPage({
  searchParams,
}: {
  searchParams?: {
    start?: string | string[]
    end?: string | string[]
    closer?: string | string[]
  }
}) {
  const start = parseEtDateString(searchParams?.start)
  const end = parseEtDateString(searchParams?.end)
  const range = resolveClosingRange(start, end)
  const todayEt = todayEtDate()
  const selectedCloserRaw = Array.isArray(searchParams?.closer) ? searchParams?.closer[0] : searchParams?.closer
  const selectedCloser = typeof selectedCloserRaw === 'string' && selectedCloserRaw.length > 0 ? selectedCloserRaw : null

  // Old getClosingActivity stays — Calendly bookings section + Cash
  // section still read from it. The leaderboard (replaced) reads from
  // the new getClosingScheduledList which is keyed off scheduled
  // Calendly events rather than form submissions.
  const [data, scheduled] = await Promise.all([
    getClosingActivity(range),
    getClosingScheduledList(range),
  ])
  const drill = selectedCloser
    ? scheduled.drillByCloser[selectedCloser] ?? []
    : ([] as CloserScheduledDrillRow[])

  // Build a base query string for closer-link toggles that preserves
  // the active start/end params.
  const baseParams = new URLSearchParams()
  if (start) baseParams.set('start', start)
  if (end) baseParams.set('end', end)

  return (
    <div>
      <HeaderBand
        eyebrow="FUNNEL · CLOSING"
        title="Closing."
        backlink={{ href: '/sales-dashboard/funnel', label: 'BACK TO PULSE' }}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <DateRangePicker
              startEtDate={range.startEtDate}
              endEtDate={range.endEtDate}
              todayEt={todayEt}
              minDate={CLOSING_FLOOR_ET}
            />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18, marginTop: 28 }}>
        <CalendlySection bookings={data.bookings} />
        <CloserScheduledSection
          closers={scheduled.closers}
          aggregate={scheduled.aggregate}
          selectedCloser={selectedCloser}
          drill={drill}
          baseParams={baseParams}
        />
        <CashSection money={data.money} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section 1 — Calendly bookings
// ---------------------------------------------------------------------------

function CalendlySection({ bookings }: { bookings: CalendlyBookingActivity }) {
  return (
    <SectionBox eyebrow="CALENDLY BOOKINGS" title="AI Partner Strategy Call · invitee-created in range.">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
        <Tile label="New scheduled" value={bookings.newScheduled} />
        <Tile label="Rescheduled" value={bookings.rescheduled} />
        <Tile label="Canceled" value={bookings.canceled} />
      </div>
    </SectionBox>
  )
}

function Tile({ label, value }: { label: string; value: number }) {
  return (
    <div style={{ padding: '16px 18px 14px', background: 'var(--color-geg-bg)', border: '1px solid var(--color-geg-border)', borderRadius: 8 }}>
      <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 8 }}>
        {label}
      </div>
      <div className="geg-numeric-serif" style={{ fontSize: 28, lineHeight: '32px', letterSpacing: '-0.02em', color: 'var(--color-geg-text)' }}>
        {value}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section 2 — Per-closer scheduled-calls list (new 2026-05-27)
// ---------------------------------------------------------------------------
//
// Replaces the old form-driven leaderboard. Each closer row shows their
// Calendly-scheduled calls in range, with form-derived outcomes filled
// in where the closer form matched (name + date ±48h). Unmatched rows
// render "missing" until the form is submitted.

function CloserScheduledSection({
  closers,
  aggregate,
  selectedCloser,
  drill,
  baseParams,
}: {
  closers: CloserScheduledAggregate[]
  aggregate: CloserScheduledAggregate
  selectedCloser: string | null
  drill: CloserScheduledDrillRow[]
  baseParams: URLSearchParams
}) {
  return (
    <SectionBox
      eyebrow="PER CLOSER"
      title="Scheduled calls in range · click a closer to drill."
    >
      <CloserScheduledTable
        closers={closers}
        aggregate={aggregate}
        selectedCloser={selectedCloser}
        drill={drill}
        baseParams={baseParams}
      />
    </SectionBox>
  )
}

// Top-bar columns: Closer / Calls / →show% Showed / →close% Closes (HT/DC) /
// No shows / Upfront. The arrow-percentage cells follow the appointment-
// setting convention — a small muted "→X%" on the left edge of the cell
// signaling the rate from the prior column to this one.
function CloserScheduledTable({
  closers,
  aggregate,
  selectedCloser,
  drill,
  baseParams,
}: {
  closers: CloserScheduledAggregate[]
  aggregate: CloserScheduledAggregate
  selectedCloser: string | null
  drill: CloserScheduledDrillRow[]
  baseParams: URLSearchParams
}) {
  const COLS = '1.6fr 0.7fr 1.1fr 1.3fr 0.7fr 0.9fr'
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '6px 0 10px', borderBottom: '1px solid var(--color-geg-border)' }}>
        <ColH label="Closer" align="left" />
        <ColH label="Calls" />
        <ColH label="Showed" />
        <ColH label="Closes (HT/DC)" />
        <ColH label="No shows" />
        <ColH label="Upfront" />
      </div>

      {/* Aggregate row (italic, all closers) */}
      <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '12px 0', borderBottom: '1px solid var(--color-geg-border)', alignItems: 'center' }}>
        <span className="geg-serif" style={{ fontSize: 14, fontStyle: 'italic', color: 'var(--color-geg-text-2)', letterSpacing: '-0.002em' }}>
          All closers
        </span>
        <Num value={aggregate.calls} accent />
        <ShowedCell calls={aggregate.calls} showed={aggregate.showed} />
        <ClosesCell showed={aggregate.showed} closed={aggregate.closed} ht={aggregate.closedHt} dc={aggregate.closedDc} />
        <Num value={aggregate.noShows} />
        <Num value={compactUsd(aggregate.upfront)} />
      </div>

      {/* Per-closer rows */}
      {closers.length === 0 ? (
        <div className="geg-serif" style={{ padding: '20px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 14 }}>
          No scheduled closer calls in this range.
        </div>
      ) : (
        closers.map((c) => {
          const isSelected = selectedCloser === c.closerName
          return (
            <div key={c.closerName}>
              <RowLink baseParams={baseParams} closerName={c.closerName} isSelected={isSelected}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: COLS,
                    gap: 10,
                    padding: '12px 12px',
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
                    {isSelected ? '▼ ' : '▸ '}{c.closerName}
                  </span>
                  <Num value={c.calls} accent />
                  <ShowedCell calls={c.calls} showed={c.showed} />
                  <ClosesCell showed={c.showed} closed={c.closed} ht={c.closedHt} dc={c.closedDc} />
                  <Num value={c.noShows} />
                  <Num value={compactUsd(c.upfront)} />
                </div>
              </RowLink>
              {isSelected ? <CloserDrill calls={drill} closerName={c.closerName} /> : null}
            </div>
          )
        })
      )}
    </div>
  )
}

// "Showed" cell with an inline →show% (calls → showed rate) on the
// left edge. Mirrors the per-rep ConnectedCell in appointment-setting.
function ShowedCell({ calls, showed }: { calls: number; showed: number }) {
  const pct = calls > 0 ? Math.round((showed / calls) * 100) : null
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        justifyContent: 'flex-end',
        gap: 6,
      }}
      title={pct === null ? 'No scheduled calls' : `${showed} of ${calls} showed (${pct}%)`}
    >
      {pct !== null ? (
        <span
          className="geg-mono"
          style={{ fontSize: 9.5, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)' }}
        >
          →{pct}%
        </span>
      ) : null}
      <Num value={showed} />
    </span>
  )
}

// "Closes" cell with an inline →close% (showed → closed rate) on the
// left, and a small HT/DC split on the right of the count.
function ClosesCell({
  showed,
  closed,
  ht,
  dc,
}: {
  showed: number
  closed: number
  ht: number
  dc: number
}) {
  const pct = showed > 0 ? Math.round((closed / showed) * 100) : null
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        justifyContent: 'flex-end',
        gap: 6,
      }}
      title={
        pct === null
          ? 'No showed calls'
          : `${closed} of ${showed} showed closed (${pct}%) · ${ht} HT / ${dc} DC`
      }
    >
      {pct !== null ? (
        <span
          className="geg-mono"
          style={{ fontSize: 9.5, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)' }}
        >
          →{pct}%
        </span>
      ) : null}
      <Num value={closed} />
      <span
        className="geg-mono"
        style={{ fontSize: 9, color: 'var(--color-geg-text-faint)', letterSpacing: '0.04em' }}
      >
        {ht}HT / {dc}DC
      </span>
    </span>
  )
}

function RowLink({
  baseParams, closerName, isSelected, children,
}: {
  baseParams: URLSearchParams
  closerName: string
  isSelected: boolean
  children: React.ReactNode
}) {
  const sp = new URLSearchParams(baseParams)
  if (isSelected) sp.delete('closer')
  else sp.set('closer', closerName)
  const qs = sp.toString()
  const href = qs ? `?${qs}` : '?'
  return (
    <Link href={href} scroll={false} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
      {children}
    </Link>
  )
}

// Drill list for a single closer — one row per scheduled Calendly
// event. Form-derived fields render "missing" until the closer submits
// the EOC form and our match (name + date ±48h) connects them.
const DRILL_COLS = '1.4fr 1fr 1fr 0.7fr 0.7fr 0.9fr 0.9fr'

function CloserDrill({ calls, closerName }: { calls: CloserScheduledDrillRow[]; closerName: string }) {
  return (
    <div style={{ margin: '0 -12px 10px', padding: '14px 16px 16px', background: 'var(--color-geg-bg)', border: '1px solid var(--color-geg-border)', borderRadius: 8 }}>
      <div
        className="geg-mono"
        style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 10 }}
      >
        {closerName} · scheduled calls · {calls.length} {calls.length === 1 ? 'row' : 'rows'} (most recent first)
      </div>
      {calls.length === 0 ? (
        <div className="geg-serif" style={{ padding: '14px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 14 }}>
          No scheduled calls in this range for this closer.
        </div>
      ) : (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: DRILL_COLS, gap: 10, padding: '6px 0 8px', borderBottom: '1px solid var(--color-geg-border)' }}>
            <ColH label="Prospect" align="left" />
            <ColH label="Scheduled (ET)" align="left" />
            <ColH label="Call type" align="left" />
            <ColH label="Showed" align="left" />
            <ColH label="Closed" align="left" />
            <ColH label="Upfront" />
            <ColH label="Plan" align="left" />
          </div>
          {calls.map((c) => (
            <div
              key={c.eventUri}
              style={{ display: 'grid', gridTemplateColumns: DRILL_COLS, gap: 10, padding: '9px 0', borderBottom: '1px dashed var(--color-geg-border)', alignItems: 'center' }}
            >
              <Cell text={c.prospectName ?? '—'} />
              <Cell text={formatEtTimestamp(c.scheduledTime)} mono />
              <Cell text={callTypeLabel(c.callType)} mono />
              <YesNoCell value={c.showed} />
              <YesNoCell value={c.closed === null ? null : c.closed === 'yes' ? 'yes' : 'no'} />
              <NumStr value={c.upfront == null ? <MissingTag /> : compactUsd(c.upfront)} />
              <Cell text={c.contractPlan ?? ''} mono missing={!c.contractPlan} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function callTypeLabel(t: CloserScheduledDrillRow['callType']): string {
  if (t === 'direct') return 'AI Strategy Call'
  if (t === 'setter') return 'Partnership (setter)'
  if (t === 'rebook') return 'Sync (rebook)'
  return t
}

// Showed / closed cell — green Yes, red No, faint DQ, italic muted
// "missing" when the form hasn't been submitted yet.
function YesNoCell({ value }: { value: 'yes' | 'no' | 'dq' | null }) {
  if (value === null) return <MissingTag />
  const text = value === 'yes' ? 'Yes' : value === 'no' ? 'No' : 'DQ'
  const color =
    value === 'yes'
      ? 'var(--color-geg-pos)'
      : value === 'no'
        ? 'var(--color-geg-neg)'
        : 'var(--color-geg-text-faint)'
  return (
    <span className="geg-mono" style={{ fontSize: 11, color, letterSpacing: '0.04em' }}>
      {text}
    </span>
  )
}

function MissingTag() {
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 10,
        fontStyle: 'italic',
        color: 'var(--color-geg-text-faint)',
        letterSpacing: '0.04em',
      }}
      title="No EOC form submitted yet — value will populate once the closer files the form."
    >
      missing
    </span>
  )
}

// ---------------------------------------------------------------------------
// Section 3 — Cash
// ---------------------------------------------------------------------------

function CashSection({ money }: { money: ClosingMoney }) {
  return (
    <SectionBox
      eyebrow="CASH"
      title="Upfront, contract value, AOV — from the closer form."
      action={
        <Link
          href="/sales-dashboard/revenue"
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-faint)',
            textDecoration: 'none',
          }}
        >
          full revenue view →
        </Link>
      }
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
        <MoneyTile label="Total upfront collected" value={money.upfrontCollected} provisional={money.provisional} />
        <MoneyTile label="Total contract value" value={money.totalContractValue} />
        <MoneyTile label="AOV (contract / closed)" value={money.aov} />
      </div>
      <div className="geg-mono" style={{ marginTop: 10, fontSize: 10, letterSpacing: '0.12em', color: 'var(--color-geg-text-faint)', lineHeight: 1.6 }}>
        Upfront sourced from <code>{money.upfrontFieldUsed}</code> · provisional until canonical cash field is confirmed (sibling field <code>amount_paid_today_number</code> exists in the mirror).
      </div>
    </SectionBox>
  )
}

function MoneyTile({ label, value, provisional }: { label: string; value: number | null; provisional?: boolean }) {
  const display = value == null ? '—' : compactUsd(value)
  return (
    <div style={{ padding: '14px 16px 12px', background: 'var(--color-geg-bg)', border: '1px solid var(--color-geg-border)', borderRadius: 8 }}>
      <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 6 }}>
        {label}{provisional ? ' · provisional' : ''}
      </div>
      <div className="geg-numeric-serif" style={{ fontSize: 22, lineHeight: '26px', letterSpacing: '-0.02em', color: 'var(--color-geg-text)' }}>
        {display}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

function SectionBox({
  eyebrow, title, action, children,
}: {
  eyebrow: string
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section
      style={{
        padding: '22px 26px 24px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', marginBottom: 16, gap: 12 }}>
        <div>
          <div
            className="geg-mono"
            style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}
          >
            {eyebrow}
          </div>
          <div
            className="geg-serif"
            style={{ marginTop: 5, fontSize: 18, color: 'var(--color-geg-text)', letterSpacing: '-0.01em' }}
          >
            {title}
          </div>
        </div>
        {action ?? null}
      </div>
      {children}
    </section>
  )
}

function Num({ value, accent }: { value: number | string; accent?: boolean }) {
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

function NumStr({ value }: { value: React.ReactNode }) {
  return (
    <span className="geg-numeric-serif" style={{ fontSize: 13, color: 'var(--color-geg-text-2)', letterSpacing: '-0.01em', textAlign: 'right' }}>
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

function Cell({ text, mono, missing }: { text: string; mono?: boolean; missing?: boolean }) {
  if (missing || text === '') {
    return <MissingTag />
  }
  const isDash = text === '—'
  return (
    <span
      className={mono ? 'geg-mono' : 'geg-serif'}
      style={{
        fontSize: mono ? 11 : 13,
        color: isDash ? 'var(--color-geg-text-faint)' : 'var(--color-geg-text-2)',
        letterSpacing: mono ? '0.04em' : '-0.002em',
        fontStyle: isDash ? 'italic' : 'normal',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {text}
    </span>
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

