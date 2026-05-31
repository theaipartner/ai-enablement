import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { resolveFunnelRange } from './funnel-stages'
import { DIRECT_BOOKING_EVENT_TYPE_URI } from './funnel-calendly'

// CEO control-center — "forms not filled" flags for TODAY (ET).
//
// Two grace windows after which a missing form is overdue:
//   - Setter: a >=90s connected call with no Setter Triage Form 15 min later.
//   - Closer: a booked meeting with no Closer EOC form 1.5 h after its START.
//     (Eventually we'll trigger off the call ENDING, once Fathom is wired for
//     closing calls; for now meeting start + 1.5h is the proxy.)
//
// "No form" = no Airtable form for that lead filed at/after the call/meeting.
// One flag per lead per side (the earliest offending interaction).

const CONNECTED_SEC = 90
const SETTER_GRACE_MS = 15 * 60 * 1000
const CLOSER_GRACE_MS = 90 * 60 * 1000

export type MissingFormFlag = {
  leadName: string
  talentName: string // setter (caller) or closer (host)
  atIso: string // the call / meeting time
}

export type MissingFormFlags = {
  setter: MissingFormFlag[]
  closer: MissingFormFlag[]
}

function norm(s: string | null | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

export async function getMissingFormFlags(): Promise<MissingFormFlags> {
  const sb = createAdminClient()
  const range = resolveFunnelRange(undefined, undefined) // today ET
  const todayStart = range.startUtcIso
  const now = new Date()
  const setterCutoff = new Date(now.getTime() - SETTER_GRACE_MS).toISOString()
  const closerCutoff = new Date(now.getTime() - CLOSER_GRACE_MS).toISOString()

  const setter = await setterFlags(sb, todayStart, setterCutoff)
  const closer = await closerFlags(sb, todayStart, closerCutoff)
  return { setter, closer }
}

// ── Setter: connected calls today missing a Setter Triage Form ────────────────
async function setterFlags(
  sb: ReturnType<typeof createAdminClient>,
  todayStart: string,
  cutoff: string,
): Promise<MissingFormFlag[]> {
  // Connected (>=90s) outbound calls today that are already past the 15-min grace.
  const { data: callData, error: callErr } = await sb
    .from('close_calls' as never)
    .select('lead_id, activity_at, raw_payload')
    .eq('direction', 'outbound')
    .gte('duration', CONNECTED_SEC)
    .gte('activity_at', todayStart)
    .lte('activity_at', cutoff)
    .order('activity_at', { ascending: true })
  if (callErr) throw new Error(`missing-forms: close_calls read failed: ${callErr.message}`)
  const calls = (callData ?? []) as unknown as Array<{
    lead_id: string | null
    activity_at: string
    raw_payload: { user_name?: string } | null
  }>
  if (calls.length === 0) return []

  // Earliest qualifying connected call per lead + its caller.
  const earliestCall = new Map<string, { at: string; caller: string | null }>()
  for (const c of calls) {
    if (!c.lead_id) continue
    if (!earliestCall.has(c.lead_id)) {
      earliestCall.set(c.lead_id, { at: c.activity_at, caller: c.raw_payload?.user_name ?? null })
    }
  }
  const leadIds = Array.from(earliestCall.keys())

  // Setter Triage Forms for those leads (when was each filed).
  const formByLead = await latestFormByLead(sb, 'airtable_setter_triage_calls', leadIds, 'Closer Triage Form')
  const names = await leadNames(sb, leadIds)

  const flags: MissingFormFlag[] = []
  for (const [leadId, call] of Array.from(earliestCall)) {
    const formAt = formByLead.get(leadId)
    // Covered if a setter form was filed at/after the call.
    if (formAt && formAt >= call.at) continue
    flags.push({
      leadName: names.get(leadId) ?? leadId,
      talentName: call.caller ?? '—',
      atIso: call.at,
    })
  }
  flags.sort((a, b) => (a.atIso < b.atIso ? -1 : 1))
  return flags
}

// ── Closer: meetings today missing a Closer EOC form ──────────────────────────
async function closerFlags(
  sb: ReturnType<typeof createAdminClient>,
  todayStart: string,
  cutoff: string,
): Promise<MissingFormFlag[]> {
  // Today's closer meetings past the 1.5h grace (non-canceled, non-hidden).
  const { data: evData, error: evErr } = await sb
    .from('calendly_scheduled_events' as never)
    .select('uri, name, event_type_uri, start_time, status, host_user_name')
    .gte('start_time', todayStart)
    .lte('start_time', cutoff)
    .is('excluded_at', null)
  if (evErr) throw new Error(`missing-forms: calendly events read failed: ${evErr.message}`)
  const events = ((evData ?? []) as unknown as Array<{
    uri: string
    name: string | null
    event_type_uri: string | null
    start_time: string | null
    status: string | null
    host_user_name: string | null
  }>).filter(
    (e) =>
      e.start_time &&
      norm(e.status) !== 'canceled' &&
      (e.event_type_uri === DIRECT_BOOKING_EVENT_TYPE_URI || norm(e.name).startsWith('partnership call w/')),
  )
  if (events.length === 0) return []

  // Resolve each meeting's invitee → close lead (email → name). utm is skipped
  // here — for a flag we only want HIGH-confidence matches; an unresolved
  // meeting is dropped rather than false-flagged.
  const uris = events.map((e) => e.uri)
  const inviteeByEvent = new Map<string, { email: string | null; name: string | null }>()
  for (let i = 0; i < uris.length; i += 100) {
    const { data, error } = await sb
      .from('calendly_invitees' as never)
      .select('event_uri, email, name')
      .in('event_uri', uris.slice(i, i + 100))
    if (error) throw new Error(`missing-forms: invitees read failed: ${error.message}`)
    for (const inv of (data ?? []) as unknown as Array<{ event_uri: string; email: string | null; name: string | null }>) {
      if (!inviteeByEvent.has(inv.event_uri)) inviteeByEvent.set(inv.event_uri, { email: inv.email, name: inv.name })
    }
  }
  const emailToLead = await leadIndex(sb, 'email')
  const nameToLead = await leadIndex(sb, 'name')

  // Per resolved lead: earliest meeting + closer.
  const earliestMeeting = new Map<string, { at: string; closer: string | null; leadName: string }>()
  for (const e of events) {
    const inv = inviteeByEvent.get(e.uri)
    if (!inv) continue
    const leadId = emailToLead.get(norm(inv.email)) ?? nameToLead.get(norm(inv.name))
    if (!leadId) continue
    const prev = earliestMeeting.get(leadId)
    if (!prev || (e.start_time as string) < prev.at) {
      earliestMeeting.set(leadId, { at: e.start_time as string, closer: e.host_user_name, leadName: inv.name ?? leadId })
    }
  }
  const leadIds = Array.from(earliestMeeting.keys())
  if (leadIds.length === 0) return []

  const formByLead = await latestFormByLead(sb, 'airtable_full_closer_report', leadIds)
  const names = await leadNames(sb, leadIds)

  const flags: MissingFormFlag[] = []
  for (const [leadId, mtg] of Array.from(earliestMeeting)) {
    const formAt = formByLead.get(leadId)
    if (formAt && formAt >= mtg.at) continue
    flags.push({
      leadName: names.get(leadId) ?? mtg.leadName,
      talentName: mtg.closer ?? '—',
      atIso: mtg.at,
    })
  }
  flags.sort((a, b) => (a.atIso < b.atIso ? -1 : 1))
  return flags
}

// ── shared helpers ────────────────────────────────────────────────────────────

// Latest airtable_created_at per lead for an Airtable form table, so we can ask
// "was a form filed at/after the interaction". `excludeFormType` drops the
// confirmation (Closer Triage Form) rows from the setter-side query.
async function latestFormByLead(
  sb: ReturnType<typeof createAdminClient>,
  table: 'airtable_setter_triage_calls' | 'airtable_full_closer_report',
  leadIds: string[],
  excludeFormType?: string,
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < leadIds.length; i += 100) {
    let query = sb
      .from(table as never)
      .select('lead_id, airtable_created_at')
      .in('lead_id', leadIds.slice(i, i + 100))
    if (excludeFormType) query = query.neq('form_type', excludeFormType)
    const { data, error } = await query
    if (error) throw new Error(`missing-forms: ${table} read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{ lead_id: string | null; airtable_created_at: string | null }>) {
      if (!r.lead_id || !r.airtable_created_at) continue
      const prev = out.get(r.lead_id)
      if (!prev || r.airtable_created_at > prev) out.set(r.lead_id, r.airtable_created_at)
    }
  }
  return out
}

async function leadNames(
  sb: ReturnType<typeof createAdminClient>,
  leadIds: string[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  for (let i = 0; i < leadIds.length; i += 100) {
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, display_name')
      .in('close_id', leadIds.slice(i, i + 100))
    if (error) throw new Error(`missing-forms: close_leads names read failed: ${error.message}`)
    for (const r of (data ?? []) as unknown as Array<{ close_id: string; display_name: string | null }>) {
      if (r.display_name) out.set(r.close_id, r.display_name)
    }
  }
  return out
}

// Unique-mapping index of close_leads by email (from contacts) or display_name —
// only keys that map to exactly one lead are kept (a shared key is ambiguous).
async function leadIndex(
  sb: ReturnType<typeof createAdminClient>,
  by: 'email' | 'name',
): Promise<Map<string, string>> {
  const map = new Map<string, string | null>()
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, display_name, contacts')
      .range(from, from + 999)
    if (error) throw new Error(`missing-forms: close_leads index read failed: ${error.message}`)
    const rows = (data ?? []) as unknown as Array<{ close_id: string; display_name: string | null; contacts: unknown }>
    if (rows.length === 0) break
    for (const r of rows) {
      const keys: string[] = []
      if (by === 'name') {
        const n = norm(r.display_name)
        if (n) keys.push(n)
      } else if (Array.isArray(r.contacts)) {
        for (const c of r.contacts as Array<{ emails?: Array<{ email?: string }> }>) {
          for (const e of c.emails ?? []) {
            const n = norm(e?.email)
            if (n) keys.push(n)
          }
        }
      }
      for (const k of keys) {
        if (!map.has(k)) map.set(k, r.close_id)
        else if (map.get(k) !== r.close_id) map.set(k, null) // ambiguous
      }
    }
    if (rows.length < 1000) break
    from += 1000
  }
  const out = new Map<string, string>()
  for (const [k, v] of Array.from(map)) if (v) out.set(k, v)
  return out
}
