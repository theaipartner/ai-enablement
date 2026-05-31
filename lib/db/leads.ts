import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'
import {
  getSpeedToLeadCohort,
  type SpeedToLeadCohortRow,
  type SpeedToLeadCohortResult,
} from './funnel-appointment-setting'
import { DIRECT_BOOKING_EVENT_TYPE_URI } from './funnel-calendly'
import { buildCalendlyLeadResolver, inviteeUtmTerm, type CalendlyLeadResolver } from './calendly-lead-match'

// Leads list + funnel (the /sales-dashboard/leads page). Built on the
// SAME cohort as the appointment-setting lead list (getSpeedToLeadCohort
// — includes re-opt-ins, and already drops creator-soft-hidden leads) so
// the two can't drift, then enriched with two columns the dial list
// doesn't carry:
//
//   - qualified     — read DIRECTLY off the Close lead's `marketing_qualified`
//                     Yes/No flag (≡ the under/over-$2,000 rule). Close
//                     overwrites it on each opt-in, so a re-opt-in resolves
//                     to its MOST RECENT submission. No Typeform join.
//   - bookingType   — direct / reactivation / setter / null, by which Calendly
//                     link(s) the lead has EVER had (utm_term → email → name).
//   - confirmed / showed / closed — per-lead form signals (confirmation form +
//                     New closer form's Call Outcome).
//
// Returns the rows; the page derives the three funnel counts + the per-lead
// booking tag from them.

export type Qualification = 'qualified' | 'non-qualified' | 'unknown'

// Booking path, by which Calendly link(s) the lead has EVER had:
//   direct       = direct link only ("Ai Partner Strategy Call" self-book)
//   setter       = partnership link only ("Partnership Call w/ …", setter-led)
//   reactivation = BOTH — a direct lead a setter re-booked with a partnership
//                  link after it fell through. Once reactivated, a lead never
//                  reverts to pure direct. (Drake 2026-05-30.)
//   null         = no qualifying booking.
export type BookingType = 'direct' | 'reactivation' | 'setter' | null

