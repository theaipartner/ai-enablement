// Fulfillment Dashboard data layer.
//
// Aggregations (active clients total / by CSM / by journey stage) and
// the notifications feed (negative-sentiment call_reviews on the day,
// missed-recording flags from calendar_events with no matched call).
//
// All reads use createAdminClient — server-only. JS-side aggregation
// because the dataset is tiny (~200 active clients, ~30 events/day per
// CSM, ~30 reviews/day worst case).

import { createAdminClient } from '@/lib/supabase/admin'
import { JOURNEY_STAGE_LABEL } from '@/lib/client-vocab'
import { getEstPeriodBoundary } from '@/lib/time/est-periods'

// ---------------------------------------------------------------------------
// Active clients aggregations
// ---------------------------------------------------------------------------

export type CsmCount = {
  team_member_id: string | null
  team_member_name: string | null
  count: number
}

export type JourneyStageCount = {
  value: string | null
  label: string
  count: number
}

export type ActiveClientsAggregate = {
  total: number
  by_csm: CsmCount[]
  by_journey_stage: JourneyStageCount[]
}

export async function getActiveClientsAggregate(): Promise<ActiveClientsAggregate> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('clients')
    .select(
      `
      id,
      journey_stage,
      client_team_assignments(role, unassigned_at, team_members(id, full_name))
    `,
    )
    .eq('status', 'active')
    .is('archived_at', null)

  if (error) throw error
  const rows = (data ?? []) as Array<{
    id: string
    journey_stage: string | null
    client_team_assignments: Array<{
      role: string
      unassigned_at: string | null
      team_members: { id: string; full_name: string } | null
    }> | null
  }>

  // By CSM (primary, currently active).
  const csmCounts = new Map<string, CsmCount>()
  const UNASSIGNED_KEY = '__unassigned__'
  // By journey stage.
  const stageCounts = new Map<string, number>()

  for (const row of rows) {
    const primary = (row.client_team_assignments ?? []).find(
      (a) => a.role === 'primary_csm' && a.unassigned_at === null,
    )
    const key = primary?.team_members?.id ?? UNASSIGNED_KEY
    if (!csmCounts.has(key)) {
      csmCounts.set(key, {
        team_member_id: primary?.team_members?.id ?? null,
        team_member_name: primary?.team_members?.full_name ?? null,
        count: 0,
      })
    }
    csmCounts.get(key)!.count += 1

    const stageKey = row.journey_stage ?? '__null__'
    stageCounts.set(stageKey, (stageCounts.get(stageKey) ?? 0) + 1)
  }

  const by_csm = Array.from(csmCounts.values()).sort((a, b) => {
    // Unassigned at the bottom; otherwise descending by count, then by name.
    const aUnassigned = a.team_member_id === null
    const bUnassigned = b.team_member_id === null
    if (aUnassigned !== bUnassigned) return aUnassigned ? 1 : -1
    if (b.count !== a.count) return b.count - a.count
    return (a.team_member_name ?? '').localeCompare(b.team_member_name ?? '')
  })

  const by_journey_stage: JourneyStageCount[] = Array.from(stageCounts.entries())
    .map(([value, count]) => {
      const isNull = value === '__null__'
      return {
        value: isNull ? null : value,
        label: isNull ? 'Unassigned' : JOURNEY_STAGE_LABEL[value] ?? value,
        count,
      }
    })
    .sort((a, b) => {
      if (a.value === null) return 1
      if (b.value === null) return -1
      return b.count - a.count
    })

  return { total: rows.length, by_csm, by_journey_stage }
}

// ---------------------------------------------------------------------------
// Notifications feed
// ---------------------------------------------------------------------------

export type Notification =
  | {
      kind: 'negative_sentiment'
      occurred_at: string
      call_id: string
      call_title: string | null
      client_id: string | null
      client_name: string | null
    }
  | {
      kind: 'missed_recording'
      occurred_at: string
      google_event_id: string
      event_title: string | null
      csm_name: string | null
      end_time: string
    }

