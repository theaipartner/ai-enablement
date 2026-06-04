// Fulfillment Dashboard data layer.
//
// Aggregations (active clients total / by CSM / by journey stage) and
// the notifications feed (negative-sentiment call_reviews on the day,
// missed-recording flags from calendar_events with no matched call).
//
// All reads use createAdminClient — server-only. JS-side aggregation
// because the dataset is tiny (~200 active clients, ~30 events/day per
// CSM, ~30 reviews/day worst case).

import { cache } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { JOURNEY_STAGE_LABEL } from '@/lib/client-vocab'

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

// Lookback window for both call-flag feeds (sentiment + missing recording).
const CALL_FLAG_LOOKBACK_DAYS = 3

function normalizeTitle(t: string | null | undefined): string {
  return (t ?? '').trim().toLowerCase().replace(/\s+/g, ' ')
}

// ---- Sentiment call flags: mixed (yellow) or negative (red) call reviews
// from the past 3 days.
export type SentimentCallFlag = {
  call_id: string
  call_title: string | null
  client_id: string | null
  client_name: string | null
  sentiment: 'yellow' | 'red'
  occurred_at: string
}

export async function getSentimentCallFlags(): Promise<SentimentCallFlag[]> {
  const supabase = createAdminClient()
  const since = new Date(
    Date.now() - CALL_FLAG_LOOKBACK_DAYS * 86_400_000,
  ).toISOString()

  const { data: docs, error } = await supabase
    .from('documents')
    .select('id, metadata, created_at')
    .eq('document_type', 'call_review')
    .gte('created_at', since)
    .order('created_at', { ascending: false })
  if (error) throw error

  const rows = (docs ?? []).filter((d) => {
    const t = ((d.metadata ?? {}) as Record<string, unknown>).sentiment_tier
    return t === 'red' || t === 'yellow'
  }) as Array<{
    created_at: string
    metadata: { sentiment_tier?: string; call_id?: string; client_id?: string | null }
  }>

  const clientIds = Array.from(
    new Set(rows.map((r) => r.metadata.client_id).filter((x): x is string => !!x)),
  )
  const callIds = Array.from(
    new Set(rows.map((r) => r.metadata.call_id).filter((x): x is string => !!x)),
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
  const callById = new Map((callLookup.data ?? []).map((c) => [c.id, c]))

  return rows
    .filter((r) => !!r.metadata.call_id)
    .map((r) => {
      const call = callById.get(r.metadata.call_id!) ?? null
      return {
        call_id: r.metadata.call_id!,
        call_title: call?.title ?? null,
        client_id: r.metadata.client_id ?? null,
        client_name: r.metadata.client_id
          ? clientNameById.get(r.metadata.client_id) ?? null
          : null,
        sentiment: (r.metadata.sentiment_tier === 'red' ? 'red' : 'yellow') as
          | 'red'
          | 'yellow',
        occurred_at: call?.started_at ?? r.created_at,
      }
    })
    .sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
}

// ---- Missing-recording flags: calendar events from the past 3 days whose
// 30-min post-end grace has elapsed with no matching Fathom call, scoped to
// clients with at-risk / problem CSM standing. The client is resolved from
// the event's external attendees (email / alternate_emails).
export type MissingRecordingFlag = {
  google_event_id: string
  event_title: string | null
  client_id: string
  client_name: string
  csm_standing: string
  csm_name: string | null
  occurred_at: string
}

export async function getMissingRecordingFlags(): Promise<MissingRecordingFlag[]> {
  const supabase = createAdminClient()
  const now = Date.now()
  const since = new Date(now - CALL_FLAG_LOOKBACK_DAYS * 86_400_000).toISOString()

  // At-risk / problem clients → email lookup (email + alternate_emails).
  const { data: flaggedClients, error: clientErr } = await supabase
    .from('clients')
    .select('id, full_name, email, metadata, csm_standing')
    .in('csm_standing', ['at_risk', 'problem'])
    .is('archived_at', null)
  if (clientErr) throw clientErr

  type FlaggedClient = { id: string; full_name: string; csm_standing: string }
  const emailToClient = new Map<string, FlaggedClient>()
  for (const c of flaggedClients ?? []) {
    const fc: FlaggedClient = {
      id: c.id as string,
      full_name: (c.full_name as string | null) ?? '(no name)',
      csm_standing: c.csm_standing as string,
    }
    const reg = (e: string | null | undefined) => {
      if (e && e.trim()) emailToClient.set(e.trim().toLowerCase(), fc)
    }
    reg(c.email as string | null)
    const meta = (c.metadata ?? {}) as Record<string, unknown>
    for (const alt of (meta.alternate_emails as string[] | undefined) ?? []) {
      if (typeof alt === 'string') reg(alt)
    }
  }
  if (emailToClient.size === 0) return []

  const [
    { data: events, error: eventsErr },
    { data: candidateCalls, error: callsErr },
  ] = await Promise.all([
    supabase
      .from('calendar_events')
      .select('google_event_id, title, start_time, end_time, team_member_id, attendees')
      .gte('start_time', since)
      .lte('start_time', new Date(now).toISOString())
      .order('start_time', { ascending: false }),
    supabase
      .from('calls')
      .select('id, title, started_at')
      .eq('call_category', 'client')
      .gte('started_at', since)
      .lt('started_at', new Date(now + 30 * 60 * 1000).toISOString()),
  ])
  if (eventsErr) throw eventsErr
  if (callsErr) throw callsErr
  const calls = candidateCalls ?? []

  const tmIds = Array.from(
    new Set(
      (events ?? []).map((e) => e.team_member_id).filter((x): x is string => !!x),
    ),
  )
  const { data: tms } = tmIds.length
    ? await supabase.from('team_members').select('id, full_name').in('id', tmIds)
    : { data: [] as Array<{ id: string; full_name: string }> }
  const csmNameById = new Map((tms ?? []).map((t) => [t.id, t.full_name]))

  const flags: MissingRecordingFlag[] = []
  for (const ev of events ?? []) {
    if (!ev.end_time) continue
    if (new Date(ev.end_time).getTime() + 30 * 60 * 1000 > now) continue
    const titleNorm = normalizeTitle(ev.title)
    if (!titleNorm) continue
    const evStartMs = new Date(ev.start_time).getTime()
    const matched = calls.some(
      (c) =>
        normalizeTitle(c.title) === titleNorm &&
        Math.abs(new Date(c.started_at).getTime() - evStartMs) <= 30 * 60 * 1000,
    )
    if (matched) continue

    // Attribute to a flagged client via the event's external attendees.
    let client: FlaggedClient | null = null
    for (const a of (ev.attendees ?? []) as Array<{ email?: string }>) {
      const e = (a.email ?? '').trim().toLowerCase()
      const hit = e ? emailToClient.get(e) : undefined
      if (hit) {
        client = hit
        break
      }
    }
    if (!client) continue

    flags.push({
      google_event_id: ev.google_event_id,
      event_title: ev.title,
      client_id: client.id,
      client_name: client.full_name,
      csm_standing: client.csm_standing,
      csm_name: ev.team_member_id
        ? csmNameById.get(ev.team_member_id) ?? null
        : null,
      occurred_at: ev.start_time,
    })
  }
  return flags.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
}

// ---- Late-start flags: client calls whose Fathom recording began 10+ minutes
// after the scheduled calendar start, past 3 days. A call is matched to a
// calendar event by normalized title within a ±30-min window (so 10–30 min
// late is detectable); the client comes from the call's primary_client_id.
const LATE_START_THRESHOLD_MIN = 10

export type LateStartFlag = {
  call_id: string
  call_title: string | null
  client_id: string | null
  client_name: string | null
  minutes_late: number
  occurred_at: string
}

export async function getLateStartFlags(): Promise<LateStartFlag[]> {
  const supabase = createAdminClient()
  const now = Date.now()
  const since = new Date(now - CALL_FLAG_LOOKBACK_DAYS * 86_400_000).toISOString()
  const nowIso = new Date(now).toISOString()

  const [
    { data: events, error: eventsErr },
    { data: calls, error: callsErr },
  ] = await Promise.all([
    supabase
      .from('calendar_events')
      .select('title, start_time')
      .gte('start_time', since)
      .lte('start_time', nowIso),
    supabase
      .from('calls')
      .select('id, title, started_at, primary_client_id')
      .eq('call_category', 'client')
      .gte('started_at', since)
      .lte('started_at', nowIso),
  ])
  if (eventsErr) throw eventsErr
  if (callsErr) throw callsErr

  const eventList = (events ?? []) as Array<{
    title: string | null
    start_time: string
  }>
  const callList = (calls ?? []) as Array<{
    id: string
    title: string | null
    started_at: string
    primary_client_id: string | null
  }>

  const clientIds = Array.from(
    new Set(
      callList.map((c) => c.primary_client_id).filter((x): x is string => !!x),
    ),
  )
  const { data: clientRows } = clientIds.length
    ? await supabase.from('clients').select('id, full_name').in('id', clientIds)
    : { data: [] as Array<{ id: string; full_name: string }> }
  const nameById = new Map((clientRows ?? []).map((c) => [c.id, c.full_name]))

  const flags: LateStartFlag[] = []
  for (const call of callList) {
    const titleNorm = normalizeTitle(call.title)
    if (!titleNorm) continue
    const callStart = new Date(call.started_at).getTime()

    // Closest same-title event within ±30 min = the scheduled meeting.
    let bestStart: number | null = null
    let bestDelta = Number.POSITIVE_INFINITY
    for (const ev of eventList) {
      if (normalizeTitle(ev.title) !== titleNorm) continue
      const evStart = new Date(ev.start_time).getTime()
      const delta = Math.abs(callStart - evStart)
      if (delta <= 30 * 60 * 1000 && delta < bestDelta) {
        bestDelta = delta
        bestStart = evStart
      }
    }
    if (bestStart === null) continue

    const minutesLate = Math.round((callStart - bestStart) / 60000)
    if (minutesLate < LATE_START_THRESHOLD_MIN) continue

    flags.push({
      call_id: call.id,
      call_title: call.title,
      client_id: call.primary_client_id ?? null,
      client_name: call.primary_client_id
        ? nameById.get(call.primary_client_id) ?? null
        : null,
      minutes_late: minutesLate,
      occurred_at: call.started_at,
    })
  }
  return flags.sort((a, b) => (a.occurred_at < b.occurred_at ? 1 : -1))
}

// ---------------------------------------------------------------------------
// Needs-review clients
// ---------------------------------------------------------------------------
//
// Clients auto-created by the Fathom classifier when it couldn't
// confidently resolve a call participant. They carry the `needs_review`
// tag (see docs/schema/clients.md) and surface in the dashboard box so
// the CSM lead can clear the tag, merge the row into the real client, or
// archive it. `metadata` carries the auto-create breadcrumbs we show as
// context (what call spawned the row).

export type NeedsReviewClient = {
  id: string
  full_name: string
  email: string
  created_at: string
  auto_create_reason: string | null
  auto_created_from_call_title: string | null
}

export async function getNeedsReviewClients(): Promise<NeedsReviewClient[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('clients')
    .select('id, full_name, email, created_at, metadata')
    .contains('tags', ['needs_review'])
    .is('archived_at', null)
    .order('created_at', { ascending: false })

  if (error) throw error
  const rows = (data ?? []) as Array<{
    id: string
    full_name: string | null
    email: string | null
    created_at: string
    metadata: Record<string, unknown> | null
  }>

  return rows.map((r) => {
    const meta = r.metadata ?? {}
    return {
      id: r.id,
      full_name: r.full_name ?? '(no name)',
      email: r.email ?? '',
      created_at: r.created_at,
      auto_create_reason:
        typeof meta.auto_create_reason === 'string'
          ? meta.auto_create_reason
          : null,
      auto_created_from_call_title:
        typeof meta.auto_created_from_call_title === 'string'
          ? meta.auto_created_from_call_title
          : null,
    }
  })
}

// All active (non-archived) clients as merge targets for the dashboard
// needs-review box. Mirrors listMergeCandidates (lib/db/merge.ts) but
// without a single-source exclusion — the box has many sources, so each
// row filters itself out client-side. email coerced to '' so the
// SearchableClientSelect's string ops are safe.
export async function getNeedsReviewMergeCandidates(): Promise<
  { id: string; full_name: string; email: string }[]
> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('clients')
    .select('id, full_name, email')
    .is('archived_at', null)
    .order('full_name', { ascending: true })

  if (error) throw error
  return (data ?? []).map((r) => ({
    id: r.id as string,
    full_name: (r.full_name as string | null) ?? '(no name)',
    email: (r.email as string | null) ?? '',
  }))
}

