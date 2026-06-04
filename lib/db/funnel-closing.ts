import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'
import { DIRECT_BOOKING_EVENT_TYPE_URI } from './funnel-calendly'
import { buildCalendlyLeadResolver, inviteeUtmTerm } from './calendly-lead-match'

// Funnel · Closing stage — activity-in-period view, trimmed shape.
//
// Three sections on the page (data layer mirrors that):
//   1. Calendly bookings (new / rescheduled / canceled) for the
//      AI Partner Strategy Call event type.
//   2. Per-closer leaderboard + click-to-drill (same shape as the
//      setter page, with closing-side metrics).
//   3. Cash (upfront / contract / AOV) from the closer form.

export const CLOSING_FLOOR_ET = '2026-05-22'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CalendlyBookingActivity = {
  total: number          // all valid-link bookings created in range (excl. hidden)
  rescheduled: number    // of those, invitees rescheduled=true
  canceled: number       // of those, invitees status=canceled
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
  // Sales = full HIGH-TICKET closes (deposits excluded). Digital College is
  // excluded — it has its own tally on the funnel page — so DC closes and their
  // cash don't count here. Includes instant-book / form-only meetings (pure form
  // read, no Calendly dependency).
  closes: number
  totalContractValue: number
  aov: number | null
  upfrontFieldUsed: string
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

type EventRow = { uri: string; event_type_uri: string | null; name: string | null; excluded_at: string | null }

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
    return { total: 0, rescheduled: 0, canceled: 0 }
  }

  // Resolve each invitee's event to decide whether it counts. A valid
  // closer booking is one of the two links (direct funnel URI + the
  // "Partnership Call w/" setter family) and NOT creator-hidden
  // (excluded_at). Key on the LINK, never the bare name — the direct
  // funnel link and the Aman-solo lookalike share the name "Ai/AI
  // Partner Strategy Call" (casing drifts). See migration 0061 +
  // docs/schema/calendly_scheduled_events.md.
  const eventUris = Array.from(new Set(invitees.map((i) => i.event_uri)))
  const eventByUri = new Map<string, EventRow>()
  for (let i = 0; i < eventUris.length; i += 100) {
    const chunk = eventUris.slice(i, i + 100)
    const { data, error } = await sb
      .from('calendly_scheduled_events' as never)
      .select('uri, event_type_uri, name, excluded_at')
      .in('uri', chunk)
    if (error) throw new Error(`calendly_scheduled_events read failed: ${error.message}`)
    for (const e of (data ?? []) as unknown as EventRow[]) eventByUri.set(e.uri, e)
  }

  const isValidBooking = (uri: string) => {
    const e = eventByUri.get(uri)
    if (!e || e.excluded_at) return false
    return categorizeEvent(e.event_type_uri, e.name ?? '') !== null
  }

  let total = 0, rescheduled = 0, canceled = 0
  for (const inv of invitees) {
    if (!isValidBooking(inv.event_uri)) continue
    total++
    if (inv.status === 'canceled') canceled++
    if (inv.rescheduled) rescheduled++
  }
  return { total, rescheduled, canceled }
}

// ---------------------------------------------------------------------------
// Closer form: per-closer leaderboard + money + drill
// ---------------------------------------------------------------------------

