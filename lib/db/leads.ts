import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'
import {
  getSpeedToLeadCohort,
  type SpeedToLeadCohortRow,
} from './funnel-appointment-setting'

// View-only Leads list (the /sales-dashboard/leads page). Built on the
// SAME cohort as the appointment-setting lead list (getSpeedToLeadCohort
// — already includes re-opt-ins) so the two can't drift, then enriched
// with two columns the dial list doesn't carry:
//
//   - qualified  — read DIRECTLY off the Close lead's `investment` field
//                  (the budget answer Close stores from the Typeform
//                  submission). "Under $2,000" → non-qualified; any higher
//                  band → qualified; not set → unknown. No Typeform join /
//                  email-match needed — the answer lives on the lead, and
//                  Close overwrites it on each opt-in, so a re-opt-in's
//                  status is automatically its MOST RECENT submission
//                  (Drake 2026-05-29). (Close also has a `marketing_qualified`
//                  Yes/No flag; we key on `investment` per Drake's rule.)
//   - booked     — match the lead (email, else name) to a Calendly invitee
//                  on the "AI Partner Strategy Call" link. No match → false.
//
// Booked matching is email-primary, name-fallback, and imperfect by nature:
// unmatched leads show not-booked honestly rather than guessing.

// Calendly direct-booking event-name prefix. Source of truth:
// ingestion/calendly + lib/db/funnel-calendly.ts (NAME_PREFIX_LC).
const STRATEGY_CALL_PREFIX_LC = 'ai partner strategy call'

export type Qualification = 'qualified' | 'non-qualified' | 'unknown'

export type LeadRow = SpeedToLeadCohortRow & {
  qualified: Qualification
  booked: boolean
}

export type LeadsResult = {
  rows: LeadRow[]
  total: number
  newCount: number
  reoptinCount: number
  qualifiedCount: number
  bookedCount: number
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

const DAY_MS = 24 * 60 * 60 * 1000

export async function getLeadsForRange(range: DateRange): Promise<LeadsResult> {
  // 1. Cohort (new + re-opt-in) with all the dial-list metrics.
  const cohort = await getSpeedToLeadCohort(range)
  const rows = cohort.rows
  const empty: LeadsResult = {
    rows: [], total: 0, newCount: 0, reoptinCount: 0, qualifiedCount: 0, bookedCount: 0,
  }
  if (rows.length === 0) return empty

  const sb = createAdminClient()
  const leadIds = rows.map((r) => r.leadId)

  // 2. Lead identity (emails + names) + qualified — all from close_leads.
  //    `investment` is the budget answer Close stores from the Typeform
  //    submission (and overwrites on each opt-in → most-recent wins).
  //    Chunked .in to stay under PostgREST's URI budget.
  const leadEmails = new Map<string, string[]>()       // leadId → normalized emails
  const leadNames = new Map<string, string>()          // leadId → normalized name
  const leadQualified = new Map<string, Qualification>() // leadId → qualified
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, display_name, contacts, investment')
      .in('close_id', chunk)
    if (error) throw new Error(`leads: close_leads read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{
      close_id: string
      display_name: string | null
      contacts: unknown
      investment: string | null
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
      leadQualified.set(r.close_id, qualFromInvestment(r.investment))
    }
  }

  // 3. Booked — Calendly invitees on the strategy-call link, for events
  //    created from the window start onward (a lead opting in this window
  //    books during/after it, sometimes for a future date). Build booked
  //    email + name sets, match the cohort against them.
  const bookedEmails = new Set<string>()
  const bookedNames = new Set<string>()
  {
    const evStart = new Date(new Date(range.startUtcIso).getTime() - 2 * DAY_MS).toISOString()
    const eventUris: string[] = []
    let from = 0
    for (;;) {
      const { data, error } = await sb
        .from('calendly_scheduled_events' as never)
        .select('uri, name, event_created_at')
        .eq('status', 'active')
        .gte('event_created_at', evStart)
        .order('event_created_at', { ascending: true })
        .range(from, from + 999)
      if (error) throw new Error(`leads: calendly events read failed: ${error.message}`)
      const evs = (data ?? []) as unknown as Array<{ uri: string; name: string | null; event_created_at: string }>
      if (evs.length === 0) break
      for (const e of evs) {
        if (e.name && norm(e.name).startsWith(STRATEGY_CALL_PREFIX_LC)) eventUris.push(e.uri)
      }
      if (evs.length < 1000) break
      from += 1000
    }
    for (let i = 0; i < eventUris.length; i += 100) {
      const chunk = eventUris.slice(i, i + 100)
      const { data, error } = await sb
        .from('calendly_invitees' as never)
        .select('event_uri, email, name')
        .in('event_uri', chunk)
        .eq('status', 'active')
      if (error) throw new Error(`leads: calendly invitees read failed: ${error.message}`)
      for (const inv of (data ?? []) as unknown as Array<{ email: string | null; name: string | null }>) {
        const e = norm(inv.email)
        if (e) bookedEmails.add(e)
        const n = norm(inv.name)
        if (n) bookedNames.add(n)
      }
    }
  }

  // 4. Assemble.
  let qualifiedCount = 0
  let bookedCount = 0
  let newCount = 0
  let reoptinCount = 0
  const out: LeadRow[] = rows.map((r) => {
    const emails = leadEmails.get(r.leadId) ?? []
    const name = leadNames.get(r.leadId) ?? ''

    const qualified = leadQualified.get(r.leadId) ?? 'unknown'

    let booked = false
    for (const e of emails) {
      if (bookedEmails.has(e)) { booked = true; break }
    }
    if (!booked && name && bookedNames.has(name)) booked = true

    if (qualified === 'qualified') qualifiedCount++
    if (booked) bookedCount++
    if (r.optInType === 'reoptin') reoptinCount++
    else newCount++

    return { ...r, qualified, booked }
  })

  return {
    rows: out,
    total: out.length,
    newCount,
    reoptinCount,
    qualifiedCount,
    bookedCount,
  }
}

// Qualified from the Close lead's `investment` budget band.
// "Under $2,000" → non-qualified; any higher band → qualified; unset →
// unknown. Drake's rule (2026-05-29): under $2k investment = unqualified.
function qualFromInvestment(investment: string | null): Qualification {
  if (!investment || !investment.trim()) return 'unknown'
  if (/^under\s/i.test(investment.trim())) return 'non-qualified'
  return 'qualified'
}
