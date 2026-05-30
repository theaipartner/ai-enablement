import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import { getLeadsForRange, type LeadRow, type Qualification, type BookingType } from '@/lib/db/leads'
import { resolveFunnelRange } from '@/lib/db/funnel-stages'
import { parseEtDateString, todayEtDate } from '@/lib/db/funnel-window'
import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'
import { searchLeads, type LeadSearchResult } from '@/lib/db/lead-search'
import { LeadSearch } from './lead-search'
import { PersonPill } from '../header-pills'
import { DateRangePicker } from '../funnel/landing-pages/date-range-picker'
import { DeleteLeadButton } from './delete-lead-button'

// Sales Dashboard — Leads (top-of-funnel + roster).
//
// Funnel header: Leads (toggle all ↔ unique/new-only) → Qualified vs
// Unqualified → Direct bookings. Then the per-lead roster table. A
// lead = a Close lead that opted in during the window (new OR re-opt-in);
// the cohort already drops creator-soft-hidden (fake) leads. Creators get
// an × to hide a fake lead. Shares the cohort via getLeadsForRange →
// getSpeedToLeadCohort so the Leads page + dial list can't drift.

export const dynamic = 'force-dynamic'

type View = 'all' | 'unique'

export default async function SalesDashboardLeadsPage({
  searchParams,
}: {
  searchParams?: { start?: string | string[]; end?: string | string[]; view?: string | string[]; q?: string | string[] }
}) {
  const q = (Array.isArray(searchParams?.q) ? searchParams?.q[0] : searchParams?.q) ?? ''
  if (q.trim().length >= 2) {
    const results = await searchLeads(q)
    return (
      <div>
        <HeaderBand eyebrow="SALES · LEADS" title="Leads." />
        <LeadSearch initial={q} />
        <SearchResults results={results} query={q.trim()} />
      </div>
    )
  }

  const start = parseEtDateString(searchParams?.start)
  const end = parseEtDateString(searchParams?.end)
  const range = resolveFunnelRange(start ?? undefined, end ?? undefined)
  const todayEt = todayEtDate()
  const view: View = pickView(searchParams?.view)

  const [allRows, access] = await Promise.all([
    getLeadsForRange(range),
    getCurrentUserAccessTier(),
  ])
  const canDelete = access?.tier === 'creator'

  // Unique = new opt-ins only (re-opt-ins removed). All = the full cohort.
  const rows = view === 'unique' ? allRows.filter((r) => r.optInType === 'new') : allRows

  const c = {
    leads: rows.length,
    newCount: rows.filter((r) => r.optInType === 'new').length,
    reoptin: rows.filter((r) => r.optInType === 'reoptin').length,
    qualified: rows.filter((r) => r.qualified === 'qualified').length,
    unqualified: rows.filter((r) => r.qualified === 'non-qualified').length,
    unknown: rows.filter((r) => r.qualified === 'unknown').length,
    // Mutually exclusive booking buckets (direct = direct-only, reactivation =
    // both links, setter = partnership-only). Showed/Closed are per-lead.
    direct: rows.filter((r) => r.bookingType === 'direct').length,
    directConfirmed: rows.filter((r) => r.bookingType === 'direct' && r.confirmed).length,
    directShowed: rows.filter((r) => r.bookingType === 'direct' && r.showed).length,
    directClosed: rows.filter((r) => r.bookingType === 'direct' && r.closed).length,
    react: rows.filter((r) => r.bookingType === 'reactivation').length,
    reactShowed: rows.filter((r) => r.bookingType === 'reactivation' && r.showed).length,
    reactClosed: rows.filter((r) => r.bookingType === 'reactivation' && r.closed).length,
    setter: rows.filter((r) => r.bookingType === 'setter').length,
    setterShowed: rows.filter((r) => r.bookingType === 'setter' && r.showed).length,
    setterClosed: rows.filter((r) => r.bookingType === 'setter' && r.closed).length,
  }

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · LEADS"
        title="Leads."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <DateRangePicker startEtDate={range.startEtDate} endEtDate={range.endEtDate} todayEt={todayEt} />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />

      <LeadSearch initial="" />

      <FunnelHeader c={c} view={view} searchParams={searchParams} />

      <BookingFunnels c={c} />

      <div style={{ marginTop: 22 }}>
        <HeaderRow />
        <div style={{ marginTop: 4 }}>
          {rows.length === 0 ? (
            <EmptyState />
          ) : (
            rows.map((r) => <LeadRowView key={r.leadId} r={r} canDelete={canDelete} />)
          )}
        </div>
      </div>
    </div>
  )
}

function pickView(raw: string | string[] | undefined): View {
  const v = Array.isArray(raw) ? raw[0] : raw
  return v === 'unique' ? 'unique' : 'all'
}

