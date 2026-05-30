import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'
import {
  getSpeedToLeadCohort,
  type SpeedToLeadCohortRow,
} from './funnel-appointment-setting'
import { DIRECT_BOOKING_EVENT_TYPE_URI } from './funnel-calendly'
import { buildCalendlyLeadResolver, inviteeUtmTerm } from './calendly-lead-match'

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
//   - directBooked  — the lead has an "Ai Partner Strategy Call" (the DIRECT
//                     funnel link) Calendly booking EVER, any status (incl.
//                     canceled). That marks them a direct self-book. Match
//                     by email, else name. Drake 2026-05-29.
//
// Returns the rows; the page derives the funnel counts (and the
// all/unique toggle) from them.

export type Qualification = 'qualified' | 'non-qualified' | 'unknown'

export type LeadRow = SpeedToLeadCohortRow & {
  qualified: Qualification
  directBooked: boolean
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
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

  // 3. Direct booked — invitees on the DIRECT funnel link (the exact
  //    "Ai Partner Strategy Call" event type), ANY status, EVER. Resolve
  //    each booking to a Close lead by its utm_term token first (the
  //    strong key), and also build email + name sets as fallbacks. A
  //    cohort lead matching any of the three was a direct book.
  const leadResolver = await buildCalendlyLeadResolver(sb)
  const directLeadIds = new Set<string>()
  const directEmails = new Set<string>()
  const directNames = new Set<string>()
  {
    const eventUris: string[] = []
    let from = 0
    for (;;) {
      const { data, error } = await sb
        .from('calendly_scheduled_events' as never)
        .select('uri')
        .eq('event_type_uri', DIRECT_BOOKING_EVENT_TYPE_URI)
        .range(from, from + 999)
      if (error) throw new Error(`leads: calendly events read failed: ${error.message}`)
      const evs = (data ?? []) as unknown as Array<{ uri: string }>
      if (evs.length === 0) break
      for (const e of evs) eventUris.push(e.uri)
      if (evs.length < 1000) break
      from += 1000
    }
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
        if (lid) directLeadIds.add(lid)
        const e = norm(inv.email)
        if (e) directEmails.add(e)
        const n = norm(inv.name)
        if (n) directNames.add(n)
      }
    }
  }

  // 4. Assemble.
  return rows.map((r) => {
    const emails = leadEmails.get(r.leadId) ?? []
    const name = leadNames.get(r.leadId) ?? ''
    const qualified = leadQualified.get(r.leadId) ?? 'unknown'
    // Lead-id (utm_term token) first, then email, then name.
    let directBooked = directLeadIds.has(r.leadId)
    if (!directBooked) {
      for (const e of emails) {
        if (directEmails.has(e)) { directBooked = true; break }
      }
    }
    if (!directBooked && name && directNames.has(name)) directBooked = true
    return { ...r, qualified, directBooked }
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
