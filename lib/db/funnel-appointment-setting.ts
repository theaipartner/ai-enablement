import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { Window } from './sales-dashboard-shared'
import { getDateRangeFromWindow, type DateRange } from './funnel-window'

// Funnel · Appointment Setting stage — Tier 1 (timing/effort) live
// from Close system-recorded calls/SMS; Tier 2 (outcome splits) live
// from Close lead-status flips. Airtable forms are the canonical
// source for outcomes per the spec, but adoption is 0% today (5
// total rows vs ~750 connected calls/30d) — wired via Close status
// flips for now until form adoption stabilizes. Drake's call.
//
// Per-call role attribution: a call is a "closer triage" if
// call.user_id == lead.closer_owner_id; a "setter dial" if
// call.user_id == lead.setter_owner_id. Same user can show up on
// both sides depending on which lead they're calling. Calls where
// neither match are unclassified.

// Hard floor for all appointment-setting metrics. Anything before
// May 24, 2026 ET (when Drake's tracking convention started) is
// excluded — earlier data is pre-process and would distort baselines.
const APPT_SETTING_MIN_ET_DATE = '2026-05-24'

function resolveRange(arg: Window | DateRange): DateRange {
  const raw = typeof arg === 'string' ? getDateRangeFromWindow(arg) : arg
  return clampToFloor(raw)
}

// Clamp the lower bound of a range to APPT_SETTING_MIN_ET_DATE. If
// the user picks a date earlier than the floor, the effective range
// starts at the floor instead. The end date is untouched.
function clampToFloor(range: DateRange): DateRange {
  if (range.startEtDate >= APPT_SETTING_MIN_ET_DATE) return range
  // Rebuild using the explicit-range builder so the UTC instants
  // line up with the clamped ET dates.
  return dateRangeFromExplicitInternal(APPT_SETTING_MIN_ET_DATE, range.endEtDate)
}

function dateRangeFromExplicitInternal(startEtDate: string, endEtDate: string): DateRange {
  // Mirrors dateRangeFromExplicit in funnel-window.ts but local to
  // this module so we don't introduce a new public export just for
  // this clamp.
  const startUtc = etDateMidnight(startEtDate)
  const endUtc = etDateMidnight(addDaysToEtDateStr(endEtDate, 1))
  return {
    startEtDate,
    endEtDate,
    startUtcIso: startUtc.toISOString(),
    endUtcIso: endUtc.toISOString(),
  }
}

function etDateMidnight(etDate: string): Date {
  const [y, m, d] = etDate.split('-').map((n) => parseInt(n, 10))
  // Compute the ET-to-UTC offset for this calendar date by reading
  // the hour-of-day for "noon UTC" in ET — that's outside any DST
  // transition window, so the offset is stable for the date.
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  const etHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      hour12: false,
    }).format(noonUtc),
    10,
  ) % 24
  const offsetHours = 12 - etHour
  return new Date(Date.UTC(y, m - 1, d, offsetHours, 0, 0))
}

// ---------------------------------------------------------------------------
// Status IDs from the Close pipeline (sourced from
// docs/reports/close-smartview-discovery.md § Lead status pipeline).
// Note: schema doc-listed statuses are augmented with statuses
// discovered in the data probe (Lead Engaged, Call Reactivation,
// Invalid). Lead Engaged is intentionally unused per Drake.
// ---------------------------------------------------------------------------

const STATUS = {
  confirmedBooking: 'stat_dppOL2h1QjfH4QcHYI9Vro1LBJDO9bQUiBjCa83e4y1',
  handedOver: 'stat_GZca7DExvxZ2FkjKNFgWxqrlKwB1ULxA2xKrYszhVf5',
  disqualifiedLead: 'stat_Sy5P7oFaIcdSOAON2XY1ELblocmqzvnB7ie7cMQllSX',
  downsell: 'stat_1uxT6m8Gkkn31Xkmiix215MHAEJEqSWWGJgshpZpM8Y',
} as const

// Status-flip lookback window after a connect. A status change to
// one of the outcome statuses within this many days of a connect
// is attributed to that connect.
const STATUS_LOOKBACK_DAYS = 7
const STATUS_LOOKBACK_MS = STATUS_LOOKBACK_DAYS * 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// First Message Response
// ---------------------------------------------------------------------------

// First Message Response — time-block breakdown.
//
// Cohort: all leads created on or after 2026-05-01 ET midnight,
// cumulative and growing. Locked start date per Drake's call.
//
// Buckets: 6 time-of-day blocks (4 hours each, ET) keyed off
// `close_leads.date_created`:
//   0: 12am–4am  ·  1: 4am–8am  ·  2: 8am–12pm
//   3: 12pm–4pm  ·  4: 4pm–8pm  ·  5: 8pm–12am
//
// Per block: two response rates side by side
//   - everReplied = lead has ≥1 inbound SMS at ANY time
//   - within24h   = first inbound landed within 24h of date_created
//
// Denominator = all leads in the cohort that fell in this block,
// whether or not we ever texted them. Matches the Close-UI calc:
// "leads where SMS received > 0 / total new leads."

// FMR cohort starts at May 24, 2026 00:00 ET (= 04:00 UTC during EDT).
// Aligned with APPT_SETTING_MIN_ET_DATE — same floor across the page.
const FMR_COHORT_START_UTC_ISO = '2026-05-24T04:00:00Z'
const ONE_DAY_MS = 24 * 60 * 60 * 1000

export type FmrTimeBlock = {
  blockIndex: 0 | 1 | 2 | 3 | 4 | 5
  label: string                   // e.g. "12am–4am"
  cohortSize: number              // leads created in this block
  everReplied: number             // received ≥1 inbound
  within24h: number               // first inbound ≤24h after creation
  everRepliedRate: number | null  // 0..1
  within24hRate: number | null    // 0..1
}

export type FmrTimeBlocksResult = {
  cohortStart: string             // ET-anchored display label
  cohortSize: number              // total leads
  cohortEverReplied: number
  cohortWithin24h: number
  blocks: FmrTimeBlock[]
}

const BLOCK_LABELS = ['12am–4am', '4am–8am', '8am–12pm', '12pm–4pm', '4pm–8pm', '8pm–12am'] as const

// Returns the ET-hour-of-day (0–23) for a given UTC ISO timestamp.
function etHourOfDay(iso: string): number {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hour12: false,
  })
  return parseInt(fmt.format(new Date(iso)), 10) % 24
}

export async function getFmrTimeBlocks(): Promise<FmrTimeBlocksResult> {
  const sb = createAdminClient()

  // Cohort: leads created since May 1, 2026 ET. Paginate to avoid
  // PostgREST's default page limit.
  const leads: Array<{ close_id: string; date_created: string }> = []
  {
    let from = 0
    const PAGE = 1000
    for (;;) {
      const { data, error } = await sb
        .from('close_leads' as never)
        .select('close_id, date_created')
        .gte('date_created', FMR_COHORT_START_UTC_ISO)
        .order('date_created', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`close_leads cohort read failed: ${error.message}`)
      const rows = (data ?? []) as unknown as Array<{ close_id: string; date_created: string }>
      if (rows.length === 0) break
      leads.push(...rows)
      if (rows.length < PAGE) break
      from += PAGE
    }
  }

  // Inbound SMS scan — keyed only by date so we get every inbound
  // since cohort start. Faster than a per-lead `.in()` filter.
  const earliestInboundByLead = new Map<string, string>()
  {
    let from = 0
    const PAGE = 1000
    for (;;) {
      const { data, error } = await sb
        .from('close_sms' as never)
        .select('lead_id, activity_at')
        .eq('direction', 'inbound')
        .gte('activity_at', FMR_COHORT_START_UTC_ISO)
        .order('activity_at', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`close_sms inbound read failed: ${error.message}`)
      const rows = (data ?? []) as unknown as Array<{ lead_id: string; activity_at: string }>
      if (rows.length === 0) break
      for (const r of rows) {
        if (!r.lead_id) continue
        if (!earliestInboundByLead.has(r.lead_id)) {
          earliestInboundByLead.set(r.lead_id, r.activity_at)
        }
      }
      if (rows.length < PAGE) break
      from += PAGE
    }
  }

  // Bucket each lead.
  const totals = [0, 0, 0, 0, 0, 0]
  const everCounts = [0, 0, 0, 0, 0, 0]
  const within24Counts = [0, 0, 0, 0, 0, 0]
  for (const lead of leads) {
    const hour = etHourOfDay(lead.date_created)
    const block = Math.floor(hour / 4) as 0 | 1 | 2 | 3 | 4 | 5
    totals[block]++
    const inboundAt = earliestInboundByLead.get(lead.close_id)
    if (inboundAt) {
      everCounts[block]++
      const deltaMs = new Date(inboundAt).getTime() - new Date(lead.date_created).getTime()
      if (deltaMs >= 0 && deltaMs <= ONE_DAY_MS) {
        within24Counts[block]++
      }
    }
  }

  const blocks: FmrTimeBlock[] = []
  for (let i = 0; i < 6; i++) {
    const total = totals[i]
    blocks.push({
      blockIndex: i as 0 | 1 | 2 | 3 | 4 | 5,
      label: BLOCK_LABELS[i],
      cohortSize: total,
      everReplied: everCounts[i],
      within24h: within24Counts[i],
      everRepliedRate: total > 0 ? everCounts[i] / total : null,
      within24hRate: total > 0 ? within24Counts[i] / total : null,
    })
  }

  return {
    cohortStart: 'May 24, 2026 · 12:00am ET',
    cohortSize: leads.length,
    cohortEverReplied: everCounts.reduce((a, b) => a + b, 0),
    cohortWithin24h: within24Counts.reduce((a, b) => a + b, 0),
    blocks,
  }
}

