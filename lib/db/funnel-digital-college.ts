import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'
import { buildCalendlyLeadResolver, inviteeUtmTerm } from './calendly-lead-match'
import { fetchChunked } from './query-parallel'

// Funnel · Digital College (low-ticket) — the dedicated DC closers' per-rep view.
//
// DC closers are now data-driven off team_members (sales_role = 'dc_closer'),
// resolving like every other sales rep (Drake 2026-06-07): a row carries the
// closer's close_user_id (dials), airtable_user_id (form attribution via the
// closer report's closer_record_ids), and calendly_event_type_uri (their DC
// sale link). Previously this module hardcoded a single closer (Robby) across
// three constants and grouped by the raw closer-name string — which split one
// person into two rows ("Robby" from forms vs "Robby Bryant" from Calendly/
// dials). Grouping is now by close_user_id; full_name is display-only.
//
// Aman's downsell DC closes live on the Full Closer Report (call_outcome =
// 'Digital College Closed') and are NOT in this view — Aman is a high-ticket
// closer, not a dc_closer. This is the dedicated low-ticket path only.
//
// FORM-FIRST (Drake 2026-05-31): a DC closer didn't always have a Calendly
// link, so the form is the source of truth for meetings/shows/closes. Calendly
// events are ADDITIVE — when there's a booked event for a meeting we use it
// (start time, booking record), and a booked event with NO matching form is a
// meeting that hasn't been worked yet (a no-show until a form is entered).
// Forms and links are unioned per lead.
//
// Outcome model on the closer report (DC rows):
//   - call_outcome 'Digital College Closed' → a DC close. `dc_plans`
//                                (Base/Wix × Monthly/Yearly) gives the
//                                per-product breakdown. "Base" = Base44.
//   - call_outcome contains 'DQ'      → DQ (showed, disqualified).
//   - otherwise                       → showed, not closed (follow up).
// A filed form = showed (there is no no-show field).

// Post-close onboarding (fulfillment) Calendly event types to exclude from
// meetings, should any appear. Sale links live on team_members; this is the
// shared exclusion set. (none yet)
const DC_ONBOARDING_EVENT_TYPE_URIS = new Set<string>([])

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// A DC closer resolved from team_members. closeUserId is the stable grouping
// key everywhere in this module; fullName is display-only.
type DcCloser = {
  closeUserId: string
  fullName: string
  airtableUserId: string | null
  eventTypeUri: string | null
}

// Per-meeting outcome. null = no form filed yet (a booked Calendly event with
// no matching form → a no-show / un-worked meeting).
export type DcOutcome = 'closed' | 'follow_up' | 'dq' | null

export type DcDrillRow = {
  key: string
  leadId: string | null     // Close lead_id (for the per-lead link); null = unresolved
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
  // True when the lead had a Calendly event (the closer's link) for this meeting.
  hasMeetingLink: boolean
}

export type DcAggregate = {
  closerKey: string   // close_user_id — the stable selection/grouping key
  closerName: string  // full_name — display only
  dials: number       // outbound close_calls by this closer in range
  meetings: number    // distinct leads (forms ∪ the closer's Calendly events) in range
  shows: number       // meetings with a filed form
  base44Monthly: number
  base44Yearly: number
  wixMonthly: number
  wixYearly: number
  closes: number      // call_outcome 'Digital College Closed'
}