// ---------------------------------------------------------------------------
// Client channel signals (ghost flags + uninstrumented channels)
// ---------------------------------------------------------------------------
//
// Both derive from one Postgres aggregate (client_channel_signals RPC,
// migration 0074) — per active client, the latest author_type='client'
// message in their channel plus whether the channel has ANY ingested message.
// The aggregate runs server-side to avoid PostgREST's 1000-row fetch cap (see
// the migration header). The RPC isn't in the generated types yet; reach it
// through an untyped handle (same pattern as lib/db/client-meetings.ts).

const GHOST_SILENCE_DAYS = 14

type ClientChannelSignal = {
  client_id: string
  full_name: string | null
  slack_user_id: string | null
  slack_channel_id: string | null
  channel_name: string | null
  channel_created_at: string | null
  last_client_message_at: string | null
  ghost_dismissed_at: string | null
  channel_has_messages: boolean
}

// cache() dedupes the RPC to a single call per request even though both the
// ghost and the uninstrumented-channel readers below consume it.
const getClientChannelSignals = cache(
  async function getClientChannelSignals(): Promise<ClientChannelSignal[]> {
    const supabase = createAdminClient() as unknown as SupabaseClient
    const { data, error } = await supabase.rpc('client_channel_signals')
    if (error) throw error
    return (data ?? []) as ClientChannelSignal[]
  },
)

