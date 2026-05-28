import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'

// Funnel · Closing stage — activity-in-period view, trimmed shape.
//
// Three sections on the page (data layer mirrors that):
//   1. Calendly bookings (new / rescheduled / canceled) for the
//      AI Partner Strategy Call event type.
//   2. Per-closer leaderboard + click-to-drill (same shape as the
//      setter page, with closing-side metrics).
//   3. Cash (upfront / contract / AOV) from the closer form.

export const CLOSING_FLOOR_ET = '2026-05-22'

// Calendly closer-call event names — case-insensitive match because
// "Ai" vs "AI" both occur in the local data.
const CLOSER_EVENT_NAMES_LOWER = new Set([
  'ai partner strategy call',
])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CalendlyBookingActivity = {
  newScheduled: number   // invitees rescheduled=false, status=active
  rescheduled: number    // invitees rescheduled=true
  canceled: number       // invitees status=canceled
}

export type CloserLeaderboardRow = {
  closerName: string
  callsLogged: number
  showed: number
  noShow: number
  closed: number
  notClosed: number
  closeRate: number | null     // closed / callsLogged
  totalUpfront: number         // sum amount_paid_today_currency (provisional cash field)
  totalContract: number        // sum total_contract_amount
}

export type CloserCallDrillRow = {
  recordId: string
  prospectName: string | null
  dateTimeOfCall: string | null
  callType: string | null
  showed: string | null
  closed: string | null
  noShowReason: string | null
  amountUpfront: number | null
  contractValue: number | null
  paymentPlan: string | null
}

export type ClosingMoney = {
  upfrontCollected: number
  totalContractValue: number
  aov: number | null
  upfrontFieldUsed: 'amount_paid_today_currency'
  provisional: boolean
}

export type ClosingActivity = {
  range: DateRange
  bookings: CalendlyBookingActivity
  closers: CloserLeaderboardRow[]
  aggregate: CloserLeaderboardRow      // 'All closers' summary row
  money: ClosingMoney
}

// ---------------------------------------------------------------------------
// Calendly: bookings activity
// ---------------------------------------------------------------------------

type InviteeRow = {
  uri: string
  event_uri: string
  status: string | null
  rescheduled: boolean | null
  invitee_created_at: string
}

type EventRow = { uri: string; name: string | null }

async function loadCalendlyBookings(range: DateRange): Promise<CalendlyBookingActivity> {
  const sb = createAdminClient()

  let invitees: InviteeRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('calendly_invitees' as never)
      .select('uri, event_uri, status, rescheduled, invitee_created_at')
      .gte('invitee_created_at', range.startUtcIso)
      .lt('invitee_created_at', range.endUtcIso)
      .range(from, from + 999)
    if (error) throw new Error(`calendly_invitees read failed: ${error.message}`)
    const rows = (data ?? []) as unknown as InviteeRow[]
    if (rows.length === 0) break
    invitees = invitees.concat(rows)
    if (rows.length < 1000) break
    from += 1000
  }

  if (invitees.length === 0) {
    return { newScheduled: 0, rescheduled: 0, canceled: 0 }
  }

  const eventUris = Array.from(new Set(invitees.map((i) => i.event_uri)))
  const nameByUri = new Map<string, string | null>()
  for (let i = 0; i < eventUris.length; i += 100) {
    const chunk = eventUris.slice(i, i + 100)
    const { data, error } = await sb
      .from('calendly_scheduled_events' as never)
      .select('uri, name')
      .in('uri', chunk)
    if (error) throw new Error(`calendly_scheduled_events read failed: ${error.message}`)
    for (const e of (data ?? []) as unknown as EventRow[]) nameByUri.set(e.uri, e.name)
  }

  const isCloser = (uri: string) => {
    const n = nameByUri.get(uri)?.toLowerCase().trim()
    return !!n && CLOSER_EVENT_NAMES_LOWER.has(n)
  }

  let newScheduled = 0, rescheduled = 0, canceled = 0
  for (const inv of invitees) {
    if (!isCloser(inv.event_uri)) continue
    if (inv.status === 'canceled') canceled++
    else if (inv.rescheduled) rescheduled++
    else newScheduled++
  }
  return { newScheduled, rescheduled, canceled }
}

// ---------------------------------------------------------------------------
// Closer form: per-closer leaderboard + money + drill
// ---------------------------------------------------------------------------