// ---------------------------------------------------------------------------
// Speed to Lead (per-rep, separately for setters + closers)
//
// Spec (Drake-confirmed):
//   1. Cohort = leads with date_created in the window AND initial
//      status (first close_lead_status_changes row, identified by
//      old_status_id IS NULL) is New Opt-in or Unconfirmed Booking.
//   2. For each cohort lead: find earliest outbound call (any user,
//      any duration — doesn't have to be connected).
//   3. Delta = earliest_call.activity_at - lead.date_created.
//      Clock-start is lead creation for EVERYONE (setter + closer
//      both — closer side no longer uses booking time).
//   4. Bucket by the call's user_id.
//   5. Route each user to setter/closer table by their global role
//      (the union of all setter_owner_id / closer_owner_id values
//      across close_leads).
// ---------------------------------------------------------------------------

const STATUS_NEW_OPTIN = 'stat_ZIoyCWBDoWtYQ8EhrO6heT1XMIj4JeIbni74EsAyLiX'
const STATUS_UNCONFIRMED_BOOKING = 'stat_VXEKegQ4HN87CtntYn7SCwO0ooqHMFKBlp0tJIq6KKs'
const QUALIFYING_INITIAL_STATUSES = new Set([STATUS_NEW_OPTIN, STATUS_UNCONFIRMED_BOOKING])

// Explicit primary-role override for dual-role users. The global-
// owner-id sets show some users wearing both hats (typically Aman,
// who closes but occasionally sets); routing them on auto-detect
// alone misclassifies their operational role. Keep this list short
// and explicit; the rest fall back to the global-set membership.
const PRIMARY_ROLE_OVERRIDE: Record<string, 'setter' | 'closer'> = {
  'user_8bvDMahhN45SVVqq8MJ6KEPdxl3eGBGpPZIUAQwBZ93': 'closer', // Aman Ali
}

// User IDs to exclude from the speed-to-lead + triage tables. Used
// for non-operational reps (leadership, automation accounts) whose
// occasional calls show up in the data but aren't part of the
// actual setter/closer rotation.
const EXCLUDED_REP_IDS = new Set<string>([
  'user_DFKbypchBYDyzLMdsg3ujzxWZyxTMKbsysYRc9LGAch', // Nabeel Junaid
])

function resolveRole(userId: string, closerSet: Set<string>, setterSet: Set<string>): 'setter' | 'closer' | null {
  if (EXCLUDED_REP_IDS.has(userId)) return null
  const override = PRIMARY_ROLE_OVERRIDE[userId]
  if (override) return override
  const inCloser = closerSet.has(userId)
  const inSetter = setterSet.has(userId)
  if (inSetter && !inCloser) return 'setter'
  if (inCloser && !inSetter) return 'closer'
  if (inSetter && inCloser) return 'closer' // dual-role default
  return null
}

export type SpeedToLeadRow = {
  userId: string
  name: string | null            // resolved from close_calls.raw_payload.user_name
  callsAttributed: number        // distinct leads where this rep was first to dial
  avgSec: number | null          // arithmetic mean of speed-to-dial seconds (capped at 24h)
}

export type SpeedToLeadResult = {
  setters: SpeedToLeadRow[]
  closers: SpeedToLeadRow[]
}

// Per-lead audit row used by the drill-down expander. Returned by
// getSpeedToLeadLeadsForUser when a rep row is clicked.
export type SpeedToLeadLeadRow = {
  leadId: string
  displayName: string | null
  leadCreatedAt: string          // ISO UTC — UI renders in ET
  firstCallAt: string            // ISO UTC
  deltaSec: number               // actual gap (uncapped — show real time for audit)
}

// Outlier cap. Speed-to-lead samples > 24h after lead creation are
// usually stale callbacks or re-engagements, not "speed" — clip them
// so the arithmetic mean isn't dragged by a long tail.
const SPEED_CAP_SEC = 24 * 60 * 60