export type DigitalCollegeResult = {
  closers: DcAggregate[]
  aggregate: DcAggregate
  drillByCloser: Record<string, DcDrillRow[]>  // keyed by closerKey (close_user_id)
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
  closerKey: string         // resolved close_user_id of the DC closer
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

function emptyDcAggregate(closerKey: string, name: string): DcAggregate {
  return {
    closerKey,
    closerName: name,
    dials: 0, meetings: 0, shows: 0,
    base44Monthly: 0, base44Yearly: 0, wixMonthly: 0, wixYearly: 0, closes: 0,
  }
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

// The DC closers, from team_members. Only rows with a close_user_id are usable
// (it's the grouping key + dials key); rows missing it are skipped.
async function loadDcClosers(): Promise<DcCloser[]> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('team_members' as never)
    .select('full_name, close_user_id, airtable_user_id, calendly_event_type_uri')
    .eq('sales_role', 'dc_closer')
    .is('archived_at', null)
  if (error) throw new Error(`team_members (dc_closer) read failed: ${error.message}`)
  const rows = (data ?? []) as unknown as Array<{
    full_name: string | null
    close_user_id: string | null
    airtable_user_id: string | null
    calendly_event_type_uri: string | null
  }>
  return rows
    .filter((r) => r.close_user_id)
    .map((r) => ({
      closeUserId: r.close_user_id as string,
      fullName: (r.full_name ?? '').trim() || (r.close_user_id as string),
      airtableUserId: r.airtable_user_id,
      eventTypeUri: r.calendly_event_type_uri,
    }))
}

// DC meetings from the regular closer EOC form. A form belongs to a DC closer
// when its closer_record_ids includes that closer's airtable_user_id (the
// authoritative join, mirroring funnel-appointment-setting / funnel-closing).
// Mapped into DcSaleRow: filed form = showed, closed = call_outcome 'Digital
// College Closed', plans = dc_plans, follow-up/dq derived from the outcome.
// Widen the read 14 days back for late fills, then client-filter to the range.
async function loadDcSales(range: DateRange, closers: DcCloser[]): Promise<DcSaleRow[]> {
  const sb = createAdminClient()
  const widenStartMs = new Date(range.startUtcIso).getTime() - 14 * 24 * 60 * 60 * 1000
  const widenStartIso = new Date(widenStartMs).toISOString()

  // airtable rec-id → closer key. (close_user_id of the DC closer.)
  const keyByAirtableId = new Map<string, string>()
  for (const c of closers) {
    if (c.airtableUserId) keyByAirtableId.set(c.airtableUserId, c.closeUserId)
  }
  if (keyByAirtableId.size === 0) return []

  type EocRow = {
    record_id: string; airtable_created_at: string | null; lead_id: string | null
    prospect_name: string | null; date_time_of_call: string | null
    closer_record_ids: string[] | null; setter_names: string[] | null
    call_outcome: string | null; dc_plans: string[] | null
  }
  let raw: EocRow[] = []
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('airtable_full_closer_report' as never)
      .select(
        'record_id, airtable_created_at, lead_id, prospect_name, date_time_of_call, ' +
        'closer_record_ids, setter_names, call_outcome, dc_plans',
      )
      .eq('form_type', 'New')
      .gte('airtable_created_at', widenStartIso)
      .order('airtable_created_at', { ascending: false })
      .range(from, from + 999)
    if (error) throw new Error(`airtable_full_closer_report (DC) read failed: ${error.message}`)
    const page = (data ?? []) as unknown as EocRow[]
    if (page.length === 0) break
    raw = raw.concat(page)
    if (page.length < 1000) break
    from += 1000
  }

  return raw
    // Attribute each form to a DC closer by record-id membership.
    .map((r): DcSaleRow | null => {
      const closerKey = (r.closer_record_ids ?? [])
        .map((id) => (id ? keyByAirtableId.get(id) : undefined))
        .find((k): k is string => Boolean(k))
      if (!closerKey) return null
      const co = (r.call_outcome ?? '').toLowerCase()
      return {
        record_id: r.record_id,
        airtable_created_at: r.airtable_created_at,
        lead_id: r.lead_id,
        prospect_name: r.prospect_name,
        date_time_of_call: r.date_time_of_call,
        closerKey,
        setter_names: r.setter_names,
        closed: co.includes('digital college closed') ? 'Yes' : 'No',
        plans: r.dc_plans,
        // dcOutcome: not-closed → 'No' = DQ, else follow-up. DQ outcome → DQ.
        follow_up: co.includes('dq') ? 'No' : 'Yes',
      }
    })
    .filter((r): r is DcSaleRow => r != null)
    .filter((r) => {
      const ts = effectiveDcTs(r)
      return ts != null && ts >= range.startUtcIso && ts < range.endUtcIso
    })
}

type DcEvent = {
  uri: string
  startTime: string
  prospectName: string | null
  leadId: string | null
  canceled: boolean
  closerKey: string  // resolved from the event_type_uri's owning DC closer
}

