import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'
import {
  getSpeedToLeadCohort,
  type SpeedToLeadCohortRow,
} from './funnel-appointment-setting'
import { classifyResponse } from './funnel-typeform'

// View-only Leads list (the /sales-dashboard/leads page). Built on the
// SAME cohort as the appointment-setting lead list (getSpeedToLeadCohort
// — already includes re-opt-ins) so the two can't drift, then enriched
// with two cross-source joins the dial list doesn't carry:
//
//   - qualified  — match the lead (email/phone, else name) to a Typeform
//                  response and classify the budget question. "Under
//                  $2,000" → non-qualified; anything higher → qualified.
//                  Reuses funnel-typeform's classifier. No match → unknown.
//   - booked     — match the lead (email, else name) to a Calendly invitee
//                  on the "AI Partner Strategy Call" link. No match → false.
//
// Matching is email-primary, name-fallback, and imperfect by nature
// (Drake 2026-05-29): unmatched leads show unknown / not-booked honestly
// rather than guessing. For forward (June+) leads, where Typeform →
// Close → Calendly all flow live to production, match rates are high.

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

  // 2. Lead identity (emails + names) from close_leads.contacts jsonb.
  //    Chunked .in to stay under PostgREST's URI budget.
  const leadEmails = new Map<string, string[]>() // leadId → normalized emails
  const leadNames = new Map<string, string>()       // leadId → normalized name
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, display_name, contacts')
      .in('close_id', chunk)
    if (error) throw new Error(`leads: close_leads contacts read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{
      close_id: string
      display_name: string | null
      contacts: unknown
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
    }
  }

  // 3. Qualified — Typeform responses around the opt-in window. Latest
  //    submission per email wins. classifyResponse reads the budget
  //    field ref (single live funnel: SFedWelr).
  const qualByEmail = new Map<string, Qualification>()
  {
    const start = new Date(new Date(range.startUtcIso).getTime() - 2 * DAY_MS).toISOString()
    const end = new Date(new Date(range.endUtcIso).getTime() + DAY_MS).toISOString()
    let from = 0
    for (;;) {
      const { data, error } = await sb
        .from('typeform_responses' as never)
        .select('form_id, submitted_at, answers')
        .gte('submitted_at', start)
        .lt('submitted_at', end)
        .order('submitted_at', { ascending: true }) // ascending → last write wins = most recent
        .range(from, from + 999)
      if (error) throw new Error(`leads: typeform read failed: ${error.message}`)
      const trows = (data ?? []) as unknown as Array<{ form_id: string; submitted_at: string; answers: unknown }>
      if (trows.length === 0) break
      for (const t of trows) {
        const email = emailFromAnswers(t.answers)
        if (!email) continue
        // classifyResponse only reads `answers`; full TfRow shape for the type.
        qualByEmail.set(
          email,
          classifyResponse({ response_id: '', form_id: t.form_id, landed_at: null, submitted_at: t.submitted_at, answers: t.answers }),
        )
      }
      if (trows.length < 1000) break
      from += 1000
    }
  }

  // 4. Booked — Calendly invitees on the strategy-call link, for events
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

  // 5. Assemble.
  let qualifiedCount = 0
  let bookedCount = 0
  let newCount = 0
  let reoptinCount = 0
  const out: LeadRow[] = rows.map((r) => {
    const emails = leadEmails.get(r.leadId) ?? []
    const name = leadNames.get(r.leadId) ?? ''

    let qualified: Qualification = 'unknown'
    for (const e of emails) {
      const q = qualByEmail.get(e)
      if (q) { qualified = q; break }
    }

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

// Extract the first email answer from a Typeform answers[] array.
function emailFromAnswers(answers: unknown): string | null {
  if (!Array.isArray(answers)) return null
  for (const a of answers as Array<{ type?: string; email?: string }>) {
    if (a?.type === 'email' && a.email) return norm(a.email)
  }
  return null
}
