import { HeaderBand } from '@/components/gregory/header-band'
import {
  getCallActivityMetrics,
  getCallActivityForUser,
  type CallActivityRepRow,
  type CallActivityDrillRow,
} from '@/lib/db/funnel-appointment-setting'
import {
  getClosingActivity,
  getClosingScheduledList,
  CLOSING_FLOOR_ET,
  type CalendlyBookingActivity,
  type CloserScheduledDrillRow,
  type ClosingMoney,
} from '@/lib/db/funnel-closing'
import {
  getDigitalCollegeActivity,
  type DcDrillRow,
} from '@/lib/db/funnel-digital-college'
import {
  parseEtDateString,
  todayEtDate,
  dateRangeFromExplicit,
} from '@/lib/db/funnel-window'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'
import { PerRepCallActivityTable } from '../funnel/appointment-setting/_components/sortable-tables'
import { CloserScheduledTables } from '../funnel/closed/_components/closer-tables'
import { DigitalCollegeTables } from './_components/digital-college-tables'
import { DateRangePicker } from '../funnel/landing-pages/date-range-picker'
import { PersonPill } from '../header-pills'
import { PersistPageState } from '@/components/sales/persist-page-state'

// Sales Dashboard — People.
//
// Consolidates the per-rep views that previously lived on the Appointment
// Setting + Closing funnel pages, under one date picker:
//   1. Call Activity — per-rep volume / outcomes / speed (setters + closers),
//      click-to-drill into a rep's calls (?rep=)
//   2. Calendly bookings — closer bookings booked in range
//   3. Per-closer scheduled calls — leaderboard with click-to-drill (?closer=)
//   4. Cash — upfront / contract value / AOV from the closer form
//
// The Appointment Setting + Closing pages still exist (and own the FMR chart
// + speed boxes, which moved to /leads); this page is the per-rep home that
// will replace their per-rep sections. Layout is deliberately one-column —
// "organize later" per Drake. Components are imported from those pages'
// _components folders for now; relocate to components/sales/ when the old
// pages are retired.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Default = TODAY (single-day window), mirroring the Closing page; broaden
// via the picker. Clamp to the earliest floor across the two sources
// (Closing = May 22; Call Activity clamps itself to May 24 internally, so
// pre-24 days simply read empty for that section).
function resolvePeopleRange(start: string | null, end: string | null) {
  const today = todayEtDate()
  const s = start ?? today
  const e = end ?? today
  const sClamped = s < CLOSING_FLOOR_ET ? CLOSING_FLOOR_ET : s
  return dateRangeFromExplicit(sClamped, e)
}