type CloserReportRow = {
  record_id: string
  airtable_created_at: string
  date_time_of_call: string | null
  call_type: string | null
  showed: string | null
  closed: string | null
  no_show_reason: string | null
  payment_plan_type: string | null
  amount_paid_today_currency: number | null
  total_contract_amount: number | null
  closer_names: string[] | null
  prospect_name: string | null
}

// Effective call date = date_time_of_call when present, else airtable_created_at.
// Closer fills the form 0-2+ days AFTER the actual call, so filtering by
// form-fill time mis-buckets recent activity. Filter by call time (or
// form-fill time as fallback for unfilled rows) so an ET-day picker
// aligns with what the closer sees in Airtable.
function effectiveTsIso(r: { date_time_of_call: string | null; airtable_created_at: string }): string {
  return r.date_time_of_call ?? r.airtable_created_at
}

async function loadCloserReportRows(range: DateRange): Promise<CloserReportRow[]> {
  const sb = createAdminClient()
  // Pull rows whose form-fill time is in a generous superset of the
  // requested range (range expanded back 14 days). Then client-side
  // filter on `effectiveTsIso(r)` falling inside the range. 14 days
  // covers the realistic late-fill envelope; this table is small
  // (single-digit rows/day) so the wider read is cheap.
  const widenStartMs = new Date(range.startUtcIso).getTime() - 14 * 24 * 60 * 60 * 1000
  const widenStartIso = new Date(widenStartMs).toISOString()

  let rows: CloserReportRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('airtable_full_closer_report' as never)
      .select(
        'record_id, airtable_created_at, date_time_of_call, call_type, showed, closed, no_show_reason, ' +
        'payment_plan_type, amount_paid_today_currency, total_contract_amount, closer_names, prospect_name',
      )
      .gte('airtable_created_at', widenStartIso)
      .order('airtable_created_at', { ascending: false })
      .range(from, from + 999)
    if (error) throw new Error(`airtable_full_closer_report read failed: ${error.message}`)
    const page = (data ?? []) as unknown as CloserReportRow[]
    if (page.length === 0) break
    rows = rows.concat(page)
    if (page.length < 1000) break
    from += 1000
  }

  // Effective-date filter — keep rows whose CALL time falls inside the
  // user-requested range. UTC ISO comparison is valid because both
  // bounds are derived from ET-anchored midnights (see funnel-window).
  return rows.filter((r) => {
    const ts = effectiveTsIso(r)
    return ts >= range.startUtcIso && ts < range.endUtcIso
  })
}

// Provisional cash field — see schema-doc ambiguity #3.
function pickUpfront(r: CloserReportRow): number | null {
  if (typeof r.amount_paid_today_currency === 'number' && Number.isFinite(r.amount_paid_today_currency)) {
    return r.amount_paid_today_currency
  }
  return null
}

function emptyLeaderboardRow(closerName: string): CloserLeaderboardRow {
  return {
    closerName,
    callsLogged: 0, showed: 0, noShow: 0,
    closed: 0, notClosed: 0, closeRate: null,
    totalUpfront: 0, totalContract: 0,
  }
}

function accumulateRow(acc: CloserLeaderboardRow, r: CloserReportRow): void {
  acc.callsLogged++
  if (r.showed === 'Yes') acc.showed++
  else if (r.showed === 'No') acc.noShow++
  if (r.closed === 'Yes') acc.closed++
  else if (r.closed === 'No') acc.notClosed++
  const u = pickUpfront(r)
  if (u != null) acc.totalUpfront += u
  if (typeof r.total_contract_amount === 'number' && Number.isFinite(r.total_contract_amount)) {
    acc.totalContract += r.total_contract_amount
  }
}

function finalizeRow(acc: CloserLeaderboardRow): void {
  acc.closeRate = acc.callsLogged > 0 ? acc.closed / acc.callsLogged : null
}