export async function getSpeedToLead(arg: Window | DateRange): Promise<SpeedToLeadResult> {
  const range = resolveRange(arg)
  const sb = createAdminClient()

  // Build the global role index from close_leads owner fields.
  // Used as fallback when an individual lead doesn't have owner_id
  // populated (~70% of leads). A user that appears as setter only
  // globally gets all their unattributed leads counted as setter
  // speed-to-lead; same for closer-only. Users in BOTH global sets
  // fall back to "unclassified" since we can't infer which hat they
  // were wearing for that call.
  const { data: ownerRows, error: ownerErr } = await sb
    .from('close_leads' as never)
    .select('closer_owner_id, setter_owner_id')
    .or('closer_owner_id.not.is.null,setter_owner_id.not.is.null')
    .range(0, 19999)
  if (ownerErr) throw new Error(`close_leads owner read failed: ${ownerErr.message}`)
  const closerUsers = new Set<string>()
  const setterUsers = new Set<string>()
  for (const r of (ownerRows ?? []) as unknown as Array<{ closer_owner_id: string | null; setter_owner_id: string | null }>) {
    if (r.closer_owner_id) closerUsers.add(r.closer_owner_id)
    if (r.setter_owner_id) setterUsers.add(r.setter_owner_id)
  }

  // Cohort: leads created in window. We further filter by initial
  // status (New Opt-in or Unconfirmed Booking) via the status-
  // changes table below — that's what excludes test/manual leads
  // that started in some other status.
  const { data: leads, error: leadsErr } = await sb
    .from('close_leads' as never)
    .select('close_id, date_created, status_id')
    .gte('date_created', range.startUtcIso)
    .lt('date_created', range.endUtcIso)
    .range(0, 9999)
  if (leadsErr) throw new Error(`close_leads read failed: ${leadsErr.message}`)
  const leadRows = (leads ?? []) as unknown as Array<{
    close_id: string
    date_created: string
    status_id: string | null
  }>
  if (leadRows.length === 0) return { setters: [], closers: [] }
  const leadIdSet = new Set(leadRows.map((l) => l.close_id))

  // Initial-status filter. Close convention: no status change row
  // is emitted for the initial state — only transitions. So a
  // lead's initial status is:
  //   - the `old_status_id` of its EARLIEST status change, OR
  //   - the current `status_id` if the lead has no status changes
  //     (i.e., never moved from initial state).
  // Pull all status changes whose date_created falls in or just
  // after our window (a lead created in the window has its first
  // change shortly after creation), find the earliest per lead.
  const earliestOldStatusByLead = new Map<string, string | null>()
  {
    const scStart = range.startUtcIso
    const scEnd = new Date(new Date(range.endUtcIso).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString()
    let scFrom = 0
    const scPAGE = 1000
    for (;;) {
      const { data: page, error } = await sb
        .from('close_lead_status_changes' as never)
        .select('lead_id, old_status_id, date_created')
        .gte('date_created', scStart)
        .lt('date_created', scEnd)
        .order('date_created', { ascending: true })
        .range(scFrom, scFrom + scPAGE - 1)
      if (error) throw new Error(`close_lead_status_changes read failed: ${error.message}`)
      const rows = (page ?? []) as unknown as Array<{ lead_id: string; old_status_id: string | null; date_created: string }>
      if (rows.length === 0) break
      for (const r of rows) {
        if (!leadIdSet.has(r.lead_id)) continue
        if (!earliestOldStatusByLead.has(r.lead_id)) {
          earliestOldStatusByLead.set(r.lead_id, r.old_status_id)
        }
      }
      if (rows.length < scPAGE) break
      scFrom += scPAGE
    }
  }
  const qualifyingLeadIds = new Set<string>()
  for (const lead of leadRows) {
    // Initial status = earliest change's old_status_id, OR if no
    // change exists, the lead's current status_id (never moved).
    const initial = earliestOldStatusByLead.has(lead.close_id)
      ? earliestOldStatusByLead.get(lead.close_id)
      : lead.status_id
    if (initial && QUALIFYING_INITIAL_STATUSES.has(initial)) {
      qualifyingLeadIds.add(lead.close_id)
    }
  }
  if (qualifyingLeadIds.size === 0) return { setters: [], closers: [] }

  // First outbound call per lead — pull every outbound call in a
  // generous window, then filter in-memory to our lead set. Avoids
  // a `.in()` filter with hundreds of IDs that overruns PostgREST's
  // URI length budget. Selecting raw_payload too so we can resolve
  // user_id → user_name without a separate users mirror.
  const lookbackStart = new Date(new Date(range.startUtcIso).getTime() - 30 * 24 * 60 * 60 * 1000).toISOString()
  const lookbackEnd = new Date(new Date(range.endUtcIso).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const callRows: Array<{ lead_id: string; user_id: string | null; activity_at: string; raw_payload: { user_name?: string } | null }> = []
  const nameByUser = new Map<string, string>()
  let from = 0
  const PAGE = 1000
  for (;;) {
    const { data: page, error } = await sb
      .from('close_calls' as never)
      .select('lead_id, user_id, activity_at, raw_payload')
      .eq('direction', 'outbound')
      .gte('activity_at', lookbackStart)
      .lt('activity_at', lookbackEnd)
      .order('activity_at', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) throw new Error(`close_calls read failed: ${error.message}`)
    const rows = (page ?? []) as unknown as Array<{ lead_id: string; user_id: string | null; activity_at: string; raw_payload: { user_name?: string } | null }>
    if (rows.length === 0) break
    for (const r of rows) {
      if (r.user_id && r.raw_payload?.user_name && !nameByUser.has(r.user_id)) {
        nameByUser.set(r.user_id, r.raw_payload.user_name)
      }
      if (qualifyingLeadIds.has(r.lead_id)) callRows.push(r)
    }
    if (rows.length < PAGE) break
    from += PAGE
  }

  // Per-(user, lead) earliest call. For each (rep, lead) pair, find
  // the rep's EARLIEST outbound call to that lead. A lead Connor
  // dials Monday and Aman follows up Tuesday counts in BOTH reps'
  // rows with their respective deltas. Matches the operational
  // metric of "each rep's speed for their own leads."
  const earliestCallByUserLead = new Map<string, Map<string, string>>()
  for (const c of callRows) {
    if (!c.user_id) continue
    let perUser = earliestCallByUserLead.get(c.user_id)
    if (!perUser) {
      perUser = new Map()
      earliestCallByUserLead.set(c.user_id, perUser)
    }
    if (!perUser.has(c.lead_id)) {
      perUser.set(c.lead_id, c.activity_at)
    }
  }

  // Per-rep speed: delta from lead.date_created → rep's earliest
  // call to that lead. Bucket by user_id; route to setter/closer
  // table by global role. Dual-role users (e.g. Aman) land on
  // setter side (most are setter-dominant in volume).
  const setterTimes = new Map<string, number[]>()
  const closerTimes = new Map<string, number[]>()
  const leadById = new Map(leadRows.map((l) => [l.close_id, l]))

  earliestCallByUserLead.forEach((perUser, userId) => {
    const role = resolveRole(userId, closerUsers, setterUsers)
    if (!role) return
    const target = role === 'setter' ? setterTimes : closerTimes
    const arr = target.get(userId) ?? []
    perUser.forEach((earliestCallAt, leadId) => {
      const lead = leadById.get(leadId)
      if (!lead) return
      const createdMs = new Date(lead.date_created).getTime()
      const callMs = new Date(earliestCallAt).getTime()
      if (!Number.isFinite(createdMs) || callMs < createdMs) return
      arr.push((callMs - createdMs) / 1000)
    })
    if (arr.length > 0) target.set(userId, arr)
  })

  return {
    setters: toSpeedRows(setterTimes, nameByUser),
    closers: toSpeedRows(closerTimes, nameByUser),
  }
}

// Drill-down: list every (lead × rep's earliest call) pair for the
// given user_id within the speed-to-lead window. Audit surface; gets
// rendered when a rep row on the page is clicked.
export async function getSpeedToLeadLeadsForUser(
  arg: Window | DateRange,
  userId: string,
): Promise<SpeedToLeadLeadRow[]> {
  const range = resolveRange(arg)
  const sb = createAdminClient()

  // Cohort identical to getSpeedToLead.
  const { data: leads, error: leadsErr } = await sb
    .from('close_leads' as never)
    .select('close_id, display_name, date_created, status_id')
    .gte('date_created', range.startUtcIso)
    .lt('date_created', range.endUtcIso)
    .range(0, 9999)
  if (leadsErr) throw new Error(`close_leads read failed: ${leadsErr.message}`)
  const leadRows = (leads ?? []) as unknown as Array<{
    close_id: string
    display_name: string | null
    date_created: string
    status_id: string | null
  }>
  if (leadRows.length === 0) return []
  const leadIdSet = new Set(leadRows.map((l) => l.close_id))

  // Initial-status qualification (same logic).
  const earliestOld = new Map<string, string | null>()
  {
    const scStart = range.startUtcIso
    const scEnd = new Date(new Date(range.endUtcIso).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString()
    let from = 0
    for (;;) {
      const { data: page, error } = await sb
        .from('close_lead_status_changes' as never)
        .select('lead_id, old_status_id, date_created')
        .gte('date_created', scStart)
        .lt('date_created', scEnd)
        .order('date_created', { ascending: true })
        .range(from, from + 999)
      if (error) throw new Error(`status changes read failed: ${error.message}`)
      const rows = (page ?? []) as unknown as Array<{ lead_id: string; old_status_id: string | null; date_created: string }>
      if (rows.length === 0) break
      for (const r of rows) {
        if (!leadIdSet.has(r.lead_id)) continue
        if (!earliestOld.has(r.lead_id)) earliestOld.set(r.lead_id, r.old_status_id)
      }
      if (rows.length < 1000) break
      from += 1000
    }
  }
  const qualifyingLeads = leadRows.filter((l) => {
    const initial = earliestOld.has(l.close_id) ? earliestOld.get(l.close_id) : l.status_id
    return initial != null && QUALIFYING_INITIAL_STATUSES.has(initial)
  })
  if (qualifyingLeads.length === 0) return []
  const qualifyingMap = new Map(qualifyingLeads.map((l) => [l.close_id, l]))

  // Earliest outbound call by THIS user to each cohort lead.
  const lookbackEnd = new Date(new Date(range.endUtcIso).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
  const earliestCallByLead = new Map<string, string>()
  let from = 0
  for (;;) {
    const { data: page, error } = await sb
      .from('close_calls' as never)
      .select('lead_id, user_id, activity_at')
      .eq('direction', 'outbound')
      .eq('user_id', userId)
      .gte('activity_at', range.startUtcIso)
      .lt('activity_at', lookbackEnd)
      .order('activity_at', { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(`close_calls read failed: ${error.message}`)
    const rows = (page ?? []) as unknown as Array<{ lead_id: string; user_id: string; activity_at: string }>
    if (rows.length === 0) break
    for (const r of rows) {
      if (!qualifyingMap.has(r.lead_id)) continue
      if (!earliestCallByLead.has(r.lead_id)) earliestCallByLead.set(r.lead_id, r.activity_at)
    }
    if (rows.length < 1000) break
    from += 1000
  }

  const out: SpeedToLeadLeadRow[] = []
  earliestCallByLead.forEach((firstCallAt, leadId) => {
    const lead = qualifyingMap.get(leadId)
    if (!lead) return
    const createdMs = new Date(lead.date_created).getTime()
    const callMs = new Date(firstCallAt).getTime()
    if (!Number.isFinite(createdMs) || callMs < createdMs) return
    out.push({
      leadId,
      displayName: lead.display_name,
      leadCreatedAt: lead.date_created,
      firstCallAt,
      deltaSec: (callMs - createdMs) / 1000,
    })
  })
  // Slowest first — most useful for audit (find outliers).
  out.sort((a, b) => b.deltaSec - a.deltaSec)
  return out
}

function toSpeedRows(byUser: Map<string, number[]>, nameByUser: Map<string, string>): SpeedToLeadRow[] {
  const out: SpeedToLeadRow[] = []
  byUser.forEach((vals, userId) => {
    if (vals.length === 0) return
    // Cap outliers — speed >24h after creation is a stale callback,
    // not a "speed to lead" data point.
    const capped = vals.map((v) => Math.min(v, SPEED_CAP_SEC))
    const sum = capped.reduce((a, b) => a + b, 0)
    out.push({
      userId,
      name: nameByUser.get(userId) ?? null,
      callsAttributed: vals.length,
      avgSec: capped.length > 0 ? sum / capped.length : null,
    })
  })
  out.sort((a, b) => b.callsAttributed - a.callsAttributed)
  return out
}

function addDaysToEtDateStr(etDate: string, days: number): string {
  const [y, m, d] = etDate.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Triage metrics — per-rep + aggregate, for both closer + setter
// stages. Joins close_calls to close_leads to attribute each call
// to a role via the owner-id match.
// ---------------------------------------------------------------------------

type Outcome =
  | 'confirmedBooking'
  | 'handedOver'
  | 'disqualified'
  | 'downsell'

function classifyStatusFlip(newStatusId: string): Outcome | null {
  if (newStatusId === STATUS.confirmedBooking) return 'confirmedBooking'
  if (newStatusId === STATUS.handedOver) return 'handedOver'
  if (newStatusId === STATUS.disqualifiedLead) return 'disqualified'
  if (newStatusId === STATUS.downsell) return 'downsell'
  return null
}

// ---------------------------------------------------------------------------
// Triage Calls (new Airtable-sourced model)
//
// Outcomes from airtable_setter_triage_calls.booking_status — even
// though "setter triage" is in the form name, closers (Aman) also
// fill this form when they triage. The dashboard routes each rep
// into setters/closers via the standard resolveRole() helper.
//
// Bucket mapping per Drake:
//   - "Confirmed Booked with Closer" → bookings
//   - "Disqualified Lead"            → dqs
//   - "Downsell" (was "Digital College") → downsells
//   - "Follow Up" / "Follow-Up"      → followUps (empty as of 2026-05-25)
//
// Volume + connect-rate continue to come from close_calls — the
// Airtable form is filled only on connected calls, so it doesn't
// give us "total outbound dials" / "no-answer rate." Pair the two
// sources per rep.
// ---------------------------------------------------------------------------

export type TriageRepRow = {
  userId: string | null    // null for the aggregate row
  name: string | null
  totalCalls: number       // close_calls outbound by user_id in window
  totalConnects: number    // same + duration > 0
  connectRate: number | null
  bookings: number         // outcomes from Airtable form
  dqs: number
  downsells: number
  followUps: number
}

export type TriageMetricsResult = {
  setters: TriageRepRow[]
  closers: TriageRepRow[]
  settersAggregate: TriageRepRow
  closersAggregate: TriageRepRow
  // Sparseness signal — surfaced on the page so users know to
  // expect mostly-empty outcome cells while form adoption ramps.
  totalFormsInWindow: number
}

// ---------------------------------------------------------------------------
// Speed-to-Lead (per-lead) — its own section, NOT split by caller.
//
// Cohort: leads created in the window with initial status New Opt-in
// or Unconfirmed Booking. For each lead, find the earliest outbound
// call (any caller, any duration). Top-level: avg speed-to-lead +
// connection rate of those first calls. Drill: one row per lead with
// prospect / created / called / connected Y/N / caller name.
//
// Caller filter narrows the drill rows to leads where the first
// caller was the selected user. The aggregate stats (avg + rate)
// recompute against the filtered subset so what you see matches
// what the drill shows.
// ---------------------------------------------------------------------------

export type SpeedToLeadCohortRow = {
  leadId: string
  prospectName: string | null
  leadCreatedAt: string             // ISO UTC
  firstCallAt: string | null        // null if no outbound call yet
  firstCallOver90s: boolean         // duration > 90s
  callerUserId: string | null
  callerName: string | null
  speedSec: number | null           // null if no first call
}

export type SpeedToLeadCohortResult = {
  cohortSize: number
  leadsCalled: number               // had ≥1 outbound call
  leadsOver90s: number               // first call duration > 90s
  avgSpeedToLeadSec: number | null  // mean of speedSec (24h cap on outliers)
  over90sRate: number | null        // leadsOver90s / leadsCalled
  // All callers that appear in the cohort — drives the filter dropdown.
  // userId may be null for leads where we couldn't resolve a caller.
  callers: Array<{ userId: string; name: string | null; leadCount: number }>
  // The actual per-lead rows. Already filtered if `callerFilter` was
  // passed in. The page caps to 10 client-side via see-more.
  rows: SpeedToLeadCohortRow[]
}

export async function getSpeedToLeadCohort(
  arg: Window | DateRange,
  callerFilter?: string | null,
): Promise<SpeedToLeadCohortResult> {
  const range = resolveRange(arg)
  const sb = createAdminClient()

  // Cohort: leads created in window with qualifying initial status.
  const { data: leads, error: leadsErr } = await sb
    .from('close_leads' as never)
    .select('close_id, display_name, date_created, status_id')
    .gte('date_created', range.startUtcIso)
    .lt('date_created', range.endUtcIso)
    .range(0, 9999)
  if (leadsErr) throw new Error(`close_leads read failed: ${leadsErr.message}`)
  const leadRows = (leads ?? []) as unknown as Array<{
    close_id: string
    display_name: string | null
    date_created: string
    status_id: string | null
  }>
  if (leadRows.length === 0) {
    return { cohortSize: 0, leadsCalled: 0, leadsOver90s: 0, avgSpeedToLeadSec: null, over90sRate: null, callers: [], rows: [] }
  }
  const leadIdSet = new Set(leadRows.map((l) => l.close_id))

  // Initial-status qualification — same logic as the per-rep speed
  // calc (earliest old_status_id from status changes, or current
  // status_id if no change exists).
  const earliestOld = new Map<string, string | null>()
  {
    const scStart = range.startUtcIso
    const scEnd = new Date(new Date(range.endUtcIso).getTime() + 14 * 24 * 60 * 60 * 1000).toISOString()
    let scFrom = 0
    for (;;) {
      const { data: page, error } = await sb
        .from('close_lead_status_changes' as never)
        .select('lead_id, old_status_id, date_created')
        .gte('date_created', scStart)
        .lt('date_created', scEnd)
        .order('date_created', { ascending: true })
        .range(scFrom, scFrom + 999)
      if (error) throw new Error(`status changes read failed: ${error.message}`)
      const rows = (page ?? []) as unknown as Array<{ lead_id: string; old_status_id: string | null; date_created: string }>
      if (rows.length === 0) break
      for (const r of rows) {
        if (!leadIdSet.has(r.lead_id)) continue
        if (!earliestOld.has(r.lead_id)) earliestOld.set(r.lead_id, r.old_status_id)
      }
      if (rows.length < 1000) break
      scFrom += 1000
    }
  }
  const qualifyingLeads = leadRows.filter((l) => {
    const initial = earliestOld.has(l.close_id) ? earliestOld.get(l.close_id) : l.status_id
    return initial != null && QUALIFYING_INITIAL_STATUSES.has(initial)
  })
  if (qualifyingLeads.length === 0) {
    return { cohortSize: 0, leadsCalled: 0, leadsOver90s: 0, avgSpeedToLeadSec: null, over90sRate: null, callers: [], rows: [] }
  }
  const qualifyingMap = new Map(qualifyingLeads.map((l) => [l.close_id, l]))

  // First outbound call per qualifying lead (any caller).
  const firstCallByLead = new Map<string, { userId: string | null; activity_at: string; duration: number | null }>()
  const nameByUser = new Map<string, string>()
  {
    let from = 0
    const lookbackEnd = new Date(new Date(range.endUtcIso).getTime() + 30 * 24 * 60 * 60 * 1000).toISOString()
    for (;;) {
      const { data: page, error } = await sb
        .from('close_calls' as never)
        .select('lead_id, user_id, activity_at, duration, raw_payload')
        .eq('direction', 'outbound')
        .gte('activity_at', range.startUtcIso)
        .lt('activity_at', lookbackEnd)
        .order('activity_at', { ascending: true })
        .range(from, from + 999)
      if (error) throw new Error(`close_calls read failed: ${error.message}`)
      const rows = (page ?? []) as unknown as Array<{
        lead_id: string
        user_id: string | null
        activity_at: string
        duration: number | null
        raw_payload: { user_name?: string } | null
      }>
      if (rows.length === 0) break
      for (const r of rows) {
        if (!qualifyingMap.has(r.lead_id)) continue
        if (r.user_id && r.raw_payload?.user_name && !nameByUser.has(r.user_id)) {
          nameByUser.set(r.user_id, r.raw_payload.user_name)
        }
        if (!firstCallByLead.has(r.lead_id)) {
          firstCallByLead.set(r.lead_id, { userId: r.user_id, activity_at: r.activity_at, duration: r.duration })
        }
      }
      if (rows.length < 1000) break
      from += 1000
    }
  }

  // Prospect names from Airtable form (any form row matching by
  // lead_id). Form prospect_name beats lead.display_name when both
  // are present — the form was filled by a human who confirmed it.
  const prospectFromForm = new Map<string, string>()
  {
    const leadIds = Array.from(qualifyingMap.keys())
    for (let i = 0; i < leadIds.length; i += 100) {
      const chunk = leadIds.slice(i, i + 100)
      const { data, error } = await sb
        .from('airtable_setter_triage_calls' as never)
        .select('lead_id, prospect_name')
        .in('lead_id', chunk)
        .not('prospect_name', 'is', null)
      if (error) throw new Error(`airtable prospect lookup failed: ${error.message}`)
      for (const r of (data ?? []) as unknown as Array<{ lead_id: string; prospect_name: string | null }>) {
        if (r.lead_id && r.prospect_name && !prospectFromForm.has(r.lead_id)) {
          prospectFromForm.set(r.lead_id, r.prospect_name)
        }
      }
    }
  }

  // Build per-lead rows (full cohort, pre-filter).
  const allRows: SpeedToLeadCohortRow[] = []
  for (const lead of qualifyingLeads) {
    const call = firstCallByLead.get(lead.close_id)
    let speedSec: number | null = null
    if (call) {
      const dt = (new Date(call.activity_at).getTime() - new Date(lead.date_created).getTime()) / 1000
      if (Number.isFinite(dt) && dt >= 0) speedSec = dt
    }
    allRows.push({
      leadId: lead.close_id,
      prospectName: prospectFromForm.get(lead.close_id) ?? lead.display_name ?? null,
      leadCreatedAt: lead.date_created,
      firstCallAt: call?.activity_at ?? null,
      firstCallOver90s: call ? (call.duration ?? 0) > 90 : false,
      callerUserId: call?.userId ?? null,
      callerName: call?.userId ? (nameByUser.get(call.userId) ?? null) : null,
      speedSec,
    })
  }

  // Callers list (for the filter dropdown). Counts leads per caller
  // across the cohort regardless of any active filter.
  const callerCounts = new Map<string, number>()
  for (const r of allRows) {
    if (!r.callerUserId) continue
    callerCounts.set(r.callerUserId, (callerCounts.get(r.callerUserId) ?? 0) + 1)
  }
  const callers = Array.from(callerCounts.entries())
    .map(([userId, leadCount]) => ({ userId, name: nameByUser.get(userId) ?? null, leadCount }))
    .sort((a, b) => b.leadCount - a.leadCount)

  // Apply caller filter (if set). Aggregate stats recompute on the
  // filtered subset so the top-line matches the visible drill.
  const filteredRows = callerFilter
    ? allRows.filter((r) => r.callerUserId === callerFilter)
    : allRows

  let cappedSum = 0
  let speedN = 0
  let over90sCount = 0
  let calledCount = 0
  for (const r of filteredRows) {
    if (r.speedSec !== null) {
      cappedSum += Math.min(r.speedSec, SPEED_CAP_SEC)
      speedN++
    }
    if (r.firstCallAt) calledCount++
    if (r.firstCallOver90s) over90sCount++
  }

  // Sort rows: most recent first call first; leads without calls go
  // to the bottom.
  filteredRows.sort((a, b) => {
    if (a.firstCallAt && b.firstCallAt) return a.firstCallAt < b.firstCallAt ? 1 : -1
    if (a.firstCallAt) return -1
    if (b.firstCallAt) return 1
    return 0
  })

  return {
    cohortSize: filteredRows.length,
    leadsCalled: calledCount,
    leadsOver90s: over90sCount,
    avgSpeedToLeadSec: speedN > 0 ? cappedSum / speedN : null,
    over90sRate: calledCount > 0 ? over90sCount / calledCount : null,
    callers,
    rows: filteredRows,
  }
}

// ---------------------------------------------------------------------------
// Call Activity — merged speed-to-lead + triage outcomes per rep.
//
// Top-level columns per rep: Calls / Connects / Books / DQs /
// Downsells / Follow-ups / Avg Speed-to-Lead. Drill columns:
// Prospect / Time of call / Speed delta / Call duration / Outcome.
//
// Volume + connect count from close_calls (outbound, in window).
// Speed = (rep's earliest call to each lead - lead.date_created),
// per-user-per-lead, capped at 24h for the aggregate avg.
// Outcomes from airtable_setter_triage_calls.booking_status:
//   - "Confirmed Booked with Closer" → bookings
//   - "Disqualified Lead"            → dqs
//   - "Downsell"                     → downsells
//   - "Follow Up" / "Follow-Up"      → followUps
// Outcomes attributed to whoever filled the form (setter_names).
// ---------------------------------------------------------------------------

export type CallActivityRepRow = {
  userId: string | null
  name: string | null
  totalCalls: number
  totalOver90s: number
  bookings: number
  dqs: number
  downsells: number
  followUps: number
}

export type CallActivityResult = {
  setters: CallActivityRepRow[]
  closers: CallActivityRepRow[]
  settersAggregate: CallActivityRepRow
  closersAggregate: CallActivityRepRow
  totalFormsInWindow: number
}

export type CallActivityDrillRow = {
  callId: string                       // close_calls.close_id — React key
  leadId: string
  prospectName: string | null
  callAt: string                       // ISO UTC of this call
  durationSec: number                  // call duration, > 90 (filtered upstream)
  bookingStatus: string | null
  bucket: TriageCallDrillRow['bucket']
}

export async function getCallActivityMetrics(arg: Window | DateRange): Promise<CallActivityResult> {
  const range = resolveRange(arg)
  const sb = createAdminClient()

  // Global role index — same source as triage/speed.
  const { data: ownerRows, error: ownerErr } = await sb
    .from('close_leads' as never)
    .select('closer_owner_id, setter_owner_id')
    .or('closer_owner_id.not.is.null,setter_owner_id.not.is.null')
    .range(0, 19999)
  if (ownerErr) throw new Error(`close_leads owner read failed: ${ownerErr.message}`)
  const closerUsers = new Set<string>()
  const setterUsers = new Set<string>()
  for (const r of (ownerRows ?? []) as unknown as Array<{ closer_owner_id: string | null; setter_owner_id: string | null }>) {
    if (r.closer_owner_id) closerUsers.add(r.closer_owner_id)
    if (r.setter_owner_id) setterUsers.add(r.setter_owner_id)
  }

  // Pull all outbound calls in window — per-rep volume + calls over
  // 90s. Speed-to-lead lives in its own section now; we only need the
  // call-level stats here.
  type Vol = { calls: number; over90s: number }
  const volumeByUser = new Map<string, Vol>()
  const nameByUser = new Map<string, string>()
  const userIdByName = new Map<string, string>()
  {
    let from = 0
    for (;;) {
      const { data: page, error } = await sb
        .from('close_calls' as never)
        .select('user_id, duration, raw_payload')
        .eq('direction', 'outbound')
        .not('user_id', 'is', null)
        .gte('activity_at', range.startUtcIso)
        .lt('activity_at', range.endUtcIso)
        .range(from, from + 999)
      if (error) throw new Error(`close_calls read failed: ${error.message}`)
      const rows = (page ?? []) as unknown as Array<{
        user_id: string
        duration: number | null
        raw_payload: { user_name?: string } | null
      }>
      if (rows.length === 0) break
      for (const r of rows) {
        if (!volumeByUser.has(r.user_id)) volumeByUser.set(r.user_id, { calls: 0, over90s: 0 })
        const v = volumeByUser.get(r.user_id)!
        v.calls++
        if ((r.duration ?? 0) > 90) v.over90s++

        const nm = r.raw_payload?.user_name
        if (nm && !nameByUser.has(r.user_id)) {
          nameByUser.set(r.user_id, nm)
          userIdByName.set(nm, r.user_id)
        }
      }
      if (rows.length < 1000) break
      from += 1000
    }
  }

  // Outcomes from Airtable form — attributed to whoever filled it
  // (setter_names → user_id via name lookup).
  //
  // Dedupe by lead_id, keeping the most-recent form per lead. Mirrors
  // what Airtable's default view shows: when a lead has multiple forms
  // (e.g., one setter marks Confirmed-Booked, another later marks DQ),
  // only the latest outcome counts. Rows missing lead_id are dropped
  // — those are typically empty/junk submissions.
  type Outcomes = { bookings: number; dqs: number; downsells: number; followUps: number }
  const newOutcomes = (): Outcomes => ({ bookings: 0, dqs: 0, downsells: 0, followUps: 0 })
  const outcomesByUser = new Map<string, Outcomes>()
  let totalForms = 0
  {
    type FormRow = { lead_id: string | null; booking_status: string | null; setter_names: string[] | null; airtable_created_at: string }
    const allRows: FormRow[] = []
    let from = 0
    for (;;) {
      const { data: page, error } = await sb
        .from('airtable_setter_triage_calls' as never)
        .select('lead_id, booking_status, setter_names, airtable_created_at')
        .gte('airtable_created_at', range.startUtcIso)
        .lt('airtable_created_at', range.endUtcIso)
        .range(from, from + 999)
      if (error) throw new Error(`airtable_setter_triage_calls read failed: ${error.message}`)
      const rows = (page ?? []) as unknown as FormRow[]
      if (rows.length === 0) break
      allRows.push(...rows)
      if (rows.length < 1000) break
      from += 1000
    }
    totalForms = allRows.length

    // Dedupe by lead_id (latest airtable_created_at wins). Drop rows
    // with no lead_id — those are empty/junk submissions Airtable's
    // own views also exclude.
    const latestByLead = new Map<string, FormRow>()
    for (const r of allRows) {
      if (!r.lead_id) continue
      const existing = latestByLead.get(r.lead_id)
      if (!existing || r.airtable_created_at > existing.airtable_created_at) {
        latestByLead.set(r.lead_id, r)
      }
    }
    latestByLead.forEach((r) => {
      const bucket = classifyBookingStatus(r.booking_status)
      if (bucket === 'unclassified') return
      for (const nm of (r.setter_names ?? [])) {
        const uid = userIdByName.get(nm)
        if (!uid) continue
        if (!outcomesByUser.has(uid)) outcomesByUser.set(uid, newOutcomes())
        outcomesByUser.get(uid)![bucket]++
      }
    })
  }

  // Compose per-rep rows.
  const setters: CallActivityRepRow[] = []
  const closers: CallActivityRepRow[] = []
  const allUserIds = new Set<string>([
    ...Array.from(volumeByUser.keys()),
    ...Array.from(outcomesByUser.keys()),
  ])
  allUserIds.forEach((userId) => {
    const role = resolveRole(userId, closerUsers, setterUsers)
    if (!role) return
    const v = volumeByUser.get(userId) ?? { calls: 0, over90s: 0 }
    const o = outcomesByUser.get(userId) ?? newOutcomes()
    const row: CallActivityRepRow = {
      userId,
      name: nameByUser.get(userId) ?? null,
      totalCalls: v.calls,
      totalOver90s: v.over90s,
      bookings: o.bookings,
      dqs: o.dqs,
      downsells: o.downsells,
      followUps: o.followUps,
    }
    if (role === 'setter') setters.push(row)
    else closers.push(row)
  })
  setters.sort((a, b) => b.totalCalls - a.totalCalls)
  closers.sort((a, b) => b.totalCalls - a.totalCalls)

  return {
    setters,
    closers,
    settersAggregate: aggregateCallActivity(setters),
    closersAggregate: aggregateCallActivity(closers),
    totalFormsInWindow: totalForms,
  }
}

function aggregateCallActivity(rows: CallActivityRepRow[]): CallActivityRepRow {
  let calls = 0, over90s = 0, bookings = 0, dqs = 0, downsells = 0, followUps = 0
  for (const r of rows) {
    calls += r.totalCalls
    over90s += r.totalOver90s
    bookings += r.bookings
    dqs += r.dqs
    downsells += r.downsells
    followUps += r.followUps
  }
  return {
    userId: null,
    name: null,
    totalCalls: calls,
    totalOver90s: over90s,
    bookings,
    dqs,
    downsells,
    followUps,
  }
}

// Drill: for one rep, return one row per outbound call with
// duration > 90s in the window. Outcome looked up per-lead from any
// Airtable form row, regardless of who filled it (drill shows what
// HAPPENED to the lead, not who reported).
export async function getCallActivityForUser(
  arg: Window | DateRange,
  userId: string,
): Promise<CallActivityDrillRow[]> {
  const range = resolveRange(arg)
  const sb = createAdminClient()

  // Every outbound call by this rep in window with duration > 90s.
  type RawCall = { callId: string; leadId: string; activityAt: string; durationSec: number }
  const calls: RawCall[] = []
  {
    let from = 0
    for (;;) {
      const { data: page, error } = await sb
        .from('close_calls' as never)
        .select('close_id, lead_id, activity_at, duration')
        .eq('direction', 'outbound')
        .eq('user_id', userId)
        .gt('duration', 90)
        .gte('activity_at', range.startUtcIso)
        .lt('activity_at', range.endUtcIso)
        .order('activity_at', { ascending: false })
        .range(from, from + 999)
      if (error) throw new Error(`close_calls (drill) read failed: ${error.message}`)
      const rows = (page ?? []) as unknown as Array<{ close_id: string; lead_id: string; activity_at: string; duration: number | null }>
      if (rows.length === 0) break
      for (const r of rows) {
        if (r.duration == null) continue
        calls.push({
          callId: r.close_id,
          leadId: r.lead_id,
          activityAt: r.activity_at,
          durationSec: r.duration,
        })
      }
      if (rows.length < 1000) break
      from += 1000
    }
  }
  if (calls.length === 0) return []

  // Distinct lead ids for prospect-name + outcome lookups.
  const leadIds = Array.from(new Set(calls.map((c) => c.leadId)))

  // Lead display names.
  const leadName = new Map<string, string | null>()
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, display_name')
      .in('close_id', chunk)
    if (error) throw new Error(`close_leads (drill) read failed: ${error.message}`)
    for (const l of (data ?? []) as unknown as Array<{ close_id: string; display_name: string | null }>) {
      leadName.set(l.close_id, l.display_name)
    }
  }

  // Outcomes per lead from Airtable form (most recent row wins).
  const outcomeByLead = new Map<string, { bookingStatus: string | null; prospectName: string | null }>()
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const { data, error } = await sb
      .from('airtable_setter_triage_calls' as never)
      .select('lead_id, booking_status, prospect_name, airtable_created_at')
      .in('lead_id', chunk)
      .order('airtable_created_at', { ascending: false })
    if (error) throw new Error(`airtable (drill) read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{ lead_id: string; booking_status: string | null; prospect_name: string | null }>) {
      if (!r.lead_id) continue
      if (!outcomeByLead.has(r.lead_id)) {
        outcomeByLead.set(r.lead_id, { bookingStatus: r.booking_status, prospectName: r.prospect_name })
      }
    }
  }

  // Compose. Form prospect_name wins over close_leads.display_name.
  return calls.map((c) => {
    const form = outcomeByLead.get(c.leadId)
    return {
      callId: c.callId,
      leadId: c.leadId,
      prospectName: form?.prospectName ?? leadName.get(c.leadId) ?? null,
      callAt: c.activityAt,
      durationSec: c.durationSec,
      bookingStatus: form?.bookingStatus ?? null,
      bucket: classifyBookingStatus(form?.bookingStatus ?? null),
    }
  })
}

export type TriageCallDrillRow = {
  recordId: string
  prospectName: string | null
  occurredAtIso: string    // event_date_time if set, else airtable_created_at
  bookingStatus: string | null
  bucket: 'bookings' | 'dqs' | 'downsells' | 'followUps' | 'unclassified'
}

function classifyBookingStatus(bs: string | null): TriageCallDrillRow['bucket'] {
  if (!bs) return 'unclassified'
  const s = bs.toLowerCase()
  if (s.includes('confirmed booked')) return 'bookings'
  if (s.includes('disqualif')) return 'dqs'
  if (s.includes('downsell') || s.includes('digital college')) return 'downsells'
  if (s.includes('follow')) return 'followUps'
  return 'unclassified'
}

export async function getTriageMetrics(arg: Window | DateRange): Promise<TriageMetricsResult> {
  const range = resolveRange(arg)
  const sb = createAdminClient()

  // Global role index (same source as speed-to-lead).
  const { data: ownerRows, error: ownerErr } = await sb
    .from('close_leads' as never)
    .select('closer_owner_id, setter_owner_id')
    .or('closer_owner_id.not.is.null,setter_owner_id.not.is.null')
    .range(0, 19999)
  if (ownerErr) throw new Error(`close_leads owner read failed: ${ownerErr.message}`)
  const closerUsers = new Set<string>()
  const setterUsers = new Set<string>()
  for (const r of (ownerRows ?? []) as unknown as Array<{ closer_owner_id: string | null; setter_owner_id: string | null }>) {
    if (r.closer_owner_id) closerUsers.add(r.closer_owner_id)
    if (r.setter_owner_id) setterUsers.add(r.setter_owner_id)
  }

  // Volume side: outbound calls in window, per user. Also build the
  // user_id → name map AND the name → user_id reverse lookup so we
  // can join Airtable's setter_names back to a Close user_id.
  type Volume = { calls: number; connects: number }
  const volumeByUser = new Map<string, Volume>()
  const nameByUser = new Map<string, string>()
  const userIdByName = new Map<string, string>()
  let from = 0
  for (;;) {
    const { data: page, error } = await sb
      .from('close_calls' as never)
      .select('user_id, duration, raw_payload')
      .eq('direction', 'outbound')
      .not('user_id', 'is', null)
      .gte('activity_at', range.startUtcIso)
      .lt('activity_at', range.endUtcIso)
      .range(from, from + 999)
    if (error) throw new Error(`close_calls read failed: ${error.message}`)
    const rows = (page ?? []) as unknown as Array<{ user_id: string; duration: number | null; raw_payload: { user_name?: string } | null }>
    if (rows.length === 0) break
    for (const r of rows) {
      if (!volumeByUser.has(r.user_id)) volumeByUser.set(r.user_id, { calls: 0, connects: 0 })
      const v = volumeByUser.get(r.user_id)!
      v.calls++
      if ((r.duration ?? 0) > 0) v.connects++
      const nm = r.raw_payload?.user_name
      if (nm && !nameByUser.has(r.user_id)) {
        nameByUser.set(r.user_id, nm)
        userIdByName.set(nm, r.user_id)
      }
    }
    if (rows.length < 1000) break
    from += 1000
  }

  // Outcomes side: Airtable form rows in window. Each row's setter
  // is mapped back to a Close user_id by name.
  type Outcomes = { bookings: number; dqs: number; downsells: number; followUps: number }
  const newOutcomes = (): Outcomes => ({ bookings: 0, dqs: 0, downsells: 0, followUps: 0 })
  const outcomesByUser = new Map<string, Outcomes>()
  let totalForms = 0
  let formFrom = 0
  for (;;) {
    const { data: page, error } = await sb
      .from('airtable_setter_triage_calls' as never)
      .select('record_id, booking_status, setter_names, airtable_created_at')
      .gte('airtable_created_at', range.startUtcIso)
      .lt('airtable_created_at', range.endUtcIso)
      .range(formFrom, formFrom + 999)
    if (error) throw new Error(`airtable_setter_triage_calls read failed: ${error.message}`)
    const rows = (page ?? []) as unknown as Array<{ record_id: string; booking_status: string | null; setter_names: string[] | null; airtable_created_at: string }>
    if (rows.length === 0) break
    totalForms += rows.length
    for (const r of rows) {
      const bucket = classifyBookingStatus(r.booking_status)
      if (bucket === 'unclassified') continue
      const names = r.setter_names ?? []
      // One outcome per form-row. If multiple setter_names, credit
      // each (rare; usually just one). Could double-count if a row
      // legitimately has two reps.
      for (const nm of names) {
        const uid = userIdByName.get(nm)
        if (!uid) continue
        if (!outcomesByUser.has(uid)) outcomesByUser.set(uid, newOutcomes())
        outcomesByUser.get(uid)![bucket]++
      }
    }
    if (rows.length < 1000) break
    formFrom += 1000
  }

  // Merge volume + outcomes per user; route to setters/closers.
  const setterRows: TriageRepRow[] = []
  const closerRows: TriageRepRow[] = []
  const allUserIds = new Set<string>([
    ...Array.from(volumeByUser.keys()),
    ...Array.from(outcomesByUser.keys()),
  ])
  allUserIds.forEach((userId) => {
    const role = resolveRole(userId, closerUsers, setterUsers)
    if (!role) return
    const v = volumeByUser.get(userId) ?? { calls: 0, connects: 0 }
    const o = outcomesByUser.get(userId) ?? newOutcomes()
    const row: TriageRepRow = {
      userId,
      name: nameByUser.get(userId) ?? null,
      totalCalls: v.calls,
      totalConnects: v.connects,
      connectRate: v.calls > 0 ? v.connects / v.calls : null,
      bookings: o.bookings,
      dqs: o.dqs,
      downsells: o.downsells,
      followUps: o.followUps,
    }
    if (role === 'setter') setterRows.push(row)
    else closerRows.push(row)
  })
  setterRows.sort((a, b) => b.totalCalls - a.totalCalls)
  closerRows.sort((a, b) => b.totalCalls - a.totalCalls)

  return {
    setters: setterRows,
    closers: closerRows,
    settersAggregate: aggregateRows(setterRows),
    closersAggregate: aggregateRows(closerRows),
    totalFormsInWindow: totalForms,
  }
}

function aggregateRows(rows: TriageRepRow[]): TriageRepRow {
  const totals = { totalCalls: 0, totalConnects: 0, bookings: 0, dqs: 0, downsells: 0, followUps: 0 }
  for (const r of rows) {
    totals.totalCalls += r.totalCalls
    totals.totalConnects += r.totalConnects
    totals.bookings += r.bookings
    totals.dqs += r.dqs
    totals.downsells += r.downsells
    totals.followUps += r.followUps
  }
  return {
    userId: null,
    name: null,
    totalCalls: totals.totalCalls,
    totalConnects: totals.totalConnects,
    connectRate: totals.totalCalls > 0 ? totals.totalConnects / totals.totalCalls : null,
    bookings: totals.bookings,
    dqs: totals.dqs,
    downsells: totals.downsells,
    followUps: totals.followUps,
  }
}

// Drill-down: list this rep's Airtable form rows in the window so
// the page can show their calls (prospect, time, outcome).
export async function getTriageCallsForUser(
  arg: Window | DateRange,
  userId: string,
): Promise<TriageCallDrillRow[]> {
  const range = resolveRange(arg)
  const sb = createAdminClient()

  // Find this user's display name from close_calls.raw_payload.
  // Could match multiple names if the user has had a name change;
  // collect the set.
  const knownNames = new Set<string>()
  let from = 0
  for (;;) {
    const { data: page, error } = await sb
      .from('close_calls' as never)
      .select('raw_payload')
      .eq('user_id', userId)
      .not('raw_payload', 'is', null)
      .range(from, from + 199)
    if (error) throw new Error(`close_calls name lookup failed: ${error.message}`)
    const rows = (page ?? []) as unknown as Array<{ raw_payload: { user_name?: string } | null }>
    if (rows.length === 0) break
    for (const r of rows) {
      const nm = r.raw_payload?.user_name
      if (nm) knownNames.add(nm)
    }
    if (rows.length < 200) break
    from += 200
  }
  if (knownNames.size === 0) return []

  // Pull all Airtable rows in window; filter in JS by setter_names
  // overlap with knownNames (Postgres array overlap via .ov() is
  // possible but JS is fine for the form's small size).
  const out: TriageCallDrillRow[] = []
  let af = 0
  for (;;) {
    const { data: page, error } = await sb
      .from('airtable_setter_triage_calls' as never)
      .select('record_id, prospect_name, booking_status, setter_names, event_date_time, airtable_created_at')
      .gte('airtable_created_at', range.startUtcIso)
      .lt('airtable_created_at', range.endUtcIso)
      .order('airtable_created_at', { ascending: false })
      .range(af, af + 999)
    if (error) throw new Error(`airtable_setter_triage_calls drill read failed: ${error.message}`)
    const rows = (page ?? []) as unknown as Array<{
      record_id: string
      prospect_name: string | null
      booking_status: string | null
      setter_names: string[] | null
      event_date_time: string | null
      airtable_created_at: string
    }>
    if (rows.length === 0) break
    for (const r of rows) {
      const namesHere = r.setter_names ?? []
      if (!namesHere.some((n) => knownNames.has(n))) continue
      out.push({
        recordId: r.record_id,
        prospectName: r.prospect_name,
        occurredAtIso: r.event_date_time ?? r.airtable_created_at,
        bookingStatus: r.booking_status,
        bucket: classifyBookingStatus(r.booking_status),
      })
    }
    if (rows.length < 1000) break
    af += 1000
  }
  return out
}

export type CloserTriageRow = {
  userId: string | null      // null for the aggregate row
  name: string | null
  totalCalls: number
  connects: number
  connectRate: number | null
  confirmedBooking: number   // outcomes from status flips within 7d of a connect
  handedOver: number
  triageDq: number
}

export type SetterTriageRow = {
  userId: string | null
  name: string | null
  totalDials: number
  connects: number
  connectRate: number | null
  booked: number
  digitalCollege: number
  dq: number
  followUp: number | null    // null = "not captured yet" (Airtable-form-pending)
}

export type AppointmentSettingMetrics = {
  closerAggregate: CloserTriageRow
  setterAggregate: SetterTriageRow
  perCloser: CloserTriageRow[]
  perSetter: SetterTriageRow[]
}

export async function getAppointmentSettingMetrics(arg: Window | DateRange): Promise<AppointmentSettingMetrics> {
  const range = resolveRange(arg)
  const sb = createAdminClient()

  // Build the global role index from close_leads owner fields.
  // Used as a FALLBACK when the call's specific lead doesn't have
  // owner_id set (majority of leads — only ~30% have owner_ids
  // populated in the probe). A user_id classified as setter-only
  // globally will have all their unattributed calls counted as
  // setter dials; same for closer-only. Users in BOTH sets fall
  // back to "unknown" when the lead is unowned (we can't infer
  // which hat they're wearing).
  const { data: ownerRows, error: ownerErr } = await sb
    .from('close_leads' as never)
    .select('closer_owner_id, setter_owner_id')
    .or('closer_owner_id.not.is.null,setter_owner_id.not.is.null')
    .range(0, 19999)
  if (ownerErr) throw new Error(`close_leads owner read failed: ${ownerErr.message}`)
  const closerUsers = new Set<string>()
  const setterUsers = new Set<string>()
  for (const r of (ownerRows ?? []) as unknown as Array<{ closer_owner_id: string | null; setter_owner_id: string | null }>) {
    if (r.closer_owner_id) closerUsers.add(r.closer_owner_id)
    if (r.setter_owner_id) setterUsers.add(r.setter_owner_id)
  }

  // Pull every outbound call in the window + raw_payload so we can
  // resolve user_id → user_name in the same pass.
  const { data: calls, error: callsErr } = await sb
    .from('close_calls' as never)
    .select('close_id, lead_id, user_id, duration, activity_at, raw_payload')
    .eq('direction', 'outbound')
    .not('user_id', 'is', null)
    .gte('activity_at', range.startUtcIso)
    .lt('activity_at', range.endUtcIso)
    .range(0, 19999)
  if (callsErr) throw new Error(`close_calls read failed: ${callsErr.message}`)
  const callRows = (calls ?? []) as unknown as Array<{
    close_id: string
    lead_id: string
    user_id: string
    duration: number | null
    activity_at: string
    raw_payload: { user_name?: string } | null
  }>

  // Build the user_id → name map opportunistically.
  const nameByUser = new Map<string, string>()
  for (const c of callRows) {
    if (c.raw_payload?.user_name && !nameByUser.has(c.user_id)) {
      nameByUser.set(c.user_id, c.raw_payload.user_name)
    }
  }

  if (callRows.length === 0) {
    return {
      closerAggregate: emptyCloserRow(null),
      setterAggregate: emptySetterRow(null),
      perCloser: [],
      perSetter: [],
    }
  }

  // Look up each call's lead to find the owner ids — pull in
  // batches of 100 ids to keep PostgREST URI length safe.
  const leadIds = Array.from(new Set(callRows.map((c) => c.lead_id)))
  const ownerByLead = new Map<string, { closer: string | null; setter: string | null }>()
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const { data: leads, error: leadsErr } = await sb
      .from('close_leads' as never)
      .select('close_id, closer_owner_id, setter_owner_id')
      .in('close_id', chunk)
    if (leadsErr) throw new Error(`close_leads read failed: ${leadsErr.message}`)
    for (const l of (leads ?? []) as unknown as Array<{ close_id: string; closer_owner_id: string | null; setter_owner_id: string | null }>) {
      ownerByLead.set(l.close_id, { closer: l.closer_owner_id, setter: l.setter_owner_id })
    }
  }

  // Pull status changes that happened DURING the window or in the
  // 7-day post-window lookback. Page the lookup rather than passing
  // every lead_id in a `.in()`.
  const statusUpper = new Date(new Date(range.endUtcIso).getTime() + STATUS_LOOKBACK_MS).toISOString()
  const scByLead = new Map<string, Array<{ new_status_id: string; date_created: string }>>()
  const leadIdSet = new Set(leadIds)
  {
    let from = 0
    const PAGE = 1000
    for (;;) {
      const { data: page, error: scErr } = await sb
        .from('close_lead_status_changes' as never)
        .select('lead_id, new_status_id, date_created')
        .gte('date_created', range.startUtcIso)
        .lt('date_created', statusUpper)
        .order('date_created', { ascending: true })
        .range(from, from + PAGE - 1)
      if (scErr) throw new Error(`close_lead_status_changes read failed: ${scErr.message}`)
      const rows = (page ?? []) as unknown as Array<{ lead_id: string; new_status_id: string; date_created: string }>
      if (rows.length === 0) break
      for (const r of rows) {
        if (!leadIdSet.has(r.lead_id)) continue
        const arr = scByLead.get(r.lead_id) ?? []
        arr.push({ new_status_id: r.new_status_id, date_created: r.date_created })
        scByLead.set(r.lead_id, arr)
      }
      if (rows.length < PAGE) break
      from += PAGE
    }
  }

  // Aggregation buckets.
  type Acc = { calls: number; connects: number; outcomes: Record<Outcome, number> }
  const newAcc = (): Acc => ({ calls: 0, connects: 0, outcomes: { confirmedBooking: 0, handedOver: 0, disqualified: 0, downsell: 0 } })
  const closerAgg = newAcc()
  const setterAgg = newAcc()
  const closerByUser = new Map<string, Acc>()
  const setterByUser = new Map<string, Acc>()

  for (const call of callRows) {
    // Per-lead-owner match first; fall back to user's global role.
    const owners = ownerByLead.get(call.lead_id)
    let isCloserCall = false
    let isSetterCall = false
    if (owners) {
      if (owners.closer != null && owners.closer === call.user_id) isCloserCall = true
      else if (owners.setter != null && owners.setter === call.user_id) isSetterCall = true
    }
    if (!isCloserCall && !isSetterCall) {
      // Fallback: user's resolved role (includes the explicit
      // override map for dual-role users like Aman).
      const role = resolveRole(call.user_id, closerUsers, setterUsers)
      if (role === 'closer') isCloserCall = true
      else if (role === 'setter') isSetterCall = true
    }
    if (!isCloserCall && !isSetterCall) continue

    const connected = (call.duration ?? 0) > 0
    const bucket = isCloserCall ? closerAgg : setterAgg
    const perUserMap = isCloserCall ? closerByUser : setterByUser
    if (!perUserMap.has(call.user_id)) perUserMap.set(call.user_id, newAcc())
    const perUser = perUserMap.get(call.user_id)!

    bucket.calls++
    perUser.calls++
    if (!connected) continue
    bucket.connects++
    perUser.connects++

    // Attribute the next status flip within lookback to this connect.
    // First flip on this lead at-or-after the call's activity_at that
    // matches one of our outcome statuses.
    const flips = scByLead.get(call.lead_id) ?? []
    const callMs = new Date(call.activity_at).getTime()
    const cutoffMs = callMs + STATUS_LOOKBACK_MS
    for (const f of flips) {
      const fMs = new Date(f.date_created).getTime()
      if (fMs < callMs) continue
      if (fMs > cutoffMs) break
      const outcome = classifyStatusFlip(f.new_status_id)
      if (outcome) {
        bucket.outcomes[outcome]++
        perUser.outcomes[outcome]++
        break
      }
    }
  }

  return {
    closerAggregate: toCloserRow(null, closerAgg, nameByUser),
    setterAggregate: toSetterRow(null, setterAgg, nameByUser),
    perCloser: Array.from(closerByUser.entries())
      .map(([uid, acc]) => toCloserRow(uid, acc, nameByUser))
      .sort((a, b) => b.totalCalls - a.totalCalls),
    perSetter: Array.from(setterByUser.entries())
      .map(([uid, acc]) => toSetterRow(uid, acc, nameByUser))
      .sort((a, b) => b.totalDials - a.totalDials),
  }
}

function toCloserRow(uid: string | null, a: { calls: number; connects: number; outcomes: Record<Outcome, number> }, nameByUser: Map<string, string>): CloserTriageRow {
  return {
    userId: uid,
    name: uid ? (nameByUser.get(uid) ?? null) : null,
    totalCalls: a.calls,
    connects: a.connects,
    connectRate: a.calls > 0 ? a.connects / a.calls : null,
    confirmedBooking: a.outcomes.confirmedBooking,
    handedOver: a.outcomes.handedOver,
    triageDq: a.outcomes.disqualified,
  }
}

function toSetterRow(uid: string | null, a: { calls: number; connects: number; outcomes: Record<Outcome, number> }, nameByUser: Map<string, string>): SetterTriageRow {
  return {
    userId: uid,
    name: uid ? (nameByUser.get(uid) ?? null) : null,
    totalDials: a.calls,
    connects: a.connects,
    connectRate: a.calls > 0 ? a.connects / a.calls : null,
    booked: a.outcomes.confirmedBooking,
    digitalCollege: a.outcomes.downsell,
    dq: a.outcomes.disqualified,
    // Follow-up isn't captured anywhere in Close — depends on the
    // setter Airtable form which has 0% adoption. Render as null so
    // the page can show "—" with a note. Drake's call.
    followUp: null,
  }
}

function emptyCloserRow(uid: string | null): CloserTriageRow {
  return { userId: uid, name: null, totalCalls: 0, connects: 0, connectRate: null, confirmedBooking: 0, handedOver: 0, triageDq: 0 }
}

function emptySetterRow(uid: string | null): SetterTriageRow {
  return { userId: uid, name: null, totalDials: 0, connects: 0, connectRate: null, booked: 0, digitalCollege: 0, dq: 0, followUp: null }
}