export default async function SalesPeoplePage({
  searchParams,
}: {
  searchParams?: {
    start?: string | string[]
    end?: string | string[]
    rep?: string | string[]
    closer?: string | string[]
    dccloser?: string | string[]
  }
}) {
  const start = parseEtDateString(searchParams?.start)
  const end = parseEtDateString(searchParams?.end)
  const range = resolvePeopleRange(start, end)
  const todayEt = todayEtDate()

  const selectedRepRaw = Array.isArray(searchParams?.rep) ? searchParams?.rep[0] : searchParams?.rep
  const selectedRep = typeof selectedRepRaw === 'string' && selectedRepRaw.startsWith('user_') ? selectedRepRaw : null
  const selectedCloserRaw = Array.isArray(searchParams?.closer) ? searchParams?.closer[0] : searchParams?.closer
  const selectedCloser = typeof selectedCloserRaw === 'string' && selectedCloserRaw.length > 0 ? selectedCloserRaw : null
  const selectedDcCloserRaw = Array.isArray(searchParams?.dccloser) ? searchParams?.dccloser[0] : searchParams?.dccloser
  const selectedDcCloser = typeof selectedDcCloserRaw === 'string' && selectedDcCloserRaw.length > 0 ? selectedDcCloserRaw : null

  const [activity, repDrill, scheduled, closingData, digitalCollege, access] = await Promise.all([
    getCallActivityMetrics(range),
    selectedRep ? getCallActivityForUser(range, selectedRep) : Promise.resolve([] as CallActivityDrillRow[]),
    getClosingScheduledList(range),
    getClosingActivity(range),
    getDigitalCollegeActivity(range),
    getCurrentUserAccessTier(),
  ])
  const canDelete = access?.tier === 'creator'
  const closerDrill = selectedCloser ? scheduled.drillByCloser[selectedCloser] ?? [] : ([] as CloserScheduledDrillRow[])
  const dcDrill = selectedDcCloser ? digitalCollege.drillByCloser[selectedDcCloser] ?? [] : ([] as DcDrillRow[])

  // Closer-link toggles preserve the active range + the rep drill so
  // switching a closer doesn't drop the Call Activity expansion.
  const baseParams = new URLSearchParams()
  if (start) baseParams.set('start', start)
  if (end) baseParams.set('end', end)
  if (selectedRep) baseParams.set('rep', selectedRep)
  // Carry the other table's selection so toggling a closer/DC-closer doesn't
  // collapse the other expanded drill.
  if (selectedCloser) baseParams.set('closer', selectedCloser)
  if (selectedDcCloser) baseParams.set('dccloser', selectedDcCloser)

  return (
    <div>
      <PersistPageState window />
      <HeaderBand
        eyebrow="SALES · TALENT"
        title="Talent."
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
        <SectionBox eyebrow="CALL ACTIVITY" title="Per-rep call volume, outcomes, and speed — click a rep to drill, a column to sort.">
          <CallActivityStacked
            setters={activity.setters}
            closers={activity.closers}
            settersAggregate={activity.settersAggregate}
            closersAggregate={activity.closersAggregate}
            totalFormsInWindow={activity.totalFormsInWindow}
            selectedRep={selectedRep}
            drill={repDrill}
            canDelete={canDelete}
          />
        </SectionBox>

        <CalendlySection bookings={closingData.bookings} />

        <SectionBox eyebrow="PER CLOSER" title="Scheduled calls in range · click a closer to drill, click a column header to sort.">
          <CloserScheduledTables
            closers={scheduled.closers}
            aggregate={scheduled.aggregate}
            selectedCloser={selectedCloser}
            drill={closerDrill}
            baseParams={baseParams.toString()}
            canDelete={canDelete}
          />
        </SectionBox>

        <SectionBox eyebrow="DIGITAL COLLEGE" title="Low-ticket closer (Robby) · dials, meetings, shows, plans, closes — click to drill, a column to sort.">
          <DigitalCollegeTables
            closers={digitalCollege.closers}
            aggregate={digitalCollege.aggregate}
            selectedCloser={selectedDcCloser}
            drill={dcDrill}
            baseParams={baseParams.toString()}
          />
          <div className="geg-mono" style={{ marginTop: 12, fontSize: 10, letterSpacing: '0.08em', color: 'var(--color-geg-text-faint)', lineHeight: 1.5 }}>
            Dials from <code>close_calls</code> (Robby&apos;s outbound). Meetings = his <code>airtable_digital_college_sales</code> forms unioned with his Calendly bookings; a booked call with no form yet is a meeting but not a show. Show = a form was filed (the DC form has no no-show field). Closes = <code>Closed? = Yes</code>; plans (Base44 / Wix × Monthly / Yearly) come from the form&apos;s plan multi-select. Aman&apos;s downsell DC closes live on the closer report, not here.
          </div>
        </SectionBox>

        <CashSection money={closingData.money} />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Call Activity — merged per-rep table (volume + outcomes + speed), stacked
// setters then closers. Ported from the appointment-setting page.
// ---------------------------------------------------------------------------

function CallActivityStacked({
  setters,
  closers,
  settersAggregate,
  closersAggregate,
  totalFormsInWindow,
  selectedRep,
  drill,
  canDelete,
}: {
  setters: CallActivityRepRow[]
  closers: CallActivityRepRow[]
  settersAggregate: CallActivityRepRow
  closersAggregate: CallActivityRepRow
  totalFormsInWindow: number
  selectedRep: string | null
  drill: CallActivityDrillRow[]
  canDelete?: boolean
}) {
  return (
    <div>
      <div style={{ display: 'grid', gap: 14 }}>
        <PerRepCallActivityTable
          label="Triage (Setter)"
          variant="setter"
          aggregate={settersAggregate}
          rows={setters}
          selectedRep={selectedRep}
          drill={drill}
          canDelete={canDelete}
        />
        <PerRepCallActivityTable
          label="Confirmation Calls (Closer)"
          variant="closer"
          aggregate={closersAggregate}
          rows={closers}
          selectedRep={selectedRep}
          drill={drill}
          canDelete={canDelete}
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
        Volume + calls over 90s from <code>close_calls</code>. Outcomes come
        from the triage form <code>Call Status</code> field, routed by{' '}
        <code>Form Type</code> — Setter Triage Form (HT Book / DC Book / Setter
        pipeline / DQ) into the setter list, Closer Triage Form (Confirmed /
        Rescheduled / Downsold / Setter pipeline / DQ) into the closer
        list. Forms predating the 2026-05-26 redesign (no Form Type) show as NA
        in the drill. Speed-to-lead = avg of the earliest call each rep made to
        each lead, minus lead creation (24h cap on outliers).
        {totalFormsInWindow > 0
          ? ` ${totalFormsInWindow} form${totalFormsInWindow === 1 ? '' : 's'} filled in this range — adoption is still ramping.`
          : ' No Airtable form rows yet in this range.'}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Calendly bookings + Cash — ported from the Closing page.
// ---------------------------------------------------------------------------

function CalendlySection({ bookings }: { bookings: CalendlyBookingActivity }) {
  return (
    <SectionBox eyebrow="CALENDLY BOOKINGS" title="Closer bookings booked in range (direct + setter, excl. hidden).">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>
        <Tile label="Total bookings" value={bookings.total} />
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

function CashSection({ money }: { money: ClosingMoney }) {
  return (
    <SectionBox
      eyebrow="CASH"
      title="Sales, upfront cash, contract value, AOV — from the closer form."
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <CountTile label="Sales (HT closes)" value={money.closes} />
        <MoneyTile label="Total upfront collected" value={money.upfrontCollected} />
        <MoneyTile label="Total contract value" value={money.totalContractValue} />
        <MoneyTile label="AOV (contract / closed)" value={money.aov} />
      </div>
      <div className="geg-mono" style={{ marginTop: 10, fontSize: 10, letterSpacing: '0.12em', color: 'var(--color-geg-text-faint)', lineHeight: 1.6 }}>
        High-ticket only — Digital College sales + cash are excluded here (see the DC tally on the funnel page). Sales + upfront from the closer form&apos;s Call Outcome / <code>amount_paid_today_number</code> (new form) and legacy <code>Closed?</code> / <code>amount_paid_today_currency</code> (old form), including instant-book meetings filed with no Calendly booking.
      </div>
    </SectionBox>
  )
}

function CountTile({ label, value, subtitle }: { label: string; value: number; subtitle?: string }) {
  return (
    <div style={{ padding: '14px 16px 12px', background: 'var(--color-geg-bg)', border: '1px solid var(--color-geg-border)', borderRadius: 8 }}>
      <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 6 }}>
        {label}
      </div>
      <div className="geg-numeric-serif" style={{ fontSize: 22, lineHeight: '26px', letterSpacing: '-0.02em', color: 'var(--color-geg-text)' }}>
        {value}
      </div>
      {subtitle ? (
        <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)', marginTop: 3 }}>
          {subtitle}
        </div>
      ) : null}
    </div>
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
// Shared section wrapper (ported from the Closing page).
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
