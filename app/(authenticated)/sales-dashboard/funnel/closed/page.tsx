import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import {
  getClosingActivity,
  getCloserCallsForCloser,
  CLOSING_FLOOR_ET,
  type CalendlyBookingActivity,
  type CloserLeaderboardRow,
  type CloserCallDrillRow,
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

// Closing default end = TODAY (not yesterday). The closer form is
// webhook-driven, so today's entries land in near-real-time; clamping
// to yesterday would hide rows whose call already happened today.
// The main Pulse page still defaults to yesterday because Meta lands
// the morning after.
function resolveClosingRange(start: string | null, end: string | null) {
  const today = todayEtDate()
  const s = start ?? CLOSING_FLOOR_ET
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

  const [data, drill] = await Promise.all([
    getClosingActivity(range),
    selectedCloser ? getCloserCallsForCloser(range, selectedCloser) : Promise.resolve([] as CloserCallDrillRow[]),
  ])

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
        <CloserLeaderboardSection
          closers={data.closers}
          aggregate={data.aggregate}
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
// Section 2 — Per-closer leaderboard + click-to-drill
// ---------------------------------------------------------------------------

function CloserLeaderboardSection({
  closers,
  aggregate,
  selectedCloser,
  drill,
  baseParams,
}: {
  closers: CloserLeaderboardRow[]
  aggregate: CloserLeaderboardRow
  selectedCloser: string | null
  drill: CloserCallDrillRow[]
  baseParams: URLSearchParams
}) {
  return (
    <SectionBox eyebrow="PER CLOSER" title="Calls logged, showed, closed, money — click a row to drill.">
      <LeaderboardTable
        closers={closers}
        aggregate={aggregate}
        selectedCloser={selectedCloser}
        drill={drill}
        baseParams={baseParams}
      />
    </SectionBox>
  )
}

function LeaderboardTable({
  closers,
  aggregate,
  selectedCloser,
  drill,
  baseParams,
}: {
  closers: CloserLeaderboardRow[]
  aggregate: CloserLeaderboardRow
  selectedCloser: string | null
  drill: CloserCallDrillRow[]
  baseParams: URLSearchParams
}) {
  const COLS = '1.6fr 0.7fr 0.7fr 0.7fr 0.8fr 0.9fr 0.9fr'
  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '6px 0 10px', borderBottom: '1px solid var(--color-geg-border)' }}>
        <ColH label="Closer" align="left" />
        <ColH label="Calls" />
        <ColH label="Showed" />
        <ColH label="Closed" />
        <ColH label="Close rate" />
        <ColH label="Upfront" />
        <ColH label="Contract" />
      </div>

      {/* Aggregate row (italic, all closers) */}
      <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '12px 0', borderBottom: '1px solid var(--color-geg-border)', alignItems: 'center' }}>
        <span className="geg-serif" style={{ fontSize: 14, fontStyle: 'italic', color: 'var(--color-geg-text-2)', letterSpacing: '-0.002em' }}>
          All closers
        </span>
        <Num value={aggregate.callsLogged} accent />
        <Num value={aggregate.showed} />
        <Num value={aggregate.closed} />
        <Num value={renderRate(aggregate.closeRate)} />
        <Num value={compactUsd(aggregate.totalUpfront)} />
        <Num value={compactUsd(aggregate.totalContract)} />
      </div>

      {/* Per-closer rows */}
      {closers.length === 0 ? (
        <div className="geg-serif" style={{ padding: '20px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 14 }}>
          No closer-form rows in this range.
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
                  <Num value={c.callsLogged} accent />
                  <Num value={c.showed} />
                  <Num value={c.closed} />
                  <Num value={renderRate(c.closeRate)} />
                  <Num value={compactUsd(c.totalUpfront)} />
                  <Num value={compactUsd(c.totalContract)} />
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

function CloserDrill({ calls, closerName }: { calls: CloserCallDrillRow[]; closerName: string }) {
  return (
    <div style={{ margin: '0 -12px 10px', padding: '14px 16px 16px', background: 'var(--color-geg-bg)', border: '1px solid var(--color-geg-border)', borderRadius: 8 }}>
      <div
        className="geg-mono"
        style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 10 }}
      >
        {closerName} · per-call detail · {calls.length} {calls.length === 1 ? 'row' : 'rows'} (most recent first)
      </div>
      {calls.length === 0 ? (
        <div className="geg-serif" style={{ padding: '14px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 14 }}>
          No calls in this range for this closer.
        </div>
      ) : (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 0.9fr 0.7fr 0.7fr 0.9fr 0.9fr 0.9fr', gap: 10, padding: '6px 0 8px', borderBottom: '1px solid var(--color-geg-border)' }}>
            <ColH label="Prospect" align="left" />
            <ColH label="Call time (ET)" align="left" />
            <ColH label="Call type" align="left" />
            <ColH label="Showed" align="left" />
            <ColH label="Closed" align="left" />
            <ColH label="Upfront" />
            <ColH label="Contract" />
            <ColH label="Plan" align="left" />
          </div>
          {calls.map((c) => (
            <div
              key={c.recordId}
              style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 0.9fr 0.7fr 0.7fr 0.9fr 0.9fr 0.9fr', gap: 10, padding: '9px 0', borderBottom: '1px dashed var(--color-geg-border)', alignItems: 'center' }}
            >
              <Cell text={c.prospectName ?? '—'} />
              <Cell text={c.dateTimeOfCall ? formatEtTimestamp(c.dateTimeOfCall) : '—'} mono />
              <Cell text={c.callType ?? '—'} mono />
              <Cell text={c.showed ?? '—'} mono />
              <Cell text={c.closed ?? '—'} mono />
              <NumStr value={c.amountUpfront == null ? '—' : compactUsd(c.amountUpfront)} />
              <NumStr value={c.contractValue == null ? '—' : compactUsd(c.contractValue)} />
              <Cell text={c.paymentPlan ?? '—'} mono />
            </div>
          ))}
        </div>
      )}
    </div>
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

function NumStr({ value }: { value: string }) {
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

function Cell({ text, mono }: { text: string; mono?: boolean }) {
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

function renderRate(r: number | null): string {
  if (r == null) return '—'
  return `${(r * 100).toFixed(1)}%`
}
