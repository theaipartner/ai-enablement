import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

// Teams Meeting Tracker data layer. The /teams page reads exclusively
// from Supabase — never from Google directly at render time. The cron
// at api/teams_calendar_sync_cron.py owns the Calendar API round trip
// and writes to calendar_events on a 30-minute cadence.

// One CSM row + their week's meetings, ready for the page to render.
export type TeamsCsmBlock = {
  team_member: {
    id: string
    full_name: string
    email: string
  }
  meetings: TeamsMeeting[]
  // True when the most recent calendar_sync audit row reports
  // calendar_api_denied for this CSM. Surfaces an "API access denied"
  // pill in the UI without blocking the rest of the page from
  // rendering.
  calendar_api_denied: boolean
}

export type TeamsMeeting = {
  google_event_id: string
  title: string | null
  start_time: string // ISO UTC
  end_time: string // ISO UTC
  // Matched Fathom call when one exists. null = "(no Fathom match)"
  // in the UI; the row still renders, just without a checkmark.
  matched_call: {
    id: string
    started_at: string
    title: string | null
    client_id: string | null
    client_name: string | null
    // Minutes the Fathom call started AFTER the Calendar event's
    // scheduled start. null when no match. ≥2 → render a lateness
    // pill; <2 → just the checkmark; negative (early start) → no
    // lateness indicator.
    minutes_late: number | null
  } | null
}

// OAuth state surfaced to the page so it can render the Reconnect
// banner for Drake when the token is missing or recently failed.
export type TeamsOAuthState = {
  connected: boolean
  // The most recent calendar_sync audit row's error_message, if any.
  // Non-null on a known-bad refresh state — Drake re-OAuths to clear.
  last_error: string | null
}

const ESTLOCALE = 'America/New_York'

// Convert this moment in EST to the Monday-00:00 / next-Monday-00:00
// pair, ISO UTC. Mirrors the Python cron's `_current_week_window`
// helper. We do the conversion via Intl.DateTimeFormat to avoid pulling
// in a date library; the math is small enough to be readable.
export function getCurrentWeekWindow(now: Date = new Date()): { start: string; end: string } {
  // Get EST y/m/d/h/m/s for the input moment.
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ESTLOCALE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
  })
  const parts = fmt.formatToParts(now).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value
    return acc
  }, {})
  const weekdayMap: Record<string, number> = {
    Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6,
  }
  const weekdayOffset = weekdayMap[parts.weekday] ?? 0
  // Reconstruct EST midnight Monday by walking back `weekdayOffset` days
  // from the EST midnight of "today" (in EST). The cleanest way to
  // build an EST midnight ISO and then convert to UTC is to use the
  // same Intl machinery in reverse — but it's overkill for our 1-line
  // need. Use a Date constructed from the EST y/m/d at 00:00 EST,
  // expressed as a UTC offset.
  //
  // EST is UTC-5 (winter) / EDT is UTC-4 (summer). The offset for the
  // input moment is the difference between the UTC and local clocks.
  const utc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  )
  const offsetMs = utc - now.getTime() // positive = local ahead of UTC
  // Local midnight of "today" in EST:
  const localMidnightUtc =
    Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), 0, 0, 0) -
    offsetMs
  const mondayUtc = localMidnightUtc - weekdayOffset * 24 * 60 * 60 * 1000
  const nextMondayUtc = mondayUtc + 7 * 24 * 60 * 60 * 1000
  return {
    start: new Date(mondayUtc).toISOString(),
    end: new Date(nextMondayUtc).toISOString(),
  }
}

// Title normalization for the join against `calls.title`. Case-
// insensitive, whitespace-trimmed. Mirrors the cron-side normalization
// when we add fuzzy matching later (V1 is exact match).
function normalizeTitle(t: string | null | undefined): string {
  return (t ?? '').trim().toLowerCase()
}