// Active clients silent in their Slack channel 14+ days. Channels with no
// ingested messages (bot not present) are excluded — we have no visibility,
// so we don't claim "ghost" (those surface under getUninstrumentedChannels).
// Channels younger than 14 days are excluded (no time to go quiet). A CSM can
// dismiss via metadata.ghost_dismissed_at; hidden until the client posts again.
export type GhostClientFlag = {
  id: string
  full_name: string
  last_client_message_at: string | null // null when the client has never posted
  days_silent: number | null
}

export async function getGhostClientFlags(): Promise<GhostClientFlag[]> {
  const rows = await getClientChannelSignals()
  const now = Date.now()
  const silenceCutoff = now - GHOST_SILENCE_DAYS * 86_400_000

  const flags: GhostClientFlag[] = []
  for (const row of rows) {
    if (!row.channel_created_at) continue
    // No slack_user_id → their messages can't be attributed (they'd look
    // silent regardless). They belong in Missing Slack IDs, not here.
    if (!row.slack_user_id) continue
    if (!row.channel_has_messages) continue // bot not in channel — no visibility
    if (new Date(row.channel_created_at).getTime() > silenceCutoff) continue
    const last = row.last_client_message_at
      ? new Date(row.last_client_message_at).getTime()
      : null
    if (last !== null && last >= silenceCutoff) continue
    if (row.ghost_dismissed_at) {
      const dismissed = new Date(row.ghost_dismissed_at).getTime()
      if (last === null || last <= dismissed) continue
    }
    flags.push({
      id: row.client_id,
      full_name: row.full_name ?? '(no name)',
      last_client_message_at: row.last_client_message_at,
      days_silent:
        last !== null ? Math.floor((now - last) / 86_400_000) : null,
    })
  }

  flags.sort(
    (a, b) =>
      (b.days_silent ?? Number.POSITIVE_INFINITY) -
      (a.days_silent ?? Number.POSITIVE_INFINITY),
  )
  return flags
}