// DC-sales Calendly events (the closers' sale links) whose slot falls in range
// (additive meetings — used when a meeting has a link; orphans with no form =
// no-show).
async function loadDcEvents(range: DateRange, closers: DcCloser[]): Promise<DcEvent[]> {
  const sb = createAdminClient()
  // event_type_uri → closer key.
  const keyByEventUri = new Map<string, string>()
  for (const c of closers) {
    if (c.eventTypeUri && !DC_ONBOARDING_EVENT_TYPE_URIS.has(c.eventTypeUri)) {
      keyByEventUri.set(c.eventTypeUri, c.closeUserId)
    }
  }
  if (keyByEventUri.size === 0) return []

  const { data: eventData, error: eventErr } = await sb
    .from('calendly_scheduled_events' as never)
    .select('uri, start_time, status, event_type_uri')
    .is('excluded_at', null)
    .in('event_type_uri', Array.from(keyByEventUri.keys()))
    .gte('start_time', range.startUtcIso)
    .lt('start_time', range.endUtcIso)
    .order('start_time', { ascending: true })
    .range(0, 999)
  if (eventErr) throw new Error(`calendly_scheduled_events (DC) read failed: ${eventErr.message}`)
  const inScope = (eventData ?? []) as unknown as Array<{
    uri: string
    start_time: string
    status: string | null
    event_type_uri: string | null
  }>
  if (inScope.length === 0) return []

  // Resolve each event's invitee for lead identity (lead_id via utm_term; email
  // is the fallback below). A DC link often has no utm_term, so without the
  // email fallback a form (keyed by lead_id) and its booking (keyed by name)
  // don't merge — the lead surfaces twice (Tasha Garza, Drake 2026-05-31).
  const leadResolver = await buildCalendlyLeadResolver(sb)
  const byEvent = new Map<string, { name: string | null; email: string | null; leadId: string | null }>()
  const uris = inScope.map((e) => e.uri)
  {
    // event_uri partitioned across chunks; first-wins per event preserved.
    const rows = await fetchChunked<{
      event_uri: string
      name: string | null
      email: string | null
      raw_payload: { tracking?: { utm_term?: string | null } | null } | null
    }>(
      uris,
      (chunk) => sb
        .from('calendly_invitees' as never)
        .select('event_uri, name, email, raw_payload')
        .in('event_uri', chunk) as never,
      'calendly_invitees (DC) read failed',
      200,
    )
    for (const r of rows) {
      if (byEvent.has(r.event_uri)) continue
      byEvent.set(r.event_uri, {
        name: r.name,
        email: r.email,
        leadId: leadResolver(inviteeUtmTerm(r.raw_payload)),
      })
    }
  }

  // Email → close lead_id fallback for events the utm_term didn't resolve. Once
  // the booking knows its lead, it groups under the same lead_id as the DC form.
  const needEmails = new Set<string>()
  byEvent.forEach((inv) => {
    if (!inv.leadId && inv.email) needEmails.add(inv.email.toLowerCase().trim())
  })
  if (needEmails.size > 0) {
    const emailToLeadId = new Map<string, string>()
    for (let fromIdx = 0; ; fromIdx += 1000) {
      const { data, error } = await sb
        .from('close_leads' as never)
        .select('close_id, contacts')
        .range(fromIdx, fromIdx + 999)
      if (error) throw new Error(`close_leads (DC email-resolve) read failed: ${error.message}`)
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
    byEvent.forEach((inv, uri) => {
      if (inv.leadId || !inv.email) return
      const lid = emailToLeadId.get(inv.email.toLowerCase().trim())
      if (lid) byEvent.set(uri, { ...inv, leadId: lid })
    })
  }

  return inScope.map((e) => {
    const inv = byEvent.get(e.uri)
    return {
      uri: e.uri,
      startTime: e.start_time,
      prospectName: inv?.name ?? null,
      leadId: inv?.leadId ?? null,
      canceled: e.status === 'canceled',
      closerKey: keyByEventUri.get(e.event_type_uri ?? '') as string,
    }
  })
}

// Outbound dials in range per DC closer, from close_calls. Returns a map of
// close_user_id → count.
async function loadDials(range: DateRange, closers: DcCloser[]): Promise<Map<string, number>> {
  const sb = createAdminClient()
  const out = new Map<string, number>()
  await Promise.all(
    closers.map(async (c) => {
      const { count, error } = await sb
        .from('close_calls' as never)
        .select('close_id', { count: 'exact', head: true })
        .eq('user_id', c.closeUserId)
        .eq('direction', 'outbound')
        .gte('date_created', range.startUtcIso)
        .lt('date_created', range.endUtcIso)
      if (error) throw new Error(`close_calls (DC dials) count failed: ${error.message}`)
      out.set(c.closeUserId, count ?? 0)
    }),
  )
  return out
}

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

export async function getDigitalCollegeActivity(range: DateRange): Promise<DigitalCollegeResult> {
  const closers = await loadDcClosers()
  if (closers.length === 0) {
    return { closers: [], aggregate: emptyDcAggregate('', 'All DC closers'), drillByCloser: {} }
  }
  const nameByKey = new Map(closers.map((c) => [c.closeUserId, c.fullName]))

  const [sales, events, dialsByUser] = await Promise.all([
    loadDcSales(range, closers),
    loadDcEvents(range, closers),
    loadDials(range, closers),
  ])

  // Per-meeting rows keyed by lead. A form is the meeting (showed); a Calendly
  // event with no matching form is an un-worked booked meeting. closerKey is
  // carried from the form (authoritative) or the event's owning closer.
  type Meeting = {
    key: string
    closerKey: string
    row: DcDrillRow
    hasForm: boolean
  }
  const meetings = new Map<string, Meeting>()
  // Form key by normalized name → so a Calendly booking that resolved to neither
  // a lead_id nor an email still merges with a form of the same name instead of
  // doubling the lead (secondary to the lead_id match below).
  const formKeyByName = new Map<string, string>()

  // 1. Forms first — they're the source of truth.
  for (const r of sales) {
    const key = dcLeadKey(r.lead_id, r.prospect_name, `rec:${r.record_id}`)
    const nm = (r.prospect_name ?? '').toLowerCase().trim()
    if (nm) formKeyByName.set(nm, key)
    const outcome = dcOutcome(r.closed, r.follow_up)
    const flags = planFlags(r.plans)
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
      closerKey: r.closerKey,
      hasForm: true,
      row: {
        key,
        leadId: r.lead_id,
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

  // 2. Calendly events — fill in the meeting link where a form exists, else add
  //    an un-worked (no-form) meeting. Canceled events with no form drop out.
  for (const ev of events) {
    const key = dcLeadKey(ev.leadId, ev.prospectName, `evt:${ev.uri}`)
    // Direct key (lead_id/name) first, then a name match against the forms —
    // covers a booking that resolved no lead_id but shares a form's name.
    const nm = (ev.prospectName ?? '').toLowerCase().trim()
    const existing = meetings.get(key) ?? (nm ? meetings.get(formKeyByName.get(nm) ?? '') : undefined)
    if (existing) {
      existing.row.hasMeetingLink = true
      // Prefer the Calendly slot time for the scheduled column when present.
      existing.row.scheduledTime = existing.row.scheduledTime ?? ev.startTime
      continue
    }
    if (ev.canceled) continue
    meetings.set(key, {
      key,
      closerKey: ev.closerKey,
      hasForm: false,
      row: {
        key,
        leadId: ev.leadId,
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

  // 3. Aggregate per closer (by close_user_id) + build drill lists.
  const byCloser = new Map<string, DcAggregate>()
  const drillByCloser: Record<string, DcDrillRow[]> = {}
  const ensureAgg = (closerKey: string): DcAggregate => {
    let agg = byCloser.get(closerKey)
    if (!agg) {
      agg = emptyDcAggregate(closerKey, nameByKey.get(closerKey) ?? closerKey)
      byCloser.set(closerKey, agg)
      drillByCloser[closerKey] = []
    }
    return agg
  }
  for (const m of Array.from(meetings.values())) {
    const agg = ensureAgg(m.closerKey)
    agg.meetings++
    if (m.hasForm) agg.shows++
    if (m.row.closed) {
      agg.closes++
      if (m.row.base44Monthly) agg.base44Monthly++
      if (m.row.base44Yearly) agg.base44Yearly++
      if (m.row.wixMonthly) agg.wixMonthly++
      if (m.row.wixYearly) agg.wixYearly++
    }
    drillByCloser[m.closerKey].push(m.row)
  }

  // Attach dials per closer; a closer with dials but no meetings still shows.
  for (const c of closers) {
    const dials = dialsByUser.get(c.closeUserId) ?? 0
    if (dials === 0 && !byCloser.has(c.closeUserId)) continue
    ensureAgg(c.closeUserId).dials = dials
  }

  // Sort drill rows most-recent first.
  for (const key of Object.keys(drillByCloser)) {
    drillByCloser[key].sort((a, b) =>
      (a.scheduledTime ?? '') < (b.scheduledTime ?? '') ? 1 : (a.scheduledTime ?? '') > (b.scheduledTime ?? '') ? -1 : 0,
    )
  }

  const closersOut = Array.from(byCloser.values()).sort((a, b) => b.meetings - a.meetings)
  const aggregate = closersOut.reduce<DcAggregate>((acc, c) => ({
    closerKey: '',
    closerName: 'All DC closers',
    dials: acc.dials + c.dials,
    meetings: acc.meetings + c.meetings,
    shows: acc.shows + c.shows,
    base44Monthly: acc.base44Monthly + c.base44Monthly,
    base44Yearly: acc.base44Yearly + c.base44Yearly,
    wixMonthly: acc.wixMonthly + c.wixMonthly,
    wixYearly: acc.wixYearly + c.wixYearly,
    closes: acc.closes + c.closes,
  }), emptyDcAggregate('', 'All DC closers'))

  return { closers: closersOut, aggregate, drillByCloser }
}
