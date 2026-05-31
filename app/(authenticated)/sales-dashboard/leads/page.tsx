import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import { getLeadsForRange, type Qualification } from '@/lib/db/leads'
import { getLeadsFunnel, type LeadsFunnel } from '@/lib/db/leads-funnel'
import { getFmrTimeBlocks, getSpeedToLeadCohort } from '@/lib/db/funnel-appointment-setting'
import { resolveFunnelRange } from '@/lib/db/funnel-stages'
import { parseEtDateString, todayEtDate } from '@/lib/db/funnel-window'
import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'
import { searchLeads, type LeadSearchResult } from '@/lib/db/lead-search'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import { FmrTimeBlockChart } from '@/components/sales/fmr-time-block-chart'
import { SpeedToLeadBoxes } from '@/components/sales/speed-to-lead-boxes'
import { LeadSearch } from './lead-search'
import { ViewToggle } from './view-toggle'
import { LeadRoster } from './lead-roster'
import { PersonPill } from '../header-pills'
import { DateRangePicker } from '../funnel/landing-pages/date-range-picker'

// Sales Dashboard — Leads (top-of-funnel + roster).
//
// All↔Unique toggle re-scopes everything. Then a stacked funnel — Total
// (adspend → opt-ins → dials → connected → books → shows → closes), Direct,
// Setter-led, Reactivation (getLeadsFunnel) — then the speed-to-lead boxes,
// the FMR chart, and the per-lead roster. A lead = a Close lead that opted in
// during the window (new OR re-opt-in); the cohort already drops
// creator-soft-hidden (fake) leads, and creators get an × to hide one. Shares
// the cohort via getLeadsForRange → getSpeedToLeadCohort so boxes + roster +
// dial list can't drift.

export const dynamic = 'force-dynamic'
// The page now also fans out into the FMR cohort scan + speed-to-lead
// cohort (close_leads / close_sms / close_calls), same as the
// appointment-setting page; 60s headroom prevents a cold-start 500.
export const maxDuration = 60

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

  // Fetch the cohort ONCE (it's the heavy scan) + access + the cached FMR in
  // parallel, then reuse the cohort for both the roster (getLeadsForRange) and
  // the speed-to-lead boxes — no duplicate cohort scan. (Perf option A.)
  // FMR is cohort-wide (since May 24, NOT range-scoped); the speed boxes ARE
  // range-scoped to the same cohort getLeadsForRange uses, so they can't drift.
  const [speedCohort, access, fmr] = await Promise.all([
    getSpeedToLeadCohort(range),
    getCurrentUserAccessTier(),
    getFmrTimeBlocks(),
  ])
  const allRows = await getLeadsForRange(range, speedCohort)
  const canDelete = access?.tier === 'creator'

  // Unique = new opt-ins only (re-opt-ins removed). All = the full cohort.
  const rows = view === 'unique' ? allRows.filter((r) => r.optInType === 'new') : allRows

  // Funnel stack (Total / Direct / Setter / Reactivation) over the same,
  // view-filtered rows — boxes + roster can't drift.
  const funnel = await getLeadsFunnel(rows, range)

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

      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 20 }}>
        <ViewToggle current={view} />
      </div>

      <FunnelStack funnel={funnel} />

      <div style={{ marginTop: 26 }}>
        <SectionLabel>Speed to lead · this window</SectionLabel>
        <SpeedToLeadBoxes cohort={speedCohort} />
      </div>

      <div style={{ marginTop: 26 }}>
        <SectionLabel>First message response · by hour of creation · since May 24 ET</SectionLabel>
        <FmrTimeBlockChart fmr={fmr} />
      </div>

      <LeadRoster rows={rows} canDelete={canDelete} />
    </div>
  )
}

// Eyebrow heading for the metric sections added to the leads page (speed
// boxes + FMR chart).
function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="geg-mono"
      style={{ fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 10 }}
    >
      {children}
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

// ---------------------------------------------------------------------------
// Funnel stack — Total on top, then Direct / Setter-led / Reactivation, each a
// full-width horizontal funnel (Drake 2026-05-31). Total carries an adspend
// node; Setter shows a qual/unqual split on its pool. Counts come from
// getLeadsFunnel over the view-filtered cohort, so the boxes + roster + the
// All/Unique toggle all move together.
// ---------------------------------------------------------------------------

// Dials live in a bracket beside each funnel's lead amount (not a stage), so
// the funnel reads strictly top-down. Coats: Direct green, Setter-led ("new
// opt-ins") yellow, Reactivation pale blue, Total neutral. (Drake 2026-05-31.)
function FunnelStack({ funnel }: { funnel: LeadsFunnel }) {
  const { total: t, direct: d, setter: s, reactivation: re } = funnel
  const dials = (n: number) => `${n.toLocaleString('en-US')} dials`
  return (
    <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
      <StackedFunnelBox
        label="Total"
        sublabel="Every opt-in in the window"
        tone="neutral"
        adspend={funnel.adspendUsd}
        stages={[
          { value: t.optIns, caption: 'Opt-ins', accent: true, bracket: dials(t.dials) },
          { value: t.connected, caption: 'Connected' },
          { value: t.books, caption: 'Books' },
          { value: t.shows, caption: 'Shows' },
          { value: t.closes, caption: 'Closes' },
        ]}
      />
      <StackedFunnelBox
        label="Direct"
        sublabel="Booked a strategy call after opt-in (includes reactivations)"
        tone="pos"
        stages={[
          { value: d.qualifiedOptIns, caption: 'Qual. opt-ins' },
          { value: d.books, caption: 'Booked', accent: true, bracket: dials(d.dials) },
          { value: d.connected, caption: 'Connected' },
          { value: d.confirms, caption: 'Confirms' },
          { value: d.shows, caption: 'Shows' },
          { value: d.closes, caption: 'Closes' },
        ]}
      />
      <StackedFunnelBox
        label="New opt-ins (setter-led)"
        sublabel="Never booked a strategy call"
        tone="warn"
        poolSplit={{ qualified: s.qualified, unqualified: s.unqualified }}
        stages={[
          { value: s.pool, caption: 'Pool', accent: true, bracket: dials(s.dials) },
          { value: s.connected, caption: 'Connected' },
          { value: s.books, caption: 'Books' },
          { value: s.shows, caption: 'Shows' },
          { value: s.closes, caption: 'Closes' },
        ]}
      />
      <StackedFunnelBox
        label="Reactivation"
        sublabel="Direct leads that lost their strat spot · activity counted after the handover"
        tone="blue"
        stages={[
          { value: re.pool, caption: 'Pool', accent: true, bracket: dials(re.dials) },
          { value: re.connected, caption: 'Connected' },
          { value: re.books, caption: 'Books' },
          { value: re.shows, caption: 'Shows' },
          { value: re.closes, caption: 'Closes' },
        ]}
      />
    </div>
  )
}