function normalizeTitle(t: string | null | undefined): string {
  return (t ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

export async function getDashboardNotifications(): Promise<Notification[]> {
  const supabase = createAdminClient()

  const todayStartEt = getEstPeriodBoundary('today')
  const now = new Date()

  // ---- Negative-sentiment call_reviews (today in ET).
  const sentimentPromise = supabase
    .from('documents')
    .select('id, metadata, created_at')
    .eq('document_type', 'call_review')
    .gte('created_at', todayStartEt.toISOString())
    .order('created_at', { ascending: false })

  // ---- Calendar events whose end_time + 30 min has passed.
  // Window: events that started today (EST). Since calendar_events has
  // both start_time and end_time non-null, no yesterday fallback is
  // needed — we only surface today's events where the 30-min-post-end
  // grace period has already elapsed AND no matching call landed.
  const matchWindowStart = todayStartEt.toISOString()
  const matchWindowEnd = new Date(now.getTime() + 30 * 60 * 1000).toISOString()
  const eventsPromise = supabase
    .from('calendar_events')
    .select('google_event_id, title, start_time, end_time, team_member_id')
    .gte('start_time', matchWindowStart)
    .lte('start_time', now.toISOString())
    .order('start_time', { ascending: false })

  const callsPromise = supabase
    .from('calls')
    .select('id, title, started_at')
    .eq('call_category', 'client')
    .gte('started_at', matchWindowStart)
    .lt('started_at', matchWindowEnd)

  const [
    { data: sentimentDocs, error: sentimentError },
    { data: events, error: eventsError },
    { data: candidateCalls, error: callsError },
  ] = await Promise.all([sentimentPromise, eventsPromise, callsPromise])

  if (sentimentError) throw sentimentError
  if (eventsError) throw eventsError
  if (callsError) throw callsError

  // ---- Build negative-sentiment notifications.
  const negativeRows = (sentimentDocs ?? []).filter((d) => {
    const meta = (d.metadata ?? {}) as Record<string, unknown>
    return meta.sentiment_tier === 'red'
  }) as Array<{
    id: string
    created_at: string
    metadata: {
      sentiment_tier?: string
      call_id?: string
      client_id?: string | null
      started_at?: string
    }
  }>

  const clientIds = Array.from(
    new Set(
      negativeRows
        .map((r) => r.metadata.client_id)
        .filter((x): x is string => !!x),
    ),
  )
  const callIds = Array.from(
    new Set(
      negativeRows
        .map((r) => r.metadata.call_id)
        .filter((x): x is string => !!x),
    ),
  )

  const [clientLookup, callLookup] = await Promise.all([
    clientIds.length
      ? supabase.from('clients').select('id, full_name').in('id', clientIds)
      : Promise.resolve({ data: [] as Array<{ id: string; full_name: string }> }),
    callIds.length
      ? supabase.from('calls').select('id, title, started_at').in('id', callIds)
      : Promise.resolve({
          data: [] as Array<{ id: string; title: string | null; started_at: string }>,
        }),
  ])
  const clientNameById = new Map(
    (clientLookup.data ?? []).map((c) => [c.id, c.full_name]),
  )
  const callById = new Map(
    (callLookup.data ?? []).map((c) => [c.id, c]),
  )

  const sentimentNotifications: Notification[] = negativeRows
    .filter((r) => !!r.metadata.call_id)
    .map((r) => {
      const call = callById.get(r.metadata.call_id!) ?? null
      return {
        kind: 'negative_sentiment' as const,
        occurred_at: call?.started_at ?? r.created_at,
        call_id: r.metadata.call_id!,
        call_title: call?.title ?? null,
        client_id: r.metadata.client_id ?? null,
        client_name: r.metadata.client_id
          ? clientNameById.get(r.metadata.client_id) ?? null
          : null,
      }
    })

  // ---- Build missed-recording notifications.
  const calls = candidateCalls ?? []
  // CSM name lookup for the events.
  const teamMemberIds = Array.from(
    new Set((events ?? []).map((e) => e.team_member_id).filter((x): x is string => !!x)),
  )
  const { data: teamMemberRows } = teamMemberIds.length
    ? await supabase
        .from('team_members')
        .select('id, full_name')
        .in('id', teamMemberIds)
    : { data: [] as Array<{ id: string; full_name: string }> }
  const csmNameById = new Map(
    (teamMemberRows ?? []).map((tm) => [tm.id, tm.full_name]),
  )

  const missedNotifications: Notification[] = []
  for (const ev of events ?? []) {
    // End_time + 30 min cutoff. If end_time is null (shouldn't happen
    // per schema), treat as not-yet-passed and skip — we don't want to
    // surface alerts for events still in the future.
    if (!ev.end_time) continue
    const cutoffMs = new Date(ev.end_time).getTime() + 30 * 60 * 1000
    if (cutoffMs > now.getTime()) continue

    // Title + ±30 min match (same shape as teams.ts).
    const evTitleNorm = normalizeTitle(ev.title)
    if (!evTitleNorm) continue
    const evStartMs = new Date(ev.start_time).getTime()
    const matched = calls.some((c) => {
      if (normalizeTitle(c.title) !== evTitleNorm) return false
      const deltaMs = Math.abs(new Date(c.started_at).getTime() - evStartMs)
      return deltaMs <= 30 * 60 * 1000
    })
    if (matched) continue

    missedNotifications.push({
      kind: 'missed_recording',
      occurred_at: ev.start_time,
      google_event_id: ev.google_event_id,
      event_title: ev.title,
      csm_name: ev.team_member_id ? csmNameById.get(ev.team_member_id) ?? null : null,
      end_time: ev.end_time,
    })
  }

  // Combine + sort newest-first.
  return [...sentimentNotifications, ...missedNotifications].sort((a, b) =>
    a.occurred_at < b.occurred_at ? 1 : -1,
  )
}
