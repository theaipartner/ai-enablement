import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import {
  getCallActivityMetrics,
  getCallActivityForUser,
  type CallActivityDrillRow,
} from '@/lib/db/funnel-appointment-setting'
import {
  getClosingScheduledList,
  getClosingActivity,
  getCloserFormMetricsByRep,
  CLOSING_FLOOR_ET,
  type CloserScheduledDrillRow,
} from '@/lib/db/funnel-closing'
import {
  getDigitalCollegeActivity,
  type DcDrillRow,
} from '@/lib/db/funnel-digital-college'
import { todayEtDate, dateRangeFromExplicit } from '@/lib/db/funnel-window'
import { resolveSalesWindow } from '@/lib/db/sales-window-cookie'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'
import { createAdminClient } from '@/lib/supabase/admin'
import { PerRepCallActivityTable } from '../../funnel/appointment-setting/_components/sortable-tables'
import { CloserScheduledTables } from '../../funnel/closed/_components/closer-tables'
import { DigitalCollegeTables } from '../_components/digital-college-tables'
import { DateRangePicker } from '../../funnel/landing-pages/date-range-picker'
import { PersonPill } from '../../header-pills'
import { PersistPageState } from '@/components/sales/persist-page-state'
import { buildRoster, type RosterPerson, type SalesRole } from './_components/roster-data'
import { RosterGrid } from './_components/roster-grid'

// Sales identity = team_members (close_user_id → canonical sales_role +
// is_active) among non-archived sales rows. is_active is the durable, editable
// flag (no code deploy to change the roster — one SQL update flips it); sales
// reps are all is_csm=false, so it's independent of the CSM-side surfaces.
// sales_role is the canonical role the card chip + crucial metrics key off.
async function loadSalesIdentity(): Promise<Map<string, { active: boolean; role: SalesRole }>> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('team_members' as never)
    .select('close_user_id, is_active, sales_role')
    .not('sales_role', 'is', null)
    .is('archived_at', null)
  if (error) throw new Error(`team_members identity read failed: ${error.message}`)
  const out = new Map<string, { active: boolean; role: SalesRole }>()
  for (const r of (data ?? []) as unknown as Array<{ close_user_id: string | null; is_active: boolean | null; sales_role: SalesRole }>) {
    if (r.close_user_id) out.set(r.close_user_id, { active: !!r.is_active, role: r.sales_role })
  }
  return out
}

// Sales Dashboard — Talent · Roster (By Rep).
//
// A mockup / candidate replacement for the section-by-call-type Talent page.
// Instead of splitting reps across a Triage table and a Confirmation table,
// this organizes by PERSON: one block per human (?rep absent = the roster
// grid), with the exact existing drilldowns shown on a per-person detail view
// (?rep set). It reads the SAME loaders /people reads — no new data, no logic
// change — and merges their output by Close user_id (see buildRoster).

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function resolvePeopleRange(start: string | null, end: string | null) {
  const today = todayEtDate()
  const s = start ?? today
  const e = end ?? today
  const sClamped = s < CLOSING_FLOOR_ET ? CLOSING_FLOOR_ET : s
  return dateRangeFromExplicit(sClamped, e)
}

