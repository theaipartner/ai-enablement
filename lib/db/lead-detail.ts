import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { SetterCallReviewFull } from './setter-calls'
import type { BookingType } from './leads'
import { DIRECT_BOOKING_EVENT_TYPE_URI } from './funnel-calendly'
import { getLeadCycles, deriveType, type CycleStages } from './lead-tags'
import { fetchChunked } from './query-parallel'

// Per-lead detail (the /sales-dashboard/leads/[close_id] page). Pulls one
// Close lead's identity + opt-in facts, its FULL call history (both
// directions), and each call's setter-call review when one exists. The
// page renders the calls collapsed-by-default, expanding to the review.
//
// Reviews + transcripts only exist for transcribed setter calls (>=90s,
// since the 2026-05-24 horizon) — older / sub-90s / closer calls show as
// rows with no review. That's inherent to the upstream data, not a gap
// here. Closing-call info is a future addition (stubbed on the page).

export type Qualification = 'qualified' | 'non-qualified' | 'unknown'

export type LeadCallEntry = {
  closeCallId: string
  activityAt: string             // ISO UTC
  durationSec: number
  direction: string | null       // 'inbound' | 'outbound' | null
  connected: boolean             // duration >= 90s
  setterName: string | null
  // True when a transcript landed for this call → the per-call detail
  // page (/sales-dashboard/calls/[id]) has audio/transcript to show.
  hasTranscript: boolean
  // The Sonnet review, when it has run. null = no review (not transcribed
  // yet, or sub-90s / closer call that never gets one).
  review: SetterCallReviewFull | null
}

// One row in the lifecycle timeline (chronological, oldest first). The
// lifecycle is form-driven: the opt-in anchor, every Airtable form outcome
// (setter triage / confirmation / closer EOC) in order, and the trailing
// follow-up booking. Close dials/connected calls are intentionally excluded —
// the forms carry only `lead_id` (no call id / Calendly URI), so there's no
// reliable form↔call↔booking link on the current stack and interleaving calls
// would be guesswork.
export type LeadTimelineEvent =
  | { kind: 'optin'; at: string; reopt: boolean }   // reopt = the latest re-opt-in divider
  | { kind: 'form'; at: string; source: 'triage' | 'confirmation' | 'closer' | 'dc'; label: string; by: string | null; notes: string | null }
  | { kind: 'followup'; at: string; name: string }

// Close details surfaced on the per-lead page when the lead has closed.
export type LeadCloseDetail = {
  offer: 'ht' | 'dc'
  closer: string | null
  plans: string[]          // DC plan multi-select (Base44 / Wix × Mo/Yr); [] for HT
  at: string | null        // meeting time of the close
}