// Pull every active CSM, the week's calendar events, the candidate
// `calls` rows for matching, and the most recent audit error per CSM
// (if any). Combine in JS — Postgres-side join would require a more
// complex query and the dataset is tiny (4 CSMs × ~40 events/wk).
export async function getTeamsThisWeek(): Promise<{
  csms: TeamsCsmBlock[]
  weekStart: string
  weekEnd: string
}> {
  const supabase = createAdminClient()
  const { start, end } = getCurrentWeekWindow()

  // CSMs.
  const { data: rawCsms } = await supabase
    .from('team_members')
    .select('id, full_name, email, is_csm, archived_at, metadata')
    .eq('is_csm', true)
    .is('archived_at', null)
  const csms = (rawCsms ?? [])
    .filter((c) => {
      const meta = c.metadata as { sentinel?: boolean } | null
      return !meta?.sentinel
    })
    .sort((a, b) => (a.full_name ?? '').localeCompare(b.full_name ?? ''))

  // Calendar events for the week, all CSMs at once.
  const teamMemberIds = csms.map((c) => c.id)
  const { data: rawEvents } = teamMemberIds.length
    ? await supabase
        .from('calendar_events')
        .select('team_member_id, google_event_id, title, start_time, end_time')
        .in('team_member_id', teamMemberIds)
        .gte('start_time', start)
        .lt('start_time', end)
        .order('start_time', { ascending: true })
    : { data: [] as Array<{
        team_member_id: string
        google_event_id: string
        title: string | null
        start_time: string
        end_time: string
      }> }
  const events = rawEvents ?? []

  // Candidate calls for matching: all client calls in the same week
  // window with a non-null title. ±30 minute tolerance handled in JS.
  // Widen the window by 30 min on each side so a call that started
  // before/after the strict week edge still matches an edge event.
  const matchStart = new Date(new Date(start).getTime() - 30 * 60 * 1000).toISOString()
  const matchEnd = new Date(new Date(end).getTime() + 30 * 60 * 1000).toISOString()
  const { data: rawCalls } = await supabase
    .from('calls')
    .select('id, title, started_at, primary_client_id')
    .eq('call_category', 'client')
    .gte('started_at', matchStart)
    .lt('started_at', matchEnd)
  const calls = rawCalls ?? []

  // Bulk-fetch client names for any matched call's primary_client_id.
  const clientIds = Array.from(
    new Set(calls.map((c) => c.primary_client_id).filter((x): x is string => !!x)),
  )
  const { data: rawClients } = clientIds.length
    ? await supabase
        .from('clients')
        .select('id, full_name')
        .in('id', clientIds)
    : { data: [] as Array<{ id: string; full_name: string }> }
  const clientNameById = new Map(
    (rawClients ?? []).map((c) => [c.id, c.full_name]),
  )

  // Most-recent calendar_sync audit row — used to surface per-CSM
  // calendar_api_denied state. Read the most recent processed row and
  // walk its `payload.errors` array.
  const { data: latestAudit } = await supabase
    .from('webhook_deliveries')
    .select('payload, received_at')
    .eq('source', 'teams_calendar_sync')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  const deniedTeamMemberIds = new Set<string>()
  if (latestAudit?.payload) {
    const errors = (latestAudit.payload as { errors?: Array<{ team_member_id?: string; error_code?: string }> })
      .errors
    for (const e of errors ?? []) {
      if (e.error_code === 'calendar_api_denied' && e.team_member_id) {
        deniedTeamMemberIds.add(e.team_member_id)
      }
    }
  }

  // Group events by team_member, attach matches.
  const eventsByMember = new Map<string, typeof events>()
  for (const ev of events) {
    const arr = eventsByMember.get(ev.team_member_id) ?? []
    arr.push(ev)
    eventsByMember.set(ev.team_member_id, arr)
  }

  const blocks: TeamsCsmBlock[] = csms.map((csm) => {
    const memberEvents = eventsByMember.get(csm.id) ?? []
    const meetings: TeamsMeeting[] = memberEvents.map((ev) => {
      const evStartMs = new Date(ev.start_time).getTime()
      const evTitleNorm = normalizeTitle(ev.title)
      // Title must match (case-insensitive trim) AND the call's
      // started_at must be within ±30 minutes of the event start.
      let bestMatch: typeof calls[number] | null = null
      let bestDeltaMs = Number.POSITIVE_INFINITY
      for (const call of calls) {
        if (normalizeTitle(call.title) !== evTitleNorm) continue
        const callStartMs = new Date(call.started_at).getTime()
        const deltaMs = Math.abs(callStartMs - evStartMs)
        if (deltaMs > 30 * 60 * 1000) continue
        if (deltaMs < bestDeltaMs) {
          bestMatch = call
          bestDeltaMs = deltaMs
        }
      }
      let matchedCall: TeamsMeeting['matched_call'] = null
      if (bestMatch) {
        const callStartMs = new Date(bestMatch.started_at).getTime()
        const deltaSignedMin = Math.round((callStartMs - evStartMs) / 60000)
        matchedCall = {
          id: bestMatch.id,
          started_at: bestMatch.started_at,
          title: bestMatch.title,
          client_id: bestMatch.primary_client_id,
          client_name: bestMatch.primary_client_id
            ? clientNameById.get(bestMatch.primary_client_id) ?? null
            : null,
          minutes_late: deltaSignedMin > 0 ? deltaSignedMin : null,
        }
      }
      return {
        google_event_id: ev.google_event_id,
        title: ev.title,
        start_time: ev.start_time,
        end_time: ev.end_time,
        matched_call: matchedCall,
      }
    })
    return {
      team_member: { id: csm.id, full_name: csm.full_name, email: csm.email },
      meetings,
      calendar_api_denied: deniedTeamMemberIds.has(csm.id),
    }
  })

  return { csms: blocks, weekStart: start, weekEnd: end }
}

// Probe whether Drake has a usable Google OAuth token row. Used by the
// /teams page to decide whether to render the Reconnect banner.
export async function getDrakeOAuthState(): Promise<TeamsOAuthState> {
  const supabase = createAdminClient()
  // Find the creator (Drake) by access_tier — one row in production.
  const { data: drake } = await supabase
    .from('team_members')
    .select('id')
    .eq('access_tier', 'creator')
    .is('archived_at', null)
    .limit(1)
    .maybeSingle()
  if (!drake) {
    return { connected: false, last_error: 'no_creator_row' }
  }
  const { data: token } = await supabase
    .from('oauth_tokens')
    .select('access_token_expires_at')
    .eq('team_member_id', drake.id)
    .eq('provider', 'google')
    .maybeSingle()
  if (!token) {
    return { connected: false, last_error: null }
  }
  // Look for a recent oauth_token_unavailable audit error.
  const { data: latestAudit } = await supabase
    .from('webhook_deliveries')
    .select('processing_error, processing_status, received_at')
    .eq('source', 'teams_calendar_sync')
    .order('received_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (
    latestAudit?.processing_status === 'failed' &&
    latestAudit.processing_error?.startsWith('oauth_token_unavailable')
  ) {
    return { connected: false, last_error: latestAudit.processing_error }
  }
  return { connected: true, last_error: null }
}