export default async function SalesRosterPage({
  searchParams,
}: {
  searchParams?: {
    start?: string | string[]
    end?: string | string[]
    rep?: string | string[]
    repfam?: string | string[]
    closer?: string | string[]
    dccloser?: string | string[]
  }
}) {
  const { start, end } = resolveSalesWindow(searchParams)
  const range = resolvePeopleRange(start, end)
  const todayEt = todayEtDate()

  const selectedRepRaw = Array.isArray(searchParams?.rep) ? searchParams?.rep[0] : searchParams?.rep
  const selectedRep =
    typeof selectedRepRaw === 'string' && selectedRepRaw.startsWith('user_') ? selectedRepRaw : null
  const selectedCloserRaw = Array.isArray(searchParams?.closer) ? searchParams?.closer[0] : searchParams?.closer
  const selectedCloser = typeof selectedCloserRaw === 'string' && selectedCloserRaw.length > 0 ? selectedCloserRaw : null
  const selectedDcCloserRaw = Array.isArray(searchParams?.dccloser) ? searchParams?.dccloser[0] : searchParams?.dccloser
  const selectedDcCloser = typeof selectedDcCloserRaw === 'string' && selectedDcCloserRaw.length > 0 ? selectedDcCloserRaw : null

  const [activity, repDrill, scheduled, closingData, digitalCollege, closerForms, access, identity] = await Promise.all([
    getCallActivityMetrics(range),
    selectedRep ? getCallActivityForUser(range, selectedRep) : Promise.resolve([] as CallActivityDrillRow[]),
    getClosingScheduledList(range),
    getClosingActivity(range),
    getDigitalCollegeActivity(range),
    getCloserFormMetricsByRep(range),
    getCurrentUserAccessTier(),
    loadSalesIdentity(),
  ])
  void closingData
  const canDelete = access?.tier === 'creator'

  const roster = buildRoster(activity, scheduled, digitalCollege, closerForms, identity)
  const person = selectedRep ? roster.find((p) => p.userId === selectedRep) ?? null : null

  // Window-only query string for the roster cards' detail links.
  const windowParams = new URLSearchParams()
  if (start) windowParams.set('start', start)
  if (end) windowParams.set('end', end)
  const windowQs = windowParams.toString()

  // baseParams the reused scheduled / DC tables build their closer-toggle
  // links from — preserve window + the active person selection.
  const baseParams = new URLSearchParams(windowParams)
  if (selectedRep) baseParams.set('rep', selectedRep)
  if (selectedCloser) baseParams.set('closer', selectedCloser)
  if (selectedDcCloser) baseParams.set('dccloser', selectedDcCloser)

  return (
    <div>
      <PersistPageState window />
      <HeaderBand
        eyebrow="SALES · TALENT"
        title={person ? person.name : 'Roster.'}
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

      {person ? (
        <PersonDetail
          person={person}
          windowQs={windowQs}
          repDrill={repDrill}
          scheduledDrill={selectedCloser ? scheduled.drillByCloser[selectedCloser] ?? [] : []}
          dcDrill={selectedDcCloser ? digitalCollege.drillByCloser[selectedDcCloser] ?? [] : []}
          selectedCloser={selectedCloser}
          selectedDcCloser={selectedDcCloser}
          baseParams={baseParams.toString()}
          canDelete={canDelete}
        />
      ) : (
        <div style={{ marginTop: 28 }}>
          <RosterGrid people={roster} windowQs={windowQs} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Per-person detail — reuses the exact existing drilldown tables, scoped to
// one person. Each table the person has a role in is rendered with their
// single row + their drill.
// ---------------------------------------------------------------------------

function PersonDetail({
  person,
  windowQs,
  repDrill,
  scheduledDrill,
  dcDrill,
  selectedCloser,
  selectedDcCloser,
  baseParams,
  canDelete,
}: {
  person: RosterPerson
  windowQs: string
  repDrill: CallActivityDrillRow[]
  scheduledDrill: CloserScheduledDrillRow[]
  dcDrill: DcDrillRow[]
  selectedCloser: string | null
  selectedDcCloser: string | null
  baseParams: string
  canDelete: boolean
}) {
  return (
    <div style={{ marginTop: 20 }}>
      <Link
        href={windowQs ? `?${windowQs}` : '?'}
        className="geg-mono"
        style={{
          display: 'inline-block',
          marginBottom: 18,
          fontSize: 11,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
          textDecoration: 'none',
        }}
      >
        ← All reps
      </Link>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
        {person.scheduled ? (
          <SectionBox eyebrow="CASH" title="This rep's closes + upfront collected in range.">
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
              <DetailTile label="Closed" value={String(person.scheduled.closed)} />
              <DetailTile label="HT / DC" value={`${person.scheduled.closedHt} / ${person.scheduled.closedDc}`} />
              <DetailTile label="Upfront" value={compactUsd(person.scheduled.upfront)} />
              <DetailTile label="Showed / No-show" value={`${person.scheduled.showed} / ${person.scheduled.noShows}`} />
            </div>
          </SectionBox>
        ) : null}

        {person.setter || person.closer ? (
          <SectionBox eyebrow="CALL ACTIVITY" title="Volume, outcomes, and the per-call drill — click a row to collapse.">
            <div style={{ display: 'grid', gap: 14 }}>
              {person.setter ? (
                <PerRepCallActivityTable
                  label="Triage (Setter)"
                  variant="setter"
                  aggregate={person.setter}
                  rows={[person.setter]}
                  selectedRep={person.userId}
                  selectedFam="setter"
                  drill={repDrill}
                  canDelete={canDelete}
                />
              ) : null}
              {person.closer ? (
                <PerRepCallActivityTable
                  label="Confirmation Calls (Closer)"
                  variant="closer"
                  aggregate={person.closer}
                  rows={[person.closer]}
                  selectedRep={person.userId}
                  selectedFam="closer"
                  drill={repDrill}
                  canDelete={canDelete}
                />
              ) : null}
            </div>
          </SectionBox>
        ) : null}

        {person.scheduled ? (
          <SectionBox eyebrow="SCHEDULED CALLS" title="Scheduled calls in range · click the row to drill into each booking.">
            <CloserScheduledTables
              closers={[person.scheduled]}
              aggregate={person.scheduled}
              selectedCloser={selectedCloser}
              drill={scheduledDrill}
              baseParams={baseParams}
              canDelete={canDelete}
            />
          </SectionBox>
        ) : null}

        {person.dc ? (
          <SectionBox eyebrow="DIGITAL COLLEGE" title="Low-ticket activity · dials, meetings, shows, plans, closes.">
            <DigitalCollegeTables
              closers={[person.dc]}
              aggregate={person.dc}
              selectedCloser={selectedDcCloser}
              drill={dcDrill}
              baseParams={baseParams}
            />
          </SectionBox>
        ) : null}
      </div>
    </div>
  )
}

function DetailTile({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ padding: '14px 16px 12px', background: 'var(--color-geg-bg)', border: '1px solid var(--color-geg-border)', borderRadius: 8 }}>
      <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 6 }}>
        {label}
      </div>
      <div className="geg-numeric-serif" style={{ fontSize: 22, lineHeight: '26px', letterSpacing: '-0.02em', color: 'var(--color-geg-text)' }}>
        {value}
      </div>
    </div>
  )
}

function SectionBox({
  eyebrow, title, children,
}: {
  eyebrow: string
  title: string
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
      <div style={{ marginBottom: 16 }}>
        <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.18em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}>
          {eyebrow}
        </div>
        <div className="geg-serif" style={{ marginTop: 5, fontSize: 18, color: 'var(--color-geg-text)', letterSpacing: '-0.01em' }}>
          {title}
        </div>
      </div>
      {children}
    </section>
  )
}