function buildLeaderboard(rows: CloserReportRow[]): { closers: CloserLeaderboardRow[]; aggregate: CloserLeaderboardRow } {
  // closer_names is text[]; one form row can credit multiple closers
  // (rare but real). Each named closer gets +1 in that case.
  const byName = new Map<string, CloserLeaderboardRow>()
  const aggregate = emptyLeaderboardRow('All closers')
  for (const r of rows) {
    accumulateRow(aggregate, r)
    const names = (r.closer_names ?? []).filter((n) => typeof n === 'string' && n.length > 0)
    if (names.length === 0) {
      // Unattributed — still surface so the row count matches the
      // aggregate. Drake can spot fill-rate gaps from this row.
      const acc = byName.get('(unattributed)') ?? emptyLeaderboardRow('(unattributed)')
      accumulateRow(acc, r)
      byName.set('(unattributed)', acc)
      continue
    }
    for (const nm of names) {
      const acc = byName.get(nm) ?? emptyLeaderboardRow(nm)
      accumulateRow(acc, r)
      byName.set(nm, acc)
    }
  }
  byName.forEach((acc) => finalizeRow(acc))
  finalizeRow(aggregate)
  const closers = Array.from(byName.values()).sort((a, b) => b.callsLogged - a.callsLogged)
  return { closers, aggregate }
}

