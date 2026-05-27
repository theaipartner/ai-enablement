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
// Per block: two response rates side by side. Both use a UNIFIED
// "response" definition (Drake 2026-05-27): the prospect counts as
// having responded if EITHER channel triggers — an inbound SMS at
// any point, OR ANY outbound dial to that lead was answered
// (duration >= 90s, the existing call-connected threshold). Only
// one needs to be true. Updated 2026-05-27 (afternoon): "any
// connect ever" replaces "first dial answered" — the question is
// whether the lead has interacted with us at all, not whether they
// picked up immediately. Setters double-dial as policy; a connect
// on the second dial is still a response.
//
//   - everReplied = lead has (≥1 inbound SMS) OR (≥1 connected
//                   outbound dial, duration >= 90s), at ANY time
//   - within24h   = either of those channels happened within 24h of
//                   date_created. Per-channel: a connect that came
//                   later than 24h still counts for everReplied but
//                   NOT within24h.
//
// Denominator = all leads in the cohort that fell in this block,
// whether or not we ever texted them. Matches the Close-UI calc:
// "leads where SMS received > 0 / total new leads."

// FMR cohort starts at May 24, 2026 00:00 ET (= 04:00 UTC during EDT).
// Aligned with APPT_SETTING_MIN_ET_DATE — same floor across the page.
const FMR_COHORT_START_UTC_ISO = '2026-05-24T04:00:00Z'
const ONE_DAY_MS = 24 * 60 * 60 * 1000

