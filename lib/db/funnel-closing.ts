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