function buildMoney(rows: CloserReportRow[]): ClosingMoney {
  let upfront = 0, contract = 0, closedCount = 0, contractClosedSum = 0
  for (const r of rows) {
    const u = pickUpfront(r)
    if (u != null) upfront += u
    if (typeof r.total_contract_amount === 'number' && Number.isFinite(r.total_contract_amount)) {
      contract += r.total_contract_amount
      if (r.closed === 'Yes') {
        contractClosedSum += r.total_contract_amount
        closedCount++
      }
    }
  }
  return {
    upfrontCollected: upfront,
    totalContractValue: contract,
    aov: closedCount > 0 ? contractClosedSum / closedCount : null,
    upfrontFieldUsed: 'amount_paid_today_currency',
    provisional: true,
  }
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export async function getClosingActivity(range: DateRange): Promise<ClosingActivity> {
  const [bookings, rows] = await Promise.all([
    loadCalendlyBookings(range),
    loadCloserReportRows(range),
  ])

  const { closers, aggregate } = buildLeaderboard(rows)
  const money = buildMoney(rows)

  return { range, bookings, closers, aggregate, money }
}

// Drill: per-call rows for one closer (by name).
export async function getCloserCallsForCloser(range: DateRange, closerName: string): Promise<CloserCallDrillRow[]> {
  // Pull all rows in range (the closer_names array filter is awkward
  // in PostgREST — easier to filter client-side; the row set is small).
  const rows = await loadCloserReportRows(range)
  const out: CloserCallDrillRow[] = []
  for (const r of rows) {
    const names = r.closer_names ?? []
    const matches = closerName === '(unattributed)'
      ? names.length === 0
      : names.includes(closerName)
    if (!matches) continue
    out.push({
      recordId: r.record_id,
      prospectName: r.prospect_name,
      dateTimeOfCall: r.date_time_of_call ?? r.airtable_created_at,
      callType: r.call_type,
      showed: r.showed,
      closed: r.closed,
      noShowReason: r.no_show_reason,
      amountUpfront: pickUpfront(r),
      contractValue: typeof r.total_contract_amount === 'number' ? r.total_contract_amount : null,
      paymentPlan: r.payment_plan_type,
    })
  }
  // Most recent first.
  out.sort((a, b) => {
    const ax = a.dateTimeOfCall ?? ''
    const bx = b.dateTimeOfCall ?? ''
    return ax < bx ? 1 : ax > bx ? -1 : 0
  })
  return out
}

// ===========================================================================
// Scheduled-list aggregator (2026-05-27)
// ===========================================================================
//
// New surface — replaces the "leaderboard from form data" view with one
// keyed off Calendly scheduled events. Why: the form is sparsely filled
// (closers don't always submit the EOC) so the old leaderboard
// undercounts what the closer team actually shows up to. The new view
// pulls every scheduled closer event in range, attributes by Calendly
// host, and joins to the form when present — letting the closer team
// see "scheduled calls" as the load-bearing number with form-derived
// outcomes filling in as forms get submitted.
//
// Event categorization (case-insensitive name prefix):
//   - "ai partner strategy call"  → 'direct' — round-robin from funnel
//   - "partnership call"          → 'setter' — setter-booked
//   - "ai partner sync"           → 'rebook' — follow-up (not in use yet)
//
// Form match: name (case+trim) + date-of-call within ±48h of event
// start_time. ~25% match rate today given form-fill discipline; the
// unmatched rows render with form fields blank ("missing" downstream).
// Improve later via a fuzzier match or by making form-fill mandatory.

export type CloserCallType = 'direct' | 'setter' | 'rebook'

export type CloserScheduledDrillRow = {
  eventUri: string
  prospectName: string | null
  scheduledTime: string       // ISO UTC
  callType: CloserCallType
  // For 'setter' bookings: the setter's name pulled from the matched
  // form's `setter_names[0]`. Null when no form matched. For 'direct'
  // bookings, the intent is the ad attribution — not wired yet,
  // always null. For 'rebook' (follow-up), null.
  bookedBy: string | null
  // Outcomes from the matched Airtable form. null = form not filled
  // (or unmatchable). Downstream UI renders null as "missing".
  showed: 'yes' | 'no' | 'dq' | null
  closed: 'yes' | 'no' | null
  // Resolved close type from payment_plan_type when closed='yes'.
  // null if the close happened but plan unknown, or not closed yet.
  closeType: 'ht' | 'dc' | null
  upfront: number | null
  // Booking lifecycle. 'active' = still on the calendar. 'canceled' =
  // hard cancel (booking fell through). 'rescheduled' = the original
  // slot was moved (Calendly cancels the old leg with reason
  // "Rescheduled from connected calendar event"; a new active event
  // exists separately). Canceled + rescheduled rows show in the drill
  // with a tag but do NOT count toward the closer's aggregates.
  bookingStatus: 'active' | 'canceled' | 'rescheduled'
}

export type CloserScheduledAggregate = {
  closerName: string
  calls: number        // total scheduled events for this closer in range
  // Per-call-type breakdown for the new top-bar columns.
  directCalls: number
  setterCalls: number
  followupCalls: number
  showed: number       // matched + showed='Yes'
  noShows: number      // matched + showed='No' (DQs excluded)
  closed: number       // matched + closed='Yes'
  closedHt: number     // payment_plan_type implies high-ticket
  closedDc: number     // payment_plan_type implies digital college
  upfront: number      // sum of amount_paid_today_currency on matched forms
}

export type CloserScheduledResult = {
  closers: CloserScheduledAggregate[]
  aggregate: CloserScheduledAggregate
  drillByCloser: Record<string, CloserScheduledDrillRow[]>
}

const FORM_MATCH_WINDOW_SEC = 48 * 60 * 60

function categorizeEventName(name: string): CloserCallType | null {
  const n = name.toLowerCase().trim()
  if (n.startsWith('ai partner strategy call')) return 'direct'
  if (n.startsWith('partnership call')) return 'setter'
  if (n.startsWith('ai partner sync')) return 'rebook'
  return null
}

// Closer-booking lifecycle. Calendly cancels the original leg of a
// reschedule with the sentinel reason "Rescheduled from connected
// calendar event"; any other cancellation is a hard cancel. Active
// events (status != canceled) are live bookings.
function resolveBookingStatus(
  status: string | null,
  cancellation: { reason?: string | null } | null,
): 'active' | 'canceled' | 'rescheduled' {
  if (status !== 'canceled') return 'active'
  const reason = (cancellation?.reason ?? '').toLowerCase()
  return reason.includes('reschedul') ? 'rescheduled' : 'canceled'
}

function normalizeShowed(raw: string | null): 'yes' | 'no' | 'dq' | null {
  if (!raw) return null
  const v = raw.toLowerCase()
  if (v === 'yes') return 'yes'
  if (v === 'no') return 'no'
  if (v.startsWith('other')) return 'dq'
  return null
}

function normalizeClosed(raw: string | null): 'yes' | 'no' | null {
  if (!raw) return null
  const v = raw.toLowerCase()
  if (v === 'yes') return 'yes'
  if (v === 'no') return 'no'
  return null
}

function classifyPlan(plan: string | null): 'ht' | 'dc' | null {
  if (!plan) return null
  const v = plan.toLowerCase()
  if (v.includes('ticket')) return 'ht'
  if (v.includes('college')) return 'dc'
  return null
}

// ---------------------------------------------------------------------------
// Booked-by resolver — match a Calendly closer event to the setter who
// booked it, via the setter triage form's Confirmed Call Date&Time.
// ---------------------------------------------------------------------------

// Digits-only phone (drops +, spaces, dashes). Returns null when fewer
// than 10 digits — too short to be a real number to match on.
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  return digits.length >= 10 ? digits : null
}