// Global lead search results (any lead, not just the window's cohort). Each
// links to the per-lead page.
function SearchResults({ results, query }: { results: LeadSearchResult[]; query: string }) {
  return (
    <div style={{ marginTop: 22 }}>
      <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 8 }}>
        {results.length} {results.length === 1 ? 'match' : 'matches'} for &ldquo;{query}&rdquo;
      </div>
      {results.length === 0 ? (
        <div className="geg-mono" style={{ padding: '28px 0', textAlign: 'center', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
          No leads match.
        </div>
      ) : (
        results.map((r) => (
          <Link
            key={r.leadId}
            href={`/sales-dashboard/leads/${encodeURIComponent(r.leadId)}`}
            style={{ display: 'grid', gridTemplateColumns: '1.6fr 1fr 1fr', gap: 10, padding: '10px 8px', borderBottom: '1px dashed var(--color-geg-border)', textDecoration: 'none', color: 'inherit', alignItems: 'center' }}
          >
            <span className="geg-serif" style={{ fontSize: 14, color: 'var(--color-geg-text)' }}>
              {r.name ?? <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>(no name)</span>}
            </span>
            <span><QualifiedTag q={r.qualified} /></span>
            <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-3)', letterSpacing: '0.04em' }}>
              {r.dateCreated ? formatEt(r.dateCreated) : '—'}
            </span>
          </Link>
        ))
      )}
    </div>
  )
}

// Build a /sales-dashboard/leads href preserving the date range + setting view.
function leadsHref(searchParams: { start?: string | string[]; end?: string | string[] } | undefined, view: View): string {
  const p = new URLSearchParams()
  const s = Array.isArray(searchParams?.start) ? searchParams?.start[0] : searchParams?.start
  const e = Array.isArray(searchParams?.end) ? searchParams?.end[0] : searchParams?.end
  if (s) p.set('start', s)
  if (e) p.set('end', e)
  p.set('view', view)
  return `/sales-dashboard/leads?${p.toString()}`
}

// ---------------------------------------------------------------------------
// Funnel header — three stages: Leads · Qualified⟋Unqualified · Direct bookings
// ---------------------------------------------------------------------------

function FunnelHeader({
  c,
  view,
  searchParams,
}: {
  c: { leads: number; newCount: number; reoptin: number; qualified: number; unqualified: number; unknown: number; direct: number }
  view: View
  searchParams: { start?: string | string[]; end?: string | string[] } | undefined
}) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.3fr', gap: 12, marginTop: 24 }}>
      {/* 1. Leads — value in smaller font; click to toggle all ↔ unique */}
      <Link href={leadsHref(searchParams, view === 'all' ? 'unique' : 'all')} style={{ textDecoration: 'none' }}>
        <Box>
          <BoxLabel>
            Leads
            <ToggleChip active={view} />
          </BoxLabel>
          <div className="geg-numeric-serif" style={{ marginTop: 6, fontSize: 22, letterSpacing: '-0.02em', color: 'var(--color-geg-accent)' }}>
            {c.leads.toLocaleString('en-US')}
          </div>
          <SubLine>
            {view === 'unique'
              ? 'new opt-ins only'
              : `${c.newCount.toLocaleString('en-US')} new · ${c.reoptin.toLocaleString('en-US')} re-opt-in`}
          </SubLine>
        </Box>
      </Link>

      {/* 2. Qualified ⟋ Unqualified — split, equal opposing halves */}
      <Box>
        <BoxLabel>Qualified ⟋ Unqualified</BoxLabel>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1px 1fr', alignItems: 'center', marginTop: 6 }}>
          <SplitHalf value={c.qualified} caption="Qualified" color="var(--color-geg-pos)" align="left" />
          <div style={{ height: 36, background: 'var(--color-geg-border)' }} />
          <SplitHalf value={c.unqualified} caption="Unqualified" color="var(--color-geg-text-3)" align="right" />
        </div>
        {c.unknown > 0 ? <SubLine>+{c.unknown.toLocaleString('en-US')} unknown</SubLine> : null}
      </Box>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Booking funnels — three mutually-exclusive pipelines by the lead's booking
// path. Direct has a Confirmed stage (a self-book gets a confirmation call);
// Reactivation + Setter-led skip Confirmed (a partnership/setter call is
// confirmed by nature). Showed/Closed are per-lead (any New closer form).
// ---------------------------------------------------------------------------

type FunnelCounts = {
  direct: number; directConfirmed: number; directShowed: number; directClosed: number
  react: number; reactShowed: number; reactClosed: number
  setter: number; setterShowed: number; setterClosed: number
}