type StageDef = { value: number | null; caption: string; accent?: boolean; bracket?: string }
type FunnelTone = 'neutral' | 'pos' | 'warn' | 'blue'

const TONE_STYLE: Record<FunnelTone, { background: string; border: string }> = {
  neutral: { background: 'var(--color-geg-bg-elev)', border: 'var(--color-geg-border)' },
  pos: { background: 'var(--color-geg-pos-fill)', border: 'var(--color-geg-pos-border)' },
  warn: { background: 'var(--color-geg-warn-fill)', border: 'var(--color-geg-warn-border)' },
  // No blue token in the palette — pale-blue literal for the reactivation coat.
  blue: { background: 'rgba(125, 168, 224, 0.10)', border: 'rgba(125, 168, 224, 0.45)' },
}

function StackedFunnelBox({
  label,
  sublabel,
  tone = 'neutral',
  adspend,
  poolSplit,
  stages,
}: {
  label: string
  sublabel: string
  tone?: FunnelTone
  adspend?: number | null
  poolSplit?: { qualified: number; unqualified: number }
  stages: StageDef[]
}) {
  // Optional adspend node, then the stages — every node chevron-separated, so
  // cells alternate node/chevron/node and the grid columns alternate 1fr/auto.
  const cells: React.ReactNode[] = []
  if (adspend !== undefined) {
    cells.push(
      <div key="adspend" style={{ textAlign: 'center', minWidth: 0 }}>
        <div
          className="geg-numeric-serif"
          style={{ fontSize: 22, letterSpacing: '-0.02em', color: adspend == null ? 'var(--color-geg-text-faint)' : 'var(--color-geg-warn)' }}
        >
          {adspend == null ? '—' : compactUsd(adspend)}
        </div>
        <div className="geg-mono" style={{ fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', marginTop: 2 }}>
          Adspend
        </div>
      </div>,
    )
    cells.push(<Chevron key="ch-adspend" />)
  }
  stages.forEach((s, i) => {
    if (i > 0) cells.push(<Chevron key={`ch${i}`} />)
    cells.push(<FunnelStage key={s.caption} value={s.value} caption={s.caption} accent={s.accent} bracket={s.bracket} />)
  })
  const cols = cells.map((_, i) => (i % 2 === 0 ? '1fr' : 'auto')).join(' ')
  const toneStyle = TONE_STYLE[tone]

  return (
    <div style={{ padding: '14px 16px', background: toneStyle.background, border: `1px solid ${toneStyle.border}`, borderRadius: 8, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <BoxLabel>{label}</BoxLabel>
        {poolSplit ? (
          <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)' }}>
            {poolSplit.qualified.toLocaleString('en-US')} qual · {poolSplit.unqualified.toLocaleString('en-US')} unqual
          </span>
        ) : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', gap: 4, marginTop: 12 }}>
        {cells}
      </div>
      <SubLine>{sublabel}</SubLine>
    </div>
  )
}

function FunnelStage({ value, caption, accent, bracket }: { value: number | null; caption: string; accent?: boolean; bracket?: string }) {
  const pending = value === null
  return (
    <div style={{ textAlign: 'center', minWidth: 0 }}>
      <div
        className="geg-numeric-serif"
        style={{ fontSize: 22, letterSpacing: '-0.02em', color: pending ? 'var(--color-geg-text-faint)' : accent ? 'var(--color-geg-accent)' : 'var(--color-geg-text)' }}
        title={pending ? 'Not wired yet — pending the booking-confirmation matching flow' : undefined}
      >
        {pending ? '—' : value.toLocaleString('en-US')}
        {bracket ? (
          <span className="geg-mono" style={{ fontSize: 9, fontWeight: 400, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)', marginLeft: 4 }}>
            ({bracket})
          </span>
        ) : null}
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

function QualifiedTag({ q }: { q: Qualification }) {
  const text = q === 'qualified' ? 'Qualified' : q === 'non-qualified' ? 'Not qualified' : '—'
  const color = q === 'qualified' ? 'var(--color-geg-pos)' : q === 'non-qualified' ? 'var(--color-geg-text-3)' : 'var(--color-geg-text-faint)'
  return (
    <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.03em', color }} title={q === 'unknown' ? 'No marketing_qualified flag on the Close lead' : undefined}>
      {text}
    </span>
  )
}

// --- formatters (ET date, mm/ss duration) — local ---

function formatEt(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}