export type LeadRow = SpeedToLeadCohortRow & {
  qualified: Qualification
  bookingType: BookingType
  // Per-lead form signals (NOT per-call). The page gates these by bookingType
  // to build each funnel's stages.
  confirmed: boolean // confirmation form (Closer Triage Form) marked confirmed
  showed: boolean    // any New closer form shows attendance
  closed: boolean    // any New closer form is a full close (HT/DC)
  // Membership signals for the leads-page funnel stack (Drake 2026-05-31):
  //   - hasDirect: ever booked the direct strategy-call link → a "direct
  //     booking lead" (includes reactivations).
  //   - hasPartnership: ever booked a setter/partnership link.
  //   - reactivatedAt: close_leads.reactivated_at — set once when a direct lead
  //     lost its strat spot (see migration 0063/0064). null = not reactivated.
  //   - closeTimeIso: the closing closer-form's date_time_of_call (earliest
  //     HT/DC close), used to cap raw dials at the close. null = not closed.
  hasDirect: boolean
  hasPartnership: boolean
  reactivatedAt: string | null
  closeTimeIso: string | null
  // Computed status for the roster Status column (Close's status_label is NOT
  // used — it's inaccurate). leadType drives the colour; statusWord is the
  // lead's furthest-reached funnel stage. Type precedence dq > reactivation >
  // direct > opt-in. Word ladders: direct = Booked/Confirmed/Showed/Closed;
  // opt-in & reactivation = Connected/Booked/Showed/Closed; dq = "DQ". DQ is
  // lifecycle-scoped (a DQ before the latest opt-in doesn't count) so it resets
  // on re-opt-in. Computed each load — cheap over the cohort's already-loaded
  // forms; no stored state to drift.
  leadType: 'direct' | 'optin' | 'reactivation' | 'dq'
  statusWord: string
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

// Booking signals for one Calendly link family, keyed by lead-id (utm_term),
// email, and name — each mapped to the list of booking times (event_created_at)
// for that key. Times let us ask not just "did they ever book this link" but
// "did they book it AFTER their latest opt-in" (the direct/strategy test —
// Drake 2026-05-31: a strat call booked before a re-opt-in shouldn't classify
// the current journey as direct).
type TimedSignals = {
  byLeadId: Map<string, (string | null)[]>
  byEmail: Map<string, (string | null)[]>
  byName: Map<string, (string | null)[]>
}

function pushTime(map: Map<string, (string | null)[]>, key: string, t: string | null): void {
  if (!key) return
  const arr = map.get(key)
  if (arr) arr.push(t)
  else map.set(key, [t])
}

// Pull every scheduled-event (uri + when it was booked) for a link family:
// 'direct' = the exact DIRECT event type; 'partnership' = the setter-led
// "Partnership Call w/ …" name family (one event type per closer, name prefix).
async function fetchEvents(
  sb: ReturnType<typeof createAdminClient>,
  kind: 'direct' | 'partnership',
): Promise<Array<{ uri: string; createdAt: string | null }>> {
  const out: Array<{ uri: string; createdAt: string | null }> = []
  for (let from = 0; ; from += 1000) {
    const base = sb.from('calendly_scheduled_events' as never).select('uri, event_created_at')
    const q =
      kind === 'direct'
        ? base.eq('event_type_uri', DIRECT_BOOKING_EVENT_TYPE_URI)
        : base.ilike('name', 'Partnership Call w/%')
    const { data, error } = await q.range(from, from + 999)
    if (error) throw new Error(`leads: calendly events (${kind}) read failed: ${error.message}`)
    const evs = (data ?? []) as unknown as Array<{ uri: string; event_created_at: string | null }>
    for (const e of evs) out.push({ uri: e.uri, createdAt: e.event_created_at })
    if (evs.length < 1000) break
  }
  return out
}

// Collect lead-id / email / name → booking-time signals from a set of events'
// invitees. Each invitee inherits its event's event_created_at.
async function collectTimedSignals(
  sb: ReturnType<typeof createAdminClient>,
  leadResolver: CalendlyLeadResolver,
  events: Array<{ uri: string; createdAt: string | null }>,
): Promise<TimedSignals> {
  const byLeadId = new Map<string, (string | null)[]>()
  const byEmail = new Map<string, (string | null)[]>()
  const byName = new Map<string, (string | null)[]>()
  const createdByUri = new Map(events.map((e) => [e.uri, e.createdAt]))
  const uris = events.map((e) => e.uri)
  for (let i = 0; i < uris.length; i += 100) {
    const chunk = uris.slice(i, i + 100)
    const { data, error } = await sb
      .from('calendly_invitees' as never)
      .select('email, name, raw_payload, event_uri')
      .in('event_uri', chunk)
    if (error) throw new Error(`leads: calendly invitees read failed: ${error.message}`)
    for (const inv of (data ?? []) as unknown as Array<{
      email: string | null
      name: string | null
      raw_payload: { tracking?: { utm_term?: string | null } | null } | null
      event_uri: string
    }>) {
      const t = createdByUri.get(inv.event_uri) ?? null
      const lid = leadResolver(inviteeUtmTerm(inv.raw_payload))
      if (lid) pushTime(byLeadId, lid, t)
      pushTime(byEmail, norm(inv.email), t)
      pushTime(byName, norm(inv.name), t)
    }
  }
  return { byLeadId, byEmail, byName }
}

// All booking times for a lead across its keys (lead-id, emails, name).
function bookingTimes(sig: TimedSignals, leadId: string, emails: string[], name: string): (string | null)[] {
  const out: (string | null)[] = []
  const a = sig.byLeadId.get(leadId)
  if (a) out.push(...a)
  for (const e of emails) {
    const x = sig.byEmail.get(e)
    if (x) out.push(...x)
  }
  if (name) {
    const y = sig.byName.get(name)
    if (y) out.push(...y)
  }
  return out
}

// Did this lead EVER book via the link family?
function bookedEver(sig: TimedSignals, leadId: string, emails: string[], name: string): boolean {
  return bookingTimes(sig, leadId, emails, name).length > 0
}

// Did this lead book via the link family AT OR AFTER `sinceIso` (its latest
// opt-in)? Used for the direct/strategy test so a stale pre-re-opt-in booking
// doesn't classify the current journey.
function bookedSince(sig: TimedSignals, leadId: string, emails: string[], name: string, sinceIso: string): boolean {
  const since = new Date(sinceIso).getTime()
  if (!Number.isFinite(since)) return bookedEver(sig, leadId, emails, name)
  return bookingTimes(sig, leadId, emails, name).some((t) => t != null && new Date(t).getTime() >= since)
}

// New-form Call Outcome → did they attend the call? Everything except a
// no-show / reschedule / cancel counts as showed (closes, deposit, DQ/Bad
// Fit, and the follow-ups all mean they were on the call).
function outcomeShowed(callOutcome: string | null): boolean {
  const v = (callOutcome ?? '').trim().toLowerCase()
  if (!v) return false
  if (v.includes('ghost') || v.includes('no show') || v.includes('reschedul') || v.includes('cancel')) return false
  return true
}

// New-form Call Outcome → a full close (Deposit is NOT a close).
function outcomeClosed(callOutcome: string | null): boolean {
  const v = (callOutcome ?? '').trim().toLowerCase()
  return v.includes('high ticket closed') || v.includes('digital college closed')
}

export async function getLeadsForRange(
  range: DateRange,
  // Optional pre-fetched cohort — the leads page already fetches it for the
  // speed-to-lead boxes, so passing it in avoids a duplicate full cohort scan
  // (~48k close_sms + ~16k close_calls). Falls back to fetching when omitted.
  // (Perf option A — no logic change.)
  cohort?: SpeedToLeadCohortResult,
): Promise<LeadRow[]> {
  // 1. Cohort (new + re-opt-in; soft-hidden leads already filtered out).
  const c = cohort ?? (await getSpeedToLeadCohort(range))
  const rows = c.rows
  if (rows.length === 0) return []

  const sb = createAdminClient()
  const leadIds = rows.map((r) => r.leadId)

  // 2. Lead identity (emails + names) + qualified — from close_leads.
  const leadEmails = new Map<string, string[]>()
  const leadNames = new Map<string, string>()
  const leadQualified = new Map<string, Qualification>()
  const leadReactivatedAt = new Map<string, string>()
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, display_name, contacts, marketing_qualified, reactivated_at')
      .in('close_id', chunk)
    if (error) throw new Error(`leads: close_leads read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{
      close_id: string
      display_name: string | null
      contacts: unknown
      marketing_qualified: string | null
      reactivated_at: string | null
    }>) {
      const emails = new Set<string>()
      if (Array.isArray(r.contacts)) {
        for (const c of r.contacts as Array<{ emails?: Array<{ email?: string }> }>) {
          for (const e of c.emails ?? []) {
            const n = norm(e?.email)
            if (n) emails.add(n)
          }
        }
      }
      leadEmails.set(r.close_id, Array.from(emails))
      if (r.display_name) leadNames.set(r.close_id, norm(r.display_name))
      leadQualified.set(r.close_id, qualFromMarketingQualified(r.marketing_qualified))
      if (r.reactivated_at) leadReactivatedAt.set(r.close_id, r.reactivated_at)
    }
  }

  // optInAt per lead — anchors the lifecycle window for DQ scoping (a DQ before
  // the latest opt-in belongs to a prior journey and shouldn't count).
  const optInAtByLead = new Map(rows.map((r) => [r.leadId, r.optInAt]))
  const afterOptIn = (leadId: string, at: string | null): boolean => {
    const optIn = optInAtByLead.get(leadId)
    if (!optIn || !at) return true
    return new Date(at).getTime() >= new Date(optIn).getTime()
  }

  // 3. Booking signals — the DIRECT link ("Ai Partner Strategy Call") and the
  //    SETTER/PARTNERSHIP link family ("Partnership Call w/ …"), ANY status,
  //    EVER. A lead is classified by which it has had: direct-only = 'direct',
  //    partnership-only = 'setter', BOTH = 'reactivation' (a direct lead a
  //    setter re-booked after it fell through — and once reactivated it never
  //    reverts to pure direct). Match by utm_term token → email → name.
  //    The DIRECT test is time-gated to the lead's latest opt-in (a strat call
  //    booked before a re-opt-in shouldn't classify the current journey —
  //    Drake 2026-05-31); PARTNERSHIP stays ever-based.
  const leadResolver = await buildCalendlyLeadResolver(sb)
  const directSig = await collectTimedSignals(sb, leadResolver, await fetchEvents(sb, 'direct'))
  const partnershipSig = await collectTimedSignals(sb, leadResolver, await fetchEvents(sb, 'partnership'))

  // 4. Confirmed direct bookings — the confirmation call's form (the
  //    Closer Triage Form, a confirmation call that's almost always Aman),
  //    matched to the lead by lead_id. "Confirmed" = a Call Status starting
  //    with "Confirmed" (covers "Confirmed Booking" + the confirmed-for-a-
  //    different-time option). Other statuses (DQ / Setter pipeline, and the
  //    stray "High Ticket booking" left over from a form_type backfill) do
  //    NOT count. The form is the sole decider — no call-duration gate, since
  //    a sub-90s confirmation call still warrants a filed form.
  //    Read BOTH form families: the confirmation (Closer Triage Form) drives
  //    the direct Confirmed stage; the setter triage drives opt-in/reactivation
  //    Connected ("Setter pipeline / Follow up") and Booked (HT/DC booking —
  //    NOT "Confirmed Booking", which is the Confirmed stage, direct only). Any
  //    "DQ" status on either, after the lead's opt-in, flags DQ.
  const confirmedLeadIds = new Set<string>()
  const setterConnectedIds = new Set<string>()
  const setterBookedIds = new Set<string>()
  const dqLeadIds = new Set<string>()
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const { data, error } = await sb
      .from('airtable_setter_triage_calls' as never)
      .select('lead_id, form_type, call_status, airtable_created_at')
      .in('lead_id', chunk)
    if (error) throw new Error(`leads: triage forms read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{
      lead_id: string | null; form_type: string | null; call_status: string | null; airtable_created_at: string | null
    }>) {
      if (!r.lead_id) continue
      const cs = norm(r.call_status)
      if (cs.includes('dq') && afterOptIn(r.lead_id, r.airtable_created_at)) dqLeadIds.add(r.lead_id)
      if (r.form_type === 'Closer Triage Form') {
        if (cs.startsWith('confirmed')) confirmedLeadIds.add(r.lead_id)
      } else {
        if (cs.includes('setter pipeline') || cs.includes('follow up')) setterConnectedIds.add(r.lead_id)
        if (cs.includes('booking') && !cs.includes('confirmed')) setterBookedIds.add(r.lead_id)
      }
    }
  }

  // 5. Showed / Closed — the closer EOC form (form_type=New), matched to the
  //    lead by lead_id, derived from Call Outcome (same mapping as the closer
  //    drill). The form is the sole decider, mirroring the confirmation flow.
  //    A lead with ANY New closer form whose outcome shows/closes counts.
  const showedLeadIds = new Set<string>()
  const closedLeadIds = new Set<string>()
  // Close moment per lead = the EARLIEST closing (HT/DC) form's meeting time.
  // Used to cap raw dials at close (post-close fulfillment dials are excluded).
  const closeTime = new Map<string, string>()
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const { data, error } = await sb
      .from('airtable_full_closer_report' as never)
      .select('lead_id, call_outcome, date_time_of_call, airtable_created_at')
      .eq('form_type', 'New')
      .in('lead_id', chunk)
    if (error) throw new Error(`leads: closer form read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{
      lead_id: string | null; call_outcome: string | null; date_time_of_call: string | null; airtable_created_at: string | null
    }>) {
      if (!r.lead_id) continue
      if (norm(r.call_outcome).includes('dq') && afterOptIn(r.lead_id, r.airtable_created_at)) dqLeadIds.add(r.lead_id)
      if (outcomeShowed(r.call_outcome)) showedLeadIds.add(r.lead_id)
      if (outcomeClosed(r.call_outcome)) {
        closedLeadIds.add(r.lead_id)
        if (r.date_time_of_call) {
          const prev = closeTime.get(r.lead_id)
          if (!prev || r.date_time_of_call < prev) closeTime.set(r.lead_id, r.date_time_of_call)
        }
      }
    }
  }

  // 7. Assemble — classify each lead by which booking links it has ever had.
  return rows.map((r) => {
    const emails = leadEmails.get(r.leadId) ?? []
    const name = leadNames.get(r.leadId) ?? ''
    const qualified = leadQualified.get(r.leadId) ?? 'unknown'
    const hasDirect = bookedSince(directSig, r.leadId, emails, name, r.optInAt)
    const hasPartnership = bookedEver(partnershipSig, r.leadId, emails, name)
    const bookingType: BookingType =
      hasDirect && hasPartnership
        ? 'reactivation'
        : hasDirect
          ? 'direct'
          : hasPartnership
            ? 'setter'
            : null

    // Computed status — type (colour) + furthest-stage word.
    const confirmed = confirmedLeadIds.has(r.leadId)
    const showed = showedLeadIds.has(r.leadId)
    const closed = closedLeadIds.has(r.leadId)
    const reactivatedAt = leadReactivatedAt.get(r.leadId) ?? null
    const isDq = dqLeadIds.has(r.leadId)
    const leadType: LeadRow['leadType'] = isDq
      ? 'dq'
      : reactivatedAt
        ? 'reactivation'
        : hasDirect
          ? 'direct'
          : 'optin'
    const booked = hasPartnership || setterBookedIds.has(r.leadId)
    const connected = r.anyCallConnected || setterConnectedIds.has(r.leadId)
    let statusWord: string
    if (leadType === 'dq') statusWord = 'DQ'
    else if (leadType === 'direct') statusWord = closed ? 'Closed' : showed ? 'Showed' : confirmed ? 'Confirmed' : 'Booked'
    else statusWord = closed ? 'Closed' : showed ? 'Showed' : booked ? 'Booked' : connected || leadType === 'reactivation' ? 'Connected' : '—'

    return {
      ...r,
      qualified,
      bookingType,
      confirmed,
      showed,
      closed,
      hasDirect,
      hasPartnership,
      reactivatedAt,
      closeTimeIso: closeTime.get(r.leadId) ?? null,
      leadType,
      statusWord,
    }
  })
}

// Qualified from the Close lead's `marketing_qualified` flag (the team's
// canonical Yes/No, ≡ the under/over-$2,000 rule). Unset → unknown.
function qualFromMarketingQualified(mq: string | null): Qualification {
  const v = (mq ?? '').trim().toLowerCase()
  if (v === 'yes') return 'qualified'
  if (v === 'no') return 'non-qualified'
  return 'unknown'
}