// Channels for active clients with ZERO ingested messages — i.e. the Slack
// bot / Ella isn't a member, so we capture nothing (and Ella's digest is
// blind to them). Surfaces under the dashboard's "Channel flags" section as a
// to-do for inviting the bot. Resolves automatically once the bot is added
// and a message ingests.
export type UninstrumentedChannel = {
  client_id: string
  full_name: string
  channel_name: string | null
}

export async function getUninstrumentedChannels(): Promise<
  UninstrumentedChannel[]
> {
  const rows = await getClientChannelSignals()
  return rows
    // Missing slack_user_id → surfaced under Missing Slack IDs instead; only
    // clients with complete IDs belong here.
    .filter((r) => !r.channel_has_messages && !!r.slack_user_id)
    .map((r) => ({
      client_id: r.client_id,
      full_name: r.full_name ?? '(no name)',
      channel_name: r.channel_name,
    }))
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
}

// ---------------------------------------------------------------------------
// Missing Slack IDs
// ---------------------------------------------------------------------------
//
// Active clients with no slack_user_id and/or no mapped (non-archived) Slack
// channel — the same condition the client list/detail flags via pills. Shown
// on the dashboard with inline actions to add either id, so it no longer needs
// a manual curl. Clients here are excluded from No Ella / Ghost until complete.

export type MissingSlackClient = {
  client_id: string
  full_name: string
  missing_user: boolean
  missing_channel: boolean
}

export async function getMissingSlackClients(): Promise<MissingSlackClient[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('clients')
    .select('id, full_name, slack_user_id, slack_channels(slack_channel_id, is_archived)')
    .eq('status', 'active')
    .is('archived_at', null)
  if (error) throw error

  const out: MissingSlackClient[] = []
  for (const row of (data ?? []) as Array<{
    id: string
    full_name: string | null
    slack_user_id: string | null
    slack_channels: Array<{ slack_channel_id: string; is_archived: boolean }> | null
  }>) {
    const hasChannel = (row.slack_channels ?? []).some((c) => !c.is_archived)
    const missing_user = !row.slack_user_id
    const missing_channel = !hasChannel
    if (missing_user || missing_channel) {
      out.push({
        client_id: row.id,
        full_name: row.full_name ?? '(no name)',
        missing_user,
        missing_channel,
      })
    }
  }
  return out.sort((a, b) => a.full_name.localeCompare(b.full_name))
}
