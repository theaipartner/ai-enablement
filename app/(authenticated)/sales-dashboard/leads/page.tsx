import { HeaderBand } from '@/components/gregory/header-band'
import { getLeadsForRange, type LeadRow, type Qualification } from '@/lib/db/leads'
import { resolveFunnelRange } from '@/lib/db/funnel-stages'
import { parseEtDateString, todayEtDate } from '@/lib/db/funnel-window'
import { PersonPill } from '../header-pills'
import { DateRangePicker } from '../funnel/landing-pages/date-range-picker'

// Sales Dashboard — Leads (view-only roster).
//
// Every lead that opted in during the selected timeframe — new opt-ins
// AND re-opt-ins (existing Close account, opted in again) — with the
// same per-lead metrics the appointment-setting dial list shows, plus
// three roster columns: opt-in type, qualified (Typeform budget), and
// booked (Calendly strategy call). Read-only; the dial list on the
// Appointment Setting page is the working surface. Shares the cohort
// via getLeadsForRange → getSpeedToLeadCohort so the two can't drift.

export const dynamic = 'force-dynamic'

const COLS = '1.6fr 0.9fr 1.1fr 1fr 0.7fr 1.2fr 0.9fr 0.8fr 1fr'

export default async function SalesDashboardLeadsPage({
  searchParams,
}: {
  searchParams?: { start?: string | string[]; end?: string | string[] }
}) {
  const start = parseEtDateString(searchParams?.start)
  const end = parseEtDateString(searchParams?.end)
  const range = resolveFunnelRange(start ?? undefined, end ?? undefined)
  const todayEt = todayEtDate()

  const result = await getLeadsForRange(range)

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · LEADS"
        title="Leads."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <DateRangePicker
              startEtDate={range.startEtDate}
              endEtDate={range.endEtDate}
              todayEt={todayEt}
            />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />

      <SummaryStrip result={result} />

      <div style={{ marginTop: 22 }}>
        <HeaderRow />
        <div style={{ marginTop: 4 }}>
          {result.rows.length === 0 ? (
            <EmptyState />
          ) : (
            result.rows.map((r) => <LeadRowView key={r.leadId} r={r} />)
          )}
        </div>
      </div>
    </div>
  )
}

function SummaryStrip({ result }: { result: Awaited<ReturnType<typeof getLeadsForRange>> }) {
  const items: Array<{ label: string; value: number; accent?: boolean }> = [
    { label: 'Leads', value: result.total, accent: true },
    { label: 'New opt-ins', value: result.newCount },
    { label: 'Re-opt-ins', value: result.reoptinCount },
    { label: 'Qualified', value: result.qualifiedCount },
    { label: 'Booked', value: result.bookedCount },
  ]
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${items.length}, minmax(0, 1fr))`,
        gap: 12,
        marginTop: 24,
      }}
    >
      {items.map((it) => (
        <div
          key={it.label}
          style={{
            padding: '14px 16px',
            background: 'var(--color-geg-bg-elev)',
            border: '1px solid var(--color-geg-border)',
            borderRadius: 8,
          }}
        >
          <div
            className="geg-mono"
            style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}
          >
            {it.label}
          </div>
          <div
            className="geg-numeric-serif"
            style={{ marginTop: 6, fontSize: 28, letterSpacing: '-0.02em', color: it.accent ? 'var(--color-geg-accent)' : 'var(--color-geg-text)' }}
          >
            {it.value.toLocaleString('en-US')}
          </div>
        </div>
      ))}
    </div>
  )
}

const HEADERS = ['Prospect', 'Opt-in', 'Opted in (ET)', 'Qualified', 'Booked', 'Time to call', 'Connected', 'Intensity', 'Caller']

function HeaderRow() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: COLS,
        gap: 10,
        padding: '0 0 8px',
        borderBottom: '1px solid var(--color-geg-border)',
      }}
    >
      {HEADERS.map((h) => (
        <span
          key={h}
          className="geg-mono"
          style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}
        >
          {h}
        </span>
      ))}
    </div>
  )
}

function LeadRowView({ r }: { r: LeadRow }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: COLS,
        gap: 10,
        padding: '8px 0',
        borderBottom: '1px dashed var(--color-geg-border)',
        alignItems: 'center',
      }}
    >
      <span
        className="geg-serif"
        style={{ fontSize: 13, color: 'var(--color-geg-text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={r.leadId}
      >
        {r.prospectName ?? <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>(no name)</span>}
      </span>
      <span>
        <OptInBadge type={r.optInType} />
      </span>
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>
        {formatEt(r.optInAt)}
      </span>
      <span>
        <QualifiedTag q={r.qualified} />
      </span>
      <span
        className="geg-mono"
        style={{ fontSize: 11, letterSpacing: '0.04em', color: r.booked ? 'var(--color-geg-pos)' : 'var(--color-geg-text-faint)' }}
      >
        {r.booked ? 'Yes' : 'No'}
      </span>
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>
        {r.speedSec !== null ? (
          <>
            {formatDuration(r.speedSec)}
            {/* (yes/no) = connected on either of the first two dials —
                same signal as the appointment-setting dial list. */}
            <span style={{ color: 'var(--color-geg-text-faint)', marginLeft: 4 }}>
              ({r.firstTwoDialsConnected ? 'yes' : 'no'})
            </span>
          </>
        ) : (
          <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>not yet called</span>
        )}
      </span>
      <span
        className="geg-mono"
        style={{
          fontSize: 11,
          letterSpacing: '0.04em',
          color: r.anyCallConnected ? 'var(--color-geg-pos)' : r.firstCallAt ? 'var(--color-geg-neg)' : 'var(--color-geg-text-faint)',
        }}
      >
        {r.firstCallAt ? (r.anyCallConnected ? 'Yes' : 'No') : '—'}
      </span>
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>
        {r.intensity}
      </span>
      <span
        className="geg-serif"
        style={{ fontSize: 12, color: 'var(--color-geg-text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {r.callerName ?? '—'}
      </span>
    </div>
  )
}

function OptInBadge({ type }: { type: LeadRow['optInType'] }) {
  const reoptin = type === 'reoptin'
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 8.5,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: reoptin ? 'var(--color-geg-accent)' : 'var(--color-geg-text-3)',
        border: `1px solid ${reoptin ? 'var(--color-geg-accent)' : 'var(--color-geg-border)'}`,
        borderRadius: 4,
        padding: '1px 5px',
      }}
    >
      {reoptin ? 're-opt-in' : 'new'}
    </span>
  )
}

function QualifiedTag({ q }: { q: Qualification }) {
  const text = q === 'qualified' ? 'Qualified' : q === 'non-qualified' ? 'Not qualified' : '—'
  const color =
    q === 'qualified' ? 'var(--color-geg-pos)' : q === 'non-qualified' ? 'var(--color-geg-text-3)' : 'var(--color-geg-text-faint)'
  return (
    <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.03em', color }} title={q === 'unknown' ? 'No matching Typeform response' : undefined}>
      {text}
    </span>
  )
}

function EmptyState() {
  return (
    <div
      className="geg-mono"
      style={{ padding: '40px 0', textAlign: 'center', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}
    >
      No leads opted in for this range.
    </div>
  )
}

// --- formatters (ET date, mm/ss duration) — local, view-only ---

function formatEt(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso))
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ${Math.round(sec % 60)}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}