function BookingFunnels({ c }: { c: FunnelCounts }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginTop: 12 }}>
      <BookingFunnelBox
        label="Direct bookings"
        sublabel="Ai Partner Strategy Call only"
        booked={c.direct}
        confirmed={c.directConfirmed}
        showed={c.directShowed}
        closed={c.directClosed}
      />
      <BookingFunnelBox
        label="Direct reactivations"
        sublabel="Direct, then re-booked via a Partnership link"
        booked={c.react}
        showed={c.reactShowed}
        closed={c.reactClosed}
      />
      <BookingFunnelBox
        label="Setter-led bookings"
        sublabel="Partnership Call w/ only"
        booked={c.setter}
        showed={c.setterShowed}
        closed={c.setterClosed}
      />
    </div>
  )
}

// `confirmed` omitted → a 3-stage funnel (Booked → Showed → Closed).
function BookingFunnelBox({
  label,
  sublabel,
  booked,
  confirmed,
  showed,
  closed,
}: {
  label: string
  sublabel: string
  booked: number | null
  confirmed?: number | null
  showed: number | null
  closed: number | null
}) {
  const stages: Array<{ value: number | null; caption: string; accent?: boolean }> = [
    { value: booked, caption: 'Booked', accent: true },
  ]
  if (confirmed !== undefined) stages.push({ value: confirmed, caption: 'Confirmed' })
  stages.push({ value: showed, caption: 'Showed' }, { value: closed, caption: 'Closed' })

  const cols = stages.map(() => '1fr').join(' auto ')
  const cells: React.ReactNode[] = []
  stages.forEach((s, i) => {
    if (i > 0) cells.push(<Chevron key={`ch${i}`} />)
    cells.push(<FunnelStage key={s.caption} value={s.value} caption={s.caption} accent={s.accent} />)
  })

  return (
    <Box>
      <BoxLabel>{label}</BoxLabel>
      <div style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', gap: 4, marginTop: 12 }}>
        {cells}
      </div>
      <SubLine>{sublabel}</SubLine>
    </Box>
  )
}

function FunnelStage({ value, caption, accent }: { value: number | null; caption: string; accent?: boolean }) {
  const pending = value === null
  return (
    <div style={{ textAlign: 'center', minWidth: 0 }}>
      <div
        className="geg-numeric-serif"
        style={{ fontSize: 22, letterSpacing: '-0.02em', color: pending ? 'var(--color-geg-text-faint)' : accent ? 'var(--color-geg-accent)' : 'var(--color-geg-text)' }}
        title={pending ? 'Not wired yet — pending the booking-confirmation matching flow' : undefined}
      >
        {pending ? '—' : value.toLocaleString('en-US')}
      </div>
      <div className="geg-mono" style={{ fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', marginTop: 2 }}>
        {caption}
      </div>
    </div>
  )
}

function Chevron() {
  return <span className="geg-mono" style={{ fontSize: 12, color: 'var(--color-geg-text-faint)', textAlign: 'center' }}>›</span>
}

function Box({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '14px 16px', background: 'var(--color-geg-bg-elev)', border: '1px solid var(--color-geg-border)', borderRadius: 8, height: '100%' }}>
      {children}
    </div>
  )
}

function BoxLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="geg-mono"
      style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', display: 'flex', alignItems: 'center', gap: 8 }}
    >
      {children}
    </div>
  )
}

function SubLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="geg-mono" style={{ marginTop: 6, fontSize: 9.5, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)' }}>
      {children}
    </div>
  )
}

function ToggleChip({ active }: { active: View }) {
  return (
    <span className="geg-mono" style={{ fontSize: 8.5, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)', border: '1px solid var(--color-geg-border)', borderRadius: 4, padding: '1px 5px' }}>
      {active === 'all' ? 'all · tap for unique' : 'unique · tap for all'}
    </span>
  )
}

function SplitHalf({ value, caption, color, align }: { value: number; caption: string; color: string; align: 'left' | 'right' }) {
  return (
    <div style={{ textAlign: align, padding: align === 'left' ? '0 10px 0 0' : '0 0 0 10px' }}>
      <div className="geg-numeric-serif" style={{ fontSize: 26, letterSpacing: '-0.02em', color }}>
        {value.toLocaleString('en-US')}
      </div>
      <div className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
        {caption}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Roster table
// ---------------------------------------------------------------------------

const COLS = '1.6fr 0.8fr 1.1fr 0.9fr 1fr 1.2fr 0.85fr 0.7fr 1fr 0.35fr'
const HEADERS = ['Prospect', 'Opt-in', 'Opted in (ET)', 'Qualified', 'Booking', 'Time to call', 'Connected', 'Intensity', 'Caller', '']

function HeaderRow() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '0 0 8px', borderBottom: '1px solid var(--color-geg-border)' }}>
      {HEADERS.map((h, i) => (
        <span key={h || `c${i}`} className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}>
          {h}
        </span>
      ))}
    </div>
  )
}