type CloserReportRow = {
  record_id: string
  lead_id: string | null
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
  // New-form (redesigned) fields — the close + cash live here on New forms;
  // the legacy `closed` / `amount_paid_today_currency` are null on them.
  form_type: string | null
  call_outcome: string | null
  amount_paid_today_number: number | null
  deposit_amount: number | string | null
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
        'record_id, lead_id, airtable_created_at, date_time_of_call, call_type, showed, closed, no_show_reason, ' +
        'payment_plan_type, amount_paid_today_currency, total_contract_amount, closer_names, prospect_name, ' +
        'form_type, call_outcome, amount_paid_today_number, deposit_amount',
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
  const inRange = rows.filter((r) => {
    const ts = effectiveTsIso(r)
    return ts >= range.startUtcIso && ts < range.endUtcIso
  })

  // Drop test / soft-hidden forms, keyed on the BACKING LEAD (display_name
  // 'test' or excluded_at) — same as the closer drill. The form's own
  // prospect_name is unreliable here (e.g. a "testr" form on the 'test' lead),
  // so a name-only filter let test closes inflate the Cash totals.
  const leadIds = Array.from(new Set(inRange.map((r) => r.lead_id).filter((x): x is string => !!x)))
  const hiddenOrTest = new Set<string>()
  for (let i = 0; i < leadIds.length; i += 200) {
    const chunk = leadIds.slice(i, i + 200)
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, display_name, excluded_at')
      .in('close_id', chunk)
    if (error) throw new Error(`close_leads (closer-report filter) read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{ close_id: string; display_name: string | null; excluded_at: string | null }>) {
      if (r.excluded_at != null || (r.display_name ?? '').trim().toLowerCase() === 'test') hiddenOrTest.add(r.close_id)
    }
  }
  return inRange.filter((r) => {
    if (r.lead_id && hiddenOrTest.has(r.lead_id)) return false
    if ((r.prospect_name ?? '').trim().toLowerCase() === 'test') return false
    return true
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
  let upfront = 0, contract = 0, contractClosedSum = 0
  let closes = 0
  for (const r of rows) {
    // Close + offer + deposit: new forms via call_outcome, legacy via closed/plan.
    let isClose = false, isDeposit = false
    let closeType: 'ht' | 'dc' | null = null
    if (r.form_type === 'New') {
      const d = deriveNewOutcome(r.call_outcome)
      isClose = d.closed === 'yes'
      isDeposit = d.closed === 'deposit'
      closeType = d.closeType
    } else {
      isClose = r.closed === 'Yes'
      closeType = isClose ? classifyPlan(r.payment_plan_type) : null
    }
    // Digital College is excluded from the talent-page money — it has its own
    // tally on the funnel page. Skip a DC close entirely (its count + its cash).
    if (closeType === 'dc') continue
    // Upfront = cash collected today; new field preferred, legacy fallback. A
    // deposit collects the deposit amount.
    const paid = toNum(r.amount_paid_today_number) ?? toNum(r.amount_paid_today_currency)
    const u = isDeposit ? (toNum(r.deposit_amount) ?? paid) : paid
    if (u != null && Number.isFinite(u)) upfront += u
    if (typeof r.total_contract_amount === 'number' && Number.isFinite(r.total_contract_amount)) {
      contract += r.total_contract_amount
    }
    if (isClose) {
      closes++
      if (typeof r.total_contract_amount === 'number' && Number.isFinite(r.total_contract_amount)) {
        contractClosedSum += r.total_contract_amount
      }
    }
  }
  return {
    upfrontCollected: upfront,
    closes,
    totalContractValue: contract,
    aov: closes > 0 ? contractClosedSum / closes : null,
    upfrontFieldUsed: 'amount_paid_today_number',
    provisional: false,
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
// Scheduled-list aggregator — per-LEAD (2026-05-29 rework)
// ===========================================================================
//
// Keyed off Calendly scheduled events, collapsed to ONE ROW PER LEAD.
// Why per-lead (Drake 2026-05-29): a lead who reschedules or rebooks was
// previously one drill row per calendar event (the canceled leg + the new
// leg both showed). The closer team wants each lead to appear exactly once
// with one of three states: no tag / a rebooking-count badge / "cancelled".
//
// VALID LINKS ONLY — a booking counts toward the closer view iff it is one
// of these two Calendly event types, matched on the LINK (event_type_uri /
// name family), never the bare name (the "Ai" vs "AI" casing collision
// makes the name ambiguous — see docs/schema/calendly_scheduled_events.md):
//   - DIRECT funnel self-book → event_type `…9ecaabb3938c`
//     (`DIRECT_BOOKING_EVENT_TYPE_URI`). Round-robins to whichever closer;
//     "Success AP" is Aman's overflow ("ghost") calendar — renamed below.
//   - SETTER-led → the "Partnership Call w/ {closer}" name family.
// Everything else (the Aman-solo "AI Partner Strategy Call" lookalike, the
// period variant, Sales Interview, test events, ai-partner-sync follow-ups)
// is VOID — dropped entirely, never counted.
//
// REBOOKING COUNT — a reschedule is just a cancel + a new booking in
// Calendly, so we don't special-case it: we count the lead's NET valid
// bookings (every invitee.created on a valid link, since the closing
// floor) and the badge shows `bookings − 1` = number of rebookings. So a
// clean single booking gets no badge; one reschedule/rebook shows "1".
//
// CANCELLED — a lead with NO live (active) valid booking anywhere has
// fallen through; their row shows the "cancelled" tag instead of a number,
// and is excluded from the closer's aggregate counts. A cancel that was
// followed by a new booking is NOT cancelled (the new booking wins).

export type CloserCallType = 'direct' | 'setter'

export type CloserScheduledDrillRow = {
  eventUri: string            // the representative (shown) event
  leadId: string | null       // Close lead_id (for the per-lead link); null = unresolved
  prospectName: string | null
  scheduledTime: string       // ISO UTC — the representative booking's slot
  callType: CloserCallType
  // For 'setter' bookings: the setter's name. Preferred from the matched
  // closer form's own Setter Name (resolved id→name), falling back to the
  // triage-form resolver. Null when unresolved → "Missing". 'direct' → "—".
  bookedBy: string | null
  // Outcomes from the matched Airtable closer form. New-form (Form Type =
  // New) rows derive these from Call Outcome — showed gains reschedule /
  // follow-up states, closed gains deposit. Old rows still map yes/no/dq.
  // null = no matched form → UI renders "missing".
  showed: 'yes' | 'no' | 'dq' | 'reschedule' | 'short_follow' | 'long_follow' | null
  closed: 'yes' | 'no' | 'deposit' | null
  closeType: 'ht' | 'dc' | null
  upfront: number | null
  // Net count of valid bookings this lead has had (every booking attempt
  // on a valid link, since the floor, across both calendars — a cancel /
  // no-show / reschedule each made a fresh booking, so they all add up).
  // 1 = a single clean booking (no badge). ≥2 drives the count badge on
  // whichever tag applies (live → neutral, dead → cancelled).
  bookingCount: number
  // True when the lead has no LIVE booking left — every booking canceled
  // OR no-showed (a no-show is treated as a fallen-through booking, same
  // as a cancel). Shows the "cancelled" tag (with the count when ≥2) and
  // is excluded from aggregates.
  cancelled: boolean
  // True when this row came from a closer EOC form with NO Calendly booking —
  // an instant-book meeting that never created an event. eventUri is a
  // synthetic `form:<record_id>` key (no calendly row to hide). Drake 2026-06-04.
  formOnly?: boolean
}

export type CloserScheduledAggregate = {
  closerName: string
  calls: number        // live leads (one row per lead) hosted by this closer
  directCalls: number
  setterCalls: number
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

// Categorize a Calendly event into a closer-call type by its LINK. Returns
// null for anything that isn't one of the two valid links (→ dropped).
function categorizeEvent(eventTypeUri: string | null, name: string): CloserCallType | null {
  if (eventTypeUri === DIRECT_BOOKING_EVENT_TYPE_URI) return 'direct'
  // The setter-led family has one event type per closer ("Partnership Call
  // w/ Aman", "…w/ Adam", …). There is no casing-lookalike here, so the
  // "partnership call w/" name prefix is a safe, closer-agnostic match.
  if (name.toLowerCase().trim().startsWith('partnership call w/')) return 'setter'
  return null
}

// "Success AP" is Aman's overflow / ghost calendar (the round-robin routes
// here when his own calendar is full and a lead would otherwise fall
// through). Surface it as "Ghost" in Gregory. Drake 2026-05-29.
function displayHost(host: string | null): string {
  if (!host) return '(no host)'
  return host.toLowerCase().trim() === 'success ap' ? 'Ghost' : host
}

// Lead identity for collapsing events to one row. The Close lead_id
// (resolved from the booking's utm_term token) is the strongest key;
// then email; then the (normalized) name; finally the event URI so two
// genuinely-anonymous bookings never merge into one phantom lead.
function leadKeyOf(leadId: string | null, email: string | null, name: string | null, eventUri: string): string {
  if (leadId) return `l:${leadId}`
  const e = (email ?? '').toLowerCase().trim()
  if (e) return `e:${e}`
  const n = (name ?? '').toLowerCase().trim()
  if (n) return `n:${n}`
  return `evt:${eventUri}`
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

function toNum(v: number | string | null | undefined): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') { const n = Number(v); return Number.isFinite(n) ? n : null }
  return null
}

// New-form (Form Type = New) disposition: derive showed / closed / closeType
// from the single Call Outcome field. Mapping per Drake 2026-05-30:
//   closed  = High Ticket Closed (ht) | Digital College Closed (dc); Deposit
//             is its own 'deposit' state (showed, NOT closed).
//   showed  = the closes + Deposit + DQ/Bad Fit (= 'yes'); Short-/Long-Term
//             Follow get their own states; Ghosted/Cancelled = 'no';
//             Rescheduled = 'reschedule'.
function deriveNewOutcome(callOutcome: string | null): {
  showed: CloserScheduledDrillRow['showed']
  closed: CloserScheduledDrillRow['closed']
  closeType: 'ht' | 'dc' | null
} {
  const v = (callOutcome ?? '').toLowerCase().trim()
  if (v.includes('high ticket closed')) return { showed: 'yes', closed: 'yes', closeType: 'ht' }
  if (v.includes('digital college closed')) return { showed: 'yes', closed: 'yes', closeType: 'dc' }
  if (v === 'deposit') return { showed: 'yes', closed: 'deposit', closeType: null }
  if (v.includes('short-term follow') || v.includes('short term follow')) return { showed: 'short_follow', closed: 'no', closeType: null }
  if (v.includes('long-term follow') || v.includes('long term follow')) return { showed: 'long_follow', closed: 'no', closeType: null }
  if (v.includes('dq') || v.includes('bad fit')) return { showed: 'yes', closed: 'no', closeType: null }
  if (v.includes('ghost') || v.includes('no show')) return { showed: 'no', closed: 'no', closeType: null }
  if (v.includes('reschedul')) return { showed: 'reschedule', closed: 'no', closeType: null }
  if (v.includes('cancel')) return { showed: 'no', closed: 'no', closeType: null }
  return { showed: null, closed: null, closeType: null }
}

// Resolve Airtable Setter/Closer record-ids → display names. The new closer
// form carries Setter Name as record-ids only (the Name lookup was dropped),
// so we learn id→name from every (record-id, name) pair our mirror already
// has: closer forms' Closer/Setter name arrays + triage setter arrays.
async function buildSetterNameResolver(
  sb: ReturnType<typeof createAdminClient>,
): Promise<(ids: string[] | null) => string | null> {
  const idToName = new Map<string, string>()
  const learn = (ids: string[] | null, names: string[] | null) => {
    if (!ids || !names) return
    for (let i = 0; i < ids.length; i++) {
      if (ids[i] && names[i] && !idToName.has(ids[i])) idToName.set(ids[i], names[i])
    }
  }
  // Closer forms — closer + setter pairs.
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('airtable_full_closer_report' as never)
      .select('closer_record_ids, closer_names, setter_record_ids, setter_names')
      .range(from, from + 999)
    if (error) throw new Error(`setter-name resolver (closer) read failed: ${error.message}`)
    const rows = (data ?? []) as unknown as Array<{
      closer_record_ids: string[] | null; closer_names: string[] | null
      setter_record_ids: string[] | null; setter_names: string[] | null
    }>
    for (const r of rows) { learn(r.closer_record_ids, r.closer_names); learn(r.setter_record_ids, r.setter_names) }
    if (rows.length < 1000) break
  }
  // Triage forms — setter pairs (covers setters who never close).
  {
    const { data, error } = await sb
      .from('airtable_setter_triage_calls' as never)
      .select('setter_record_ids, setter_names')
      .range(0, 4999)
    if (error) throw new Error(`setter-name resolver (triage) read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{ setter_record_ids: string[] | null; setter_names: string[] | null }>) {
      learn(r.setter_record_ids, r.setter_names)
    }
  }
  return (ids) => {
    if (!ids || ids.length === 0) return null
    return idToName.get(ids[0]) ?? null
  }
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

function normName(n: string | null | undefined): string | null {
  if (!n) return null
  const v = n.toLowerCase().trim()
  return v || null
}

type BookedByInvitee = { name: string | null; email: string | null; phones: string[]; leadId: string | null }

// Builds a closure that resolves a Calendly event's "booked by" setter.
// Pulls triage forms with a confirmed call date in/around the range,
// resolves each form's lead identity (emails + phones from close_leads,
// plus the form's own prospect_name), and keys them by ET date so the
// per-event lookup is O(1). Identity priority on lookup: email → phone
// → name. Name uses both full and first-name tokens since Calendly
// invitees are often first-name-only ("Inesha" vs "Inesha Joneja").
async function buildBookedByResolver(
  sb: ReturnType<typeof createAdminClient>,
): Promise<(invitee: BookedByInvitee) => string | null> {
  // Pull EVERY confirmation/booking triage form that has a setter (the table
  // is small). booked-by matches by lead IDENTITY (lead_id → email → phone →
  // name), NOT by date: a setter routinely triages on one day and books the
  // closer call for a later day, and confirmed_call_date_time is sometimes
  // mis-entered (e.g. a value predating the lead's own opt-in), so any date
  // constraint drops valid matches (Drake 2026-05-31).
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
      .range(from, from + 999)
    if (error) throw new Error(`airtable_setter_triage_calls (booked-by) read failed: ${error.message}`)
    const rows = (data ?? []) as unknown as TriageRow[]
    if (rows.length === 0) break
    triage.push(...rows)
    if (rows.length < 1000) break
    from += 1000
  }
  // Latest confirmation wins per identity: a lead re-worked by a different
  // setter attributes to the most recent triage. Sort ascending so the latest
  // is written last (last-write-wins for the precise keys below).
  triage.sort((a, b) => ((a.confirmed_call_date_time ?? '') < (b.confirmed_call_date_time ?? '') ? -1 : 1))

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

  // Identity-keyed maps (no date): identity → setter name. lead_id / email /
  // phone are precise (last-write-wins → latest setter, per the sort above).
  // Name maps are collision-safe: a key two DIFFERENT setters' leads would
  // claim is nulled (ambiguous) so the lookup returns "Missing" rather than
  // guessing — name is the weakest signal (Calendly gives first-name only).
  const byLeadId = new Map<string, string>()
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
    const setter = t.setter_names[0]
    if (t.lead_id) byLeadId.set(t.lead_id, setter)
    const keys = t.lead_id ? leadKeys.get(t.lead_id) : undefined
    for (const e of keys?.emails ?? []) byEmail.set(e, setter)
    for (const p of keys?.phones ?? []) byPhone.set(p, setter)
    // Names: lead display name + the form's own prospect_name, plus each
    // one's first-name token (Calendly invitees are first-name-only).
    const names = [keys?.name ?? null, normName(t.prospect_name)].filter(
      (x): x is string => !!x,
    )
    for (const n of names) {
      setName(n, setter)
      const first = n.split(/\s+/)[0]
      if (first && first !== n) setName(first, setter)
    }
  }

  return (invitee: BookedByInvitee): string | null => {
    if (invitee.leadId) {
      const hit = byLeadId.get(invitee.leadId)
      if (hit) return hit
    }
    const email = invitee.email ? invitee.email.toLowerCase().trim() : null
    if (email) {
      const hit = byEmail.get(email)
      if (hit) return hit
    }
    for (const p of invitee.phones) {
      const hit = byPhone.get(p)
      if (hit) return hit
    }
    const nm = normName(invitee.name)
    if (nm) {
      const full = byName.get(nm)
      if (full) return full
      const first = byName.get(nm.split(/\s+/)[0])
      if (first) return first
    }
    return null
  }
}

