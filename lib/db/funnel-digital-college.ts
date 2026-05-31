import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'
import { buildCalendlyLeadResolver, inviteeUtmTerm } from './calendly-lead-match'

// Funnel · Digital College (low-ticket) — Robby Bryant's per-rep view.
//
// The dedicated low-ticket closer (Robby) works the Digital College offer
// end-to-end and files the dedicated DC sale form (airtable_digital_college_sales,
// table tbljmzRoMoE5B26lt). Aman's downsell DC closes live on the Full
// Closer Report (call_outcome = 'Digital College Closed') and are NOT in
// this view — this is the dedicated low-ticket path only.
//
// FORM-FIRST (Drake 2026-05-31): Robby didn't always have a Calendly link,
// so the form is the source of truth for meetings/shows/closes. His Calendly
// events are ADDITIVE — when he has a booked event for a meeting we use it
// (start time, booking record), and a booked event with NO matching form is
// a meeting that hasn't been worked yet (a no-show until a form is entered).
// Forms and links are unioned per lead.
//
// Outcome model on the DC form:
//   - Closed? = Yes            → a DC close. `plans` (Base/Wix × Monthly/Yearly)
//                                gives the per-product breakdown. "Base" = Base44.
//   - Closed? = No, Follow Up? = Yes → showed, not closed (will follow up).
//   - Closed? = No, Follow Up? = No  → DQ. (The form's Follow Up field was
//                                built wrong by Zain; "No" actually means DQ.)
// There is no no-show field on the form, so a filed form = showed.

// Robby Bryant's Close CRM user id — dials are counted from his outbound
// close_calls. The dedicated low-ticket closer (Drake 2026-05-31).
export const ROBBY_CLOSE_USER_ID = 'user_rt4533Y5VcOsbso6UMYAUn8sCdtVaKYGYDnWYLvBW2l'

// Robby's "Call with Robby" Calendly event type — his DC sales link. This is
// his only event type in the mirror; there is no separate onboarding link to
// exclude today. If an onboarding (fulfillment) event type appears later, add
// it to DC_ONBOARDING_EVENT_TYPE_URIS so it's excluded from meetings.
export const ROBBY_DC_EVENT_TYPE_URI =
  'https://api.calendly.com/event_types/6f06c6ba-6ca2-48d2-ae17-a6c5c1ee75ec'
const DC_ONBOARDING_EVENT_TYPE_URIS = new Set<string>([
  // post-close onboarding event type(s) — fulfillment, not a sale. (none yet)
])

const ROBBY_DISPLAY_NAME = 'Robby Bryant'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// Per-meeting outcome. null = no form filed yet (a booked Calendly event with
// no matching form → a no-show / un-worked meeting).
export type DcOutcome = 'closed' | 'follow_up' | 'dq' | null

export type DcDrillRow = {
  key: string
  prospectName: string | null
  // ISO UTC of the meeting — the DC form's call time, else the Calendly slot.
  scheduledTime: string | null
  // Setter who booked the meeting (from the form's Setter lookup, else the
  // Calendly-derived setter). null → no setter (self-set / direct).
  bookedBy: string | null
  // True when a DC form was filed for this lead (= showed). false → a booked
  // Calendly meeting with no form yet (no-show / pending).
  showed: boolean
  outcome: DcOutcome
  closed: boolean
  // Per-product plan flags (only meaningful on a close). "Base" = Base44.
  base44Monthly: boolean
  base44Yearly: boolean
  wixMonthly: boolean
  wixYearly: boolean
  plans: string[]
  // True when the lead had a Calendly event (Robby's link) for this meeting.
  hasMeetingLink: boolean
}

export type DcAggregate = {
  closerName: string
  dials: number       // outbound close_calls by this closer in range (Robby only)
  meetings: number    // distinct leads (forms ∪ Robby's Calendly events) in range
  shows: number       // meetings with a filed form
  base44Monthly: number
  base44Yearly: number
  wixMonthly: number
  wixYearly: number
  closes: number      // Closed? = Yes
}

