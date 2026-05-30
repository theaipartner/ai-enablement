import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'
import {
  getSpeedToLeadCohort,
  type SpeedToLeadCohortRow,
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
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

// Email/name/lead-id signals for one Calendly link family, used to test
// whether a lead has ever booked via that link.
type BookingSignals = { leadIds: Set<string>; emails: Set<string>; names: Set<string> }

// Pull every scheduled-event URI for a link family: 'direct' = the exact
// DIRECT event type; 'partnership' = the setter-led "Partnership Call w/ …"
// name family (one event type per closer, so matched by name prefix).
async function fetchEventUris(
  sb: ReturnType<typeof createAdminClient>,
  kind: 'direct' | 'partnership',
): Promise<string[]> {
  const uris: string[] = []
  for (let from = 0; ; from += 1000) {
    const base = sb.from('calendly_scheduled_events' as never).select('uri')
    const q =
      kind === 'direct'
        ? base.eq('event_type_uri', DIRECT_BOOKING_EVENT_TYPE_URI)
        : base.ilike('name', 'Partnership Call w/%')
    const { data, error } = await q.range(from, from + 999)
    if (error) throw new Error(`leads: calendly events (${kind}) read failed: ${error.message}`)
    const evs = (data ?? []) as unknown as Array<{ uri: string }>
    for (const e of evs) uris.push(e.uri)
    if (evs.length < 1000) break
  }
  return uris
}

// Collect lead-id (utm_term) + email + name signals from a set of events'
// invitees — the keys we test cohort leads against.
async function collectBookingSignals(
  sb: ReturnType<typeof createAdminClient>,
  leadResolver: CalendlyLeadResolver,
  eventUris: string[],
): Promise<BookingSignals> {
  const leadIds = new Set<string>()
  const emails = new Set<string>()
  const names = new Set<string>()
  for (let i = 0; i < eventUris.length; i += 100) {
    const chunk = eventUris.slice(i, i + 100)
    const { data, error } = await sb
      .from('calendly_invitees' as never)
      .select('email, name, raw_payload')
      .in('event_uri', chunk)
    if (error) throw new Error(`leads: calendly invitees read failed: ${error.message}`)
    for (const inv of (data ?? []) as unknown as Array<{
      email: string | null
      name: string | null
      raw_payload: { tracking?: { utm_term?: string | null } | null } | null
    }>) {
      const lid = leadResolver(inviteeUtmTerm(inv.raw_payload))
      if (lid) leadIds.add(lid)
      const e = norm(inv.email)
      if (e) emails.add(e)
      const n = norm(inv.name)
      if (n) names.add(n)
    }
  }
  return { leadIds, emails, names }
}

// Did this lead ever book via the link family? lead-id (utm_term) first,
// then email, then name.
function matchesSignals(sig: BookingSignals, leadId: string, emails: string[], name: string): boolean {
  if (sig.leadIds.has(leadId)) return true
  for (const e of emails) if (sig.emails.has(e)) return true
  return !!name && sig.names.has(name)
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

export async function getLeadsForRange(range: DateRange): Promise<LeadRow[]> {
  // 1. Cohort (new + re-opt-in; soft-hidden leads already filtered out).
  const cohort = await getSpeedToLeadCohort(range)
  const rows = cohort.rows
  if (rows.length === 0) return []

  const sb = createAdminClient()
  const leadIds = rows.map((r) => r.leadId)

  // 2. Lead identity (emails + names) + qualified — from close_leads.
  const leadEmails = new Map<string, string[]>()
  const leadNames = new Map<string, string>()
  const leadQualified = new Map<string, Qualification>()
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, display_name, contacts, marketing_qualified')
      .in('close_id', chunk)
    if (error) throw new Error(`leads: close_leads read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{
      close_id: string
      display_name: string | null
      contacts: unknown
      marketing_qualified: string | null
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
    }
  }

  // 3. Booking signals — the DIRECT link ("Ai Partner Strategy Call") and the
  //    SETTER/PARTNERSHIP link family ("Partnership Call w/ …"), ANY status,
  //    EVER. A lead is classified by which it has had: direct-only = 'direct',
  //    partnership-only = 'setter', BOTH = 'reactivation' (a direct lead a
  //    setter re-booked after it fell through — and once reactivated it never
  //    reverts to pure direct). Match by utm_term token → email → name.
  const leadResolver = await buildCalendlyLeadResolver(sb)
  const directSig = await collectBookingSignals(sb, leadResolver, await fetchEventUris(sb, 'direct'))
  const partnershipSig = await collectBookingSignals(sb, leadResolver, await fetchEventUris(sb, 'partnership'))

  // 4. Confirmed direct bookings — the confirmation call's form (the
  //    Closer Triage Form, a confirmation call that's almost always Aman),
  //    matched to the lead by lead_id. "Confirmed" = a Call Status starting
  //    with "Confirmed" (covers "Confirmed Booking" + the confirmed-for-a-
  //    different-time option). Other statuses (DQ / Setter pipeline, and the
  //    stray "High Ticket booking" left over from a form_type backfill) do
  //    NOT count. The form is the sole decider — no call-duration gate, since
  //    a sub-90s confirmation call still warrants a filed form.
  const confirmedLeadIds = new Set<string>()
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const { data, error } = await sb
      .from('airtable_setter_triage_calls' as never)
      .select('lead_id, call_status')
      .eq('form_type', 'Closer Triage Form')
      .in('lead_id', chunk)
    if (error) throw new Error(`leads: confirmation form read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{ lead_id: string | null; call_status: string | null }>) {
      if (r.lead_id && (r.call_status ?? '').trim().toLowerCase().startsWith('confirmed')) {
        confirmedLeadIds.add(r.lead_id)
      }
    }
  }

  // 5. Showed / Closed — the closer EOC form (form_type=New), matched to the
  //    lead by lead_id, derived from Call Outcome (same mapping as the closer
  //    drill). The form is the sole decider, mirroring the confirmation flow.
  //    A lead with ANY New closer form whose outcome shows/closes counts.
  const showedLeadIds = new Set<string>()
  const closedLeadIds = new Set<string>()
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const { data, error } = await sb
      .from('airtable_full_closer_report' as never)
      .select('lead_id, call_outcome')
      .eq('form_type', 'New')
      .in('lead_id', chunk)
    if (error) throw new Error(`leads: closer form read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{ lead_id: string | null; call_outcome: string | null }>) {
      if (!r.lead_id) continue
      if (outcomeShowed(r.call_outcome)) showedLeadIds.add(r.lead_id)
      if (outcomeClosed(r.call_outcome)) closedLeadIds.add(r.lead_id)
    }
  }

  // 7. Assemble — classify each lead by which booking links it has ever had.
  return rows.map((r) => {
    const emails = leadEmails.get(r.leadId) ?? []
    const name = leadNames.get(r.leadId) ?? ''
    const qualified = leadQualified.get(r.leadId) ?? 'unknown'
    const hasDirect = matchesSignals(directSig, r.leadId, emails, name)
    const hasPartnership = matchesSignals(partnershipSig, r.leadId, emails, name)
    const bookingType: BookingType =
      hasDirect && hasPartnership
        ? 'reactivation'
        : hasDirect
          ? 'direct'
          : hasPartnership
            ? 'setter'
            : null
    return {
      ...r,
      qualified,
      bookingType,
      confirmed: confirmedLeadIds.has(r.leadId),
      showed: showedLeadIds.has(r.leadId),
      closed: closedLeadIds.has(r.leadId),
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
