import 'server-only'

import { unstable_cache } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import type { Window } from './sales-dashboard-shared'
import { getDateRangeFromWindow, type DateRange } from './funnel-window'
import { fetchChunked, fetchChunkedPaged } from './query-parallel'

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

// FMR signals — earliest inbound SMS + earliest >=90s outbound connect per lead,
// scanned from the window start onward (a response to a window lead lands at or
// after its opt-in, which is >= window start). Returned as plain arrays so the
// result is JSON-cacheable; buildFmrBlocks rebuilds the maps. Cached per range.
export type FmrSignals = {
  inbound: Array<[string, string]> // [leadId, earliest inbound activity_at]
  connect: Array<[string, string]> // [leadId, earliest >=90s outbound activity_at]
}

async function getFmrSignalsUncached(range: DateRange): Promise<FmrSignals> {
  const sb = createAdminClient()

  // SQL-aggregation path (DEFAULT): the materialized per-cycle FMR signals
  // (migration 0080) off each lead's earliest in-window typeform cycle, instead of
  // scanning close_sms + close_calls. Verified equal to the scan (Phase 1, 0
  // mismatches). buildFmrBlocks gates >= opt-in (already satisfied by the
  // materialization) and applies the 24h check.
  if (process.env.SALES_SPEED_USE_SCAN !== '1') {
    const rows = await fetchAllPaged<{ close_id: string; opt_in_at: string; earliest_inbound_at: string | null; earliest_connect_at: string | null }>(
      (f, t) => sb
        .from('lead_cycles' as never)
        .select('close_id, opt_in_at, earliest_inbound_at, earliest_connect_at')
        .eq('source', 'typeform')
        .gte('opt_in_at', range.startUtcIso)
        .lt('opt_in_at', range.endUtcIso)
        .range(f, t),
      'lead_cycles fmr signals',
    )
    const earliest = new Map<string, { opt: string; inb: string | null; con: string | null }>()
    for (const r of rows) {
      const prev = earliest.get(r.close_id)
      if (!prev || r.opt_in_at < prev.opt) earliest.set(r.close_id, { opt: r.opt_in_at, inb: r.earliest_inbound_at, con: r.earliest_connect_at })
    }
    const inb: Array<[string, string]> = []
    const con: Array<[string, string]> = []
    earliest.forEach((v, cid) => {
      if (v.inb) inb.push([cid, v.inb])
      if (v.con) con.push([cid, v.con])
    })
    return { inbound: inb, connect: con }
  }

  // Earliest inbound SMS per lead (>= window start).
  const inbound = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('close_sms' as never)
      .select('lead_id, activity_at')
      .eq('direction', 'inbound')
      .gte('activity_at', range.startUtcIso)
      .order('activity_at', { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(`close_sms inbound read failed: ${error.message}`)
    const rows = (data ?? []) as unknown as Array<{ lead_id: string | null; activity_at: string }>
    if (rows.length === 0) break
    for (const r of rows) if (r.lead_id && !inbound.has(r.lead_id)) inbound.set(r.lead_id, r.activity_at)
    if (rows.length < 1000) break
  }

  // Earliest >=90s outbound connect per lead (>= window start).
  const connect = new Map<string, string>()
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('close_calls' as never)
      .select('lead_id, activity_at')
      .eq('direction', 'outbound')
      .gte('duration', FMR_DIAL_CONNECTED_SEC)
      .gte('activity_at', range.startUtcIso)
      .order('activity_at', { ascending: true })
      .range(from, from + 999)
    if (error) throw new Error(`close_calls connected-outbound read failed: ${error.message}`)
    const rows = (data ?? []) as unknown as Array<{ lead_id: string | null; activity_at: string }>
    if (rows.length === 0) break
    for (const r of rows) if (r.lead_id && !connect.has(r.lead_id)) connect.set(r.lead_id, r.activity_at)
    if (rows.length < 1000) break
  }

  return { inbound: Array.from(inbound), connect: Array.from(connect) }
}

// Cached per window. The scans are keyed only by the range (date-bounded, not
// lead-bounded), so the cohort can be applied cheaply on top in buildFmrBlocks.
export function getFmrSignals(range: DateRange): Promise<FmrSignals> {
  return unstable_cache(
    () => getFmrSignalsUncached(range),
    ['fmr-signals-v1', range.startEtDate, range.endEtDate],
    { revalidate: 600 },
  )()
}