// "Connected" threshold for treating a first dial as a response. Same
// 90s bar used by /sales-dashboard/calls and the per-rep tables. Close
// counts dial-attempt time inside `duration`, so anything below this
// would otherwise let unanswered rings count as responses.
const FMR_DIAL_CONNECTED_SEC = 90

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

  // Cohort: leads created since May 24, 2026 00:00 ET (see
  // FMR_COHORT_START_UTC_ISO). Paginate to avoid PostgREST's default
  // page limit.
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

  // Earliest-CONNECTED-outbound-dial scan — track the FIRST outbound
  // call per lead WHERE duration >= 90s (i.e. an actual conversation,
  // not a ring-out). The 90s filter happens DB-side so we only
  // materialize connects. Sorting by ascending activity_at + only
  // keeping the first per lead gives us the earliest connect.
  //
  // "Any connect ever" → presence in this map.
  // "Connect within 24h"  → check the stored activity_at against the
  //                         lead's date_created.
  const earliestConnectedDialByLead = new Map<string, string>()
  {
    let from = 0
    const PAGE = 1000
    for (;;) {
      const { data, error } = await sb
        .from('close_calls' as never)
        .select('lead_id, activity_at, duration')
        .eq('direction', 'outbound')
        .gte('duration', FMR_DIAL_CONNECTED_SEC)
        .gte('activity_at', FMR_COHORT_START_UTC_ISO)
        .order('activity_at', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`close_calls connected-outbound read failed: ${error.message}`)
      const rows = (data ?? []) as unknown as Array<{
        lead_id: string | null
        activity_at: string
        duration: number | null
      }>
      if (rows.length === 0) break
      for (const r of rows) {
        if (!r.lead_id) continue
        if (!earliestConnectedDialByLead.has(r.lead_id)) {
          earliestConnectedDialByLead.set(r.lead_id, r.activity_at)
        }
      }
      if (rows.length < PAGE) break
      from += PAGE
    }
  }

  // Bucket each lead. everReplied / within24h now use the UNIFIED
  // response definition: SMS reply OR first-dial-answered (>=90s).
  // Per-channel within-24h check — a slow dial that eventually got
  // picked up still counts as everReplied but NOT within24h.
  const totals = [0, 0, 0, 0, 0, 0]
  const everCounts = [0, 0, 0, 0, 0, 0]
  const within24Counts = [0, 0, 0, 0, 0, 0]
  for (const lead of leads) {
    const hour = etHourOfDay(lead.date_created)
    const block = Math.floor(hour / 4) as 0 | 1 | 2 | 3 | 4 | 5
    totals[block]++

    const leadCreatedMs = new Date(lead.date_created).getTime()
    const inboundAt = earliestInboundByLead.get(lead.close_id)
    const earliestConnectAt = earliestConnectedDialByLead.get(lead.close_id)

    // Ever responded: either signal at any time.
    if (inboundAt || earliestConnectAt) {
      everCounts[block]++
    }

    // Within 24h: either signal landed within 24h of lead creation.
    const smsWithin24h = !!(
      inboundAt &&
      (() => {
        const delta = new Date(inboundAt).getTime() - leadCreatedMs
        return delta >= 0 && delta <= ONE_DAY_MS
      })()
    )
    const connectWithin24h = !!(
      earliestConnectAt &&
      (() => {
        const delta = new Date(earliestConnectAt).getTime() - leadCreatedMs
        return delta >= 0 && delta <= ONE_DAY_MS
      })()
    )
    if (smsWithin24h || connectWithin24h) {
      within24Counts[block]++
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

// User IDs to exclude from the speed-to-lead + triage tables. Used
// for non-operational reps (leadership, automation accounts) whose
// occasional calls show up in the data but aren't part of the
// actual setter/closer rotation.
const EXCLUDED_REP_IDS = new Set<string>([
  'user_DFKbypchBYDyzLMdsg3ujzxWZyxTMKbsysYRc9LGAch', // Nabeel Junaid
])

// Canonical sales identity loaded from team_members. Replaces the
// older PRIMARY_ROLE_OVERRIDE + MANUAL_SETTERS constants; the source
// of truth is now `team_members.sales_role` + `close_user_id`. Rows
// without close_user_id are skipped (no Close presence yet — they
// won't appear in close_calls and we have no signal to attribute).
export type SalesIdentity = {
  closerUserIds: Set<string>
  setterUserIds: Set<string>
  // close_user_id ⇄ name maps. Includes first-name aliases so
  // Airtable setter_names like ["Connor"] resolve to "Connor
  // Malewicz"'s close_user_id (kept as a fallback for forms that
  // pre-date the airtable_user_id registry).
  userIdByName: Map<string, string>
  nameByUser: Map<string, string>
  // close_user_id → every name we know this rep by (full + first).
  // Drill-side lookup for matching setter_names overlap.
  knownNamesByUserId: Map<string, Set<string>>
  // airtable_user_id (`rec…`) → close_user_id. Authoritative match
  // path: Airtable forms carry `setter_record_ids` which we resolve
  // here before falling back to name lookups (names break when
  // someone goes by a nickname — "Zach" vs "Zachary"). Populated
  // when team_members.airtable_user_id is set.
  userIdByAirtableId: Map<string, string>
}

async function loadSalesIdentity(sb: ReturnType<typeof createAdminClient>): Promise<SalesIdentity> {
  const { data, error } = await sb
    .from('team_members' as never)
    .select('id, full_name, close_user_id, airtable_user_id, sales_role, archived_at')
    .not('close_user_id', 'is', null)
    .is('archived_at', null)
  if (error) throw new Error(`team_members sales identity read failed: ${error.message}`)

  const out: SalesIdentity = {
    closerUserIds: new Set(),
    setterUserIds: new Set(),
    userIdByName: new Map(),
    nameByUser: new Map(),
    knownNamesByUserId: new Map(),
    userIdByAirtableId: new Map(),
  }
  for (const r of (data ?? []) as unknown as Array<{ full_name: string; close_user_id: string; airtable_user_id: string | null; sales_role: string | null }>) {
    if (r.sales_role === 'closer') out.closerUserIds.add(r.close_user_id)
    else if (r.sales_role === 'setter') out.setterUserIds.add(r.close_user_id)
    // 'other' / null sales_role: still register lookups so attribution
    // works, but don't claim a setter/closer slot.
    if (r.airtable_user_id) {
      out.userIdByAirtableId.set(r.airtable_user_id, r.close_user_id)
    }
    if (r.full_name) {
      out.nameByUser.set(r.close_user_id, r.full_name)
      out.userIdByName.set(r.full_name, r.close_user_id)
      const names = new Set<string>([r.full_name])
      const first = r.full_name.trim().split(/\s+/)[0]
      if (first && first !== r.full_name) {
        names.add(first)
        if (!out.userIdByName.has(first)) out.userIdByName.set(first, r.close_user_id)
      }
      out.knownNamesByUserId.set(r.close_user_id, names)
    }
  }
  return out
}

// Resolve an Airtable form's setter to a Close user_id. Tries the
// authoritative path (setter_record_ids → airtable_user_id ⇒
// close_user_id) before falling back to name match. Returns null
// when neither path resolves — caller treats the form as unattributed.
function resolveFormSetterUserId(
  setterRecordIds: string[] | null | undefined,
  setterNames: string[] | null | undefined,
  salesId: SalesIdentity,
  userIdByName: Map<string, string>,
): string | null {
  for (const recId of (setterRecordIds ?? [])) {
    const uid = salesId.userIdByAirtableId.get(recId)
    if (uid) return uid
  }
  for (const nm of (setterNames ?? [])) {
    const uid = userIdByName.get(nm)
    if (uid) return uid
  }
  return null
}

// Used by the per-rep drill: every name this rep is known by — first
// resolved from team_members (full + first-name token); falls back to
// close_calls.raw_payload.user_name if team_members has no entry.
async function buildKnownNamesForUser(
  sb: ReturnType<typeof createAdminClient>,
  userId: string,
): Promise<Set<string>> {
  const names = new Set<string>()

  // team_members entry first — authoritative.
  const { data: tm } = await sb
    .from('team_members' as never)
    .select('full_name')
    .eq('close_user_id', userId)
    .is('archived_at', null)
    .maybeSingle()
  const tmName = (tm as { full_name?: string } | null)?.full_name
  if (tmName) {
    names.add(tmName)
    const first = tmName.trim().split(/\s+/)[0]
    if (first && first !== tmName) names.add(first)
  }

  // Augment with whatever display names Close has surfaced — covers
  // edge cases (rename in Close, dual aliases) and serves as the
  // only signal for users not yet in team_members.
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('close_calls' as never)
      .select('raw_payload')
      .eq('user_id', userId)
      .not('raw_payload', 'is', null)
      .range(from, from + 199)
    if (error) throw new Error(`close_calls name lookup failed: ${error.message}`)
    const rows = (data ?? []) as unknown as Array<{ raw_payload: { user_name?: string } | null }>
    if (rows.length === 0) break
    for (const r of rows) {
      const nm = r.raw_payload?.user_name
      if (!nm) continue
      names.add(nm)
      const first = nm.trim().split(/\s+/)[0]
      if (first && first !== nm) names.add(first)
    }
    if (rows.length < 200) break
    from += 200
  }
  return names
}

// Augments a name→userId / userId→name pair of maps and a setter set
// with:
// Merges a SalesIdentity (loaded from team_members) into the
// name/user lookup pair and the setter / closer sets. team_members
// data wins over whatever close_calls.raw_payload surfaced, and
// also adds rows for setters who have no close_calls activity (e.g.
// brand-new hires whose first Close call hasn't landed yet).
//
// Also registers first-name aliases from any close_calls user_name
// not already in team_members — so users outside team_members still
// get the "Connor → Connor Malewicz" behavior we relied on before.
function mergeSalesIdentity(
  userIdByName: Map<string, string>,
  nameByUser: Map<string, string>,
  closerSet: Set<string>,
  setterSet: Set<string>,
  salesId: SalesIdentity,
): void {
  // First-name aliases for close_calls names not yet in team_members.
  const entries = Array.from(nameByUser.entries())
  for (const [uid, fullName] of entries) {
    const parts = fullName.trim().split(/\s+/)
    if (parts.length < 2) continue
    const first = parts[0]
    if (!userIdByName.has(first)) userIdByName.set(first, uid)
  }
  // Authoritative team_members overrides come last — full name and
  // first-name token win over any close_calls-derived value.
  salesId.nameByUser.forEach((name, uid) => {
    nameByUser.set(uid, name)
  })
  salesId.userIdByName.forEach((uid, name) => {
    userIdByName.set(name, uid)
  })
  // team_members sales_role wins over close_leads owner inference.
  // Force-add to the declared role's set and remove from the other
  // — otherwise resolveRole()'s "dual-role default → closer" path
  // misclassifies a team_members-declared setter who happens to be
  // listed as closer_owner on any lead.
  salesId.closerUserIds.forEach((uid) => {
    closerSet.add(uid)
    setterSet.delete(uid)
  })
  salesId.setterUserIds.forEach((uid) => {
    setterSet.add(uid)
    closerSet.delete(uid)
  })
}

// How far before a form's airtable_created_at to search for a
// matching close_call. Captures the typical "fill the form within
// 48h of the call" pattern. Past that, accept the form's claimed
// event_date_time and tag as "no call to match" in the drill.
const FORM_MATCH_LOOKBACK_HOURS = 48

export type FormMatchInput = {
  recordId: string
  leadId: string | null
  // setter's Close user_id, resolved upstream from setter_names →
  // userIdByName. Null if the form's setter name didn't resolve
  // (e.g., name typo or rep not yet in team_members / close_calls).
  setterUserId: string | null
  airtableCreatedAt: string  // ISO UTC
  eventDateTime: string | null  // ISO UTC, may be null on junk rows
}

export type FormMatchResult = FormMatchInput & {
  // The day the form is attributed to. Always set — falls back to
  // event_date_time, then airtable_created_at, so per-rep windowing
  // never drops a form for missing data.
  effectiveDateIso: string
  // close_calls.close_id of the matched call, if any. When set, the
  // form's outcome attaches to that specific call in the drill.
  matchedCallId: string | null
  matchedCallActivityAt: string | null
}

// Batch-match each form to its most-recent close_call by lead_id +
// setter user_id + duration > 90 + activity_at within the lookback
// window of the form's airtable_created_at. Direction-agnostic
// (inbound matches just as well as outbound — the call happened
// either way). One DB read for the whole batch, in-memory match.
async function matchFormsToCalls(
  sb: ReturnType<typeof createAdminClient>,
  forms: FormMatchInput[],
): Promise<FormMatchResult[]> {
  if (forms.length === 0) return []

  // Build the lead-id list + the bracket of activity_at to fetch.
  const leadIds = new Set<string>()
  let minLookback = Infinity
  let maxAnchor = -Infinity
  for (const f of forms) {
    if (f.leadId) leadIds.add(f.leadId)
    const anchorMs = new Date(f.airtableCreatedAt).getTime()
    if (Number.isFinite(anchorMs)) {
      minLookback = Math.min(minLookback, anchorMs - FORM_MATCH_LOOKBACK_HOURS * 3600 * 1000)
      maxAnchor = Math.max(maxAnchor, anchorMs)
    }
  }
  if (leadIds.size === 0 || !Number.isFinite(minLookback)) {
    // No leads or no anchorable timestamps — every form falls back.
    return forms.map((f) => ({
      ...f,
      effectiveDateIso: f.eventDateTime ?? f.airtableCreatedAt,
      matchedCallId: null,
      matchedCallActivityAt: null,
    }))
  }

  // Pull every long call to any of these leads in the bracket.
  // Paginate; lead_ids.size is bounded by the form set so practical
  // sizes stay well under PostgREST's lead-id chunk limit.
  type CallRow = { close_id: string; lead_id: string; user_id: string; activity_at: string; duration: number | null }
  const calls: CallRow[] = []
  const leadIdArr = Array.from(leadIds)
  const CHUNK = 100
  for (let i = 0; i < leadIdArr.length; i += CHUNK) {
    const chunk = leadIdArr.slice(i, i + CHUNK)
    let from = 0
    for (;;) {
      const { data, error } = await sb
        .from('close_calls' as never)
        .select('close_id, lead_id, user_id, activity_at, duration')
        .in('lead_id', chunk)
        .gt('duration', 90)
        .gte('activity_at', new Date(minLookback).toISOString())
        .lte('activity_at', new Date(maxAnchor).toISOString())
        .range(from, from + 999)
      if (error) throw new Error(`close_calls (form match) read failed: ${error.message}`)
      const rows = (data ?? []) as unknown as CallRow[]
      if (rows.length === 0) break
      calls.push(...rows)
      if (rows.length < 1000) break
      from += 1000
    }
  }

  // Group calls by lead_id for fast per-form filtering.
  const callsByLead = new Map<string, CallRow[]>()
  for (const c of calls) {
    if (!callsByLead.has(c.lead_id)) callsByLead.set(c.lead_id, [])
    callsByLead.get(c.lead_id)!.push(c)
  }

  return forms.map((f) => {
    if (!f.leadId || !f.setterUserId) {
      return { ...f, effectiveDateIso: f.eventDateTime ?? f.airtableCreatedAt, matchedCallId: null, matchedCallActivityAt: null }
    }
    const anchorMs = new Date(f.airtableCreatedAt).getTime()
    const earliestMs = anchorMs - FORM_MATCH_LOOKBACK_HOURS * 3600 * 1000
    const candidates = (callsByLead.get(f.leadId) ?? []).filter((c) => {
      if (c.user_id !== f.setterUserId) return false
      const t = new Date(c.activity_at).getTime()
      return t >= earliestMs && t <= anchorMs
    })
    if (candidates.length === 0) {
      return { ...f, effectiveDateIso: f.eventDateTime ?? f.airtableCreatedAt, matchedCallId: null, matchedCallActivityAt: null }
    }
    // Most recent wins (per Drake — multi-call leads accept the
    // imperfection that two calls in the lookback could disagree
    // on attribution).
    candidates.sort((a, b) => (a.activity_at < b.activity_at ? 1 : -1))
    const best = candidates[0]
    return { ...f, effectiveDateIso: best.activity_at, matchedCallId: best.close_id, matchedCallActivityAt: best.activity_at }
  })
}

function resolveRole(userId: string, closerSet: Set<string>, setterSet: Set<string>): 'setter' | 'closer' | null {
  if (EXCLUDED_REP_IDS.has(userId)) return null
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
  // True if EITHER of the first two outbound dials had duration >= 90s.
  // Drake's setting policy is "double-dial" so this captures the
  // "did we get them on the first attempt" signal even when the
  // pickup came on attempt #2. Surfaced as the (yes/no) bracket
  // next to "Time to call" on the UI.
  firstTwoDialsConnected: boolean
  // True if ANY outbound dial to this lead ever had duration >= 90s.
  // Drives the "Connected" column on the UI and the headline
  // "Connected rate" stat. Distinct from firstTwoDialsConnected:
  // anyCallConnected can be true while firstTwoDialsConnected is
  // false (third+ dial finally got them).
  anyCallConnected: boolean
  // Total count of outbound dials to this lead, GLOBAL (any time
  // since lead creation, not bounded by the user's date range).
  // Past cohorts naturally show higher intensity than fresh ones —
  // that's the intent: this is "how hard did we work this lead" not
  // "how many dials happened during the window".
  intensity: number
  callerUserId: string | null
  callerName: string | null
  speedSec: number | null           // null if no first call
}

export type SpeedToLeadCohortResult = {
  cohortSize: number
  leadsCalled: number               // had ≥1 outbound call
  // Count of cohort leads we ever reached (any outbound call,
  // duration >= 90s). Renamed 2026-05-27 from `leadsOver90s` —
  // the old name meant "first call connected" which is no longer
  // the metric.
  leadsConnected: number
  avgSpeedToLeadSec: number | null  // mean of speedSec (24h cap on outliers)
  // Same average computed against the subset of leads whose first
  // call landed within 3 hours. Drake's filter for the "active dialing
  // pace today" view — strips overnight leads that aren't an honest
  // signal of how fast the team is reacting in the moment.
  // null when zero leads in the cohort meet the threshold.
  avgSpeedToLeadSecUnder3h: number | null
  // Count of leads that contributed to avgSpeedToLeadSecUnder3h.
  // Surfaces in the UI as "(N of M)" subtext so the small-sample
  // case is obvious.
  leadsUnder3h: number
  connectedRate: number | null      // leadsConnected / leadsCalled
  // Mean total dials per CALLED lead in the cohort. "How hard did we
  // work the average lead." Mirrors the per-row Intensity column;
  // null when zero leads have been called.
  avgIntensity: number | null
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
    return { cohortSize: 0, leadsCalled: 0, leadsConnected: 0, avgSpeedToLeadSec: null, avgSpeedToLeadSecUnder3h: null, leadsUnder3h: 0, connectedRate: null, avgIntensity: null, callers: [], rows: [] }
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
    return { cohortSize: 0, leadsCalled: 0, leadsConnected: 0, avgSpeedToLeadSec: null, avgSpeedToLeadSecUnder3h: null, leadsUnder3h: 0, connectedRate: null, avgIntensity: null, callers: [], rows: [] }
  }
  const qualifyingMap = new Map(qualifyingLeads.map((l) => [l.close_id, l]))

  // First outbound call per qualifying lead (any caller).
  // We also track the SECOND outbound call per lead (for the
  // first-two-dials connect signal — Drake's double-dial convention)
  // and a Set of leads where ANY outbound call ever connected
  // (>= 90s, drives the global "Connected" column + rate). Plus a
  // per-lead total dial count for the global "Intensity" column.
  //
  // Upper-bound on activity_at intentionally OMITTED — intensity is
  // global (calls to date), not bounded by the user's date range
  // plus a 30-day look-forward. A cohort lead from 5/24 viewed today
  // shows every dial to date; viewed again next month, the same lead
  // will show MORE dials. That's the desired behavior — intensity
  // captures cumulative outreach effort.
  const firstCallByLead = new Map<string, { userId: string | null; activity_at: string; duration: number | null }>()
  const secondCallByLead = new Map<string, { duration: number | null }>()
  const leadsWithAnyConnect = new Set<string>()
  const dialCountByLead = new Map<string, number>()
  const nameByUser = new Map<string, string>()
  {
    let from = 0
    for (;;) {
      const { data: page, error } = await sb
        .from('close_calls' as never)
        .select('lead_id, user_id, activity_at, duration, raw_payload')
        .eq('direction', 'outbound')
        .gte('activity_at', range.startUtcIso)
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
        } else if (!secondCallByLead.has(r.lead_id)) {
          secondCallByLead.set(r.lead_id, { duration: r.duration })
        }
        if ((r.duration ?? 0) >= 90) {
          leadsWithAnyConnect.add(r.lead_id)
        }
        dialCountByLead.set(r.lead_id, (dialCountByLead.get(r.lead_id) ?? 0) + 1)
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
    const second = secondCallByLead.get(lead.close_id)
    let speedSec: number | null = null
    if (call) {
      const dt = (new Date(call.activity_at).getTime() - new Date(lead.date_created).getTime()) / 1000
      if (Number.isFinite(dt) && dt >= 0) speedSec = dt
    }
    const firstConnected = call ? (call.duration ?? 0) >= 90 : false
    const secondConnected = second ? (second.duration ?? 0) >= 90 : false
    allRows.push({
      leadId: lead.close_id,
      prospectName: prospectFromForm.get(lead.close_id) ?? lead.display_name ?? null,
      leadCreatedAt: lead.date_created,
      firstCallAt: call?.activity_at ?? null,
      firstTwoDialsConnected: firstConnected || secondConnected,
      anyCallConnected: leadsWithAnyConnect.has(lead.close_id),
      intensity: dialCountByLead.get(lead.close_id) ?? 0,
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

  // 3h outlier threshold. Per Drake (2026-05-27): the overnight leads
  // that get picked up first thing in the morning skew the headline
  // avg into a "responsiveness" number that doesn't reflect how fast
  // the team is dialing while actively working — this restricts the
  // secondary average to in-the-moment activity.
  const UNDER_3H_THRESHOLD_SEC = 3 * 60 * 60

  let cappedSum = 0
  let speedN = 0
  let under3hSum = 0
  let under3hN = 0
  let connectedCount = 0
  let calledCount = 0
  let intensitySum = 0
  for (const r of filteredRows) {
    if (r.speedSec !== null) {
      cappedSum += Math.min(r.speedSec, SPEED_CAP_SEC)
      speedN++
      if (r.speedSec < UNDER_3H_THRESHOLD_SEC) {
        under3hSum += r.speedSec
        under3hN++
      }
    }
    if (r.firstCallAt) calledCount++
    // Global "connected" — any outbound call to this lead has ever
    // had duration >= 90s. Mirrors the new Connected column.
    if (r.anyCallConnected) connectedCount++
    // Intensity contribution — sum across CALLED leads only (uncalled
    // leads have intensity 0 which would suppress the average).
    if (r.firstCallAt) intensitySum += r.intensity
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
    leadsConnected: connectedCount,
    avgSpeedToLeadSec: speedN > 0 ? cappedSum / speedN : null,
    avgSpeedToLeadSecUnder3h: under3hN > 0 ? under3hSum / under3hN : null,
    leadsUnder3h: under3hN,
    connectedRate: calledCount > 0 ? connectedCount / calledCount : null,
    avgIntensity: calledCount > 0 ? intensitySum / calledCount : null,
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
  // CONNECTED outbound dials (duration >= 90s) to a lead that had a
  // future (uncanceled) Calendly event at the moment of the dial.
  // Drake's "calling a booked lead" signal — covers both direct-
  // funnel-booked confirms and setter-booked confirms. Gated on
  // connected so a ring-out doesn't pollute the count; a connected
  // dial is either a confirm OR a new booking, an unconnected dial
  // is neither. Identity match via email → phone → name cascade
  // (see comments where confirmsByUser is computed below).
  confirms: number
  bookings: number
  dqs: number
  downsells: number
  followUps: number
  // Over-90s calls with no matching form outcome — i.e. the EOC
  // wasn't filled out (yet). max(0, totalOver90s - sum of outcomes)
  // so it never goes negative even when a form's event falls in
  // window but the call is outside, or vice versa.
  missing: number
}

export type CallActivityResult = {
  setters: CallActivityRepRow[]
  closers: CallActivityRepRow[]
  settersAggregate: CallActivityRepRow
  closersAggregate: CallActivityRepRow
  totalFormsInWindow: number
}

export type CallActivityDrillRow = {
  callId: string                       // close_calls.close_id — React key (or "form:<recordId>" for form-only rows)
  leadId: string
  prospectName: string | null
  callAt: string                       // ISO UTC — call's activity_at or form's event_date_time
  durationSec: number                  // call duration, > 90 (filtered upstream). 0 for form-only rows.
  bookingStatus: string | null
  bucket: TriageCallDrillRow['bucket']
  // True when this row came from a form whose lead has NO over-90s
  // call by this rep in window — i.e. the EOC was filled but the
  // call didn't make it into Close (or was under 90s). Surfaced as a
  // hover badge in the UI for audit.
  noMatchingCall?: boolean
}

export async function getCallActivityMetrics(arg: Window | DateRange): Promise<CallActivityResult> {
  const range = resolveRange(arg)
  const sb = createAdminClient()

  // Sales identity from team_members — authoritative source for
  // sales_role + Close user_id ⇄ name mapping. Merged into the
  // close_leads owner inference further down.
  const salesId = await loadSalesIdentity(sb)

  // Global role index — same source as triage/speed. Acts as a
  // fallback for users not yet in team_members.
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

  // Pull all calls in window — per-rep volume + calls over 90s.
  // Speed-to-lead lives in its own section now; we only need the
  // call-level stats here.
  //
  // We ALSO collect [user_id, lead_id, activity_at, direction]
  // tuples for every call so the "confirms" pass below can match
  // each OUTBOUND dial to any future Calendly event for that lead
  // (Drake's "calling a booked lead" signal).
  type Vol = { calls: number; over90s: number }
  const volumeByUser = new Map<string, Vol>()
  const nameByUser = new Map<string, string>()
  const userIdByName = new Map<string, string>()
  // Outbound-only tuples for the confirms join. We keep `duration`
  // here so the confirms pass can gate on connected dials (>=90s)
  // per Drake 2026-05-27: a connected dial to a booked lead is a
  // confirm; an UNconnected dial doesn't count for either confirm
  // or new-booking.
  const outboundCalls: Array<{ userId: string; leadId: string; activityAt: string; duration: number }> = []
  {
    // No direction filter on the volume aggregate — both inbound and
    // outbound count toward the rep's call activity (engagement on
    // the phone is engagement either way). Confirms filters to
    // outbound below since "calling a booked lead" implies WE dialed.
    let from = 0
    for (;;) {
      const { data: page, error } = await sb
        .from('close_calls' as never)
        .select('user_id, lead_id, direction, activity_at, duration, raw_payload')
        .not('user_id', 'is', null)
        .gte('activity_at', range.startUtcIso)
        .lt('activity_at', range.endUtcIso)
        .range(from, from + 999)
      if (error) throw new Error(`close_calls read failed: ${error.message}`)
      const rows = (page ?? []) as unknown as Array<{
        user_id: string
        lead_id: string | null
        direction: string | null
        activity_at: string
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

        if (r.direction === 'outbound' && r.lead_id) {
          outboundCalls.push({
            userId: r.user_id,
            leadId: r.lead_id,
            activityAt: r.activity_at,
            duration: r.duration ?? 0,
          })
        }
      }
      if (rows.length < 1000) break
      from += 1000
    }
  }

  // -----------------------------------------------------------------
  // Confirms — outbound dials to leads that had a future (uncanceled)
  // Calendly event at dial time. Per Drake (2026-05-27): closers want
  // to know which dials are confirmation-style vs cold; reframes the
  // older "direct booking" idea into a broader "booked lead" check.
  //
  // Identity-match priority (Drake 2026-05-27 follow-up):
  //   1. Email   (lead.contacts[].emails[].email ↔ invitee.email)
  //   2. Phone   (lead.contacts[].phones[].phone ↔ invitee phone in
  //              raw_payload.text_reminder_number or in the "Phone"
  //              question of raw_payload.questions_and_answers)
  //   3. Name    (lead.display_name ↔ invitee.name) — fuzzy fallback
  //
  // Phone normalization = digits-only (strips +, spaces, dashes).
  // Names lowered + trimmed. First match wins (the loop short-circuits).
  // Empirically (7d closer outbound cohort): email-and-phone catch
  // the same 14 calls (Calendly invitees usually have both), name
  // adds 15 more distinct matches → 29 total vs 15 name-only.
  // -----------------------------------------------------------------
  const confirmsByUser = new Map<string, number>()
  if (outboundCalls.length > 0) {
    // 1. Resolve lead_id → { name, emails, phones } from close_leads.
    //    contacts is a jsonb array of contact objects, each with
    //    optional `emails[]` and `phones[]` sub-arrays. We extract
    //    everything per lead (a lead can have multiple contacts).
    const leadIds = Array.from(new Set(outboundCalls.map((c) => c.leadId)))
    type LeadKeys = {
      name: string | null
      emails: string[]    // lowercased
      phones: string[]    // digits-only
    }
    const keysByLead = new Map<string, LeadKeys>()
    for (let i = 0; i < leadIds.length; i += 200) {
      const chunk = leadIds.slice(i, i + 200)
      const { data, error } = await sb
        .from('close_leads' as never)
        .select('close_id, display_name, contacts')
        .in('close_id', chunk)
      if (error) throw new Error(`close_leads contacts read failed: ${error.message}`)
      type ContactsBlob = Array<{
        emails?: Array<{ email?: string | null }>
        phones?: Array<{ phone?: string | null }>
      }>
      for (const r of (data ?? []) as unknown as Array<{
        close_id: string
        display_name: string | null
        contacts: ContactsBlob | null
      }>) {
        const emails: string[] = []
        const phones: string[] = []
        for (const c of r.contacts ?? []) {
          for (const em of c.emails ?? []) {
            if (em?.email) emails.push(em.email.toLowerCase().trim())
          }
          for (const ph of c.phones ?? []) {
            if (ph?.phone) {
              const digits = ph.phone.replace(/[^0-9]/g, '')
              if (digits.length >= 10) phones.push(digits)
            }
          }
        }
        keysByLead.set(r.close_id, {
          name: r.display_name ? r.display_name.toLowerCase().trim() : null,
          emails,
          phones,
        })
      }
    }

    // 2. Pull Calendly events in [range_start, range_end + 60d] —
    //    "future at dial time" cases. Build three lookup maps from
    //    invitee identity to event start timestamps.
    const evWindowEndIso = new Date(
      new Date(range.endUtcIso).getTime() + 60 * 24 * 60 * 60 * 1000,
    ).toISOString()
    const futureByEmail = new Map<string, number[]>()
    const futureByPhone = new Map<string, number[]>()
    const futureByName = new Map<string, number[]>()
    {
      let from = 0
      type EvRow = { uri: string; start_time: string }
      const eventByUri = new Map<string, string>()
      for (;;) {
        const { data, error } = await sb
          .from('calendly_scheduled_events' as never)
          .select('uri, start_time')
          .gte('start_time', range.startUtcIso)
          .lt('start_time', evWindowEndIso)
          .neq('status', 'canceled')
          .range(from, from + 999)
        if (error) throw new Error(`calendly events read failed: ${error.message}`)
        const rows = (data ?? []) as unknown as EvRow[]
        if (rows.length === 0) break
        for (const r of rows) eventByUri.set(r.uri, r.start_time)
        if (rows.length < 1000) break
        from += 1000
      }

      // Pull invitees for those events, including raw_payload so we
      // can extract phone from text_reminder_number / Q&A.
      const uris = Array.from(eventByUri.keys())
      type InvRow = {
        event_uri: string
        email: string | null
        name: string | null
        raw_payload: {
          text_reminder_number?: string | null
          questions_and_answers?: Array<{ question?: string | null; answer?: string | null }>
        } | null
      }
      for (let i = 0; i < uris.length; i += 200) {
        const chunk = uris.slice(i, i + 200)
        const { data, error } = await sb
          .from('calendly_invitees' as never)
          .select('event_uri, email, name, raw_payload')
          .in('event_uri', chunk)
        if (error) throw new Error(`calendly invitees read failed: ${error.message}`)
        for (const r of (data ?? []) as unknown as InvRow[]) {
          const startIso = eventByUri.get(r.event_uri)
          if (!startIso) continue
          const ts = new Date(startIso).getTime()

          if (r.email) {
            const k = r.email.toLowerCase().trim()
            const arr = futureByEmail.get(k) ?? []
            arr.push(ts)
            futureByEmail.set(k, arr)
          }
          if (r.name) {
            const k = r.name.toLowerCase().trim()
            const arr = futureByName.get(k) ?? []
            arr.push(ts)
            futureByName.set(k, arr)
          }
          // Phone: try text_reminder_number first, then any "Phone"
          // Q&A answer. Normalize to digits-only.
          const phones: string[] = []
          const trn = r.raw_payload?.text_reminder_number
          if (trn) phones.push(trn)
          for (const qa of r.raw_payload?.questions_and_answers ?? []) {
            const q = (qa?.question ?? '').toLowerCase()
            if (q.includes('phone') && qa?.answer) phones.push(qa.answer)
          }
          for (const raw of phones) {
            const digits = raw.replace(/[^0-9]/g, '')
            if (digits.length < 10) continue
            const arr = futureByPhone.get(digits) ?? []
            arr.push(ts)
            futureByPhone.set(digits, arr)
          }
        }
      }
      futureByEmail.forEach((arr) => arr.sort((a: number, b: number) => a - b))
      futureByPhone.forEach((arr) => arr.sort((a: number, b: number) => a - b))
      futureByName.forEach((arr) => arr.sort((a: number, b: number) => a - b))
    }

    // 3. Per call: check email → phone → name in priority order.
    //    First match wins; short-circuit on hit. Per-key lists are
    //    typically 1-3 entries so a linear scan is fine.
    const hasFutureMatch = (starts: number[] | undefined, afterMs: number): boolean =>
      starts ? starts.some((ts) => ts > afterMs) : false
    for (const call of outboundCalls) {
      // Gate on connected dials only — a dial that didn't pick up
      // doesn't tell us whether the closer was "confirming" or
      // "qualifying", it just rang out. Drake 2026-05-27.
      if (call.duration < 90) continue
      const keys = keysByLead.get(call.leadId)
      if (!keys) continue
      const callMs = new Date(call.activityAt).getTime()

      let matched = false
      // (1) Email
      for (const email of keys.emails) {
        if (hasFutureMatch(futureByEmail.get(email), callMs)) {
          matched = true
          break
        }
      }
      // (2) Phone fallback
      if (!matched) {
        for (const phone of keys.phones) {
          if (hasFutureMatch(futureByPhone.get(phone), callMs)) {
            matched = true
            break
          }
        }
      }
      // (3) Name fallback
      if (!matched && keys.name && hasFutureMatch(futureByName.get(keys.name), callMs)) {
        matched = true
      }

      if (matched) {
        confirmsByUser.set(call.userId, (confirmsByUser.get(call.userId) ?? 0) + 1)
      }
    }
  }

  // Merge team_members identity in: authoritative names + roles +
  // any setter who has no close_calls activity yet (e.g. Victoria,
  // whose first call hasn't been mirrored). Adds first-name aliases
  // for close_calls-only users (Connor → Connor Malewicz).
  mergeSalesIdentity(userIdByName, nameByUser, closerUsers, setterUsers, salesId)

  // Outcomes from Airtable form — attributed to the form's
  // effective_date (matched call's activity_at, else event_date_time).
  // Pull a wider window by airtable_created_at so we catch forms
  // submitted up to FORM_MATCH_LOOKBACK_HOURS after the call window.
  // Range padding: extend BACKWARD by 0 (the form's call has to be
  // within the range), FORWARD by lookback (a call at range-end could
  // have a form filed up to lookback hours later).
  type Outcomes = { bookings: number; dqs: number; downsells: number; followUps: number }
  const newOutcomes = (): Outcomes => ({ bookings: 0, dqs: 0, downsells: 0, followUps: 0 })
  const outcomesByUser = new Map<string, Outcomes>()
  // Per-rep set of close_call ids that a form matched. Used by the
  // per-rep "missing" calc — every over-90s call without an entry
  // here is missing its EOC. Distinct from outcome counts because
  // form-only outcomes (no matched call) shouldn't reduce missing.
  const matchedCallIdsByUser = new Map<string, Set<string>>()
  let totalForms = 0
  {
    type FormRow = { record_id: string; lead_id: string | null; booking_status: string | null; setter_names: string[] | null; setter_record_ids: string[] | null; event_date_time: string | null; airtable_created_at: string }
    const allRows: FormRow[] = []
    const formWindowStartIso = range.startUtcIso
    const formWindowEndIso = new Date(new Date(range.endUtcIso).getTime() + FORM_MATCH_LOOKBACK_HOURS * 3600 * 1000).toISOString()
    let from = 0
    for (;;) {
      const { data: page, error } = await sb
        .from('airtable_setter_triage_calls' as never)
        .select('record_id, lead_id, booking_status, setter_names, setter_record_ids, event_date_time, airtable_created_at')
        .gte('airtable_created_at', formWindowStartIso)
        .lt('airtable_created_at', formWindowEndIso)
        .range(from, from + 999)
      if (error) throw new Error(`airtable_setter_triage_calls read failed: ${error.message}`)
      const rows = (page ?? []) as unknown as FormRow[]
      if (rows.length === 0) break
      allRows.push(...rows)
      if (rows.length < 1000) break
      from += 1000
    }

    // Resolve each form's setter user_id, then batch-match to calls.
    // Prefer setter_record_ids (airtable_user_id → close_user_id) over
    // setter_names — names break when reps go by nicknames (Zach vs
    // Zachary McCarter).
    const matchInputs: FormMatchInput[] = allRows.map((r) => ({
      recordId: r.record_id,
      leadId: r.lead_id,
      setterUserId: resolveFormSetterUserId(r.setter_record_ids, r.setter_names, salesId, userIdByName),
      airtableCreatedAt: r.airtable_created_at,
      eventDateTime: r.event_date_time,
    }))
    const matched = await matchFormsToCalls(sb, matchInputs)
    const matchByRecord = new Map(matched.map((m) => [m.recordId, m]))

    // Filter to forms whose effective_date falls in the range.
    const inRangeRows: FormRow[] = []
    for (const r of allRows) {
      const m = matchByRecord.get(r.record_id)
      if (!m) continue
      if (m.effectiveDateIso < range.startUtcIso) continue
      if (m.effectiveDateIso >= range.endUtcIso) continue
      inRangeRows.push(r)
    }
    totalForms = inRangeRows.length

    // Dedupe by lead_id (latest effective_date wins). Drop rows with
    // no lead_id — empty/junk submissions Airtable's own views also
    // exclude.
    const latestByLead = new Map<string, FormRow>()
    for (const r of inRangeRows) {
      if (!r.lead_id) continue
      const existing = latestByLead.get(r.lead_id)
      const rDate = matchByRecord.get(r.record_id)?.effectiveDateIso ?? r.event_date_time ?? ''
      const eDate = existing ? (matchByRecord.get(existing.record_id)?.effectiveDateIso ?? existing.event_date_time ?? '') : ''
      if (!existing || rDate > eDate) latestByLead.set(r.lead_id, r)
    }
    latestByLead.forEach((r) => {
      const bucket = classifyBookingStatus(r.booking_status)
      if (bucket === 'unclassified') return
      const m = matchByRecord.get(r.record_id)
      // Use the same resolver as matchInputs above — airtable rec_id
      // wins over name. A form attributes to exactly one rep (a real
      // form has one setter; multi-setter forms get the first-resolved
      // owner only, matching dedupe-by-lead semantics elsewhere).
      const uid = resolveFormSetterUserId(r.setter_record_ids, r.setter_names, salesId, userIdByName)
      if (!uid) return
      if (!outcomesByUser.has(uid)) outcomesByUser.set(uid, newOutcomes())
      outcomesByUser.get(uid)![bucket]++
      if (m?.matchedCallId) {
        if (!matchedCallIdsByUser.has(uid)) matchedCallIdsByUser.set(uid, new Set())
        matchedCallIdsByUser.get(uid)!.add(m.matchedCallId)
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
    const matchedCalls = matchedCallIdsByUser.get(userId)?.size ?? 0
    const row: CallActivityRepRow = {
      userId,
      name: nameByUser.get(userId) ?? null,
      totalCalls: v.calls,
      totalOver90s: v.over90s,
      confirms: confirmsByUser.get(userId) ?? 0,
      bookings: o.bookings,
      dqs: o.dqs,
      downsells: o.downsells,
      followUps: o.followUps,
      missing: Math.max(0, v.over90s - matchedCalls),
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
  let calls = 0, over90s = 0, confirms = 0, bookings = 0, dqs = 0, downsells = 0, followUps = 0, missing = 0
  for (const r of rows) {
    calls += r.totalCalls
    over90s += r.totalOver90s
    confirms += r.confirms
    bookings += r.bookings
    dqs += r.dqs
    downsells += r.downsells
    followUps += r.followUps
    missing += r.missing
  }
  return {
    userId: null,
    name: null,
    totalCalls: calls,
    totalOver90s: over90s,
    confirms,
    bookings,
    dqs,
    downsells,
    followUps,
    missing,
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

  // Every call by this rep in window with duration > 90s — both
  // directions count (rep is on the phone either way).
  type RawCall = { callId: string; leadId: string; activityAt: string; durationSec: number }
  const calls: RawCall[] = []
  {
    let from = 0
    for (;;) {
      const { data: page, error } = await sb
        .from('close_calls' as never)
        .select('close_id, lead_id, activity_at, duration')
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

  // Names this rep is known by — close display name + first-name
  // alias + manual-setter entry (when their Close user_id isn't
  // ingested yet). Used to match airtable_setter_triage_calls.
  // setter_names for the form-only drill section.
  const knownNames = await buildKnownNamesForUser(sb, userId)

  // Distinct lead ids from calls for prospect-name + outcome lookups.
  const callLeadIds = Array.from(new Set(calls.map((c) => c.leadId)))

  // Lead display names for call-derived rows.
  const leadName = new Map<string, string | null>()
  for (let i = 0; i < callLeadIds.length; i += 100) {
    const chunk = callLeadIds.slice(i, i + 100)
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, display_name')
      .in('close_id', chunk)
    if (error) throw new Error(`close_leads (drill) read failed: ${error.message}`)
    for (const l of (data ?? []) as unknown as Array<{ close_id: string; display_name: string | null }>) {
      leadName.set(l.close_id, l.display_name)
    }
  }

  // Pull this rep's airtable_user_id from team_members so the form
  // filter can match by ID (more robust than name when reps go by
  // nicknames).
  const { data: tmRow } = await sb
    .from('team_members' as never)
    .select('airtable_user_id')
    .eq('close_user_id', userId)
    .is('archived_at', null)
    .maybeSingle()
  const repAirtableId = (tmRow as { airtable_user_id?: string | null } | null)?.airtable_user_id ?? null

  // Forms filled by this rep — pull airtable_created_at within
  // [range start, range end + 48h] so we catch forms submitted after
  // the call window for in-range calls. Filter is union of two
  // signals: setter_record_ids contains the rep's airtable_user_id
  // (authoritative), or setter_names overlaps with knownNames
  // (fallback for old forms or reps without an airtable_user_id yet).
  type FormRow = {
    record_id: string
    lead_id: string | null
    prospect_name: string | null
    booking_status: string | null
    setter_names: string[] | null
    setter_record_ids: string[] | null
    event_date_time: string | null
    airtable_created_at: string
  }
  const repForms: FormRow[] = []
  if (knownNames.size > 0 || repAirtableId) {
    const formWindowStart = range.startUtcIso
    const formWindowEnd = new Date(new Date(range.endUtcIso).getTime() + FORM_MATCH_LOOKBACK_HOURS * 3600 * 1000).toISOString()
    let from = 0
    for (;;) {
      const { data, error } = await sb
        .from('airtable_setter_triage_calls' as never)
        .select('record_id, lead_id, prospect_name, booking_status, setter_names, setter_record_ids, event_date_time, airtable_created_at')
        .gte('airtable_created_at', formWindowStart)
        .lt('airtable_created_at', formWindowEnd)
        .range(from, from + 999)
      if (error) throw new Error(`airtable_setter_triage_calls (drill) read failed: ${error.message}`)
      const rows = (data ?? []) as unknown as FormRow[]
      if (rows.length === 0) break
      for (const r of rows) {
        const recIds = r.setter_record_ids ?? []
        const matchById = repAirtableId !== null && recIds.includes(repAirtableId)
        const matchByName = (r.setter_names ?? []).some((n) => knownNames.has(n))
        if (matchById || matchByName) repForms.push(r)
      }
      if (rows.length < 1000) break
      from += 1000
    }
  }

  // Match each form to its call (lead_id + this user_id, > 90s, any
  // direction, 48h lookback). Most recent wins. effective_date drives
  // window filtering.
  const matchInputs: FormMatchInput[] = repForms.map((r) => ({
    recordId: r.record_id,
    leadId: r.lead_id,
    setterUserId: userId,
    airtableCreatedAt: r.airtable_created_at,
    eventDateTime: r.event_date_time,
  }))
  const matched = await matchFormsToCalls(sb, matchInputs)
  const matchByRecord = new Map(matched.map((m) => [m.recordId, m]))

  // Forms whose effective_date falls in range — drives both the
  // outcome attached to in-range calls (when matchedCallId is set)
  // and the form-only "no call" tail (when matchedCallId is null).
  const inRangeForms = repForms.filter((r) => {
    const m = matchByRecord.get(r.record_id)
    if (!m) return false
    return m.effectiveDateIso >= range.startUtcIso && m.effectiveDateIso < range.endUtcIso
  })

  // Build a callId → form map for fast lookup when composing call rows.
  // Most-recent form per call (last write wins on duplicate matches).
  const formByCallId = new Map<string, FormRow>()
  for (const r of inRangeForms) {
    const m = matchByRecord.get(r.record_id)
    if (!m?.matchedCallId) continue
    formByCallId.set(m.matchedCallId, r)
  }

  // Prospect-name + display-name lookup keyed by lead.
  const formProspectByLead = new Map<string, string | null>()
  for (const r of inRangeForms) {
    if (r.lead_id && !formProspectByLead.has(r.lead_id) && r.prospect_name) {
      formProspectByLead.set(r.lead_id, r.prospect_name)
    }
  }

  // Call rows: every in-range call, outcome from its matched form (or
  // "Missing" if no form matched THIS call specifically).
  const callRows: CallActivityDrillRow[] = calls.map((c) => {
    const form = formByCallId.get(c.callId)
    return {
      callId: c.callId,
      leadId: c.leadId,
      prospectName: form?.prospect_name ?? formProspectByLead.get(c.leadId) ?? leadName.get(c.leadId) ?? null,
      callAt: c.activityAt,
      durationSec: c.durationSec,
      bookingStatus: form?.booking_status ?? null,
      bucket: classifyBookingStatus(form?.booking_status ?? null),
    }
  })

  // Form-only rows: in-range forms whose matched_call_id is null
  // (genuine engagement gap — EOC filed but no qualifying call exists
  // in Close for this rep+lead+48h window).
  const formOnlyRows: CallActivityDrillRow[] = []
  for (const r of inRangeForms) {
    const m = matchByRecord.get(r.record_id)
    if (m?.matchedCallId) continue
    formOnlyRows.push({
      callId: `form:${r.record_id}`,
      leadId: r.lead_id ?? '',
      prospectName: r.prospect_name,
      callAt: m?.effectiveDateIso ?? r.event_date_time ?? '',
      durationSec: 0,
      bookingStatus: r.booking_status,
      bucket: classifyBookingStatus(r.booking_status),
      noMatchingCall: true,
    })
  }

  return [...callRows, ...formOnlyRows]
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

  // team_members sales identity — authoritative; merged into the
  // close_leads owner fallback below.
  const salesId = await loadSalesIdentity(sb)

  // Global role index (same source as speed-to-lead). Acts as a
  // fallback for users not yet in team_members.
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

  // Merge team_members identity in. Same rationale as
  // getCallActivityMetrics.
  mergeSalesIdentity(userIdByName, nameByUser, closerUsers, setterUsers, salesId)

  // Outcomes side: Airtable form rows in window. Each row's setter
  // is mapped back to a Close user_id by name.
  type Outcomes = { bookings: number; dqs: number; downsells: number; followUps: number }
  const newOutcomes = (): Outcomes => ({ bookings: 0, dqs: 0, downsells: 0, followUps: 0 })
  const outcomesByUser = new Map<string, Outcomes>()
  let totalForms = 0
  let formFrom = 0
  // Filter by event_date_time (call's actual date), not the form's
  // submit timestamp. See note in getCallActivityMetrics for rationale.
  for (;;) {
    const { data: page, error } = await sb
      .from('airtable_setter_triage_calls' as never)
      .select('record_id, booking_status, setter_names, event_date_time')
      .gte('event_date_time', range.startUtcIso)
      .lt('event_date_time', range.endUtcIso)
      .range(formFrom, formFrom + 999)
    if (error) throw new Error(`airtable_setter_triage_calls read failed: ${error.message}`)
    const rows = (page ?? []) as unknown as Array<{ record_id: string; booking_status: string | null; setter_names: string[] | null; event_date_time: string | null }>
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

  // Resolve every name this rep is known by — close display name +
  // first-name alias + manual-setter entry. Drives the setter_names
  // overlap filter on Airtable form rows.
  const knownNames = await buildKnownNamesForUser(sb, userId)
  if (knownNames.size === 0) return []

  // Pull all Airtable rows whose event happened in window; filter in
  // JS by setter_names overlap with knownNames. Date filter matches
  // the aggregate side — see note in getCallActivityMetrics.
  const out: TriageCallDrillRow[] = []
  let af = 0
  for (;;) {
    const { data: page, error } = await sb
      .from('airtable_setter_triage_calls' as never)
      .select('record_id, prospect_name, booking_status, setter_names, event_date_time')
      .gte('event_date_time', range.startUtcIso)
      .lt('event_date_time', range.endUtcIso)
      .order('event_date_time', { ascending: false })
      .range(af, af + 999)
    if (error) throw new Error(`airtable_setter_triage_calls drill read failed: ${error.message}`)
    const rows = (page ?? []) as unknown as Array<{
      record_id: string
      prospect_name: string | null
      booking_status: string | null
      setter_names: string[] | null
      event_date_time: string | null
    }>
    if (rows.length === 0) break
    for (const r of rows) {
      const namesHere = r.setter_names ?? []
      if (!namesHere.some((n) => knownNames.has(n))) continue
      out.push({
        recordId: r.record_id,
        prospectName: r.prospect_name,
        occurredAtIso: r.event_date_time ?? '',
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

  // team_members sales identity — authoritative source for
  // setter/closer classification. Merged into the close_leads
  // owner fallback below.
  const salesId = await loadSalesIdentity(sb)

  // Build the global role index from close_leads owner fields.
  // Used as a FALLBACK when the call's specific lead doesn't have
  // owner_id set (majority of leads — only ~30% have owner_ids
  // populated in the probe). A user_id classified as setter-only
  // globally will have all their unattributed calls counted as
  // setter dials; same for closer-only. Users in BOTH sets fall
  // back to "unknown" when the lead is unowned (we can't infer
  // which hat they're wearing). team_members entries (with
  // sales_role explicitly set) win over close_leads inference.
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
  // team_members sales_role wins over close_leads owner inference
  // — force-add to the declared role's set and remove from the
  // other so resolveRole()'s dual-role default doesn't misclassify.
  salesId.closerUserIds.forEach((uid) => { closerUsers.add(uid); setterUsers.delete(uid) })
  salesId.setterUserIds.forEach((uid) => { setterUsers.add(uid); closerUsers.delete(uid) })

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