function LeadRowView({ r, canDelete }: { r: LeadRow; canDelete: boolean }) {
  return (
    <Link href={`/sales-dashboard/leads/${encodeURIComponent(r.leadId)}`} style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '8px 0', borderBottom: '1px dashed var(--color-geg-border)', alignItems: 'center', textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}>
      <span className="geg-serif" style={{ fontSize: 13, color: 'var(--color-geg-text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.leadId}>
        {r.prospectName ?? <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>(no name)</span>}
      </span>
      <span><OptInBadge type={r.optInType} /></span>
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>{formatEt(r.optInAt)}</span>
      <span><QualifiedTag q={r.qualified} /></span>
      <span><BookingTag type={r.bookingType} /></span>
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>
        {r.speedSec !== null ? (
          <>
            {formatDuration(r.speedSec)}
            <span style={{ color: 'var(--color-geg-text-faint)', marginLeft: 4 }}>({r.firstTwoDialsConnected ? 'yes' : 'no'})</span>
          </>
        ) : (
          <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>not yet called</span>
        )}
      </span>
      <span
        className="geg-mono"
        style={{ fontSize: 11, letterSpacing: '0.04em', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        title="Yes when ANY outbound call to this lead has connected (≥90s). Bracket = total connected talk time; ×N = how many calls connected."
      >
        <span style={{ color: r.anyCallConnected ? 'var(--color-geg-pos)' : r.firstCallAt ? 'var(--color-geg-neg)' : 'var(--color-geg-text-faint)' }}>
          {r.firstCallAt ? (r.anyCallConnected ? 'Yes' : 'No') : '—'}
        </span>
        {r.anyCallConnected && r.totalConnectedDurationSec > 0 ? (
          <span style={{ color: 'var(--color-geg-text-faint)' }}>({formatDuration(r.totalConnectedDurationSec)})</span>
        ) : null}
        {r.connectedCallCount >= 2 ? <MultiCallTag count={r.connectedCallCount} /> : null}
      </span>
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>{r.intensity}</span>
      <span className="geg-serif" style={{ fontSize: 12, color: 'var(--color-geg-text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {r.callerName ?? '—'}
      </span>
      <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {canDelete ? <DeleteLeadButton closeId={r.leadId} /> : null}
      </span>
    </Link>
  )
}

// ×N pill marking a lead reached on >1 connected call; the bracketed
// duration beside it sums talk time across those calls.
function MultiCallTag({ count }: { count: number }) {
  return (
    <span
      className="geg-mono"
      title={`${count} separate calls to this lead connected (≥90s). The bracketed duration is their combined talk time.`}
      style={{ flexShrink: 0, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '1px 5px', borderRadius: 4, border: '1px solid var(--color-geg-border)', color: 'var(--color-geg-text-faint)', background: 'var(--color-geg-bg)' }}
    >
      ×{count}
    </span>
  )
}

function OptInBadge({ type }: { type: LeadRow['optInType'] }) {
  const reoptin = type === 'reoptin'
  return (
    <span className="geg-mono" style={{ fontSize: 8.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: reoptin ? 'var(--color-geg-accent)' : 'var(--color-geg-text-3)', border: `1px solid ${reoptin ? 'var(--color-geg-accent)' : 'var(--color-geg-border)'}`, borderRadius: 4, padding: '1px 5px' }}>
      {reoptin ? 're-opt-in' : 'new'}
    </span>
  )
}

function QualifiedTag({ q }: { q: Qualification }) {
  const text = q === 'qualified' ? 'Qualified' : q === 'non-qualified' ? 'Not qualified' : '—'
  const color = q === 'qualified' ? 'var(--color-geg-pos)' : q === 'non-qualified' ? 'var(--color-geg-text-3)' : 'var(--color-geg-text-faint)'
  return (
    <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.03em', color }} title={q === 'unknown' ? 'No marketing_qualified flag on the Close lead' : undefined}>
      {text}
    </span>
  )
}

// Per-lead booking-path tag — direct / reactivated / setter-led.
function BookingTag({ type }: { type: BookingType }) {
  if (type === null) {
    return <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)' }}>—</span>
  }
  const cfg = {
    direct: { label: 'direct', color: 'var(--color-geg-pos)' },
    reactivation: { label: 'reactivated', color: 'var(--color-geg-warn)' },
    setter: { label: 'setter-led', color: 'var(--color-geg-accent)' },
  }[type]
  return (
    <span
      className="geg-mono"
      style={{ fontSize: 8.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: cfg.color, border: `1px solid ${cfg.color}`, borderRadius: 4, padding: '1px 5px' }}
    >
      {cfg.label}
    </span>
  )
}

function EmptyState() {
  return (
    <div className="geg-mono" style={{ padding: '40px 0', textAlign: 'center', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
      No leads opted in for this range.
    </div>
  )
}

// --- formatters (ET date, mm/ss duration) — local ---

function formatEt(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
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
