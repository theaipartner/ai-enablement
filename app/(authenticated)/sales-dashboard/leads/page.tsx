import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import { getLeadsForRange, type Qualification } from '@/lib/db/leads'
import { matchesLeadFilter, reachedStage, type LeadFilterType, type FunnelStage } from '@/lib/db/leads-funnel'
import { getFmrTimeBlocks, getSpeedToLeadCohort } from '@/lib/db/funnel-appointment-setting'
import { resolveFunnelRange } from '@/lib/db/funnel-stages'
import { parseEtDateString, todayEtDate } from '@/lib/db/funnel-window'
import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'
import { searchLeads, type LeadSearchResult } from '@/lib/db/lead-search'
import { FmrTimeBlockChart } from '@/components/sales/fmr-time-block-chart'
import { SpeedToLeadBoxes } from '@/components/sales/speed-to-lead-boxes'
import { LeadSearch } from './lead-search'
import { LeadsFilterBar } from './leads-filter-bar'
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
  searchParams?: { [key: string]: string | string[] | undefined }
}) {
  const q = (Array.isArray(searchParams?.q) ? searchParams?.q[0] : searchParams?.q) ?? ''
  if (q.trim().length >= 2) {
    const results = await searchLeads(q)
    // Carry the window/filters (minus the search box) so a result → per-lead →
    // "Back to leads" returns to the windowed roster, not the default window.
    const backQuery = buildLeadsQuery(searchParams)
    return (
      <div>
        <HeaderBand eyebrow="SALES · LEADS" title="Leads." />
        <LeadSearch initial={q} />
        <SearchResults results={results} query={q.trim()} backQuery={backQuery} />
      </div>
    )
  }

  const start = parseEtDateString(searchParams?.start)
  const end = parseEtDateString(searchParams?.end)
  const range = resolveFunnelRange(start ?? undefined, end ?? undefined)
  const todayEt = todayEtDate()
  const view: View = pickView(searchParams?.view)
  // Lead-type (multi) + stage (single, cumulative) filters — set by the Funnel
  // page's stage links and the filter bar. The funnel and roster share the
  // reachedStage predicate, so a clicked bar opens exactly its leads.
  const types = parseTypes(searchParams?.type)
  const stage = parseStage(searchParams?.stage)

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
  const viewRows = view === 'unique' ? allRows.filter((r) => r.optInType === 'new') : allRows
  // Roster also honors the type/stage filter. Speed-to-lead + FMR stay over the
  // full (unfiltered) cohort — they're window health, not the filtered list.
  const rows = viewRows.filter((r) => matchesLeadFilter(r, types, stage))

  // Serialize the current leads-page state (date window, view, filters) so a row
  // click carries it as `ret`, letting the per-lead "Back to leads" return to
  // the exact same view. Generic over every param except `q` and `ret`.
  const backQuery = buildLeadsQuery(searchParams)

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

      <div style={{ marginTop: 20 }}>
        <LeadsFilterBar view={view} types={types} stage={stage} />
      </div>

      <div style={{ marginTop: 26 }}>
        <SectionLabel>Speed to lead · this window</SectionLabel>
        <SpeedToLeadBoxes cohort={speedCohort} connectedLeads={allRows.filter((r) => reachedStage(r, null, 'connected')).length} />
      </div>

      <div style={{ marginTop: 26 }}>
        <SectionLabel>First message response · by hour of creation · since May 24 ET</SectionLabel>
        <FmrTimeBlockChart fmr={fmr} />
      </div>

      <div style={{ marginTop: 26 }}>
        <LeadRoster rows={rows} canDelete={canDelete} backQuery={backQuery} />
      </div>
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

const VALID_TYPES: LeadFilterType[] = ['direct', 'setter', 'reactivation']
const VALID_STAGES: FunnelStage[] = ['connected', 'booked', 'confirmed', 'showed', 'closed']

// `?type=direct,reactivation` → the validated multi-select lead-type filter.
function parseTypes(raw: string | string[] | undefined): LeadFilterType[] {
  const s = (Array.isArray(raw) ? raw[0] : raw) ?? ''
  return s
    .split(',')
    .map((t) => t.trim())
    .filter((t): t is LeadFilterType => (VALID_TYPES as string[]).includes(t))
}

// `?stage=showed` → the single cumulative stage threshold (null when unset/invalid).
function parseStage(raw: string | string[] | undefined): FunnelStage | null {
  const s = (Array.isArray(raw) ? raw[0] : raw) ?? ''
  return (VALID_STAGES as string[]).includes(s) ? (s as FunnelStage) : null
}

// Serialize the leads-page state to a querystring for the per-lead "Back to
// leads" return link. Carries every param (incl. future filters) except the
// search box `q` and `ret` itself.
function buildLeadsQuery(sp?: { [key: string]: string | string[] | undefined }): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(sp ?? {})) {
    if (k === 'q' || k === 'ret' || v == null) continue
    for (const val of Array.isArray(v) ? v : [v]) params.append(k, val)
  }
  return params.toString()
}

// Global lead search results (any lead, not just the window's cohort). Each
// links to the per-lead page.
function SearchResults({ results, query, backQuery }: { results: LeadSearchResult[]; query: string; backQuery: string }) {
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
            href={`/sales-dashboard/leads/${encodeURIComponent(r.leadId)}${backQuery ? `?ret=${encodeURIComponent(backQuery)}` : ''}`}
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