type ValidEvent = {
  uri: string
  name: string
  startTime: string
  host: string | null
  status: string | null
  callType: CloserCallType
  invitee: { name: string | null; email: string | null; phones: string[]; noShow: boolean; leadId: string | null }
  inRange: boolean
  // A booking is "dead" (not a live slot) if it was canceled OR no-showed.
  // Drake 2026-05-29: a no-show counts the same as a cancel for deciding
  // whether the lead still has a live booking.
  dead: boolean
}

function emptyAggregate(name: string): CloserScheduledAggregate {
  return {
    closerName: name,
    calls: 0, directCalls: 0, setterCalls: 0,
    showed: 0, noShows: 0, closed: 0, closedHt: 0, closedDc: 0, upfront: 0,
  }
}

export async function getClosingScheduledList(
  range: DateRange,
): Promise<CloserScheduledResult> {
  const sb = createAdminClient()

  // 1. Load ALL valid-link closer events since the closing floor — not
  //    just the view range. We need each lead's full booking history to
  //    count rebookings (a reschedule's earlier leg can sit outside the
  //    range), so the count reflects all-time activity regardless of which
  //    day the user is looking at. The closer dataset is small (low
  //    hundreds since the floor); one read is cheap. Bounded by the floor.
  const floorIso = `${CLOSING_FLOOR_ET}T00:00:00.000Z`
  const { data: eventData, error: eventErr } = await sb
    .from('calendly_scheduled_events' as never)
    .select('uri, name, start_time, host_user_name, status, event_type_uri')
    .is('excluded_at', null)   // creator-hidden test bookings drop out of the closer drill + aggregates
    .gte('start_time', floorIso)
    .order('start_time', { ascending: true })
    .range(0, 4999)
  if (eventErr) throw new Error(`calendly_scheduled_events read failed: ${eventErr.message}`)
  const rawEvents = (eventData ?? []) as unknown as Array<{
    uri: string
    name: string
    start_time: string
    host_user_name: string | null
    status: string | null
    event_type_uri: string | null
  }>

  // Categorize by LINK; drop anything that isn't one of the two valid
  // links (void — never counted).
  const typed = rawEvents
    .map((e) => ({ e, callType: categorizeEvent(e.event_type_uri, e.name) }))
    .filter((x): x is { e: typeof rawEvents[number]; callType: CloserCallType } => x.callType !== null)

  if (typed.length === 0) {
    return { closers: [], aggregate: emptyAggregate('All closers'), drillByCloser: {} }
  }

  // 2. Invitees for those events (identity for lead-keying + form /
  //    booked-by match). Phone lives in raw_payload; the utm_term token
  //    resolves the Close lead_id (the strong key, tried before identity).
  const leadResolver = await buildCalendlyLeadResolver(sb)
  const eventUris = typed.map((t) => t.e.uri)
  const inviteeByEvent = new Map<string, { name: string | null; email: string | null; phones: string[]; noShow: boolean; leadId: string | null }>()
  for (let i = 0; i < eventUris.length; i += 200) {
    const chunk = eventUris.slice(i, i + 200)
    const { data, error } = await sb
      .from('calendly_invitees' as never)
      .select('event_uri, name, email, no_show, raw_payload')
      .in('event_uri', chunk)
    if (error) throw new Error(`calendly_invitees read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{
      event_uri: string
      name: string | null
      email: string | null
      no_show: boolean | null
      raw_payload: {
        text_reminder_number?: string | null
        questions_and_answers?: Array<{ question?: string | null; answer?: string | null }>
        tracking?: { utm_term?: string | null } | null
      } | null
    }>) {
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
        const leadId = leadResolver(inviteeUtmTerm(r.raw_payload))
        inviteeByEvent.set(r.event_uri, { name: r.name, email: r.email, phones, noShow: r.no_show === true, leadId })
      }
    }
  }

  // Email → lead fallback (Drake 2026-05-31). A booking whose utm_term tag
  // doesn't resolve (ad-sourced bookings frequently don't) can still be
  // identified by the invitee's email → the Close lead. ADDITIVE: only fills
  // leadId where the utm resolver left it null. Once the booking knows its
  // lead, the existing lead_id ↔ closer-form match fires (forms carry lead_id),
  // and the booking groups under its real lead instead of an email key.
  const needEmails = new Set<string>()
  inviteeByEvent.forEach((inv) => {
    if (!inv.leadId && inv.email) needEmails.add(inv.email.toLowerCase().trim())
  })
  if (needEmails.size > 0) {
    const emailToLeadId = new Map<string, string>()
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from('close_leads' as never)
        .select('close_id, contacts')
        .range(from, from + 999)
      if (error) throw new Error(`close_leads email-resolve read failed: ${error.message}`)
      const rows = (data ?? []) as unknown as Array<{ close_id: string; contacts: unknown }>
      if (rows.length === 0) break
      for (const r of rows) {
        if (!Array.isArray(r.contacts)) continue
        for (const c of r.contacts as Array<{ emails?: Array<{ email?: string }> }>) {
          for (const e of c.emails ?? []) {
            const em = (e?.email ?? '').toLowerCase().trim()
            if (em && needEmails.has(em) && !emailToLeadId.has(em)) emailToLeadId.set(em, r.close_id)
          }
        }
      }
      if (rows.length < 1000) break
    }
    inviteeByEvent.forEach((inv, uri) => {
      if (inv.leadId || !inv.email) return
      const lid = emailToLeadId.get(inv.email.toLowerCase().trim())
      if (lid) inviteeByEvent.set(uri, { ...inv, leadId: lid })
    })
  }

  // 2b. Booked-by resolver (setter attribution for the representative row).
  const bookedByResolver = await buildBookedByResolver(sb)
  // 2c. Setter id→name resolver — the new closer form carries Setter Name as
  //     record-ids only, so resolve them to display names for "Booked by".
  const setterNameResolver = await buildSetterNameResolver(sb)

  // 3. Closer forms covering the event window (±48h on either side for
  //    matching). Pull as a single windowed read; small table.
  const widenStartMs = new Date(range.startUtcIso).getTime() - FORM_MATCH_WINDOW_SEC * 1000
  const widenEndMs = new Date(range.endUtcIso).getTime() + FORM_MATCH_WINDOW_SEC * 1000
  const widenStartIso = new Date(widenStartMs).toISOString()
  const widenEndIso = new Date(widenEndMs).toISOString()
  const { data: formData, error: formErr } = await sb
    .from('airtable_full_closer_report' as never)
    .select(
      'record_id, lead_id, prospect_name, prospect_email, date_time_of_call, showed, closed, ' +
      'amount_paid_today_currency, amount_paid_today_number, deposit_amount, ' +
      'payment_plan_type, closer_names, setter_names, setter_record_ids, ' +
      'form_type, call_outcome, airtable_created_at',
    )
    .gte('date_time_of_call', widenStartIso)
    .lt('date_time_of_call', widenEndIso)
  if (formErr) throw new Error(`airtable_full_closer_report read failed: ${formErr.message}`)
  const forms = (formData ?? []) as unknown as Array<{
    record_id: string
    lead_id: string | null
    prospect_name: string | null
    prospect_email: string | null
    date_time_of_call: string | null
    showed: string | null
    closed: string | null
    amount_paid_today_currency: number | string | null
    amount_paid_today_number: number | string | null
    deposit_amount: number | string | null
    payment_plan_type: string | null
    closer_names: string[] | null
    setter_names: string[] | null
    setter_record_ids: string[] | null
    form_type: string | null
    call_outcome: string | null
    airtable_created_at: string | null
  }>

  const formsByName = new Map<string, typeof forms>()
  const formsByLeadId = new Map<string, typeof forms>()
  const formsByEmail = new Map<string, typeof forms>()
  for (const f of forms) {
    if (f.lead_id) {
      const arr = formsByLeadId.get(f.lead_id) ?? []
      arr.push(f)
      formsByLeadId.set(f.lead_id, arr)
    }
    if (f.prospect_email) {
      const ek = f.prospect_email.toLowerCase().trim()
      if (ek) {
        const arr = formsByEmail.get(ek) ?? []
        arr.push(f)
        formsByEmail.set(ek, arr)
      }
    }
    if (!f.prospect_name) continue
    const key = f.prospect_name.toLowerCase().trim()
    const arr = formsByName.get(key) ?? []
    arr.push(f)
    formsByName.set(key, arr)
  }

  // From a lead's candidate forms, pick the one for THIS event. Candidacy =
  // within the ±48h window of the event (ties a form to the right booking
  // when a lead has calls on different days). Among those, prefer a New
  // (redesigned single-disposition) form over an Old/legacy one, then the
  // most recently SUBMITTED — so a re-filled correction and the new
  // disposition both win over a stale duplicate. (Drake 2026-05-30: a lead
  // with both an old and a new form, or duplicate new forms, was previously
  // decided by raw time-proximity, which let the wrong/old form win.)
  function pickForm(
    candidates: typeof forms,
    eventMs: number,
  ): (typeof forms)[number] | null {
    const inWindow = candidates.filter(
      (c) =>
        c.date_time_of_call &&
        Math.abs(new Date(c.date_time_of_call).getTime() - eventMs) <= FORM_MATCH_WINDOW_SEC * 1000,
    )
    if (inWindow.length === 0) return null
    return inWindow.reduce((best, c) => {
      const bestIsNew = best.form_type === 'New' ? 1 : 0
      const cIsNew = c.form_type === 'New' ? 1 : 0
      if (cIsNew !== bestIsNew) return cIsNew > bestIsNew ? c : best
      return (c.airtable_created_at ?? '') > (best.airtable_created_at ?? '') ? c : best
    })
  }

  // Match a Calendly event to its closer form, in order: lead_id (from the
  // booking's utm_term token) → invitee email → prospect-name. Email is the
  // reliable key for ad-sourced bookings whose utm_term doesn't resolve and
  // whose invitee name is first-name-only (Drake 2026-05-31 — restoring the
  // email path). All scoped to the ±48h window; winner is the newest form.
  function matchForm(
    eventStartIso: string,
    leadId: string | null,
    inviteeEmail: string | null,
    inviteeName: string | null,
  ): (typeof forms)[number] | null {
    const eventMs = new Date(eventStartIso).getTime()
    if (leadId) {
      const byLead = formsByLeadId.get(leadId)
      if (byLead) {
        const hit = pickForm(byLead, eventMs)
        if (hit) return hit
      }
    }
    if (inviteeEmail) {
      const byEmail = formsByEmail.get(inviteeEmail.toLowerCase().trim())
      if (byEmail) {
        const hit = pickForm(byEmail, eventMs)
        if (hit) return hit
      }
    }
    if (!inviteeName) return null
    const candidates = formsByName.get(inviteeName.toLowerCase().trim())
    if (!candidates) return null
    return pickForm(candidates, eventMs)
  }

  // 4. Group valid events by LEAD (across all hosts / both link types).
  const eventsByLead = new Map<string, ValidEvent[]>()
  for (const { e, callType } of typed) {
    const invitee = inviteeByEvent.get(e.uri) ?? { name: null, email: null, phones: [], noShow: false, leadId: null }
    const inRange = e.start_time >= range.startUtcIso && e.start_time < range.endUtcIso
    const key = leadKeyOf(invitee.leadId, invitee.email, invitee.name, e.uri)
    const arr = eventsByLead.get(key) ?? []
    arr.push({
      uri: e.uri,
      name: e.name,
      startTime: e.start_time,
      host: e.host_user_name,
      status: e.status,
      callType,
      invitee,
      inRange,
      // Dead = canceled in Calendly ONLY. A no-show is NOT a cancel (Drake
      // 2026-05-31) — a no-showed lead keeps a live booking and surfaces with
      // Showed=No from its closer form, rather than being counted cancelled.
      dead: e.status === 'canceled',
    })
    eventsByLead.set(key, arr)
  }

  // 5. One drill row per lead that has at least one booking in the view
  //    range. Aggregates count live (non-cancelled) leads only.
  const closerMap = new Map<string, CloserScheduledAggregate>()
  const drillByCloser: Record<string, CloserScheduledDrillRow[]> = {}
  function bumpAgg(name: string): CloserScheduledAggregate {
    let agg = closerMap.get(name)
    if (!agg) {
      agg = emptyAggregate(name)
      closerMap.set(name, agg)
      drillByCloser[name] = []
    }
    return agg
  }

  const latest = (evs: ValidEvent[]) =>
    evs.reduce((a, b) => (a.startTime >= b.startTime ? a : b))

  for (const evs of Array.from(eventsByLead.values())) {
    const inRangeEvs = evs.filter((e) => e.inRange)
    if (inRangeEvs.length === 0) continue // lead has no booking in this view

    const bookingCount = evs.length                    // net valid bookings (since floor, both calendars)
    const hasLive = evs.some((e) => !e.dead)           // any booking that isn't canceled
    const cancelled = !hasLive

    // Representative = the call shown for this lead in this range: prefer
    // a live in-range booking, else the most-recent in-range one. (A lead
    // with a live future booking still shows today's in-range slot here,
    // with the count badge reflecting the rebooking.)
    const liveInRange = inRangeEvs.filter((e) => !e.dead)
    const rep = latest(liveInRange.length ? liveInRange : inRangeEvs)

    const host = displayHost(rep.host)
    const agg = bumpAgg(host)
    const invitee = rep.invitee

    // Outcomes only for live leads — a cancelled lead has no closer outcome.
    const form = cancelled ? null : matchForm(rep.startTime, invitee.leadId, invitee.email, invitee.name)

    // New form (Form Type = New) → derive from Call Outcome; old form → the
    // legacy Showed?/Closed? fields. Call type (direct/setter), scheduled
    // time, and the closer grouping all stay Calendly-sourced regardless.
    let showed: CloserScheduledDrillRow['showed'] = null
    let closed: CloserScheduledDrillRow['closed'] = null
    let closeType: 'ht' | 'dc' | null = null
    let upfront: number | null = null
    if (form && form.form_type === 'New') {
      const d = deriveNewOutcome(form.call_outcome)
      showed = d.showed
      closed = d.closed
      closeType = d.closeType
      // Upfront = cash collected; for a Deposit, that's the deposit amount.
      const paid = toNum(form.amount_paid_today_number) ?? toNum(form.amount_paid_today_currency)
      upfront = closed === 'deposit' ? (toNum(form.deposit_amount) ?? paid) : paid
    } else if (form) {
      showed = normalizeShowed(form.showed)
      closed = normalizeClosed(form.closed)
      closeType = closed === 'yes' ? classifyPlan(form.payment_plan_type) : null
      upfront = toNum(form.amount_paid_today_currency)
    }

    // Setter name: prefer the matched form's own Setter Name (id→name),
    // fall back to the triage-form resolver. Only for setter-led calls;
    // direct bookings have no setter → "—".
    const bookedBy: string | null =
      rep.callType === 'setter'
        ? (form ? setterNameResolver(form.setter_record_ids) : null) ?? bookedByResolver(invitee)
        : null

    if (!cancelled) {
      agg.calls++
      if (rep.callType === 'direct') agg.directCalls++
      else agg.setterCalls++
      // Showed = actually attended: a close/deposit/DQ ('yes') or a
      // follow-up. Reschedule/no/dq-old are not "showed". No-shows = 'no'.
      if (showed === 'yes' || showed === 'short_follow' || showed === 'long_follow') agg.showed++
      if (showed === 'no') agg.noShows++
      // Closed = a full close only — Deposit is tracked separately, not closed.
      if (closed === 'yes') {
        agg.closed++
        if (closeType === 'ht') agg.closedHt++
        if (closeType === 'dc') agg.closedDc++
      }
      if (upfront !== null && Number.isFinite(upfront)) agg.upfront += upfront
    }

    drillByCloser[host].push({
      eventUri: rep.uri,
      leadId: invitee.leadId,
      prospectName: invitee.name,
      scheduledTime: rep.startTime,
      callType: rep.callType,
      bookedBy,
      showed,
      closed,
      closeType,
      upfront,
      bookingCount,
      cancelled,
    })
  }

  // 5b. Form-only meetings (Drake 2026-06-04). Instant-book closer calls leave
  //     NO Calendly event, so the closer files an EOC with nothing to match.
  //     Mirror the setter drill's form-only rows: a New EOC form in the view
  //     range whose lead has NO Calendly event (by lead_id / email / name)
  //     becomes its own drill row, attributed to the form's closer. These are
  //     real worked meetings, so they count in the aggregates like Calendly ones.
  // Exclusion is keyed to IN-RANGE events only — the ones that actually
  // produced a drill row this range. A lead whose only Calendly event is
  // OUTSIDE the range (e.g. Kristina booked a strat call May 25, then closed
  // via an instant re-engagement Jun 3 with no new booking) gets no event row
  // here, so its in-range close must still surface as form-only. Keying off
  // all-time events wrongly hid it.
  const eventLeadIds = new Set<string>()
  const eventEmails = new Set<string>()
  const eventNames = new Set<string>()
  for (const { e } of typed) {
    if (!(e.start_time >= range.startUtcIso && e.start_time < range.endUtcIso)) continue
    const inv = inviteeByEvent.get(e.uri)
    if (!inv) continue
    if (inv.leadId) eventLeadIds.add(inv.leadId)
    if (inv.email) eventEmails.add(inv.email.toLowerCase().trim())
    if (inv.name) eventNames.add(inv.name.toLowerCase().trim())
  }
  const formOnlyCandidates = forms.filter((f) => {
    if (f.form_type !== 'New') return false
    const ts = f.date_time_of_call ?? f.airtable_created_at
    if (!ts || ts < range.startUtcIso || ts >= range.endUtcIso) return false
    if (f.lead_id && eventLeadIds.has(f.lead_id)) return false
    const email = (f.prospect_email ?? '').toLowerCase().trim()
    if (email && eventEmails.has(email)) return false
    const name = (f.prospect_name ?? '').toLowerCase().trim()
    if (name && eventNames.has(name)) return false
    return true
  })
  // Drop test / soft-hidden leads — the Calendly side filters excluded_at on the
  // event, but forms have no such flag, so check the backing lead.
  const hiddenOrTest = new Set<string>()
  const candidateLeadIds = Array.from(
    new Set(formOnlyCandidates.map((f) => f.lead_id).filter((x): x is string => !!x)),
  )
  for (let i = 0; i < candidateLeadIds.length; i += 200) {
    const chunk = candidateLeadIds.slice(i, i + 200)
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, display_name, excluded_at')
      .in('close_id', chunk)
    if (error) throw new Error(`close_leads (form-only filter) read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{ close_id: string; display_name: string | null; excluded_at: string | null }>) {
      if (r.excluded_at != null || (r.display_name ?? '').trim().toLowerCase() === 'test') hiddenOrTest.add(r.close_id)
    }
  }
  for (const f of formOnlyCandidates) {
    if (f.lead_id && hiddenOrTest.has(f.lead_id)) continue
    if (!f.lead_id && (f.prospect_name ?? '').trim().toLowerCase() === 'test') continue
    const ts = (f.date_time_of_call ?? f.airtable_created_at) as string
    const d = deriveNewOutcome(f.call_outcome)
    const hasSetter =
      (f.setter_record_ids ?? []).some((s) => s && s.trim()) ||
      (f.setter_names ?? []).some((n) => n && n.trim() && n.trim().toLowerCase() !== 'no setter')
    const callType: CloserCallType = hasSetter ? 'setter' : 'direct'
    const host = displayHost((f.closer_names ?? []).find((n) => n && n.trim())?.trim() ?? null)
    const agg = bumpAgg(host)
    const paid = toNum(f.amount_paid_today_number) ?? toNum(f.amount_paid_today_currency)
    const upfront = d.closed === 'deposit' ? (toNum(f.deposit_amount) ?? paid) : paid
    const bookedBy = callType === 'setter' ? (setterNameResolver(f.setter_record_ids) ?? null) : null
    agg.calls++
    if (callType === 'direct') agg.directCalls++
    else agg.setterCalls++
    if (d.showed === 'yes' || d.showed === 'short_follow' || d.showed === 'long_follow') agg.showed++
    if (d.showed === 'no') agg.noShows++
    if (d.closed === 'yes') {
      agg.closed++
      if (d.closeType === 'ht') agg.closedHt++
      if (d.closeType === 'dc') agg.closedDc++
    }
    if (upfront !== null && Number.isFinite(upfront)) agg.upfront += upfront
    drillByCloser[host].push({
      eventUri: `form:${f.record_id}`,
      leadId: f.lead_id,
      prospectName: f.prospect_name,
      scheduledTime: ts,
      callType,
      bookedBy,
      showed: d.showed,
      closed: d.closed,
      closeType: d.closeType,
      upfront,
      bookingCount: 1,
      cancelled: false,
      formOnly: true,
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
  const aggregate = closers.reduce<CloserScheduledAggregate>((acc, c) => ({
    closerName: 'All closers',
    calls: acc.calls + c.calls,
    directCalls: acc.directCalls + c.directCalls,
    setterCalls: acc.setterCalls + c.setterCalls,
    showed: acc.showed + c.showed,
    noShows: acc.noShows + c.noShows,
    closed: acc.closed + c.closed,
    closedHt: acc.closedHt + c.closedHt,
    closedDc: acc.closedDc + c.closedDc,
    upfront: acc.upfront + c.upfront,
  }), emptyAggregate('All closers'))

  return { closers, aggregate, drillByCloser }
}