export type LeadDetail = {
  leadId: string
  prospectName: string | null
  dateCreated: string | null
  dateFirstOptedIn: string | null
  latestOptInDate: string | null
  numberOfOptIns: number | null
  qualified: Qualification
  // Reactivation tag (close_leads.reactivated_at). Set once when a direct lead
  // lost its strat spot (handover / ghost / cancel — see migration 0063/0064).
  // null = not reactivated.
  reactivatedAt: string | null
  // Booking path (ever) + per-lead funnel stages, same source/logic as the
  // leads roster + funnel boxes. booked = bookingType !== null. confirmed /
  // showed / closed are the DIRECT-phase stages (and, for a reactivated lead,
  // include the post-handover show/close — they're originally direct).
  bookingType: BookingType
  confirmed: boolean
  showed: boolean
  closed: boolean
  // Which offer closed ('ht' | 'dc' | null). HT wins if both. Drives the
  // Journey "Closed" label + the Close-details section.
  closeType: 'ht' | 'dc' | null
  closeDetail: LeadCloseDetail | null
  // Connected — the same form-OR-call signal the roster/funnel use: a ≥90s dial,
  // a setter triage form, or a confirmation that reached the lead (any Call
  // Status except "Unresponsive – Setter Handover"). One definition everywhere.
  connected: boolean
  // DQ — any form DQ'd this lead (lifecycle-scoped). Shown as the terminal
  // marker on the journey even though it doesn't reactivate.
  isDq: boolean
  // Reactive-phase stages — only meaningful when reactivatedAt is set. Each is
  // an event AFTER the handover (a ≥90s outbound dial / partnership booking /
  // showed / closed past reactivatedAt). The journey renders these as the
  // second segment; "Eligible" is the floor when none are hit.
  reactConnected: boolean
  reactBooked: boolean
  reactShowed: boolean
  reactClosed: boolean
  // Direct-PHASE show/close — a show/close that happened BEFORE the lead lost
  // its strat spot (or any show/close when never reactivated). The per-lead
  // Journey's Direct lane uses these so a post-handover close lights only the
  // Reactivation lane, not the (frozen) Direct lane. Once a lead is on the
  // reactive path it can't retroactively light the direct path (Drake 2026-05-31).
  directShowed: boolean
  directClosed: boolean
  // Journey metrics. Dials + connected are scoped from the latest opt-in (the
  // lifecycle window). Reschedules + follow-ups are over the lead's bookings.
  totalCalls: number          // dials incl. inbound, since latest opt-in
  connectedCount: number
  totalConnectedDurationSec: number
  rescheduleCount: number     // Calendly invitees flagged rescheduled
  followUpCount: number       // "AI Partner Sync" bookings
  calls: LeadCallEntry[]
  // Lifecycle timeline, newest first, scoped from the latest opt-in.
  timeline: LeadTimelineEvent[]
  // --- Phase 5: journey/status sourced from the persistent tags (lead_cycles /
  // lead_cycle_stages via lead-tags.ts), scoped to the lead's CURRENT (latest)
  // cycle. These supersede the legacy live-compute fields above (confirmed /
  // showed / reactConnected / directShowed / …) for the journey render; those
  // are slated for removal in a follow-up cleanup. ---
  tagIsDirect: boolean          // current cycle has a direct (strat self-book)
  tagReactivatedAt: string | null
  tagIsDq: boolean              // dq tag, not suppressed by an HT close
  tagCloseType: 'ht' | 'dc' | null
  // Per-phase stage hits for the current cycle (already monotonic from the tagger).
  journeyPrimary: { connected: boolean; booked: boolean; confirmed: boolean; showed: boolean; closed: boolean }
  journeyReactive: { connected: boolean; booked: boolean; confirmed: boolean; showed: boolean; closed: boolean } | null
  // EVERY opt-in cycle (oldest-first) for the per-lead Journey — a multi-opt-in
  // lead shows each cycle's progression as its own block (Drake 2026-06-02).
  journeyCycles: Array<{
    optInAt: string
    isDirect: boolean
    reactivatedAt: string | null
    isDq: boolean
    closeType: 'ht' | 'dc' | null
    primary: { connected: boolean; booked: boolean; confirmed: boolean; showed: boolean; closed: boolean }
    reactive: { connected: boolean; booked: boolean; confirmed: boolean; showed: boolean; closed: boolean } | null
  }>
}

