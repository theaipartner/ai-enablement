import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { SetterCallReviewFull } from './setter-calls'
import type { BookingType } from './leads'
import { DIRECT_BOOKING_EVENT_TYPE_URI } from './funnel-calendly'

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
  | { kind: 'optin'; at: string }
  | { kind: 'form'; at: string; source: 'triage' | 'confirmation' | 'closer' | 'dc'; label: string; by: string | null }
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
  primaryCallerName: string | null
  calls: LeadCallEntry[]
  // Lifecycle timeline, newest first, scoped from the latest opt-in.
  timeline: LeadTimelineEvent[]
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
  // Lifecycle window: scope dials/connected to the latest opt-in onward.
  const sinceIso = lead.latest_opt_in_date ?? null

  // 2. Full call history for this lead (both directions), newest first.
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
    let q = sb
      .from('close_calls' as never)
      .select('close_id, activity_at, duration, direction, user_id, raw_payload')
      .eq('lead_id' as never, closeId)
    if (sinceIso) q = q.gte('activity_at', sinceIso)
    const { data, error } = await q
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
  for (let i = 0; i < callIds.length; i += 100) {
    const chunk = callIds.slice(i, i + 100)
    const [{ data: trx, error: trxErr }, { data: rev, error: revErr }] = await Promise.all([
      sb
        .from('setter_call_transcripts' as never)
        .select('close_call_id')
        .in('close_call_id' as never, chunk),
      sb
        .from('setter_call_reviews' as never)
        .select(
          'close_call_id, sentiment, lead_score, lead_score_reason, should_be_dqd, ' +
            'dq_reason, booked, no_book_reason, setter_strengths, setter_weaknesses, ' +
            'lead_attributes, setter_words, prospect_words, talk_ratio_setter, ' +
            'model, prompt_version, reviewed_at',
        )
        .in('close_call_id' as never, chunk),
    ])
    if (trxErr) throw new Error(`lead-detail: transcripts read failed: ${trxErr.message}`)
    if (revErr) throw new Error(`lead-detail: reviews read failed: ${revErr.message}`)
    for (const t of (trx ?? []) as unknown as Array<{ close_call_id: string }>) {
      transcriptSet.add(t.close_call_id)
    }
    for (const r of (rev ?? []) as unknown as Array<{ close_call_id: string } & SetterCallReviewFull>) {
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
  for (let i = 0; i < userIds.length; i += 100) {
    const chunk = userIds.slice(i, i + 100)
    const { data, error } = await sb
      .from('team_members' as never)
      .select('close_user_id, full_name')
      .in('close_user_id' as never, chunk)
    if (error) throw new Error(`lead-detail: team_members read failed: ${error.message}`)
    for (const m of (data ?? []) as unknown as Array<{ close_user_id: string; full_name: string }>) {
      nameByUser.set(m.close_user_id, m.full_name)
    }
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

  const connected = calls.filter((c) => c.connected)
  const totalConnectedDurationSec = connected.reduce((sum, c) => sum + c.durationSec, 0)
  // Primary caller = setter on the most recent connected call (else the
  // most recent call overall).
  const primaryCallerName =
    connected.find((c) => c.setterName)?.setterName ??
    calls.find((c) => c.setterName)?.setterName ??
    null

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
  for (let i = 0; i < eventUris.length; i += 100) {
    const chunk = eventUris.slice(i, i + 100)
    const { data, error } = await sb
      .from('calendly_scheduled_events' as never)
      .select('uri, name, event_type_uri, start_time, event_created_at')
      .in('uri', chunk)
    if (error) throw new Error(`lead-detail: events read failed: ${error.message}`)
    for (const e of (data ?? []) as unknown as Array<{ uri: string; name: string; event_type_uri: string | null; start_time: string | null; event_created_at: string | null }>) {
      const nm = norm(e.name)
      let link: 'direct' | 'setter' | 'sync' | 'other' = 'other'
      if (e.event_type_uri === DIRECT_BOOKING_EVENT_TYPE_URI) { hasDirect = true; link = 'direct' }
      else if (nm.startsWith('partnership call w/')) {
        hasPartnership = true; link = 'setter'
        if (e.event_created_at) partnershipCreatedTimes.push(e.event_created_at)
      }
      else if (nm.startsWith('ai partner sync')) { followUpCount++; link = 'sync' }
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
  const formEvents: Array<{ at: string; winAt: string | null; label: string; source: 'triage' | 'confirmation' | 'closer' | 'dc'; by: string | null }> = []
  {
    const { data, error } = await sb
      .from('airtable_setter_triage_calls' as never)
      .select('call_status, form_type, event_date_time, confirmed_call_date_time, booked_at, submitted_at, setter_names, airtable_created_at')
      .eq('lead_id', closeId)
    if (error) throw new Error(`lead-detail: triage forms read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{
      call_status: string | null; form_type: string | null
      event_date_time: string | null; confirmed_call_date_time: string | null
      booked_at: string | null; submitted_at: string | null
      setter_names: string[] | null; airtable_created_at: string | null
    }>) {
      const isConfirmation = r.form_type === 'Closer Triage Form'
      const cs = norm(r.call_status)
      if (isConfirmation && cs.startsWith('confirmed')) confirmed = true
      if (cs.includes('dq')) isDq = true
      if (isConfirmation) {
        if (cs && !cs.includes('unresponsive') && !cs.includes('handover')) confirmReached = true
      } else {
        setterTriaged = true
      }
      // Order by the meeting time itself, falling back through the form's other
      // timestamps. submitted_at is a bare date — anchor it at UTC midnight so
      // it sorts as an instant.
      const at =
        r.event_date_time ??
        r.confirmed_call_date_time ??
        r.booked_at ??
        (r.submitted_at ? `${r.submitted_at}T00:00:00Z` : null)
      if (!isConfirmation && afterReact(at)) reactTriaged = true
      if (at && r.call_status) {
        // Filler: setter_names holds the form's author for both the setter
        // triage and the confirmation (the confirming closer, e.g. "Aman Ali").
        const by = (r.setter_names ?? []).find((n) => typeof n === 'string' && n.trim() && n.trim().toLowerCase() !== 'no setter') ?? null
        formEvents.push({ at, winAt: r.airtable_created_at, label: r.call_status, source: isConfirmation ? 'confirmation' : 'triage', by })
      }
    }
  }
  {
    type CForm = { call_outcome: string | null; date_time_of_call: string | null; airtable_created_at: string | null; closer_names: string[] | null }
    const { data, error } = await sb
      .from('airtable_full_closer_report' as never)
      .select('call_outcome, date_time_of_call, airtable_created_at, closer_names')
      .eq('form_type', 'New')
      .eq('lead_id', closeId)
    if (error) throw new Error(`lead-detail: closer forms read failed: ${error.message}`)
    const forms = ((data ?? []) as unknown as CForm[]).filter((r) => r.call_outcome)
    for (const r of forms) {
      if (norm(r.call_outcome).includes('dq')) isDq = true
      const post = afterReact(r.airtable_created_at)
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
      formEvents.push({ at: latest.date_time_of_call, winAt: latest.airtable_created_at, label: latest.call_outcome as string, source: 'closer', by })
      const ct = outcomeCloseType(latest.call_outcome)
      if (ct) considerClose(ct, { closer: by, plans: [], at: latest.date_time_of_call })
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
    }
    const { data, error } = await sb
      .from('airtable_digital_college_sales' as never)
      .select('closed, follow_up, plans, closer_names, date_time_of_call, airtable_created_at')
      .is('excluded_at', null)
      .eq('lead_id', closeId)
    if (error) throw new Error(`lead-detail: digital college sales read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as DcForm[]) {
      const isBlank = !r.closed && (r.plans ?? []).length === 0
      if (isBlank) continue
      const at = r.date_time_of_call ?? r.airtable_created_at
      const closer = (r.closer_names ?? []).find((n) => typeof n === 'string' && n.trim()) ?? null
      const isClosed = norm(r.closed) === 'yes'
      const isDqForm = norm(r.follow_up) === 'no'
      if (isDqForm) isDq = true
      const post = afterReact(at)
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
      // Timeline label: the DC disposition.
      const label = isClosed ? 'Digital College closed' : isDqForm ? 'Digital College DQ' : 'Digital College follow-up'
      if (at) formEvents.push({ at, winAt: r.airtable_created_at, label, source: 'dc', by: closer })
    }
  }

  // 8. Lifecycle timeline — opt-in anchor + every form outcome + the trailing
  //    follow-up (AI Partner Sync) booking, scoped to the latest opt-in and
  //    sorted oldest-first (reads as the lead's journey top-to-bottom). No
  //    close_calls — see the LeadTimelineEvent note.
  const inWindow = (at: string) => !sinceIso || at >= sinceIso
  const timeline: LeadTimelineEvent[] = []
  if (sinceIso) timeline.push({ kind: 'optin', at: sinceIso })
  for (const f of formEvents) {
    // Show a form when its event time OR its filed time falls in the current
    // journey — a form filed after the latest opt-in belongs to this journey
    // even if its meeting time slightly predates the opt-in instant.
    if (inWindow(f.at) || (f.winAt != null && inWindow(f.winAt))) {
      timeline.push({ kind: 'form', at: f.at, source: f.source, label: f.label, by: f.by })
    }
  }
  for (const b of bookings) {
    if (b.link === 'sync' && inWindow(b.at)) timeline.push({ kind: 'followup', at: b.at, name: b.name })
  }
  timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0))

  // Reactive-phase connected/booked — a ≥90s outbound dial / partnership
  // booking after the handover. (Calls are already loaded since latest opt-in,
  // which precedes reactivation, so post-handover calls are present.)
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

  return {
    leadId: lead.close_id,
    prospectName: lead.display_name,
    dateCreated: lead.date_created,
    dateFirstOptedIn: lead.date_first_opted_in,
    latestOptInDate: lead.latest_opt_in_date,
    numberOfOptIns: lead.number_of_opt_ins,
    qualified: qualFromMarketingQualified(lead.marketing_qualified),
    reactivatedAt: lead.reactivated_at,
    bookingType,
    confirmed,
    showed,
    closed,
    closeType,
    closeDetail,
    connected: isConnected,
    isDq,
    reactConnected,
    reactBooked,
    reactShowed,
    reactClosed,
    directShowed,
    directClosed,
    totalCalls: calls.length,
    connectedCount: connected.length,
    totalConnectedDurationSec,
    rescheduleCount,
    followUpCount,
    primaryCallerName,
    calls,
    timeline,
  }
}