// YYYY-MM-DD calendar date of a UTC instant, in ET. Both the triage
// confirmed-call timestamp and the Calendly event run through this so
// the date comparison is apples-to-apples (and matches what the rest
// of the dashboard renders per ADR 0003).
function etDateString(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}

function normName(n: string | null | undefined): string | null {
  if (!n) return null
  const v = n.toLowerCase().trim()
  return v || null
}

type BookedByInvitee = { name: string | null; email: string | null; phones: string[] }

// Builds a closure that resolves a Calendly event's "booked by" setter.
// Pulls triage forms with a confirmed call date in/around the range,
// resolves each form's lead identity (emails + phones from close_leads,
// plus the form's own prospect_name), and keys them by ET date so the
// per-event lookup is O(1). Identity priority on lookup: email → phone
// → name. Name uses both full and first-name tokens since Calendly
// invitees are often first-name-only ("Inesha" vs "Inesha Joneja").
async function buildBookedByResolver(
  sb: ReturnType<typeof createAdminClient>,
  range: DateRange,
): Promise<(eventStartIso: string, invitee: BookedByInvitee) => string | null> {
  // Widen the confirmed-call pull by ±2 days around the range so an
  // event near a range boundary still finds its form even if the
  // setter's date entry drifts by a day.
  const padMs = 2 * 24 * 60 * 60 * 1000
  const startIso = new Date(new Date(range.startUtcIso).getTime() - padMs).toISOString()
  const endIso = new Date(new Date(range.endUtcIso).getTime() + padMs).toISOString()

  type TriageRow = {
    lead_id: string | null
    prospect_name: string | null
    setter_names: string[] | null
    confirmed_call_date_time: string | null
  }
  const triage: TriageRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('airtable_setter_triage_calls' as never)
      .select('lead_id, prospect_name, setter_names, confirmed_call_date_time')
      .not('confirmed_call_date_time', 'is', null)
      .gte('confirmed_call_date_time', startIso)
      .lt('confirmed_call_date_time', endIso)
      .range(from, from + 999)
    if (error) throw new Error(`airtable_setter_triage_calls (booked-by) read failed: ${error.message}`)
    const rows = (data ?? []) as unknown as TriageRow[]
    if (rows.length === 0) break
    triage.push(...rows)
    if (rows.length < 1000) break
    from += 1000
  }

  // Resolve lead identities (emails + phones) from close_leads.contacts.
  const leadIds = Array.from(
    new Set(triage.map((t) => t.lead_id).filter((x): x is string => !!x)),
  )
  const leadKeys = new Map<string, { emails: string[]; phones: string[]; name: string | null }>()
  for (let i = 0; i < leadIds.length; i += 200) {
    const chunk = leadIds.slice(i, i + 200)
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, display_name, contacts')
      .in('close_id', chunk)
    if (error) throw new Error(`close_leads (booked-by) read failed: ${error.message}`)
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
          const norm = normalizePhone(ph?.phone)
          if (norm) phones.push(norm)
        }
      }
      leadKeys.set(r.close_id, { emails, phones, name: normName(r.display_name) })
    }
  }

  // Date-keyed maps: `${etDate}|${identity}` → setter name. Email and
  // phone are precise. Name maps are collision-safe: a key that two
  // different setters' leads would claim is set to null (ambiguous) so
  // the lookup returns "Missing" instead of guessing wrong — names are
  // the weakest signal (Calendly gives first-name only) and contacts
  // are currently empty so name carries most matches today.
  const byEmail = new Map<string, string>()
  const byPhone = new Map<string, string>()
  const byName = new Map<string, string | null>()
  const setName = (key: string, setter: string) => {
    if (byName.has(key) && byName.get(key) !== setter) {
      byName.set(key, null) // collision with a different setter → ambiguous
    } else {
      byName.set(key, setter)
    }
  }
  for (const t of triage) {
    if (!t.setter_names || t.setter_names.length === 0) continue
    if (!t.confirmed_call_date_time) continue
    const setter = t.setter_names[0]
    const etDate = etDateString(t.confirmed_call_date_time)
    const keys = t.lead_id ? leadKeys.get(t.lead_id) : undefined
    for (const e of keys?.emails ?? []) byEmail.set(`${etDate}|${e}`, setter)
    for (const p of keys?.phones ?? []) byPhone.set(`${etDate}|${p}`, setter)
    // Names: lead display name + the form's own prospect_name, plus
    // each one's first-name token (Calendly invitees are first-name-only).
    const names = [keys?.name ?? null, normName(t.prospect_name)].filter(
      (x): x is string => !!x,
    )
    for (const n of names) {
      setName(`${etDate}|${n}`, setter)
      const first = n.split(/\s+/)[0]
      if (first && first !== n) setName(`${etDate}|${first}`, setter)
    }
  }

  return (eventStartIso: string, invitee: BookedByInvitee): string | null => {
    const etDate = etDateString(eventStartIso)
    const email = invitee.email ? invitee.email.toLowerCase().trim() : null
    if (email) {
      const hit = byEmail.get(`${etDate}|${email}`)
      if (hit) return hit
    }
    for (const p of invitee.phones) {
      const hit = byPhone.get(`${etDate}|${p}`)
      if (hit) return hit
    }
    const nm = normName(invitee.name)
    if (nm) {
      // null = ambiguous; `?? undefined` so `|| ` falls through cleanly.
      const full = byName.get(`${etDate}|${nm}`)
      if (full) return full
      const first = byName.get(`${etDate}|${nm.split(/\s+/)[0]}`)
      if (first) return first
    }
    return null
  }
}