function qualFromMarketingQualified(mq: string | null): Qualification {
  const v = (mq ?? '').trim().toLowerCase()
  if (v === 'yes') return 'qualified'
  if (v === 'no') return 'non-qualified'
  return 'unknown'
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

// Mirror leads.ts: showed = attended (any outcome except no-show/reschedule/
// cancel); closed = a full close (Deposit not counted).
function outcomeShowed(co: string | null): boolean {
  const v = norm(co)
  if (!v) return false
  return !(v.includes('ghost') || v.includes('no show') || v.includes('reschedul') || v.includes('cancel'))
}
function outcomeClosed(co: string | null): boolean {
  return outcomeCloseType(co) !== null
}
function outcomeCloseType(co: string | null): 'ht' | 'dc' | null {
  const v = norm(co)
  if (v.includes('high ticket closed')) return 'ht'
  if (v.includes('digital college closed')) return 'dc'
  return null
}

const CONNECTED_SEC = 90

export async function getLeadDetail(closeId: string): Promise<LeadDetail | null> {
  const sb = createAdminClient()

  // 1. Lead identity + opt-in facts.
  const { data: leadData, error: leadErr } = await sb
    .from('close_leads' as never)
    .select(
      'close_id, display_name, date_created, date_first_opted_in, ' +
        'latest_opt_in_date, number_of_opt_ins, marketing_qualified, contacts, utm_term, reactivated_at',
    )
    .eq('close_id' as never, closeId)
    .maybeSingle()
  if (leadErr) throw new Error(`lead-detail: close_leads read failed: ${leadErr.message}`)
  if (!leadData) return null
  const lead = leadData as unknown as {
    close_id: string
    display_name: string | null
    date_created: string | null
    date_first_opted_in: string | null
    latest_opt_in_date: string | null
    number_of_opt_ins: number | null
    marketing_qualified: string | null
    contacts: unknown
    utm_term: string | null
    reactivated_at: string | null
  }

  // Lead identity for matching Calendly bookings (email / utm_term / name).
  const leadEmails = new Set<string>()
  if (Array.isArray(lead.contacts)) {
    for (const c of lead.contacts as Array<{ emails?: Array<{ email?: string }> }>) {
      for (const e of c.emails ?? []) {
        const n = norm(e?.email)
        if (n) leadEmails.add(n)
      }
    }
  }
  const leadNameLc = norm(lead.display_name)
  // Current-journey boundary = the latest opt-in. The JOURNEY (stage chips +
  // header stats) resets here — only activity at/after the latest opt-in
  // counts, mirroring the roster in leads.ts so a prior journey's progress
  // doesn't carry into a re-opt-in. The LIFECYCLE below, by contrast, shows the
  // FULL history (old journey → re-opt-in → new journey).
  const sinceIso = lead.latest_opt_in_date ?? null
  const optInMs = sinceIso ? new Date(sinceIso).getTime() : null
  // In the current journey when at/after the latest opt-in (or no opt-in known).
  const afterOptIn = (iso: string | null): boolean =>
    optInMs == null || (iso != null && new Date(iso).getTime() >= optInMs)
  // A form belongs to the current journey if its event OR its filed time is
  // at/after the latest opt-in (same event-OR-filed leniency as the lifecycle).
  const inCycle = (eventAt: string | null, filedAt: string | null): boolean =>
    afterOptIn(eventAt) || afterOptIn(filedAt)

  // 2. Full call history for this lead (both directions), newest first. We fetch
  //    ALL calls (no opt-in window) for the lifecycle; the current-journey
  //    subset for the header stats is filtered out below.
  type CallRaw = {
    close_id: string
    activity_at: string
    duration: number | null
    direction: string | null
    user_id: string | null
    raw_payload: { user_name?: string } | null
  }
  const callRows: CallRaw[] = []
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('close_calls' as never)
      .select('close_id, activity_at, duration, direction, user_id, raw_payload')
      .eq('lead_id' as never, closeId)
      .order('activity_at', { ascending: false })
      .range(from, from + 999)
    if (error) throw new Error(`lead-detail: close_calls read failed: ${error.message}`)
    const rows = (data ?? []) as unknown as CallRaw[]
    if (rows.length === 0) break
    callRows.push(...rows)
    if (rows.length < 1000) break
    from += 1000
  }

  const callIds = callRows.map((c) => c.close_id)

  // 3. Which calls have a transcript, and their reviews.
  const transcriptSet = new Set<string>()
  const reviewByCall = new Map<string, SetterCallReviewFull>()
  {
    // Both reads chunk over the same partitioned callIds (unique keys), so the
    // chunks run concurrently and the two queries run alongside each other.
    const [trxRows, revRows] = await Promise.all([
      fetchChunked<{ close_call_id: string }>(
        callIds,
        (chunk) => sb
          .from('setter_call_transcripts' as never)
          .select('close_call_id')
          .in('close_call_id' as never, chunk) as never,
        'lead-detail: transcripts read failed',
        100,
      ),
      fetchChunked<{ close_call_id: string } & SetterCallReviewFull>(
        callIds,
        (chunk) => sb
          .from('setter_call_reviews' as never)
          .select(
            'close_call_id, sentiment, lead_score, lead_score_reason, should_be_dqd, ' +
              'dq_reason, call_type, booked, no_book_reason, closed, no_close_reason, ' +
              'setter_strengths, setter_weaknesses, ' +
              'lead_attributes, setter_words, prospect_words, talk_ratio_setter, ' +
              'model, prompt_version, reviewed_at',
          )
          .in('close_call_id' as never, chunk) as never,
        'lead-detail: reviews read failed',
        100,
      ),
    ])
    for (const t of trxRows) transcriptSet.add(t.close_call_id)
    for (const r of revRows) {
      const { close_call_id, ...review } = r
      reviewByCall.set(close_call_id, review)
    }
  }

  // 4. Setter names — team_members by close_user_id, falling back to the
  //    call's raw_payload.user_name when the user isn't a known member.
  const userIds = Array.from(
    new Set(callRows.map((c) => c.user_id).filter((u): u is string => !!u)),
  )
  const nameByUser = new Map<string, string>()
  {
    // close_user_id partitioned across chunks → unique keys, order-independent.
    const members = await fetchChunked<{ close_user_id: string; full_name: string }>(
      userIds,
      (chunk) => sb
        .from('team_members' as never)
        .select('close_user_id, full_name')
        .in('close_user_id' as never, chunk) as never,
      'lead-detail: team_members read failed',
      100,
    )
    for (const m of members) nameByUser.set(m.close_user_id, m.full_name)
  }
  const resolveSetter = (c: CallRaw): string | null => {
    if (c.user_id && nameByUser.has(c.user_id)) return nameByUser.get(c.user_id) ?? null
    return c.raw_payload?.user_name ?? null
  }

  // 5. Assemble call entries + aggregates.
  const calls: LeadCallEntry[] = callRows.map((c) => ({
    closeCallId: c.close_id,
    activityAt: c.activity_at,
    durationSec: c.duration ?? 0,
    direction: c.direction,
    connected: (c.duration ?? 0) >= CONNECTED_SEC,
    setterName: resolveSetter(c),
    hasTranscript: transcriptSet.has(c.close_id),
    review: reviewByCall.get(c.close_id) ?? null,
  }))

  // Current-journey calls drive the header stats + connected status (the
  // journey reset); the lifecycle renders the full `calls` list.
  const cycleCalls = calls.filter((c) => afterOptIn(c.activityAt))
  const connected = cycleCalls.filter((c) => c.connected)
  const totalConnectedDurationSec = connected.reduce((sum, c) => sum + c.durationSec, 0)

  // 6. Calendly bookings — this lead's invitees (by email, then name),
  //    classified by link family. Reschedules = invitees flagged rescheduled;
  //    follow-ups = "AI Partner Sync" bookings.
  const inviteeByUri = new Map<string, { eventUri: string; rescheduled: boolean }>()
  const addInvitees = (rows: Array<{ uri: string; event_uri: string; rescheduled: boolean | null }>) => {
    for (const r of rows) {
      if (!inviteeByUri.has(r.uri)) inviteeByUri.set(r.uri, { eventUri: r.event_uri, rescheduled: r.rescheduled === true })
    }
  }
  if (leadEmails.size > 0) {
    const { data, error } = await sb
      .from('calendly_invitees' as never)
      .select('uri, event_uri, rescheduled')
      .in('email', Array.from(leadEmails))
    if (error) throw new Error(`lead-detail: invitees (email) read failed: ${error.message}`)
    addInvitees((data ?? []) as unknown as Array<{ uri: string; event_uri: string; rescheduled: boolean | null }>)
  }
  if (leadNameLc) {
    const { data, error } = await sb
      .from('calendly_invitees' as never)
      .select('uri, event_uri, rescheduled')
      .ilike('name', leadNameLc)
    if (error) throw new Error(`lead-detail: invitees (name) read failed: ${error.message}`)
    addInvitees((data ?? []) as unknown as Array<{ uri: string; event_uri: string; rescheduled: boolean | null }>)
  }
  // utm_term token — ONLY safe when the token is unique to this lead. A generic
  // ad term (e.g. "Broad", shared by thousands) would pull in other leads'
  // bookings, so we gate on the same unique-mapping rule as the funnel match.
  if (lead.utm_term) {
    const { data: dup, error: dupErr } = await sb
      .from('close_leads' as never)
      .select('close_id')
      .eq('utm_term', lead.utm_term)
      .limit(2)
    if (dupErr) throw new Error(`lead-detail: utm_term uniqueness read failed: ${dupErr.message}`)
    if (((dup ?? []) as unknown[]).length === 1) {
      const { data, error } = await sb
        .from('calendly_invitees' as never)
        .select('uri, event_uri, rescheduled')
        .eq('raw_payload->tracking->>utm_term', lead.utm_term)
      if (error) throw new Error(`lead-detail: invitees (utm_term) read failed: ${error.message}`)
      addInvitees((data ?? []) as unknown as Array<{ uri: string; event_uri: string; rescheduled: boolean | null }>)
    }
  }
  const rescheduleCount = Array.from(inviteeByUri.values()).filter((i) => i.rescheduled).length

  const eventUris = Array.from(new Set(Array.from(inviteeByUri.values()).map((i) => i.eventUri)))
  let hasDirect = false
  let hasPartnership = false
  let followUpCount = 0
  // Partnership booking created-times — for the reactive-phase "Booked" stage
  // (a partnership booked AFTER the handover). Created-time mirrors the funnel's
  // bookedSince logic (leads.ts), not the meeting start_time.
  const partnershipCreatedTimes: string[] = []
  const bookings: Array<{ at: string; link: 'direct' | 'setter' | 'sync' | 'other'; name: string }> = []
  {
    // uri partitioned across chunks; fetchChunked preserves chunk + row order,
    // so the boolean OR / counter / push-order results are identical.
    const events = await fetchChunked<{ uri: string; name: string; event_type_uri: string | null; start_time: string | null; event_created_at: string | null }>(
      eventUris,
      (chunk) => sb
        .from('calendly_scheduled_events' as never)
        .select('uri, name, event_type_uri, start_time, event_created_at')
        .in('uri', chunk) as never,
      'lead-detail: events read failed',
      100,
    )
    for (const e of events) {
      const nm = norm(e.name)
      let link: 'direct' | 'setter' | 'sync' | 'other' = 'other'
      // Booking type resets on re-opt-in: only bookings created at/after the
      // latest opt-in classify the current journey (mirrors leads.ts
      // bookedSince(optInAt)). The `bookings` array stays full for the lifecycle.
      const bookingInCycle = afterOptIn(e.event_created_at)
      if (e.event_type_uri === DIRECT_BOOKING_EVENT_TYPE_URI) {
        if (bookingInCycle) hasDirect = true
        link = 'direct'
      } else if (nm.startsWith('partnership call w/')) {
        link = 'setter'
        if (bookingInCycle) {
          hasPartnership = true
          if (e.event_created_at) partnershipCreatedTimes.push(e.event_created_at)
        }
      } else if (nm.startsWith('ai partner sync')) { followUpCount++; link = 'sync' }
      if (e.start_time) bookings.push({ at: e.start_time, link, name: e.name })
    }
  }
  const bookingType: BookingType =
    hasDirect && hasPartnership ? 'reactivation' : hasDirect ? 'direct' : hasPartnership ? 'setter' : null

  // 7. Funnel stages + form rows from the lead's forms (by lead_id). The
  //    lifecycle is form-driven, so each form becomes a timeline row: setter
  //    triage / confirmation (airtable_setter_triage_calls) + closer EOC
  //    (airtable_full_closer_report, form_type=New). confirmed/showed/closed
  //    still feed the header stage chip.
  // Reactive phase reference instant (null when never reactivated).
  const reactMs = lead.reactivated_at ? new Date(lead.reactivated_at).getTime() : null
  const afterReact = (iso: string | null): boolean =>
    reactMs != null && iso != null && new Date(iso).getTime() >= reactMs

  let confirmed = false
  let showed = false
  let closed = false
  let isDq = false
  let reactShowed = false
  let reactClosed = false
  // Direct-phase (pre-handover) show/close — see LeadDetail.directShowed.
  let directShowed = false
  let directClosed = false
  // Which offer closed + its details. 'ht' wins over 'dc' if a lead has both.
  let closeType: 'ht' | 'dc' | null = null
  let closeDetail: LeadCloseDetail | null = null
  const considerClose = (
    offer: 'ht' | 'dc',
    detail: { closer: string | null; plans: string[]; at: string | null },
  ) => {
    if (closeType === 'ht') return // ht wins, never downgrade
    if (closeType === 'dc' && offer === 'dc') return // keep first dc
    closeType = offer
    closeDetail = { offer, ...detail }
  }
  // A setter triage form filed after the handover = a post-handover connect
  // (the form-OR-call "connected" signal, reactive phase).
  let reactTriaged = false
  // Form half of the broad "connected": a setter triage form, or a confirmation
  // that reached the lead (any Call Status except Unresponsive – Setter Handover).
  let setterTriaged = false
  let confirmReached = false
  // `at` = the event/meeting time (display + sort). `winAt` = when the form was
  // FILED (airtable_created_at) — used for the lifecycle window so a form filed
  // in the current journey shows even if its event time slightly predates the
  // latest opt-in (Israel Lopez: DQ filed 19:13, event 18:12, opt-in 19:00).
  const formEvents: Array<{ at: string; winAt: string | null; label: string; source: 'triage' | 'confirmation' | 'closer' | 'dc'; by: string | null; notes: string | null }> = []
  // The rep's free-text notes off each form (triage `notes`, closer
  // `call_notes`/`call_notes_lost`, DC `call_notes`). Surfaced on the
  // per-lead lifecycle. Trim + drop empties so a blank field renders nothing.
  const cleanNote = (s: string | null | undefined): string | null => {
    const t = (s ?? '').trim()
    return t === '' ? null : t
  }
  // The three form sources are fetched CONCURRENTLY here, then processed in their
  // original order (triage → closer → dc) in the blocks below — preserving the
  // order-dependent shared writes (formEvents push order, considerClose's
  // first-dc-wins, ht-wins).
  const [triageRes, closerRes, dcRes] = await Promise.all([
    sb
      .from('airtable_setter_triage_calls' as never)
      .select('call_status, form_type, event_date_time, confirmed_call_date_time, booked_at, submitted_at, setter_names, airtable_created_at, notes')
      .eq('lead_id', closeId),
    sb
      .from('airtable_full_closer_report' as never)
      .select('call_outcome, date_time_of_call, airtable_created_at, closer_names, call_notes, call_notes_lost')
      .eq('form_type', 'New')
      .eq('lead_id', closeId),
    sb
      .from('airtable_digital_college_sales' as never)
      .select('closed, follow_up, plans, closer_names, date_time_of_call, airtable_created_at, call_notes')
      .is('excluded_at', null)
      .eq('lead_id', closeId),
  ])
  {
    const { data, error } = triageRes
    if (error) throw new Error(`lead-detail: triage forms read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{
      call_status: string | null; form_type: string | null
      event_date_time: string | null; confirmed_call_date_time: string | null
      booked_at: string | null; submitted_at: string | null
      setter_names: string[] | null; airtable_created_at: string | null
      notes: string | null
    }>) {
      const isConfirmation = r.form_type === 'Closer Triage Form'
      const cs = norm(r.call_status)
      // Order by the meeting time itself, falling back through the form's other
      // timestamps. submitted_at is a bare date — anchor it at UTC midnight so
      // it sorts as an instant.
      const at =
        r.event_date_time ??
        r.confirmed_call_date_time ??
        r.booked_at ??
        (r.submitted_at ? `${r.submitted_at}T00:00:00Z` : null)
      // Status flags only count toward the CURRENT journey (reset on re-opt-in);
      // the form still shows in the full lifecycle below regardless.
      if (inCycle(at, r.airtable_created_at)) {
        if (isConfirmation && cs.startsWith('confirmed')) confirmed = true
        if (cs.includes('dq')) isDq = true
        if (isConfirmation) {
          if (cs && !cs.includes('unresponsive') && !cs.includes('handover')) confirmReached = true
        } else {
          setterTriaged = true
        }
        if (!isConfirmation && afterReact(at)) reactTriaged = true
      }
      if (at && r.call_status) {
        // Filler: setter_names holds the form's author for both the setter
        // triage and the confirmation (the confirming closer, e.g. "Aman Ali").
        const by = (r.setter_names ?? []).find((n) => typeof n === 'string' && n.trim() && n.trim().toLowerCase() !== 'no setter') ?? null
        formEvents.push({ at, winAt: r.airtable_created_at, label: r.call_status, source: isConfirmation ? 'confirmation' : 'triage', by, notes: cleanNote(r.notes) })
      }
    }
  }
  {
    type CForm = { call_outcome: string | null; date_time_of_call: string | null; airtable_created_at: string | null; closer_names: string[] | null; call_notes: string | null; call_notes_lost: string | null }
    const { data, error } = closerRes
    if (error) throw new Error(`lead-detail: closer forms read failed: ${error.message}`)
    const forms = ((data ?? []) as unknown as CForm[]).filter((r) => r.call_outcome)
    for (const r of forms) {
      // Reset on re-opt-in: a prior journey's closer form doesn't feed the
      // current journey's status (it still appears in the lifecycle below).
      if (!inCycle(r.date_time_of_call, r.airtable_created_at)) continue
      if (norm(r.call_outcome).includes('dq')) isDq = true
      // Post-handover if the meeting OR the filing is at/after reactivation —
      // the reactivation stamp is a coarse daily tag, so a meeting hours before
      // it that was filed after still belongs to the reactive phase.
      const post = afterReact(r.date_time_of_call) || afterReact(r.airtable_created_at)
      if (outcomeShowed(r.call_outcome)) {
        showed = true
        if (post) reactShowed = true
        else directShowed = true
      }
      if (outcomeClosed(r.call_outcome)) {
        closed = true
        if (post) reactClosed = true
        else directClosed = true
      }
    }
    // Dedup duplicate forms for the SAME meeting (within 90 min) — keep the
    // latest-submitted. Distinct reschedule forms (different meeting times) stay
    // as separate rows, so a "rescheduled → rescheduled → closed" sequence shows
    // all three.
    const withTime = forms.filter((r): r is CForm & { date_time_of_call: string } => !!r.date_time_of_call)
    withTime.sort((a, b) => (a.date_time_of_call < b.date_time_of_call ? -1 : 1))
    const CLUSTER_MS = 90 * 60 * 1000
    const clusters: (CForm & { date_time_of_call: string })[][] = []
    for (const r of withTime) {
      const last = clusters[clusters.length - 1]
      if (last && Math.abs(new Date(r.date_time_of_call).getTime() - new Date(last[0].date_time_of_call).getTime()) <= CLUSTER_MS) last.push(r)
      else clusters.push([r])
    }
    for (const group of clusters) {
      const latest = group.reduce((best, r) => ((r.airtable_created_at ?? '') > (best.airtable_created_at ?? '') ? r : best))
      const by = (latest.closer_names ?? []).find((n) => typeof n === 'string' && n.trim()) ?? null
      // Closer EOC carries two free-text fields: general call_notes and the
      // lost-call objection notes. Merge both (non-empty, blank-line joined)
      // into one notes block for the lifecycle.
      const closerNotes =
        [cleanNote(latest.call_notes), cleanNote(latest.call_notes_lost)]
          .filter((n): n is string => n !== null)
          .join('\n\n') || null
      formEvents.push({ at: latest.date_time_of_call, winAt: latest.airtable_created_at, label: latest.call_outcome as string, source: 'closer', by, notes: closerNotes })
      const ct = outcomeCloseType(latest.call_outcome)
      // Only the current journey's close drives closeType/closeDetail.
      if (ct && inCycle(latest.date_time_of_call, latest.airtable_created_at)) {
        considerClose(ct, { closer: by, plans: [], at: latest.date_time_of_call })
      }
    }
  }

  // 7b. Digital College sales (Robby's dedicated low-ticket form). A filed form
  //     = showed (no no-show field); Closed?=Yes = a DC close; Follow Up? = No =
  //     DQ (mis-built field — see funnel-digital-college.ts). Each form is a
  //     timeline row (source 'dc'); showed/closed feed the journey monotonically.
  {
    type DcForm = {
      closed: string | null; follow_up: string | null; plans: string[] | null
      closer_names: string[] | null; date_time_of_call: string | null; airtable_created_at: string | null
      call_notes: string | null
    }
    const { data, error } = dcRes
    if (error) throw new Error(`lead-detail: digital college sales read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as DcForm[]) {
      const isBlank = !r.closed && (r.plans ?? []).length === 0
      if (isBlank) continue
      const at = r.date_time_of_call ?? r.airtable_created_at
      const closer = (r.closer_names ?? []).find((n) => typeof n === 'string' && n.trim()) ?? null
      const isClosed = norm(r.closed) === 'yes'
      const isDqForm = norm(r.follow_up) === 'no'
      // Status flags only count toward the current journey (reset on re-opt-in);
      // the form still shows in the full lifecycle below.
      if (inCycle(r.date_time_of_call, r.airtable_created_at)) {
        if (isDqForm) isDq = true
        // Post-handover if the meeting OR the filing is at/after reactivation
        // (same coarse-stamp reasoning as the closer report above) — Richard
        // Harper: DC meeting 17:27, reactivated 19:00, filed next day → reactive.
        const post = afterReact(r.date_time_of_call) || afterReact(r.airtable_created_at)
        // A filed form = showed.
        showed = true
        if (post) reactShowed = true
        else directShowed = true
        if (isClosed) {
          closed = true
          if (post) reactClosed = true
          else directClosed = true
          considerClose('dc', { closer, plans: r.plans ?? [], at: r.date_time_of_call })
        }
      }
      // Timeline label: the DC disposition.
      const label = isClosed ? 'Digital College closed' : isDqForm ? 'Digital College DQ' : 'Digital College follow-up'
      if (at) formEvents.push({ at, winAt: r.airtable_created_at, label, source: 'dc', by: closer, notes: cleanNote(r.call_notes) })
    }
  }

  // 8. Lifecycle timeline — the FULL history (every form outcome + follow-up
  //    booking, no opt-in window), with an opt-in marker for the original opt-in
  //    and the latest re-opt-in so a re-opt-in lead reads old journey → re-opt-in
  //    → new journey top-to-bottom. The calls (also full history) are merged in
  //    by the page. Sorted oldest-first.
  const reopted = (lead.number_of_opt_ins ?? 1) > 1
  const timeline: LeadTimelineEvent[] = []
  // Original opt-in marker (only when there's been a re-opt-in — otherwise the
  // single opt-in below covers it). date_first_opted_in is a bare date; anchor
  // at noon UTC so it renders on its own ET day (ADR 0003).
  if (reopted && lead.date_first_opted_in) {
    const firstIso = lead.date_first_opted_in.length <= 10
      ? `${lead.date_first_opted_in}T12:00:00Z`
      : lead.date_first_opted_in
    timeline.push({ kind: 'optin', at: firstIso, reopt: false })
  }
  // Latest opt-in marker — flagged as the re-opt-in when the lead opted in >1×.
  if (sinceIso) timeline.push({ kind: 'optin', at: sinceIso, reopt: reopted })
  for (const f of formEvents) {
    timeline.push({ kind: 'form', at: f.at, source: f.source, label: f.label, by: f.by, notes: f.notes })
  }
  for (const b of bookings) {
    if (b.link === 'sync') timeline.push({ kind: 'followup', at: b.at, name: b.name })
  }
  timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  // Reactive-phase connected/booked — a ≥90s outbound dial / partnership
  // booking after the handover. Calls are the full history; afterReact scopes
  // to post-handover.
  const reactConnected =
    reactTriaged ||
    calls.some((c) => c.connected && c.direction === 'outbound' && afterReact(c.activityAt))

  // Effective connected — the general "did we reach them": a ≥90s call, a setter
  // triage form, a confirmation that reached them, a setter/reactive booking, or
  // a show/close. A pure direct (self-booked) booking does NOT count.
  // (connected[] above is the ≥90s-call list, used only for talk-time.)
  const isConnected =
    connected.length > 0 || setterTriaged || confirmReached || hasPartnership || showed || closed
  const reactBooked = partnershipCreatedTimes.some((t) => afterReact(t))

  // Phase 5 — journey/status/connected/opt-in dates from the persistent tags
  // (the source of truth), scoped to the CURRENT cycle. getLeadCycles returns
  // newest-first, so [0] is the latest cycle and the last entry is the earliest.
  const tagCycles = await getLeadCycles(closeId)
  const tagCyc = tagCycles[0] ?? null
  const tP = tagCyc?.primary ?? null
  const tR = tagCyc?.reactive ?? null
  const hits = (s: CycleStages | null) => ({
    connected: !!s?.connectedAt,
    booked: !!s?.bookedAt,
    confirmed: !!s?.confirmedAt,
    showed: !!s?.showedAt,
    closed: !!s?.closedAt,
  })
  const tagFirstOptIn = tagCycles.length ? tagCycles[tagCycles.length - 1].optInAt : null
  const tagLatestOptIn = tagCycles.length ? tagCycles[0].optInAt : null
  // All cycles, oldest-first, each as its own journey block for the per-lead page.
  const journeyCycles = tagCycles
    .slice()
    .sort((a, b) => a.optInAt.localeCompare(b.optInAt))
    .map((c) => ({
      optInAt: c.optInAt,
      isDirect: !!c.becameDirectAt,
      reactivatedAt: c.reactivatedAt,
      isDq: deriveType(c).isDq,
      closeType: c.primary?.closeType || c.reactive?.closeType || null,
      primary: hits(c.primary),
      reactive: c.reactive ? hits(c.reactive) : null,
    }))

  return {
    leadId: lead.close_id,
    prospectName: lead.display_name,
    dateCreated: lead.date_created,
    // First/latest opt-in now read from the tags (identical for single-opt-in
    // leads — kills the old Close-vs-Typeform drift). Fall back to Close only
    // when the lead has no cycle yet.
    dateFirstOptedIn: tagFirstOptIn ?? lead.date_first_opted_in,
    latestOptInDate: tagLatestOptIn ?? lead.latest_opt_in_date,
    numberOfOptIns: tagCycles.length || lead.number_of_opt_ins,
    qualified: qualFromMarketingQualified(lead.marketing_qualified),
    // Reactivation now from the tag (not the dormant close_leads.reactivated_at).
    reactivatedAt: tagCyc?.reactivatedAt ?? null,
    bookingType,
    confirmed,
    showed,
    closed,
    closeType,
    closeDetail,
    // Connected from the tag (current cycle, either phase) when tagged.
    connected: tagCyc ? !!(tP?.connectedAt || tR?.connectedAt) : isConnected,
    // A close overrides a DQ — a closed lead is no longer DQ even if an earlier
    // form DQ'd them (Drake 2026-05-31, e.g. Jason Bright).
    isDq: isDq && !closed,
    reactConnected,
    reactBooked,
    reactShowed,
    reactClosed,
    directShowed,
    directClosed,
    // Phase 5 tag-sourced journey/status (the render reads these).
    tagIsDirect: !!tagCyc?.becameDirectAt,
    tagReactivatedAt: tagCyc?.reactivatedAt ?? null,
    tagIsDq: tagCyc ? deriveType(tagCyc).isDq : false,
    tagCloseType: tagCyc ? (tP?.closeType || tR?.closeType || null) : null,
    journeyPrimary: hits(tP),
    journeyReactive: tR ? hits(tR) : null,
    journeyCycles,
    // Header stats reflect the CURRENT journey (since the latest opt-in); the
    // lifecycle (`calls`) shows the full history.
    totalCalls: cycleCalls.length,
    connectedCount: connected.length,
    totalConnectedDurationSec,
    rescheduleCount,
    followUpCount,
    calls,
    timeline,
  }
}
