import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

// Resolve a Calendly booking to a Close lead via the per-lead token the
// booking link carries in utm_term — the "aaid_<uuid>" value, mirrored
// onto close_leads.utm_term.
//
// SAFETY: only tokens that map to EXACTLY ONE Close lead are usable. The
// utm_term field is overloaded — most leads carry a generic ad-targeting
// term ("Broad", dated campaign labels) shared across thousands of leads.
// Those are dropped here (mapped to null = ambiguous), so a shared term
// can never mis-attribute a booking. The 2 same-day duplicate-lead aaid
// collisions are dropped by the same rule.
//
// This is a PRIMARY key inserted ahead of email/phone/name, never a
// replacement: a booking whose token is absent or ambiguous falls back
// to those exactly as before. ~20% of mirrored bookings resolve via the
// token today; coverage grows as new bookings carry it.

export type CalendlyLeadResolver = (utmTerm: string | null | undefined) => string | null

export async function buildCalendlyLeadResolver(
  sb: ReturnType<typeof createAdminClient>,
): Promise<CalendlyLeadResolver> {
  // utm_term → close_id, or null once a second distinct lead claims the
  // same term (ambiguous → unusable).
  const termToLead = new Map<string, string | null>()
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, utm_term')
      .not('utm_term', 'is', null)
      .range(from, from + 999)
    if (error) throw new Error(`calendly-lead-match: close_leads read failed: ${error.message}`)
    const rows = (data ?? []) as unknown as Array<{ close_id: string; utm_term: string | null }>
    if (rows.length === 0) break
    for (const r of rows) {
      const t = r.utm_term
      if (!t) continue
      if (!termToLead.has(t)) termToLead.set(t, r.close_id)
      else if (termToLead.get(t) !== r.close_id) termToLead.set(t, null) // collision → ambiguous
    }
    if (rows.length < 1000) break
    from += 1000
  }
  return (utmTerm) => {
    if (!utmTerm) return null
    return termToLead.get(utmTerm) ?? null // null = absent OR ambiguous
  }
}

// The per-lead token a Calendly invitee carries, from the mirrored
// raw_payload.tracking.utm_term.
export function inviteeUtmTerm(
  rawPayload: { tracking?: { utm_term?: string | null } | null } | null | undefined,
): string | null {
  return rawPayload?.tracking?.utm_term ?? null
}

// Resolve invitee emails → close lead id via the GIN-indexed
// resolve_close_lead_emails() RPC (migration 0096), the email fallback when the
// utm_term token didn't resolve. Replaces a full scan of close_leads.contacts in
// the DC + closing loaders. Stored contact emails are lowercased; we lowercase +
// trim the inputs to match. First lead wins per email.
export async function resolveLeadEmails(
  sb: ReturnType<typeof createAdminClient>,
  emails: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const uniq = Array.from(new Set(emails.map((e) => e.toLowerCase().trim()).filter(Boolean)))
  if (uniq.length === 0) return out
  const { data, error } = await sb.rpc('resolve_close_lead_emails' as never, { p_emails: uniq } as never)
  if (error) throw new Error(`resolve_close_lead_emails failed: ${error.message}`)
  for (const r of (data ?? []) as Array<{ email: string; close_id: string }>) {
    if (!out.has(r.email)) out.set(r.email, r.close_id)
  }
  return out
}