export async function getClosingScheduledList(
  range: DateRange,
): Promise<CloserScheduledResult> {
  const sb = createAdminClient()

  // 1. Closer-event scheduled events whose start_time falls in range.
  //    Pull a wider lookback so we catch events created before range
  //    but starting in range (rare for partnership calls but possible
  //    for AI Strategy with long lead time).
  const { data: eventData, error: eventErr } = await sb
    .from('calendly_scheduled_events' as never)
    .select('uri, name, start_time, host_user_name, status, cancellation')
    .gte('start_time', range.startUtcIso)
    .lt('start_time', range.endUtcIso)
    .order('start_time', { ascending: true })
    .range(0, 2999)
  if (eventErr) throw new Error(`calendly_scheduled_events read failed: ${eventErr.message}`)
  const allEvents = (eventData ?? []) as unknown as Array<{
    uri: string
    name: string
    start_time: string
    host_user_name: string | null
    status: string | null
    cancellation: { reason?: string | null } | null
  }>
  // Categorize + drop non-closer events. Canceled events are KEPT
  // (Drake 2026-05-28: show them in the drill tagged Canceled /
  // Rescheduled) — they just don't count toward the aggregates, gated
  // per-row in the loop below via bookingStatus.
  const events = allEvents
    .map((e) => ({
      ...e,
      callType: categorizeEventName(e.name),
      bookingStatus: resolveBookingStatus(e.status, e.cancellation),
    }))
    .filter((e) => e.callType !== null) as Array<{
      uri: string
      name: string
      start_time: string
      host_user_name: string | null
      status: string | null
      cancellation: { reason?: string | null } | null
      callType: CloserCallType
      bookingStatus: 'active' | 'canceled' | 'rescheduled'
    }>

  if (events.length === 0) {
    const emptyAgg: CloserScheduledAggregate = {
      closerName: 'All closers',
      calls: 0, directCalls: 0, setterCalls: 0, followupCalls: 0,
      showed: 0, noShows: 0, closed: 0, closedHt: 0, closedDc: 0, upfront: 0,
    }
    return { closers: [], aggregate: emptyAgg, drillByCloser: {} }
  }

  // 2. Invitees for those events (prospect name + email + phone). Phone
  //    lives in raw_payload.questions_and_answers (a "Phone" Q&A) or
  //    text_reminder_number — used by the booked-by identity match.
  const eventUris = events.map((e) => e.uri)
  const inviteeByEvent = new Map<string, { name: string | null; email: string | null; phones: string[] }>()
  for (let i = 0; i < eventUris.length; i += 200) {
    const chunk = eventUris.slice(i, i + 200)
    const { data, error } = await sb
      .from('calendly_invitees' as never)
      .select('event_uri, name, email, raw_payload')
      .in('event_uri', chunk)
    if (error) throw new Error(`calendly_invitees read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{
      event_uri: string
      name: string | null
      email: string | null
      raw_payload: {
        text_reminder_number?: string | null
        questions_and_answers?: Array<{ question?: string | null; answer?: string | null }>
      } | null
    }>) {
      // Keep the first invitee per event (1:1 in practice).
      if (!inviteeByEvent.has(r.event_uri)) {
        const rawPhones: string[] = []
        const trn = r.raw_payload?.text_reminder_number
        if (trn) rawPhones.push(trn)
        for (const qa of r.raw_payload?.questions_and_answers ?? []) {
          if ((qa?.question ?? '').toLowerCase().includes('phone') && qa?.answer) {
            rawPhones.push(qa.answer)
          }
        }
        const phones = rawPhones
          .map(normalizePhone)
          .filter((p): p is string => p !== null)
        inviteeByEvent.set(r.event_uri, { name: r.name, email: r.email, phones })
      }
    }
  }

  // 2b. Booked-by source: setter triage forms with a Confirmed Call
  //     Date&Time. A setter "books" a closing call by filing a triage
  //     EOC with a Confirmed HT/DC Booking, which carries that date.
  //     We attribute the Calendly closer event to that setter when the
  //     ET date of confirmed_call_date_time equals the ET date of the
  //     event AND the lead identity matches (email → phone → name).
  //     No match → null → "Missing" in the UI (prompts setters to fill
  //     the confirmed-call field). Drake 2026-05-28.
  const bookedByResolver = await buildBookedByResolver(sb, range)

  // 3. Closer forms covering the event window (±48h on either side for
  //    matching). Pull as a single windowed read; small table.
  const widenStartMs = new Date(range.startUtcIso).getTime() - FORM_MATCH_WINDOW_SEC * 1000
  const widenEndMs = new Date(range.endUtcIso).getTime() + FORM_MATCH_WINDOW_SEC * 1000
  const widenStartIso = new Date(widenStartMs).toISOString()
  const widenEndIso = new Date(widenEndMs).toISOString()
  const { data: formData, error: formErr } = await sb
    .from('airtable_full_closer_report' as never)
    .select(
      'record_id, prospect_name, date_time_of_call, showed, closed, ' +
      'amount_paid_today_currency, payment_plan_type, closer_names, setter_names',
    )
    .gte('date_time_of_call', widenStartIso)
    .lt('date_time_of_call', widenEndIso)
  if (formErr) throw new Error(`airtable_full_closer_report read failed: ${formErr.message}`)
  const forms = (formData ?? []) as unknown as Array<{
    record_id: string
    prospect_name: string | null
    date_time_of_call: string | null
    showed: string | null
    closed: string | null
    amount_paid_today_currency: number | string | null
    payment_plan_type: string | null
    closer_names: string[] | null
    setter_names: string[] | null
  }>

  // Build a name → forms multimap for fast lookup. Keys are
  // case-insensitive trimmed names.
  const formsByName = new Map<string, typeof forms>()
  for (const f of forms) {
    if (!f.prospect_name) continue
    const key = f.prospect_name.toLowerCase().trim()
    const arr = formsByName.get(key) ?? []
    arr.push(f)
    formsByName.set(key, arr)
  }

  // 4. For each event, find the matching form (if any). Best match =
  //    name-case-insensitive equal AND date_time_of_call closest to
  //    event.start_time within ±48h.
  function matchForm(
    eventStartIso: string,
    inviteeName: string | null,
  ): (typeof forms)[number] | null {
    if (!inviteeName) return null
    const key = inviteeName.toLowerCase().trim()
    const candidates = formsByName.get(key)
    if (!candidates) return null
    const eventMs = new Date(eventStartIso).getTime()
    let best: (typeof forms)[number] | null = null
    let bestDelta = Number.POSITIVE_INFINITY
    for (const c of candidates) {
      if (!c.date_time_of_call) continue
      const delta = Math.abs(new Date(c.date_time_of_call).getTime() - eventMs)
      if (delta <= FORM_MATCH_WINDOW_SEC * 1000 && delta < bestDelta) {
        best = c
        bestDelta = delta
      }
    }
    return best
  }

  // 5. Build per-closer aggregates + drill rows.
  const closerMap = new Map<string, CloserScheduledAggregate>()
  const drillByCloser: Record<string, CloserScheduledDrillRow[]> = {}

  function bumpAgg(name: string): CloserScheduledAggregate {
    let agg = closerMap.get(name)
    if (!agg) {
      agg = {
        closerName: name,
        calls: 0, directCalls: 0, setterCalls: 0, followupCalls: 0,
        showed: 0, noShows: 0, closed: 0,
        closedHt: 0, closedDc: 0, upfront: 0,
      }
      closerMap.set(name, agg)
      drillByCloser[name] = []
    }
    return agg
  }

  for (const ev of events) {
    const closer = ev.host_user_name ?? '(no host)'
    const agg = bumpAgg(closer)
    const active = ev.bookingStatus === 'active'

    const invitee = inviteeByEvent.get(ev.uri) ?? { name: null, email: null, phones: [] }

    // Outcomes (showed/closed/cash) only apply to calls that actually
    // happened. A canceled or rescheduled slot has no closer outcome.
    const form = active ? matchForm(ev.start_time, invitee.name) : null
    const showed = form ? normalizeShowed(form.showed) : null
    const closed = form ? normalizeClosed(form.closed) : null
    const upfront =
      form && typeof form.amount_paid_today_currency === 'number'
        ? form.amount_paid_today_currency
        : form && typeof form.amount_paid_today_currency === 'string'
          ? Number(form.amount_paid_today_currency) || null
          : null
    const plan = form ? form.payment_plan_type : null
    const planClass = classifyPlan(plan)
    const closeType: 'ht' | 'dc' | null =
      closed === 'yes' ? planClass : null

    // "Booked by" — only meaningful for setter-booked calls (the
    // "Partnership Call" event type). Direct ad bookings ("Ai Partner
    // Strategy Call", carrying utm ad-attribution) and rebooks have no
    // setter, so we don't resolve one — the UI renders "—" for those.
    // Resolved even for canceled/rescheduled bookings so Drake can see
    // whose booking fell through. null → "Missing".
    const bookedBy: string | null =
      ev.callType === 'setter' ? bookedByResolver(ev.start_time, invitee) : null

    // Aggregates count active bookings only — canceled/rescheduled
    // didn't happen, so they stay out of calls/showed/closed/cash but
    // still appear in the drill with their tag.
    if (active) {
      agg.calls++
      if (ev.callType === 'direct') agg.directCalls++
      else if (ev.callType === 'setter') agg.setterCalls++
      else if (ev.callType === 'rebook') agg.followupCalls++
      if (showed === 'yes') agg.showed++
      if (showed === 'no') agg.noShows++
      if (closed === 'yes') {
        agg.closed++
        if (planClass === 'ht') agg.closedHt++
        if (planClass === 'dc') agg.closedDc++
      }
      if (upfront !== null && Number.isFinite(upfront)) agg.upfront += upfront
    }

    drillByCloser[closer].push({
      eventUri: ev.uri,
      prospectName: invitee.name,
      scheduledTime: ev.start_time,
      callType: ev.callType,
      bookedBy,
      showed,
      closed,
      closeType,
      upfront,
      bookingStatus: ev.bookingStatus,
    })
  }

  // 6. Sort drill rows per closer (most recent first).
  for (const name of Object.keys(drillByCloser)) {
    drillByCloser[name].sort((a, b) =>
      a.scheduledTime < b.scheduledTime ? 1 : a.scheduledTime > b.scheduledTime ? -1 : 0,
    )
  }

  // 7. Closer list sorted by calls desc; aggregate "All closers" sums.
  const closers = Array.from(closerMap.values()).sort((a, b) => b.calls - a.calls)
  const aggregate: CloserScheduledAggregate = closers.reduce<CloserScheduledAggregate>(
    (acc, c) => ({
      closerName: 'All closers',
      calls: acc.calls + c.calls,
      directCalls: acc.directCalls + c.directCalls,
      setterCalls: acc.setterCalls + c.setterCalls,
      followupCalls: acc.followupCalls + c.followupCalls,
      showed: acc.showed + c.showed,
      noShows: acc.noShows + c.noShows,
      closed: acc.closed + c.closed,
      closedHt: acc.closedHt + c.closedHt,
      closedDc: acc.closedDc + c.closedDc,
      upfront: acc.upfront + c.upfront,
    }),
    {
      closerName: 'All closers',
      calls: 0, directCalls: 0, setterCalls: 0, followupCalls: 0,
      showed: 0, noShows: 0, closed: 0, closedHt: 0, closedDc: 0, upfront: 0,
    },
  )

  return { closers, aggregate, drillByCloser }
}