// Build the FMR time-of-day blocks over a cohort — the SAME window cohort as the
// roster/funnel, so cohortSize equals the Total funnel's opt-ins. Buckets each
// lead by the ET hour of its OPT-IN (a re-opt-in by its re-opt-in moment, not
// the original signup), and credits a response only at/after that opt-in.
export function buildFmrBlocks(
  cohort: Array<{ leadId: string; optInAt: string }>,
  signals: FmrSignals,
  windowLabel: string,
): FmrTimeBlocksResult {
  const inbound = new Map(signals.inbound)
  const connect = new Map(signals.connect)
  const totals = [0, 0, 0, 0, 0, 0]
  const everCounts = [0, 0, 0, 0, 0, 0]
  const within24Counts = [0, 0, 0, 0, 0, 0]
  for (const lead of cohort) {
    const optInMs = new Date(lead.optInAt).getTime()
    const block = Math.floor(etHourOfDay(lead.optInAt) / 4) as 0 | 1 | 2 | 3 | 4 | 5
    totals[block]++
    const inAt = inbound.get(lead.leadId)
    const coAt = connect.get(lead.leadId)
    // A response counts only at/after this opt-in (don't credit a re-opt-in with
    // a reply to a prior journey).
    const inOk = !!inAt && new Date(inAt).getTime() >= optInMs
    const coOk = !!coAt && new Date(coAt).getTime() >= optInMs
    if (inOk || coOk) everCounts[block]++
    const within = (at: string | undefined, ok: boolean) =>
      ok && !!at && new Date(at).getTime() - optInMs <= ONE_DAY_MS
    if (within(inAt, inOk) || within(coAt, coOk)) within24Counts[block]++
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
    cohortStart: windowLabel,
    cohortSize: cohort.length,
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

// Form↔call matching window (Drake 2026-06-07). The match anchors on the
// form's claimed call time (event_date_time): a call qualifies when it sits
// within ±48h of event_date_time. The hard guard is creation-after-call —
// the form is filled AFTER the call, so the matched call must precede the
// form's airtable_created_at (a form can't describe a call that hasn't
// happened yet). CREATION_SKEW_MS allows ~2min of Close↔Airtable clock slack.
// When a form has no event_date_time, fall back to the legacy fill-time
// lookback (calls in the 48h before airtable_created_at).
const FORM_MATCH_LOOKBACK_HOURS = 48
const FORM_MATCH_WINDOW_MS = FORM_MATCH_LOOKBACK_HOURS * 3600 * 1000
const CREATION_SKEW_MS = 2 * 60 * 1000

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
      // Earliest call we might match: 48h before the claimed event time
      // (event-anchored path) or 48h before the form fill (fallback path).
      const evtMs = f.eventDateTime ? new Date(f.eventDateTime).getTime() : NaN
      const earliest = (Number.isFinite(evtMs) ? Math.min(anchorMs, evtMs) : anchorMs) - FORM_MATCH_WINDOW_MS
      minLookback = Math.min(minLookback, earliest)
      // Latest call we might match: the form's creation time (+ skew slack).
      // A call after the form was created can't be the one it describes.
      maxAnchor = Math.max(maxAnchor, anchorMs + CREATION_SKEW_MS)
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
  // lead_id partitioned across chunks; results are grouped by lead and sorted
  // explicitly below, so chunk/page order doesn't affect the outcome.
  const leadIdArr = Array.from(leadIds)
  const calls = await fetchChunkedPaged<CallRow>(
    leadIdArr,
    (chunk, from, to) => sb
      .from('close_calls' as never)
      .select('close_id, lead_id, user_id, activity_at, duration')
      .in('lead_id', chunk)
      .gt('duration', 90)
      .gte('activity_at', new Date(minLookback).toISOString())
      .lte('activity_at', new Date(maxAnchor).toISOString())
      .range(from, to) as never,
    'close_calls (form match) read failed',
    100,
  )

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
    const createdMs = new Date(f.airtableCreatedAt).getTime()
    const evtMs = f.eventDateTime ? new Date(f.eventDateTime).getTime() : NaN
    const candidates = (callsByLead.get(f.leadId) ?? []).filter((c) => {
      if (c.user_id !== f.setterUserId) return false
      const t = new Date(c.activity_at).getTime()
      // Hard guard: the form is filled AFTER the call, so the call must
      // precede the form's creation (+skew). A call after the form was
      // created can't be the one it describes.
      if (t > createdMs + CREATION_SKEW_MS) return false
      if (Number.isFinite(evtMs)) {
        // Event-anchored: the call sits within ±48h of the claimed event time.
        return Math.abs(t - evtMs) <= FORM_MATCH_WINDOW_MS
      }
      // Fallback (form has no event time): the legacy fill-time lookback.
      return t >= createdMs - FORM_MATCH_WINDOW_MS
    })
    if (candidates.length === 0) {
      return { ...f, effectiveDateIso: f.eventDateTime ?? f.airtableCreatedAt, matchedCallId: null, matchedCallActivityAt: null }
    }
    // Prefer the call closest to the claimed event time (most accurate);
    // with no event time, the most recent qualifying call wins.
    if (Number.isFinite(evtMs)) {
      candidates.sort((a, b) =>
        Math.abs(new Date(a.activity_at).getTime() - evtMs) - Math.abs(new Date(b.activity_at).getTime() - evtMs))
    } else {
      candidates.sort((a, b) => (a.activity_at < b.activity_at ? 1 : -1))
    }
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

// PostgREST caps a single response at db-max-rows (1000); a bare
// `.range(0, 9999)` SILENTLY truncates to 1000 rather than erroring. For a
// query that can exceed 1000 rows — e.g. close_leads created in a wide window
// (1,464 on May 24–Jun 5) — that truncation undercounts the cohort, and a WIDER
// window can return FEWER leads. Paginate to fetch the full set. (Drake
// 2026-06-05: this was the funnel-cohort undercount on wide windows.)
async function fetchAllPaged<T>(
  build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  const PAGE = 1000
  const out: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(from, from + PAGE - 1)
    if (error) throw new Error(`${label} read failed: ${error.message}`)
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

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
  const leadRows = await fetchAllPaged<{
    close_id: string
    date_created: string
    status_id: string | null
  }>(
    (f, t) => sb
      .from('close_leads' as never)
      .select('close_id, date_created, status_id')
      .gte('date_created', range.startUtcIso)
      .lt('date_created', range.endUtcIso)
      .range(f, t),
    'close_leads',
  )
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
  const leadRows = await fetchAllPaged<{
    close_id: string
    display_name: string | null
    date_created: string
    status_id: string | null
  }>(
    (f, t) => sb
      .from('close_leads' as never)
      .select('close_id, display_name, date_created, status_id')
      .gte('date_created', range.startUtcIso)
      .lt('date_created', range.endUtcIso)
      .range(f, t),
    'close_leads',
  )
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
  // 'new'    = first-ever opt-in landed in the window (fresh lead).
  // 'reoptin' = lead already existed in Close (first opt-in predates
  //             the window) but opted in AGAIN during the window. We
  //             still dial them, so they belong in the list. Drake
  //             2026-05-29.
  optInType: 'new' | 'reoptin'
  leadCreatedAt: string             // ISO UTC — Close account creation
  // The opt-in moment this row is anchored to: date_created for new
  // leads, latest_opt_in_date for re-opt-ins. Speed-to-lead is measured
  // from here (Drake #1: re-opt-in speed runs from the re-opt-in, not
  // the original account creation).
  optInAt: string                   // ISO UTC
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
  // Sum of durations (seconds) across this lead's connected (>=90s)
  // outbound calls — total talk time behind the "Connected" column.
  // 0 when no call ever connected. Same call set as anyCallConnected.
  totalConnectedDurationSec: number
  // Count of this lead's connected (>=90s) outbound calls. Drives the
  // ×N multi-call tag on the lead list (shown at >=2; 0/1 = no tag).
  connectedCallCount: number
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

// Scalar stats of a set of cohort rows. Pure over the row fields, so it can be
// re-run over a FILTERED subset (the /leads type/stage filter) to keep the
// speed-to-lead boxes in sync with the roster.
export type CohortStats = Pick<
  SpeedToLeadCohortResult,
  | 'cohortSize'
  | 'leadsCalled'
  | 'leadsConnected'
  | 'avgSpeedToLeadSec'
  | 'avgSpeedToLeadSecUnder3h'
  | 'leadsUnder3h'
  | 'connectedRate'
  | 'avgIntensity'
>

export function summarizeCohortRows(rows: SpeedToLeadCohortRow[]): CohortStats {
  const UNDER_3H_THRESHOLD_SEC = 3 * 60 * 60
  let cappedSum = 0
  let speedN = 0
  let under3hSum = 0
  let under3hN = 0
  let connectedCount = 0
  let calledCount = 0
  let intensitySum = 0
  for (const r of rows) {
    if (r.speedSec !== null) {
      cappedSum += Math.min(r.speedSec, SPEED_CAP_SEC)
      speedN++
      if (r.speedSec < UNDER_3H_THRESHOLD_SEC) {
        under3hSum += r.speedSec
        under3hN++
      }
    }
    if (r.firstCallAt) {
      calledCount++
      intensitySum += r.intensity // CALLED leads only (uncalled = 0, would drag the mean)
    }
    if (r.anyCallConnected) connectedCount++
  }
  return {
    cohortSize: rows.length,
    leadsCalled: calledCount,
    leadsConnected: connectedCount,
    avgSpeedToLeadSec: speedN > 0 ? cappedSum / speedN : null,
    avgSpeedToLeadSecUnder3h: under3hN > 0 ? under3hSum / under3hN : null,
    leadsUnder3h: under3hN,
    connectedRate: calledCount > 0 ? connectedCount / calledCount : null,
    avgIntensity: calledCount > 0 ? intensitySum / calledCount : null,
  }
}

export async function getSpeedToLeadCohort(
  arg: Window | DateRange,
  callerFilter?: string | null,
): Promise<SpeedToLeadCohortResult> {
  const range = resolveRange(arg)
  const sb = createAdminClient()

  // Cohort = NEW opt-ins (account created in window, qualifying initial
  // status — the junk/test filter) UNION RE-OPT-INS (account predates
  // the window but opted in AGAIN during it). Re-opt-ins are still
  // dialed, so they belong in the list; their speed-to-lead anchors to
  // latest_opt_in_date, not the old account-creation date. Drake
  // 2026-05-29.
  type CohortLead = {
    close_id: string
    display_name: string | null
    date_created: string
    status_id: string | null
    optInType: 'new' | 'reoptin'
    optInAt: string
  }

  // "DC Revival Lead" Close custom field (cf_QivX…). Set by the re-engagement
  // SMS automation on revival-campaign leads — many of which Close auto-creates
  // as 'New Opt-in' when first texted. Drop any tagged lead from the cohort so
  // the revival batch never bombards the leads list / funnel / speed boxes /
  // FMR (all of which share this cohort). Drake 2026-06-03.
  const REVIVAL_CF = 'cf_QivXkWBvr34UIDkUBKXNCQo6woarc62wEbIacWWbN7P'
  const isRevival = (cf: Record<string, unknown> | null | undefined): boolean => {
    const v = cf?.[REVIVAL_CF]
    return v != null && String(v).trim() !== ''
  }

  // --- Membership: NEW high-ticket opt-ins, May 24 onward ---
  // A lead is in the cohort iff BOTH hold (Drake 2026-06-05):
  //   (a) it has a Typeform-sourced opt-in cycle in the window
  //       (`lead_cycles.source = 'typeform'`). Typeform (SFedWelr) is the
  //       high-ticket gate AND the only true opt-in-event record; close_fallback
  //       cycles (a Close opt-in date with no Typeform match) are NOT counted.
  //   (b) its FIRST-EVER opt-in (Close `date_first_opted_in`) falls in the
  //       window. Returning leads — those who first opted in BEFORE the window
  //       but re-opted-in during it — are excluded everywhere (lead list +
  //       funnel). Their re-opt activity still lives in lead_cycles and on the
  //       Talent / per-lead surfaces; it just isn't counted in this cohort.
  // Revival-tagged and soft-hidden (test) leads are dropped. Every cohort lead
  // is `optInType: 'new'` — there is no longer a re-opt-in member type (a new
  // lead who opts in twice still contributes its extra cycles to the funnel's
  // event count, but is ONE person in the list). Replaces the prior
  // Close-status-qualified "new ∪ re-opt-in" membership.
  //
  // NOTE: `date_first_opted_in` is read from Close, NOT lead_cycles.firstOptInAt
  // — the tagger floors opt-ins at the May-24 horizon, so its firstOptInAt can't
  // tell a genuinely-new lead from a returning one. Close's field is the only
  // record of the true original opt-in.

  // (a) Typeform opt-in cycles in the window → earliest opt-in timestamp per
  // lead (the speed-to-lead anchor). Paginated against the 1000-row cap.
  // (b) close_leads whose FIRST-EVER opt-in falls in the ET window, not
  // soft-hidden. `date_first_opted_in` is a bare `date` → ET calendar compare.
  // (a) and (b) are independent reads — fetch concurrently, then assemble.
  const [tfCycles, candidates] = await Promise.all([
    fetchAllPaged<{ close_id: string; opt_in_at: string }>(
      (f, t) => sb
        .from('lead_cycles' as never)
        .select('close_id, opt_in_at')
        .eq('source', 'typeform')
        .gte('opt_in_at', range.startUtcIso)
        .lt('opt_in_at', range.endUtcIso)
        .range(f, t),
      'lead_cycles typeform',
    ),
    fetchAllPaged<{
      close_id: string
      display_name: string | null
      date_created: string
      status_id: string | null
      custom_fields_raw: Record<string, unknown> | null
    }>(
      (f, t) => sb
        .from('close_leads' as never)
        .select('close_id, display_name, date_created, status_id, custom_fields_raw')
        .is('excluded_at', null)
        .gte('date_first_opted_in', range.startEtDate)
        .lte('date_first_opted_in', range.endEtDate)
        .range(f, t),
      'close_leads first-opt-in-window',
    ),
  ])
  const firstTfOptIn = new Map<string, string>()
  for (const r of tfCycles) {
    const prev = firstTfOptIn.get(r.close_id)
    if (!prev || r.opt_in_at < prev) firstTfOptIn.set(r.close_id, r.opt_in_at)
  }

  const cohortLeads: CohortLead[] = []
  for (const l of candidates) {
    if (isRevival(l.custom_fields_raw)) continue // drop revival-tagged leads
    const optInAt = firstTfOptIn.get(l.close_id)
    if (!optInAt) continue // no Typeform match → not a high-ticket opt-in
    cohortLeads.push({
      close_id: l.close_id,
      display_name: l.display_name,
      date_created: l.date_created,
      status_id: l.status_id,
      optInType: 'new',
      optInAt,
    })
  }

  if (cohortLeads.length === 0) {
    return { cohortSize: 0, leadsCalled: 0, leadsConnected: 0, avgSpeedToLeadSec: null, avgSpeedToLeadSecUnder3h: null, leadsUnder3h: 0, connectedRate: null, avgIntensity: null, callers: [], rows: [] }
  }
  const qualifyingLeads = cohortLeads
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
  // Per-lead total talk time + count across connected (>=90s) calls —
  // populated in the same pass as leadsWithAnyConnect so they share the
  // exact call set the "Connected" column reflects.
  const connectedDurationByLead = new Map<string, number>()
  const connectedCallCountByLead = new Map<string, number>()
  const dialCountByLead = new Map<string, number>()
  const nameByUser = new Map<string, string>()
  if (process.env.SALES_SPEED_USE_SCAN === '1') {
    // DB-side filter to the cohort lead set (was: scan ALL outbound calls since
    // the window start, discard non-cohort in JS). Chunked `.in(lead_id)` over
    // the close_calls(lead_id, date_created) index — same calls processed, just
    // filtered before transfer. Provably identical: all of a lead's calls land
    // in its chunk, ordered by activity_at, so first/second-call + per-lead
    // aggregates are unchanged. nameByUser is per-user (rep names are stable),
    // so chunk order doesn't affect it.
    const cohortIds = Array.from(qualifyingMap.keys())
    for (let i = 0; i < cohortIds.length; i += 100) {
      const idChunk = cohortIds.slice(i, i + 100)
      let from = 0
      for (;;) {
        const { data: page, error } = await sb
          .from('close_calls' as never)
          .select('lead_id, user_id, activity_at, duration, raw_payload')
          .eq('direction', 'outbound')
          .gte('activity_at', range.startUtcIso)
          .in('lead_id', idChunk)
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
          const lead = qualifyingMap.get(r.lead_id)
          if (!lead) continue
          // Re-opting in resets a lead's stats (Drake 2026-05-31): only count
          // calls at/after the lead's anchor opt-in. For new leads optInAt ≈
          // creation (no-op); for re-opt-ins it drops the prior journey's
          // dials/connects/first-call so intensity, connected, and speed all
          // reflect the current journey only.
          if (r.activity_at < lead.optInAt) continue
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
            connectedDurationByLead.set(r.lead_id, (connectedDurationByLead.get(r.lead_id) ?? 0) + (r.duration ?? 0))
            connectedCallCountByLead.set(r.lead_id, (connectedCallCountByLead.get(r.lead_id) ?? 0) + 1)
          }
          dialCountByLead.set(r.lead_id, (dialCountByLead.get(r.lead_id) ?? 0) + 1)
        }
        if (rows.length < 1000) break
        from += 1000
      }
    }
  } else {
    // SQL-aggregation path (DEFAULT): read the tagger-materialized per-cycle facts
    // (migration 0080) off each cohort person's earliest in-window cycle instead of
    // scanning close_calls. Verified equal to the scan per-lead (Phase 3 Guard B).
    // The first-call duration is encoded 90/null purely so the UNCHANGED row
    // construction's firstConnected check reflects first_two_dials_connected.
    const cohortIds = Array.from(qualifyingMap.keys())
    const optInByLead = new Map(qualifyingLeads.map((l) => [l.close_id, l.optInAt]))
    {
      // Chunks fetched concurrently; close_id is partitioned across chunks, so
      // the per-lead writes below are order-independent.
      const data = await fetchChunked<{
        close_id: string; opt_in_at: string; first_call_at: string | null; intensity: number | null
        any_call_connected: boolean | null; first_two_dials_connected: boolean | null
        caller_user_id: string | null; total_connected_duration_sec: number | null; connected_call_count: number | null
      }>(
        cohortIds,
        (chunk) => sb
          .from('lead_cycles' as never)
          .select('close_id, opt_in_at, first_call_at, intensity, any_call_connected, first_two_dials_connected, caller_user_id, total_connected_duration_sec, connected_call_count')
          .in('close_id', chunk) as never,
        'lead_cycles speed facts read failed',
        200,
      )
      for (const r of data) {
        // Only the cohort person's anchor (earliest in-window) cycle.
        if (r.opt_in_at !== optInByLead.get(r.close_id)) continue
        if (r.first_call_at) firstCallByLead.set(r.close_id, { userId: r.caller_user_id, activity_at: r.first_call_at, duration: r.first_two_dials_connected ? 90 : null })
        if (r.any_call_connected) leadsWithAnyConnect.add(r.close_id)
        dialCountByLead.set(r.close_id, r.intensity ?? 0)
        connectedDurationByLead.set(r.close_id, r.total_connected_duration_sec ?? 0)
        connectedCallCountByLead.set(r.close_id, r.connected_call_count ?? 0)
      }
    }
    // Caller display names — a light lookup for just the cohort's callers (a
    // handful of reps), not a full call scan. user_id is partitioned across
    // chunks; nameByUser first-wins is preserved (chunk order kept).
    const callerIds = Array.from(new Set(Array.from(firstCallByLead.values()).map((c) => c.userId).filter((u): u is string => !!u)))
    {
      const data = await fetchChunked<{ user_id: string | null; raw_payload: { user_name?: string } | null }>(
        callerIds,
        (chunk) => sb
          .from('close_calls' as never)
          .select('user_id, raw_payload')
          .in('user_id', chunk)
          .limit(1000) as never,
        'caller name lookup failed',
        100,
      )
      for (const r of data) {
        if (r.user_id && r.raw_payload?.user_name && !nameByUser.has(r.user_id)) nameByUser.set(r.user_id, r.raw_payload.user_name)
      }
    }
  }

  // Prospect names from Airtable form (any form row matching by
  // lead_id). Form prospect_name beats lead.display_name when both
  // are present — the form was filled by a human who confirmed it.
  const prospectFromForm = new Map<string, string>()
  {
    const leadIds = Array.from(qualifyingMap.keys())
    // lead_id partitioned across chunks; per-lead first-wins is preserved since
    // chunk order (and each chunk's row order) is unchanged.
    const data = await fetchChunked<{ lead_id: string; prospect_name: string | null }>(
      leadIds,
      (chunk) => sb
        .from('airtable_setter_triage_calls' as never)
        .select('lead_id, prospect_name')
        .in('lead_id', chunk)
        .not('prospect_name', 'is', null) as never,
      'airtable prospect lookup failed',
      100,
    )
    for (const r of data) {
      if (r.lead_id && r.prospect_name && !prospectFromForm.has(r.lead_id)) {
        prospectFromForm.set(r.lead_id, r.prospect_name)
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
      // Speed runs from the opt-in moment (account-creation for new
      // leads, latest_opt_in_date for re-opt-ins), not account creation.
      const dt = (new Date(call.activity_at).getTime() - new Date(lead.optInAt).getTime()) / 1000
      if (Number.isFinite(dt) && dt >= 0) speedSec = dt
    }
    const firstConnected = call ? (call.duration ?? 0) >= 90 : false
    const secondConnected = second ? (second.duration ?? 0) >= 90 : false
    allRows.push({
      leadId: lead.close_id,
      prospectName: prospectFromForm.get(lead.close_id) ?? lead.display_name ?? null,
      optInType: lead.optInType,
      leadCreatedAt: lead.date_created,
      optInAt: lead.optInAt,
      firstCallAt: call?.activity_at ?? null,
      firstTwoDialsConnected: firstConnected || secondConnected,
      anyCallConnected: leadsWithAnyConnect.has(lead.close_id),
      intensity: dialCountByLead.get(lead.close_id) ?? 0,
      callerUserId: call?.userId ?? null,
      callerName: call?.userId ? (nameByUser.get(call.userId) ?? null) : null,
      speedSec,
      totalConnectedDurationSec: connectedDurationByLead.get(lead.close_id) ?? 0,
      connectedCallCount: connectedCallCountByLead.get(lead.close_id) ?? 0,
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
  const stats = summarizeCohortRows(filteredRows)

  // Sort rows: most recent first call first; leads without calls go
  // to the bottom.
  filteredRows.sort((a, b) => {
    if (a.firstCallAt && b.firstCallAt) return a.firstCallAt < b.firstCallAt ? 1 : -1
    if (a.firstCallAt) return -1
    if (b.firstCallAt) return 1
    return 0
  })

  return { ...stats, callers, rows: filteredRows }
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

// Session grouping — ALL over-90s calls to the same lead by the same
// rep collapse into ONE session, regardless of how far apart they are
// (Drake 2026-05-29: dedup leads in the per-rep area no matter the
// timeline). So a rep who calls a lead today and again next week shows
// one engagement row; the "×N" tag beside the prospect reflects the
// full call count. History: 3h (2026-05-27) → 1 day (2026-05-28) →
// unbounded (2026-05-29).
const SESSION_GAP_MS = Number.POSITIVE_INFINITY

type CallForSession = { callId: string; activityAt: string }
type CallSession = {
  callIds: string[]             // ordered by activityAt ascending
  firstActivityAt: string
  lastActivityAt: string
  sessionKey: string            // `${leadId}|${firstActivityAt}` — unique per rep/lead/session
}

// Group a per-rep, per-lead list of >90s calls into sessions. Calls
// whose activityAt is within SESSION_GAP_MS of the previous call in
// the chain land in the same session. Start-to-start comparison.
function groupCallsIntoSessions(leadId: string, calls: CallForSession[]): CallSession[] {
  if (calls.length === 0) return []
  const sorted = [...calls].sort((a, b) => (a.activityAt < b.activityAt ? -1 : 1))
  const out: CallSession[] = []
  let curIds: string[] = [sorted[0].callId]
  let curFirst = sorted[0].activityAt
  let curLast = sorted[0].activityAt
  for (let i = 1; i < sorted.length; i++) {
    const c = sorted[i]
    const gap = new Date(c.activityAt).getTime() - new Date(curLast).getTime()
    if (gap <= SESSION_GAP_MS) {
      curIds.push(c.callId)
      curLast = c.activityAt
    } else {
      out.push({ callIds: curIds, firstActivityAt: curFirst, lastActivityAt: curLast, sessionKey: `${leadId}|${curFirst}` })
      curIds = [c.callId]
      curFirst = c.activityAt
      curLast = c.activityAt
    }
  }
  out.push({ callIds: curIds, firstActivityAt: curFirst, lastActivityAt: curLast, sessionKey: `${leadId}|${curFirst}` })
  return out
}

export type CallActivityRepRow = {
  userId: string | null
  name: string | null
  totalCalls: number
  // Close calls in window with duration > 90s. Raw count, not used
  // for Connected or Missing (both use session count below) — exposed
  // here for downstream consumers (pulse-history, funnel-stages).
  totalOver90s: number
  // Drill-entry count == what the Connected column shows. Equals
  // `over-90s sessions + in-range form-only rows`. A session is one
  // or more chained >90s calls to the same lead within 1 day of each
  // other (setter redials after disconnect → still one engagement).
  // Form-only rows are triage forms attributed to this rep whose
  // underlying call was <=90s (setter still filed an EOC, real
  // engagement). Drake 2026-05-27.
  totalConnected: number
  // ── Outcome counts from Airtable `call_status`, routed by `form_type`
  //    (Setter Triage Form → setter list, Closer Triage Form → closer
  //    list — Drake 2026-05-29). Each variant's UI shows only its own
  //    columns; the off-variant fields stay 0.
  // Setter form columns: htBookings, dcBookings, followUps, dqs.
  htBookings: number        // 'High Ticket booking'
  dcBookings: number        // 'Digital College booking'
  // DC closes credited to the booking setter — a DC meeting they booked that
  // closed (Robby's DC form OR an Aman downsell). Setter family only; 0 for
  // closers. Sourced separately from the close forms, not the triage status.
  dcCloses: number
  followUps: number         // 'Setter pipeline / Follow up' (+ 'Unresponsive – Setter Handover', merged per Drake)
  // Closer form columns: confirmedBooks, confirmedNewTime, downsellsOnCall, followUps, dqs.
  confirmedBooks: number    // 'Confirmed Booking'
  confirmedNewTime: number  // 'Confirmed Booking – New Time'
  downsellsOnCall: number   // 'Downsold'
  // Shared:
  dqs: number               // 'DQ / Un-interested'
  // Sessions with no EOC form filed — the engagement proxy fired
  // (over-90s call(s) to the same lead in 3h) but no form matched
  // any call in the session. max(0, sessions - matchedSessions) so
  // it never goes negative when a form's effective_date falls
  // outside the range or the form was filed without a matching call.
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
  // Number of >90s calls in the session this row represents. 1 for
  // ordinary single-call rows (the default); > 1 means the setter
  // dialed the same lead multiple times within 1 day and we collapsed
  // them into one row (UI shows a "×N" tag).
  groupedCallCount?: number
  // Airtable record_id of the EOC triage form backing this row, when
  // one exists (matched-form rows + form-only rows). Null for calls
  // with no form. Drives the creator-only "hide test call" × — only
  // form-backed rows can be hidden (the × acts on this record).
  formRecordId?: string | null
  // Form family backing this row: 'closer' (Closer Triage Form),
  // 'setter' (Setter Triage Form), or null (a connect with no form).
  // The drill renders only its own family — the Confirmation table shows
  // closer-backed connects, the Triage table the rest.
  family: 'setter' | 'closer' | null
}

// V1 (legacy full close_calls scan) — kept behind SALES_REP_ACTIVITY_USE_JS=1 and
// used by the diff harness. The volume scan + JS session-grouping here are what
// getCallActivityMetricsRpc replaces with the sales_rep_call_activity aggregate.
export async function getCallActivityMetricsLive(arg: Window | DateRange): Promise<CallActivityResult> {
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
  // We also retain (user_id, lead_id, close_id, activity_at) tuples for
  // every over-90s call so we can group them into sessions below —
  // multiple calls to the same lead within 1 day chain into one session
  // and count as a single Connected entry / a single expected EOC.
  type Vol = { calls: number; over90s: number }
  const volumeByUser = new Map<string, Vol>()
  const nameByUser = new Map<string, string>()
  const userIdByName = new Map<string, string>()
  // (userId, leadId) → list of >90s calls in window
  const over90sByUserLead = new Map<string, Map<string, CallForSession[]>>()
  {
    // No direction filter on the volume aggregate — both inbound and
    // outbound count toward the rep's call activity (engagement on
    // the phone is engagement either way).
    let from = 0
    for (;;) {
      const { data: page, error } = await sb
        .from('close_calls' as never)
        .select('close_id, user_id, lead_id, activity_at, duration, raw_payload')
        .not('user_id', 'is', null)
        .gte('activity_at', range.startUtcIso)
        .lt('activity_at', range.endUtcIso)
        .range(from, from + 999)
      if (error) throw new Error(`close_calls read failed: ${error.message}`)
      const rows = (page ?? []) as unknown as Array<{
        close_id: string
        user_id: string
        lead_id: string | null
        activity_at: string
        duration: number | null
        raw_payload: { user_name?: string } | null
      }>
      if (rows.length === 0) break
      for (const r of rows) {
        if (!volumeByUser.has(r.user_id)) volumeByUser.set(r.user_id, { calls: 0, over90s: 0 })
        const v = volumeByUser.get(r.user_id)!
        v.calls++
        if ((r.duration ?? 0) > 90) {
          v.over90s++
          if (r.lead_id) {
            if (!over90sByUserLead.has(r.user_id)) over90sByUserLead.set(r.user_id, new Map())
            const perLead = over90sByUserLead.get(r.user_id)!
            if (!perLead.has(r.lead_id)) perLead.set(r.lead_id, [])
            perLead.get(r.lead_id)!.push({ callId: r.close_id, activityAt: r.activity_at })
          }
        }

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

  // Group into sessions per (user, lead). Build two per-user maps:
  //   sessionCountByUser: number of sessions (== Connected base)
  //   sessionKeyByCallId: close_id → sessionKey, for matching forms
  //     back to a specific session in the loop below.
  const sessionCountByUser = new Map<string, number>()
  const sessionKeyByCallIdPerUser = new Map<string, Map<string, string>>()
  over90sByUserLead.forEach((leadMap, userId) => {
    let total = 0
    const callIdMap = new Map<string, string>()
    leadMap.forEach((calls, leadId) => {
      const sessions = groupCallsIntoSessions(leadId, calls)
      total += sessions.length
      for (const s of sessions) for (const cid of s.callIds) callIdMap.set(cid, s.sessionKey)
    })
    sessionCountByUser.set(userId, total)
    sessionKeyByCallIdPerUser.set(userId, callIdMap)
  })

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
  //
  // Outcomes carries every possible bucket (setter-side + closer-side +
  // shared). Setter rows only populate setter buckets, closer rows only
  // populate closer buckets — see the resolveRole branch below.
  type Outcomes = {
    htBookings: number
    dcBookings: number
    followUps: number
    confirmedBooks: number
    confirmedNewTime: number
    downsellsOnCall: number
    dqs: number
  }
  const newOutcomes = (): Outcomes => ({
    htBookings: 0,
    dcBookings: 0,
    followUps: 0,
    confirmedBooks: 0,
    confirmedNewTime: 0,
    downsellsOnCall: 0,
    dqs: 0,
  })
  // Two outcome maps, routed by Form Type: Setter Triage Form → setter,
  // Closer Triage Form → closer. A rep filing both appears in both lists.
  const setterOutcomesByUser = new Map<string, Outcomes>()
  const closerOutcomesByUser = new Map<string, Outcomes>()
  // Per-rep set of session keys a form matched, SPLIT by the matched form's
  // family (Drake 2026-05-31). The Confirmation (closer) table counts only
  // confirmation-call connections; the Triage (setter) table counts the rest.
  // Dials stay total (mimic) in both — they're not form-typed — but a stray
  // closer form must not drag a setter's whole call volume into the
  // Confirmation table's Connected/Missing.
  const matchedSessionsCloserByUser = new Map<string, Set<string>>()
  const matchedSessionsSetterByUser = new Map<string, Set<string>>()
  // Per-rep count of form-only rows (in-range forms whose underlying call
  // wasn't a >90s close_call), split by family — bumps each table's Connected.
  const formOnlyCloserByUser = new Map<string, number>()
  const formOnlySetterByUser = new Map<string, number>()
  let totalForms = 0
  {
    type FormRow = {
      record_id: string
      lead_id: string | null
      form_type: string | null         // 'Setter Triage Form' | 'Closer Triage Form'
      call_status: string | null       // the shared outcome (2026-05-26 redesign)
      setter_names: string[] | null
      setter_record_ids: string[] | null
      event_date_time: string | null
      airtable_created_at: string
    }
    const allRows: FormRow[] = []
    const formWindowStartIso = range.startUtcIso
    const formWindowEndIso = new Date(new Date(range.endUtcIso).getTime() + FORM_MATCH_LOOKBACK_HOURS * 3600 * 1000).toISOString()
    let from = 0
    for (;;) {
      const { data: page, error } = await sb
        .from('airtable_setter_triage_calls' as never)
        .select('record_id, lead_id, form_type, call_status, setter_names, setter_record_ids, event_date_time, airtable_created_at')
        .is('excluded_at', null)   // creator-hidden test entries drop out of per-rep counts
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

    // Dedupe by lead_id — latest form (by airtable_created_at) wins.
    // Drake 2026-05-28: when a setter files multiple EOCs against the
    // same lead (revising an outcome, e.g. "Follow up" → "Confirmed HT
    // Booking" later in the day), the latest filing is the truth.
    // Drop rows with no lead_id — empty/junk submissions Airtable's
    // own views also exclude.
    const latestByLead = new Map<string, FormRow>()
    for (const r of inRangeRows) {
      if (!r.lead_id) continue
      const existing = latestByLead.get(r.lead_id)
      if (!existing || r.airtable_created_at > existing.airtable_created_at) {
        latestByLead.set(r.lead_id, r)
      }
    }
    latestByLead.forEach((r) => {
      const m = matchByRecord.get(r.record_id)
      // Use the same resolver as matchInputs above — airtable rec_id
      // wins over name. A form attributes to exactly one rep (a real
      // form has one setter; multi-setter forms get the first-resolved
      // owner only, matching dedupe-by-lead semantics elsewhere).
      const uid = resolveFormSetterUserId(r.setter_record_ids, r.setter_names, salesId, userIdByName)
      if (!uid) return
      // Route the outcome by Form Type (Drake 2026-05-29): Setter Triage
      // Form → setter list, Closer Triage Form → closer list. Rows with
      // no form_type (pre-2026-05-26 old-form transition entries) are
      // skipped here — Drake reconciles those manually.
      const ft = (r.form_type ?? '').toLowerCase()
      const isCloserForm = ft.includes('closer')
      const isSetterForm = ft.includes('setter')
      if (!isCloserForm && !isSetterForm) return
      const bucket = classifyCallStatus(r.call_status)
      if (bucket === 'unclassified') return
      const target = isCloserForm ? closerOutcomesByUser : setterOutcomesByUser
      if (!target.has(uid)) target.set(uid, newOutcomes())
      target.get(uid)![bucket]++
      if (m?.matchedCallId) {
        const sessionKey = sessionKeyByCallIdPerUser.get(uid)?.get(m.matchedCallId)
        if (sessionKey) {
          const fam = isCloserForm ? matchedSessionsCloserByUser : matchedSessionsSetterByUser
          if (!fam.has(uid)) fam.set(uid, new Set())
          fam.get(uid)!.add(sessionKey)
        }
      }
    })

    // Form-only count per rep — raw (no lead-dedupe), to match the
    // drill table's row count. A form-only row is an in-range form
    // whose underlying call wasn't a >90s close_call (setter still
    // filled the EOC; the call was just shorter than the engagement
    // proxy). Used to bump the Connected column past `totalOver90s`.
    for (const r of inRangeRows) {
      const m = matchByRecord.get(r.record_id)
      if (m?.matchedCallId) continue   // matched to a >90s call → already in over90s
      const uid = resolveFormSetterUserId(r.setter_record_ids, r.setter_names, salesId, userIdByName)
      if (!uid) continue
      const ft = (r.form_type ?? '').toLowerCase()
      if (ft.includes('closer')) formOnlyCloserByUser.set(uid, (formOnlyCloserByUser.get(uid) ?? 0) + 1)
      else if (ft.includes('setter')) formOnlySetterByUser.set(uid, (formOnlySetterByUser.get(uid) ?? 0) + 1)
    }
  }

  // DC-close credit per booking setter (Drake 2026-05-31). A Digital College
  // close is credited back to the setter who booked the meeting, from BOTH
  // DC-close paths: Robby's dedicated DC sale form (airtable_digital_college_sales,
  // Closed?=Yes) and Aman's downsell on the closer report (call_outcome =
  // 'Digital College Closed'). Setter resolved by the same record-id→user
  // resolver as the triage forms. Deduped by lead so a lead counts once;
  // range-filtered by the close's effective time. (Booking credit stays on the
  // existing triage-sourced "DC Book" column — this adds the missing closes.)
  const dcClosesBySetterUser = new Map<string, number>()
  {
    // (setterUserId, leadId) pairs already counted — dedupe across both sources.
    const counted = new Set<string>()
    const credit = (
      uid: string | null,
      leadId: string | null,
      effIso: string | null,
    ) => {
      if (!uid) return
      if (!effIso || effIso < range.startUtcIso || effIso >= range.endUtcIso) return
      const key = `${uid}::${leadId ?? ''}`
      if (leadId && counted.has(key)) return
      if (leadId) counted.add(key)
      dcClosesBySetterUser.set(uid, (dcClosesBySetterUser.get(uid) ?? 0) + 1)
    }
    // (a) Robby's DC sale form.
    {
      const { data, error } = await sb
        .from('airtable_digital_college_sales' as never)
        .select('lead_id, closed, setter_record_ids, setter_names, date_time_of_call, airtable_created_at')
        .is('excluded_at', null)
      if (error) throw new Error(`digital_college_sales (setter credit) read failed: ${error.message}`)
      for (const r of (data ?? []) as unknown as Array<{
        lead_id: string | null; closed: string | null
        setter_record_ids: string[] | null; setter_names: string[] | null
        date_time_of_call: string | null; airtable_created_at: string | null
      }>) {
        if ((r.closed ?? '').trim().toLowerCase() !== 'yes') continue
        const uid = resolveFormSetterUserId(r.setter_record_ids, r.setter_names, salesId, userIdByName)
        credit(uid, r.lead_id, r.date_time_of_call ?? r.airtable_created_at)
      }
    }
    // (b) Aman-downsell DC closes on the closer report.
    {
      const { data, error } = await sb
        .from('airtable_full_closer_report' as never)
        .select('lead_id, call_outcome, setter_record_ids, setter_names, date_time_of_call, airtable_created_at')
        .eq('form_type', 'New')
      if (error) throw new Error(`closer_report (DC setter credit) read failed: ${error.message}`)
      for (const r of (data ?? []) as unknown as Array<{
        lead_id: string | null; call_outcome: string | null
        setter_record_ids: string[] | null; setter_names: string[] | null
        date_time_of_call: string | null; airtable_created_at: string | null
      }>) {
        if (!(r.call_outcome ?? '').toLowerCase().includes('digital college closed')) continue
        const uid = resolveFormSetterUserId(r.setter_record_ids, r.setter_names, salesId, userIdByName)
        credit(uid, r.lead_id, r.date_time_of_call ?? r.airtable_created_at)
      }
    }
  }

  // Compose per-rep rows. Volume/sessions are per-rep; outcomes come
  // from the form-type-routed maps.
  const setters: CallActivityRepRow[] = []
  const closers: CallActivityRepRow[] = []
  const buildRow = (userId: string, o: Outcomes, family: 'setter' | 'closer'): CallActivityRepRow => {
    const v = volumeByUser.get(userId) ?? { calls: 0, over90s: 0 }
    const totalSessions = sessionCountByUser.get(userId) ?? 0
    const closerMatched = matchedSessionsCloserByUser.get(userId)?.size ?? 0
    const setterMatched = matchedSessionsSetterByUser.get(userId)?.size ?? 0
    // Connections attributed by the matched form's family; unmatched sessions
    // default to setter (an unproven >90s call isn't a confirmation call, and
    // setters do the bulk of dialing). Dials + over-90s stay total in both.
    const familySessions = family === 'closer' ? closerMatched : Math.max(0, totalSessions - closerMatched)
    const familyMatched = family === 'closer' ? closerMatched : setterMatched
    const familyFormOnly = (family === 'closer' ? formOnlyCloserByUser : formOnlySetterByUser).get(userId) ?? 0
    return {
      userId,
      name: nameByUser.get(userId) ?? null,
      totalCalls: v.calls,
      totalOver90s: v.over90s,
      totalConnected: familySessions + familyFormOnly,
      htBookings: o.htBookings,
      dcBookings: o.dcBookings,
      // DC-close credit applies to the setter who booked the meeting; closers
      // are credited as the closer elsewhere, so this stays setter-only.
      dcCloses: family === 'setter' ? (dcClosesBySetterUser.get(userId) ?? 0) : 0,
      followUps: o.followUps,
      confirmedBooks: o.confirmedBooks,
      confirmedNewTime: o.confirmedNewTime,
      downsellsOnCall: o.downsellsOnCall,
      dqs: o.dqs,
      missing: Math.max(0, familySessions - familyMatched),
    }
  }
  // Setter list = reps with Setter Triage Form outcomes; closer list =
  // reps with Closer Triage Form outcomes. Reps with call volume but no
  // forms fall back to resolveRole (empty outcomes). A rep filing both
  // form types appears once in each list with the matching outcomes.
  const setterUserIds = new Set<string>(setterOutcomesByUser.keys())
  const closerUserIds = new Set<string>(closerOutcomesByUser.keys())
  for (const userId of Array.from(volumeByUser.keys())) {
    if (setterUserIds.has(userId) || closerUserIds.has(userId)) continue
    const role = resolveRole(userId, closerUsers, setterUsers)
    if (role === 'setter') setterUserIds.add(userId)
    else if (role === 'closer') closerUserIds.add(userId)
  }
  setterUserIds.forEach((uid) => setters.push(buildRow(uid, setterOutcomesByUser.get(uid) ?? newOutcomes(), 'setter')))
  closerUserIds.forEach((uid) => closers.push(buildRow(uid, closerOutcomesByUser.get(uid) ?? newOutcomes(), 'closer')))
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

// V2 (DEFAULT) — the per-rep call VOLUME comes from the sales_rep_call_activity
// SQL aggregate (migration 0082) instead of paginating every call into Node and
// JS-grouping sessions. The form outcomes, the form<->call matching, the family
// attribution, formOnly, `missing`, the DC-close credit, and the connected
// composition (familySessions + familyFormOnly = >=90s-OR-form) are UNCHANGED —
// reproduced here exactly, reading the RPC's per-rep volume/sessions. Matched
// sessions are derived from the matched call's (uid, lead) — equivalent to the
// JS sessionKey under SESSION_GAP_MS = Infinity (one session per user+lead).
export async function getCallActivityMetricsRpc(arg: Window | DateRange): Promise<CallActivityResult> {
  const range = resolveRange(arg)
  const sb = createAdminClient()

  const salesId = await loadSalesIdentity(sb)

  const volumeByUser = new Map<string, { calls: number; over90s: number }>()
  const sessionCountByUser = new Map<string, number>()
  const nameByUser = new Map<string, string>()
  const userIdByName = new Map<string, string>()
  const closerUsers = new Set<string>()
  const setterUsers = new Set<string>()

  // Owner index + the volume RPC run concurrently.
  const [ownerRes, rpcRes] = await Promise.all([
    sb
      .from('close_leads' as never)
      .select('closer_owner_id, setter_owner_id')
      .or('closer_owner_id.not.is.null,setter_owner_id.not.is.null')
      .range(0, 19999),
    sb.rpc('sales_rep_call_activity' as never, { p_since: range.startUtcIso, p_until: range.endUtcIso } as never),
  ])
  if (ownerRes.error) throw new Error(`close_leads owner read failed: ${ownerRes.error.message}`)
  for (const r of (ownerRes.data ?? []) as unknown as Array<{ closer_owner_id: string | null; setter_owner_id: string | null }>) {
    if (r.closer_owner_id) closerUsers.add(r.closer_owner_id)
    if (r.setter_owner_id) setterUsers.add(r.setter_owner_id)
  }
  if (rpcRes.error) throw new Error(`sales_rep_call_activity read failed: ${rpcRes.error.message}`)
  for (const r of (rpcRes.data ?? []) as unknown as Array<{
    user_id: string; total_calls: number; total_over90s: number; total_sessions: number; name_hint: string | null
  }>) {
    volumeByUser.set(r.user_id, { calls: Number(r.total_calls), over90s: Number(r.total_over90s) })
    sessionCountByUser.set(r.user_id, Number(r.total_sessions))
    if (r.name_hint && !nameByUser.has(r.user_id)) {
      nameByUser.set(r.user_id, r.name_hint)
      userIdByName.set(r.name_hint, r.user_id)
    }
  }

  mergeSalesIdentity(userIdByName, nameByUser, closerUsers, setterUsers, salesId)

  // ----- Form outcomes (identical to Live) -----
  type Outcomes = {
    htBookings: number; dcBookings: number; followUps: number
    confirmedBooks: number; confirmedNewTime: number; downsellsOnCall: number; dqs: number
  }
  const newOutcomes = (): Outcomes => ({
    htBookings: 0, dcBookings: 0, followUps: 0, confirmedBooks: 0, confirmedNewTime: 0, downsellsOnCall: 0, dqs: 0,
  })
  const setterOutcomesByUser = new Map<string, Outcomes>()
  const closerOutcomesByUser = new Map<string, Outcomes>()
  const matchedSessionsCloserByUser = new Map<string, Set<string>>()
  const matchedSessionsSetterByUser = new Map<string, Set<string>>()
  const formOnlyCloserByUser = new Map<string, number>()
  const formOnlySetterByUser = new Map<string, number>()
  let totalForms = 0
  {
    type FormRow = {
      record_id: string; lead_id: string | null; form_type: string | null; call_status: string | null
      setter_names: string[] | null; setter_record_ids: string[] | null; event_date_time: string | null; airtable_created_at: string
    }
    const allRows: FormRow[] = []
    const formWindowStartIso = range.startUtcIso
    const formWindowEndIso = new Date(new Date(range.endUtcIso).getTime() + FORM_MATCH_LOOKBACK_HOURS * 3600 * 1000).toISOString()
    let from = 0
    for (;;) {
      const { data: page, error } = await sb
        .from('airtable_setter_triage_calls' as never)
        .select('record_id, lead_id, form_type, call_status, setter_names, setter_record_ids, event_date_time, airtable_created_at')
        .is('excluded_at', null)
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

    // Latest form per lead wins (revised outcome later in the day).
    const latestByLead = new Map<string, FormRow>()
    for (const r of inRangeRows) {
      if (!r.lead_id) continue
      const existing = latestByLead.get(r.lead_id)
      if (!existing || r.airtable_created_at > existing.airtable_created_at) latestByLead.set(r.lead_id, r)
    }
    latestByLead.forEach((r) => {
      const uid = resolveFormSetterUserId(r.setter_record_ids, r.setter_names, salesId, userIdByName)
      if (!uid) return
      const ft = (r.form_type ?? '').toLowerCase()
      const isCloserForm = ft.includes('closer')
      const isSetterForm = ft.includes('setter')
      if (!isCloserForm && !isSetterForm) return
      const bucket = classifyCallStatus(r.call_status)
      if (bucket === 'unclassified') return
      const target = isCloserForm ? closerOutcomesByUser : setterOutcomesByUser
      if (!target.has(uid)) target.set(uid, newOutcomes())
      target.get(uid)![bucket]++
      const m = matchByRecord.get(r.record_id)
      // Matched session = the matched call's (uid, lead). Equivalent to the JS
      // sessionKey under gap=Infinity; only the set SIZE is used downstream.
      if (m?.matchedCallId && r.lead_id) {
        const fam = isCloserForm ? matchedSessionsCloserByUser : matchedSessionsSetterByUser
        if (!fam.has(uid)) fam.set(uid, new Set())
        fam.get(uid)!.add(`${uid}::${r.lead_id}`)
      }
    })

    // Form-only count per rep — raw (no lead-dedupe), forms whose call wasn't a
    // >90s close_call. Bumps Connected past the >90s sessions.
    for (const r of inRangeRows) {
      const m = matchByRecord.get(r.record_id)
      if (m?.matchedCallId) continue
      const uid = resolveFormSetterUserId(r.setter_record_ids, r.setter_names, salesId, userIdByName)
      if (!uid) continue
      const ft = (r.form_type ?? '').toLowerCase()
      if (ft.includes('closer')) formOnlyCloserByUser.set(uid, (formOnlyCloserByUser.get(uid) ?? 0) + 1)
      else if (ft.includes('setter')) formOnlySetterByUser.set(uid, (formOnlySetterByUser.get(uid) ?? 0) + 1)
    }
  }

  // DC-close credit per booking setter (identical to Live) — both DC-close paths.
  const dcClosesBySetterUser = new Map<string, number>()
  {
    const counted = new Set<string>()
    const credit = (uid: string | null, leadId: string | null, effIso: string | null) => {
      if (!uid) return
      if (!effIso || effIso < range.startUtcIso || effIso >= range.endUtcIso) return
      const key = `${uid}::${leadId ?? ''}`
      if (leadId && counted.has(key)) return
      if (leadId) counted.add(key)
      dcClosesBySetterUser.set(uid, (dcClosesBySetterUser.get(uid) ?? 0) + 1)
    }
    {
      const { data, error } = await sb
        .from('airtable_digital_college_sales' as never)
        .select('lead_id, closed, setter_record_ids, setter_names, date_time_of_call, airtable_created_at')
        .is('excluded_at', null)
      if (error) throw new Error(`digital_college_sales (setter credit) read failed: ${error.message}`)
      for (const r of (data ?? []) as unknown as Array<{
        lead_id: string | null; closed: string | null; setter_record_ids: string[] | null; setter_names: string[] | null
        date_time_of_call: string | null; airtable_created_at: string | null
      }>) {
        if ((r.closed ?? '').trim().toLowerCase() !== 'yes') continue
        const uid = resolveFormSetterUserId(r.setter_record_ids, r.setter_names, salesId, userIdByName)
        credit(uid, r.lead_id, r.date_time_of_call ?? r.airtable_created_at)
      }
    }
    {
      const { data, error } = await sb
        .from('airtable_full_closer_report' as never)
        .select('lead_id, call_outcome, setter_record_ids, setter_names, date_time_of_call, airtable_created_at')
        .eq('form_type', 'New')
      if (error) throw new Error(`closer_report (DC setter credit) read failed: ${error.message}`)
      for (const r of (data ?? []) as unknown as Array<{
        lead_id: string | null; call_outcome: string | null; setter_record_ids: string[] | null; setter_names: string[] | null
        date_time_of_call: string | null; airtable_created_at: string | null
      }>) {
        if (!(r.call_outcome ?? '').toLowerCase().includes('digital college closed')) continue
        const uid = resolveFormSetterUserId(r.setter_record_ids, r.setter_names, salesId, userIdByName)
        credit(uid, r.lead_id, r.date_time_of_call ?? r.airtable_created_at)
      }
    }
  }

  // Compose per-rep rows (identical to Live).
  const setters: CallActivityRepRow[] = []
  const closers: CallActivityRepRow[] = []
  const buildRow = (userId: string, o: Outcomes, family: 'setter' | 'closer'): CallActivityRepRow => {
    const v = volumeByUser.get(userId) ?? { calls: 0, over90s: 0 }
    const totalSessions = sessionCountByUser.get(userId) ?? 0
    const closerMatched = matchedSessionsCloserByUser.get(userId)?.size ?? 0
    const setterMatched = matchedSessionsSetterByUser.get(userId)?.size ?? 0
    const familySessions = family === 'closer' ? closerMatched : Math.max(0, totalSessions - closerMatched)
    const familyMatched = family === 'closer' ? closerMatched : setterMatched
    const familyFormOnly = (family === 'closer' ? formOnlyCloserByUser : formOnlySetterByUser).get(userId) ?? 0
    return {
      userId,
      name: nameByUser.get(userId) ?? null,
      totalCalls: v.calls,
      totalOver90s: v.over90s,
      totalConnected: familySessions + familyFormOnly,
      htBookings: o.htBookings,
      dcBookings: o.dcBookings,
      dcCloses: family === 'setter' ? (dcClosesBySetterUser.get(userId) ?? 0) : 0,
      followUps: o.followUps,
      confirmedBooks: o.confirmedBooks,
      confirmedNewTime: o.confirmedNewTime,
      downsellsOnCall: o.downsellsOnCall,
      dqs: o.dqs,
      missing: Math.max(0, familySessions - familyMatched),
    }
  }
  const setterUserIds = new Set<string>(setterOutcomesByUser.keys())
  const closerUserIds = new Set<string>(closerOutcomesByUser.keys())
  for (const userId of Array.from(volumeByUser.keys())) {
    if (setterUserIds.has(userId) || closerUserIds.has(userId)) continue
    const role = resolveRole(userId, closerUsers, setterUsers)
    if (role === 'setter') setterUserIds.add(userId)
    else if (role === 'closer') closerUserIds.add(userId)
  }
  setterUserIds.forEach((uid) => setters.push(buildRow(uid, setterOutcomesByUser.get(uid) ?? newOutcomes(), 'setter')))
  closerUserIds.forEach((uid) => closers.push(buildRow(uid, closerOutcomesByUser.get(uid) ?? newOutcomes(), 'closer')))
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

// Public entry — defaults to the RPC-backed V2; SALES_REP_ACTIVITY_USE_JS=1 forces
// the legacy full-scan path (fallback during bake-in; used by the diff harness).
export async function getCallActivityMetrics(arg: Window | DateRange): Promise<CallActivityResult> {
  if (process.env.SALES_REP_ACTIVITY_USE_JS === '1') return getCallActivityMetricsLive(arg)
  return getCallActivityMetricsRpc(arg)
}

function aggregateCallActivity(rows: CallActivityRepRow[]): CallActivityRepRow {
  let calls = 0, over90s = 0, connected = 0, missing = 0
  let htBookings = 0, dcBookings = 0, dcCloses = 0, followUps = 0
  let confirmedBooks = 0, confirmedNewTime = 0, downsellsOnCall = 0
  let dqs = 0
  for (const r of rows) {
    calls += r.totalCalls
    over90s += r.totalOver90s
    connected += r.totalConnected
    htBookings += r.htBookings
    dcBookings += r.dcBookings
    dcCloses += r.dcCloses
    followUps += r.followUps
    confirmedBooks += r.confirmedBooks
    confirmedNewTime += r.confirmedNewTime
    downsellsOnCall += r.downsellsOnCall
    dqs += r.dqs
    missing += r.missing
  }
  return {
    userId: null,
    name: null,
    totalCalls: calls,
    totalOver90s: over90s,
    totalConnected: connected,
    htBookings,
    dcBookings,
    dcCloses,
    followUps,
    confirmedBooks,
    confirmedNewTime,
    downsellsOnCall,
    dqs,
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
      const rows = (page ?? []) as unknown as Array<{ close_id: string; lead_id: string | null; activity_at: string; duration: number | null }>
      if (rows.length === 0) break
      for (const r of rows) {
        if (r.duration == null) continue
        if (!r.lead_id) continue   // null-lead calls can't be grouped into a session keyed by leadId
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

  // Lead display names for call-derived rows. close_id partitioned across
  // chunks → unique keys, order-independent.
  const leadName = new Map<string, string | null>()
  {
    const data = await fetchChunked<{ close_id: string; display_name: string | null }>(
      callLeadIds,
      (chunk) => sb
        .from('close_leads' as never)
        .select('close_id, display_name')
        .in('close_id', chunk) as never,
      'close_leads (drill) read failed',
      100,
    )
    for (const l of data) leadName.set(l.close_id, l.display_name)
  }

  // Pull this rep's airtable_user_id AND sales_role from team_members.
  // airtable_user_id keys the form-attribution match (more robust than
  // name when reps go by nicknames). sales_role decides which status
  // field (setter_status vs closer_status) drives the drill's Outcome
  // column.
  const { data: tmRow } = await sb
    .from('team_members' as never)
    .select('airtable_user_id, sales_role')
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
    form_type: string | null        // 'Setter Triage Form' | 'Closer Triage Form'
    call_status: string | null      // the shared outcome (2026-05-26 redesign)
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
        .select('record_id, lead_id, prospect_name, form_type, call_status, setter_names, setter_record_ids, event_date_time, airtable_created_at')
        .is('excluded_at', null)   // creator-hidden test entries drop out of the per-rep drill
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
  // When multiple forms match the same call (rare — usually a rep
  // revising an outcome), keep the one filed latest by airtable_created_at.
  const formByCallId = new Map<string, FormRow>()
  for (const r of inRangeForms) {
    const m = matchByRecord.get(r.record_id)
    if (!m?.matchedCallId) continue
    const existing = formByCallId.get(m.matchedCallId)
    if (!existing || r.airtable_created_at > existing.airtable_created_at) {
      formByCallId.set(m.matchedCallId, r)
    }
  }

  // Prospect-name + display-name lookup keyed by lead.
  const formProspectByLead = new Map<string, string | null>()
  for (const r of inRangeForms) {
    if (r.lead_id && !formProspectByLead.has(r.lead_id) && r.prospect_name) {
      formProspectByLead.set(r.lead_id, r.prospect_name)
    }
  }

  // Group calls into sessions per lead — calls within 1 day of the
  // previous chain into one session. Drake 2026-05-27: setter
  // disconnects + redials a few min later is still one engagement,
  // gets one EOC form, should be one drill row.
  const callByCallId = new Map<string, typeof calls[number]>()
  for (const c of calls) callByCallId.set(c.callId, c)
  const callsByLead = new Map<string, typeof calls>()
  for (const c of calls) {
    if (!callsByLead.has(c.leadId)) callsByLead.set(c.leadId, [])
    callsByLead.get(c.leadId)!.push(c)
  }
  const sessions: { session: CallSession; leadId: string }[] = []
  callsByLead.forEach((leadCalls, leadId) => {
    for (const s of groupCallsIntoSessions(leadId, leadCalls.map((c) => ({ callId: c.callId, activityAt: c.activityAt })))) {
      sessions.push({ session: s, leadId })
    }
  })

  // Status-string + bucket per row from the form's Call Status. Old
  // forms (pre-2026-05-26 redesign) carry no call_status — show "NA" so
  // the rep sees the form is on file but pre-redesign, without inflating
  // any per-rep counter.
  const NA_LABEL = 'NA'
  // Form family of a row's backing form — drives which table's drill shows it.
  const familyOf = (ft: string | null | undefined): 'setter' | 'closer' | null => {
    const v = (ft ?? '').toLowerCase()
    return v.includes('closer') ? 'closer' : v.includes('setter') ? 'setter' : null
  }
  const statusFor = (f: FormRow | undefined | null): {
    label: string | null
    bucket: TriageCallDrillRow['bucket']
  } => {
    if (!f) return { label: null, bucket: 'unclassified' }
    if (f.call_status) {
      return { label: f.call_status, bucket: classifyCallStatus(f.call_status) }
    }
    return { label: NA_LABEL, bucket: 'unclassified' }
  }

  // One drill row per session. Representative call = the call the
  // form is matched to (so outcome + timestamp + duration all align),
  // else the most recent call in the session.
  const callRows: CallActivityDrillRow[] = sessions.map(({ session, leadId }) => {
    // If any call in the session has a matched form, use the form
    // with the latest airtable_created_at as the row's outcome.
    // Default representative = most recent call in the session.
    let form: FormRow | undefined
    let repCallId = session.callIds[session.callIds.length - 1]
    for (const cid of session.callIds) {
      const f = formByCallId.get(cid)
      if (!f) continue
      if (!form || f.airtable_created_at > form.airtable_created_at) {
        form = f
        repCallId = cid
      }
    }
    const c = callByCallId.get(repCallId)!
    const status = statusFor(form)
    return {
      callId: c.callId,
      leadId,
      prospectName: form?.prospect_name ?? formProspectByLead.get(leadId) ?? leadName.get(leadId) ?? null,
      callAt: c.activityAt,
      durationSec: c.durationSec,
      bookingStatus: status.label,
      bucket: status.bucket,
      groupedCallCount: session.callIds.length,
      formRecordId: form?.record_id ?? null,
      family: familyOf(form?.form_type),
    }
  })

  // Form-only rows: in-range forms whose matched_call_id is null
  // (genuine engagement gap — EOC filed but no qualifying call exists
  // in Close for this rep+lead+48h window).
  const formOnlyRows: CallActivityDrillRow[] = []
  for (const r of inRangeForms) {
    const m = matchByRecord.get(r.record_id)
    if (m?.matchedCallId) continue
    const status = statusFor(r)
    formOnlyRows.push({
      callId: `form:${r.record_id}`,
      leadId: r.lead_id ?? '',
      prospectName: r.prospect_name,
      callAt: m?.effectiveDateIso ?? r.event_date_time ?? '',
      durationSec: 0,
      bookingStatus: status.label,
      bucket: status.bucket,
      noMatchingCall: true,
      formRecordId: r.record_id,
      family: familyOf(r.form_type),
    })
  }

  return [...callRows, ...formOnlyRows]
}

export type TriageCallDrillRow = {
  recordId: string
  prospectName: string | null
  occurredAtIso: string    // event_date_time if set, else airtable_created_at
  bookingStatus: string | null
  bucket:
    | 'htBookings'
    | 'dcBookings'
    | 'followUps'
    | 'confirmedBooks'
    | 'confirmedNewTime'
    | 'downsellsOnCall'
    | 'dqs'
    | 'unclassified'
}

// Setter Status dropdown (post 2026-05-27 form redesign).
// "Confirmed HT Booking" / "Confirmed DC Booking" / "Follow up" /
// "Reconfirm" / "DQ". Null or unknown → unclassified (drill shows NA,
// no counter bumped).
// Classify Airtable `Call Status` (shared by both form types) into a
// bucket. Option set (2026-05-26 redesign):
//   High Ticket booking · Digital College booking · Confirmed Booking ·
//   Confirmed Booking – New Time · Setter pipeline / Follow up ·
//   Unresponsive – Setter Handover · Downsold · DQ / Un-interested.
// "New Time" is checked BEFORE "Confirmed" (substring guard). Handover
// folds into Setter pipeline / Follow up (Drake: same thing). Out-of-set
// values → 'unclassified' (the weird entries Drake fixes manually).
function classifyCallStatus(s: string | null): TriageCallDrillRow['bucket'] {
  if (!s) return 'unclassified'
  const v = s.toLowerCase()
  if (v.includes('high ticket') || v.includes('ht booking')) return 'htBookings'
  if (v.includes('digital college') || v.includes('dc booking')) return 'dcBookings'
  if (v.includes('downsold') || v.includes('downsell')) return 'downsellsOnCall'
  if (v.includes('new time')) return 'confirmedNewTime'
  if (v.includes('confirmed')) return 'confirmedBooks'
  if (v.includes('pipeline') || v.includes('follow') || v.includes('handover')) return 'followUps'
  if (v.includes('dq') || v.includes('disqualif') || v.includes('interest')) return 'dqs'
  return 'unclassified'
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
  {
    // close_id partitioned across chunks → unique keys, order-independent.
    const leads = await fetchChunked<{ close_id: string; closer_owner_id: string | null; setter_owner_id: string | null }>(
      leadIds,
      (chunk) => sb
        .from('close_leads' as never)
        .select('close_id, closer_owner_id, setter_owner_id')
        .in('close_id', chunk) as never,
      'close_leads read failed',
      100,
    )
    for (const l of leads) {
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