export type DigitalCollegeResult = {
  closers: DcAggregate[]
  aggregate: DcAggregate
  drillByCloser: Record<string, DcDrillRow[]>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DcSaleRow = {
  record_id: string
  airtable_created_at: string | null
  lead_id: string | null
  prospect_name: string | null
  date_time_of_call: string | null
  closer_names: string[] | null
  setter_names: string[] | null
  closed: string | null
  plans: string[] | null
  follow_up: string | null
}

// Effective meeting time for an ET-day window filter: the call time when
// present, else the form-fill time (the closer files 0-2 days after).
function effectiveDcTs(r: DcSaleRow): string | null {
  return r.date_time_of_call ?? r.airtable_created_at
}

// A DC form's outcome. Closed?=Yes wins; otherwise Follow Up? decides
// follow-up vs DQ (No = DQ — the field was mis-built; see header).
function dcOutcome(closed: string | null, followUp: string | null): Exclude<DcOutcome, null> {
  if ((closed ?? '').trim().toLowerCase() === 'yes') return 'closed'
  if ((followUp ?? '').trim().toLowerCase() === 'no') return 'dq'
  return 'follow_up'
}

// Per-entry plan flags. Tolerant of label drift: an entry is Base44 if it
// mentions "base", Wix if "wix"; monthly/yearly by "month"/"year"|"annual".
function planFlags(plans: string[] | null): {
  base44Monthly: boolean
  base44Yearly: boolean
  wixMonthly: boolean
  wixYearly: boolean
} {
  let base44Monthly = false, base44Yearly = false, wixMonthly = false, wixYearly = false
  for (const raw of plans ?? []) {
    const p = (raw ?? '').toLowerCase()
    const isBase = p.includes('base')
    const isWix = p.includes('wix')
    const monthly = p.includes('month')
    const yearly = p.includes('year') || p.includes('annual')
    if (isBase && monthly) base44Monthly = true
    if (isBase && yearly) base44Yearly = true
    if (isWix && monthly) wixMonthly = true
    if (isWix && yearly) wixYearly = true
  }
  return { base44Monthly, base44Yearly, wixMonthly, wixYearly }
}

// Lead key for collapsing forms + Calendly events onto one meeting row.
function dcLeadKey(leadId: string | null, name: string | null, fallback: string): string {
  if (leadId) return `l:${leadId}`
  const n = (name ?? '').toLowerCase().trim()
  if (n) return `n:${n}`
  return fallback
}

function emptyDcAggregate(name: string): DcAggregate {
  return {
    closerName: name,
    dials: 0, meetings: 0, shows: 0,
    base44Monthly: 0, base44Yearly: 0, wixMonthly: 0, wixYearly: 0, closes: 0,
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

// DC sale forms whose effective meeting time falls in range. Widen the read
// 14 days back to catch late fills (small table; cheap), then client-filter.
async function loadDcSales(range: DateRange): Promise<DcSaleRow[]> {
  const sb = createAdminClient()
  const widenStartMs = new Date(range.startUtcIso).getTime() - 14 * 24 * 60 * 60 * 1000
  const widenStartIso = new Date(widenStartMs).toISOString()

  let rows: DcSaleRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('airtable_digital_college_sales' as never)
      .select(
        'record_id, airtable_created_at, lead_id, prospect_name, date_time_of_call, ' +
        'closer_names, setter_names, closed, plans, follow_up',
      )
      .is('excluded_at', null)
      .gte('airtable_created_at', widenStartIso)
      .order('airtable_created_at', { ascending: false })
      .range(from, from + 999)
    if (error) throw new Error(`airtable_digital_college_sales read failed: ${error.message}`)
    const page = (data ?? []) as unknown as DcSaleRow[]
    if (page.length === 0) break
    rows = rows.concat(page)
    if (page.length < 1000) break
    from += 1000
  }

  // Drop blank Airtable rows (no lead, no name, no outcome) and keep rows
  // whose effective meeting time is in the requested range.
  return rows.filter((r) => {
    const isBlank = !r.lead_id && !r.prospect_name && !r.closed && (r.plans ?? []).length === 0
    if (isBlank) return false
    const ts = effectiveDcTs(r)
    return ts != null && ts >= range.startUtcIso && ts < range.endUtcIso
  })
}

type RobbyEvent = {
  uri: string
  startTime: string
  prospectName: string | null
  leadId: string | null
  canceled: boolean
}

// Robby's DC-sales Calendly events whose slot falls in range (additive
// meetings — used when a meeting has a link; orphans with no form = no-show).
async function loadRobbyEvents(range: DateRange): Promise<RobbyEvent[]> {
  const sb = createAdminClient()
  const { data: eventData, error: eventErr } = await sb
    .from('calendly_scheduled_events' as never)
    .select('uri, start_time, status, event_type_uri')
    .is('excluded_at', null)
    .eq('event_type_uri', ROBBY_DC_EVENT_TYPE_URI)
    .gte('start_time', range.startUtcIso)
    .lt('start_time', range.endUtcIso)
    .order('start_time', { ascending: true })
    .range(0, 999)
  if (eventErr) throw new Error(`calendly_scheduled_events (DC) read failed: ${eventErr.message}`)
  const events = (eventData ?? []) as unknown as Array<{
    uri: string
    start_time: string
    status: string | null
    event_type_uri: string | null
  }>
  const inScope = events.filter((e) => !DC_ONBOARDING_EVENT_TYPE_URIS.has(e.event_type_uri ?? ''))
  if (inScope.length === 0) return []

  // Resolve each event's invitee for lead identity (lead_id via utm_term, name).
  const leadResolver = await buildCalendlyLeadResolver(sb)
  const byEvent = new Map<string, { name: string | null; leadId: string | null }>()
  const uris = inScope.map((e) => e.uri)
  for (let i = 0; i < uris.length; i += 200) {
    const chunk = uris.slice(i, i + 200)
    const { data, error } = await sb
      .from('calendly_invitees' as never)
      .select('event_uri, name, raw_payload')
      .in('event_uri', chunk)
    if (error) throw new Error(`calendly_invitees (DC) read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{
      event_uri: string
      name: string | null
      raw_payload: { tracking?: { utm_term?: string | null } | null } | null
    }>) {
      if (byEvent.has(r.event_uri)) continue
      byEvent.set(r.event_uri, {
        name: r.name,
        leadId: leadResolver(inviteeUtmTerm(r.raw_payload)),
      })
    }
  }

  return inScope.map((e) => {
    const inv = byEvent.get(e.uri)
    return {
      uri: e.uri,
      startTime: e.start_time,
      prospectName: inv?.name ?? null,
      leadId: inv?.leadId ?? null,
      canceled: e.status === 'canceled',
    }
  })
}

// Robby's outbound dials in range, from close_calls.
async function loadDials(range: DateRange, userId: string): Promise<number> {
  const sb = createAdminClient()
  const { count, error } = await sb
    .from('close_calls' as never)
    .select('close_id', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('direction', 'outbound')
    .gte('date_created', range.startUtcIso)
    .lt('date_created', range.endUtcIso)
  if (error) throw new Error(`close_calls (DC dials) count failed: ${error.message}`)
  return count ?? 0
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export async function getDigitalCollegeActivity(range: DateRange): Promise<DigitalCollegeResult> {
  const [sales, events, robbyDials] = await Promise.all([
    loadDcSales(range),
    loadRobbyEvents(range),
    loadDials(range, ROBBY_CLOSE_USER_ID),
  ])

  // Per-meeting rows keyed by lead. A form is the meeting (showed); a Robby
  // Calendly event with no matching form is an un-worked booked meeting.
  type Meeting = {
    key: string
    closerName: string
    row: DcDrillRow
    hasForm: boolean
  }
  const meetings = new Map<string, Meeting>()

  // 1. Forms first — they're the source of truth.
  for (const r of sales) {
    const key = dcLeadKey(r.lead_id, r.prospect_name, `rec:${r.record_id}`)
    const outcome = dcOutcome(r.closed, r.follow_up)
    const flags = planFlags(r.plans)
    const closerName = (r.closer_names ?? []).find((n) => n && n.trim())?.trim() ?? ROBBY_DISPLAY_NAME
    const bookedBy = (r.setter_names ?? []).find((n) => n && n.trim())?.trim() ?? null
    // If two forms collapse to one lead, keep the most recent / strongest
    // (a close beats a follow-up). Simpler: last form wins by effective time.
    const existing = meetings.get(key)
    const tsIso = effectiveDcTs(r)
    if (existing && existing.hasForm) {
      const exTs = existing.row.scheduledTime ?? ''
      if ((tsIso ?? '') <= exTs && existing.row.outcome === 'closed') continue
    }
    meetings.set(key, {
      key,
      closerName,
      hasForm: true,
      row: {
        key,
        prospectName: r.prospect_name,
        scheduledTime: tsIso,
        bookedBy,
        showed: true,
        outcome,
        closed: outcome === 'closed',
        base44Monthly: flags.base44Monthly,
        base44Yearly: flags.base44Yearly,
        wixMonthly: flags.wixMonthly,
        wixYearly: flags.wixYearly,
        plans: r.plans ?? [],
        hasMeetingLink: false,
      },
    })
  }

  // 2. Robby's Calendly events — fill in the meeting link where a form
  //    exists, else add an un-worked (no-form) meeting. Canceled events that
  //    have no form drop out (not a real meeting).
  for (const ev of events) {
    const key = dcLeadKey(ev.leadId, ev.prospectName, `evt:${ev.uri}`)
    const existing = meetings.get(key)
    if (existing) {
      existing.row.hasMeetingLink = true
      // Prefer the Calendly slot time for the scheduled column when present.
      existing.row.scheduledTime = existing.row.scheduledTime ?? ev.startTime
      continue
    }
    if (ev.canceled) continue
    meetings.set(key, {
      key,
      closerName: ROBBY_DISPLAY_NAME,
      hasForm: false,
      row: {
        key,
        prospectName: ev.prospectName,
        scheduledTime: ev.startTime,
        bookedBy: null,
        showed: false,
        outcome: null,
        closed: false,
        base44Monthly: false,
        base44Yearly: false,
        wixMonthly: false,
        wixYearly: false,
        plans: [],
        hasMeetingLink: true,
      },
    })
  }

  // 3. Aggregate per closer + build drill lists.
  const byCloser = new Map<string, DcAggregate>()
  const drillByCloser: Record<string, DcDrillRow[]> = {}
  for (const m of Array.from(meetings.values())) {
    let agg = byCloser.get(m.closerName)
    if (!agg) {
      agg = emptyDcAggregate(m.closerName)
      byCloser.set(m.closerName, agg)
      drillByCloser[m.closerName] = []
    }
    agg.meetings++
    if (m.hasForm) agg.shows++
    if (m.row.closed) {
      agg.closes++
      if (m.row.base44Monthly) agg.base44Monthly++
      if (m.row.base44Yearly) agg.base44Yearly++
      if (m.row.wixMonthly) agg.wixMonthly++
      if (m.row.wixYearly) agg.wixYearly++
    }
    drillByCloser[m.closerName].push(m.row)
  }

  // Dials attach to Robby (the only DC closer with a known Close user id).
  const robbyAgg = byCloser.get(ROBBY_DISPLAY_NAME) ?? emptyDcAggregate(ROBBY_DISPLAY_NAME)
  robbyAgg.dials = robbyDials
  if (!byCloser.has(ROBBY_DISPLAY_NAME) && robbyDials > 0) {
    byCloser.set(ROBBY_DISPLAY_NAME, robbyAgg)
    drillByCloser[ROBBY_DISPLAY_NAME] = []
  }

  // Sort drill rows most-recent first.
  for (const name of Object.keys(drillByCloser)) {
    drillByCloser[name].sort((a, b) =>
      (a.scheduledTime ?? '') < (b.scheduledTime ?? '') ? 1 : (a.scheduledTime ?? '') > (b.scheduledTime ?? '') ? -1 : 0,
    )
  }

  const closers = Array.from(byCloser.values()).sort((a, b) => b.meetings - a.meetings)
  const aggregate = closers.reduce<DcAggregate>((acc, c) => ({
    closerName: 'All DC closers',
    dials: acc.dials + c.dials,
    meetings: acc.meetings + c.meetings,
    shows: acc.shows + c.shows,
    base44Monthly: acc.base44Monthly + c.base44Monthly,
    base44Yearly: acc.base44Yearly + c.base44Yearly,
    wixMonthly: acc.wixMonthly + c.wixMonthly,
    wixYearly: acc.wixYearly + c.wixYearly,
    closes: acc.closes + c.closes,
  }), emptyDcAggregate('All DC closers'))

  return { closers, aggregate, drillByCloser }
}
