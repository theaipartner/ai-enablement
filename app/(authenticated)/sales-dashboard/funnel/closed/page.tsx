import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import {
  getClosingActivity,
  getClosingScheduledList,
  CLOSING_FLOOR_ET,
  type CalendlyBookingActivity,
  type CloserScheduledDrillRow,
  type ClosingMoney,
} from '@/lib/db/funnel-closing'
import { CloserScheduledTables } from './_components/closer-tables'
import {
  parseEtDateString,
  todayEtDate,
  dateRangeFromExplicit,
} from '@/lib/db/funnel-window'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import { PersonPill } from '../../header-pills'
import { DateRangePicker } from '../landing-pages/date-range-picker'
import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'

// Funnel · Closing — three sections:
//   1. Calendly bookings · AI Partner Strategy Call (new / resched / cancel)
//   2. Per-closer leaderboard with click-to-drill (mirrors the setter
//      page's pattern but with closing-side metrics)
//   3. Cash produced (upfront / contract / AOV) — links out to Revenue

export const dynamic = 'force-dynamic'
export const maxDuration = 60

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

  // Creator-only "hide test booking" affordance on the per-closer drill.
  // getCurrentUserAccessTier is React.cache()d (layout already called it).
  const access = await getCurrentUserAccessTier()
  const canDelete = access?.tier === 'creator'

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
        <SectionBox
          eyebrow="PER CLOSER"
          title="Scheduled calls in range · click a closer to drill, click a column header to sort."
        >
          <CloserScheduledTables
            closers={scheduled.closers}
            aggregate={scheduled.aggregate}
            selectedCloser={selectedCloser}
            drill={drill}
            baseParams={baseParams.toString()}
            canDelete={canDelete}
          />
        </SectionBox>
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

