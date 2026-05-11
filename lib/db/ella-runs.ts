import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

// Anomaly flag identifiers shared by the list filter + summary band + detail view.
// Match the audit script's check IDs from scripts/audit_ella_interactions.py
// so semantics are identical across Python audit and dashboard.
export type AnomalyFlag = 'A' | 'B_prime' | 'C' | 'D' | 'E'

export const ANOMALY_FLAG_LABEL: Record<AnomalyFlag, string> = {
  A: 'ESCALATE leak',
  B_prime: 'Real-author mismatch',
  C: 'Error',
  D: 'Length outlier',
  E: 'Bare mention',
}

export type EllaRunsListFilters = {
  from?: string // ISO date, inclusive
  to?: string // ISO date, inclusive (end of day)
  channels?: string[]
  speaker_roles?: Array<'client' | 'advisor' | 'unresolvable' | 'unknown'>
  statuses?: string[]
  anomalies?: AnomalyFlag[]
}

export type EllaRunsListRow = {
  id: string
  started_at: string
  status: string
  trigger_type: string
  slack_channel_id: string | null
  channel_name: string | null
  channel_client_name: string | null
  real_author_role: string | null
  real_author_name: string | null
  input_summary: string | null
  llm_input_tokens: number | null
  llm_output_tokens: number | null
  llm_cost_usd: number | null
  duration_ms: number | null
  anomaly_flags: AnomalyFlag[]
  slack_response_text: string | null // For anomaly A detection
  has_escalation: boolean
}

export type EllaRunDetail = EllaRunsListRow & {
  output_summary: string | null
  error_message: string | null
  trigger_ts: string | null
  thread_ts: string | null
  trigger_metadata: Record<string, unknown>
  llm_model: string | null
  thread_messages: Array<{
    slack_ts: string
    slack_user_id: string
    author_type: string
    display_name: string | null
    text: string
    sent_at: string
    is_trigger: boolean
  }>
  escalation: {
    id: string
    reason: string
    status: string
    proposed_action: Record<string, unknown> | null
    resolution: Record<string, unknown> | null
    resolution_note: string | null
    resolved_at: string | null
    handoff_reasoning: string | null
  } | null
}

export type EllaSummaryStats = {
  total_today: number
  total_week: number
  total_month: number
  status_counts: Record<string, number>
  cost_today: number
  cost_week: number
  anomaly_count_today: number
}

// --- Internal helpers ------------------------------------------------------

type RawRunRow = {
  id: string
  started_at: string
  status: string
  trigger_type: string
  input_summary: string | null
  output_summary: string | null
  error_message: string | null
  llm_input_tokens: number | null
  llm_output_tokens: number | null
  llm_cost_usd: number | null
  duration_ms: number | null
  llm_model: string | null
  trigger_metadata: Record<string, unknown> | null
}

async function fetchChannelMap(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<Map<string, { name: string; client_id: string | null; client_name: string | null }>> {
  const { data: channels } = await supabase
    .from('slack_channels')
    .select('slack_channel_id, name, client_id, clients(full_name)')
  const map = new Map<string, { name: string; client_id: string | null; client_name: string | null }>()
  for (const c of channels ?? []) {
    const clientName = (c as { clients?: { full_name?: string } }).clients?.full_name ?? null
    map.set(c.slack_channel_id, {
      name: c.name,
      client_id: c.client_id,
      client_name: clientName,
    })
  }
  return map
}

function extractTriggerField(
  trigger_metadata: Record<string, unknown> | null,
  key: string,
): string | null {
  if (!trigger_metadata) return null
  const v = trigger_metadata[key]
  return typeof v === 'string' ? v : null
}

// --- Trigger-metadata shape adapters --------------------------------------
//
// Two `agent_runs.trigger_metadata` shapes coexist:
//
//   Reactive @-mention (Batch 1.5) writes via _redact_event:
//     channel, user, ts, thread_ts, event_ts, is_team_test,
//     real_author_role, real_author_name, real_author_id
//
//   Passive monitor (Batch 2.3) writes via persist_passive_evaluation:
//     triggering_slack_channel_id, triggering_message_slack_user_id,
//     triggering_message_ts, channel_client_id, author_type,
//     haiku_decision, haiku_reasoning, skip_reason, [test_mode_run]
//
// Before this fix the dashboard read only the reactive keys, leaving
// every passive_monitor row rendered as "unknown / unknown." These
// adapters give every caller a single key-shape-agnostic accessor.

function extractChannelId(
  trigger_metadata: Record<string, unknown> | null,
): string | null {
  return (
    extractTriggerField(trigger_metadata, 'channel') ??
    extractTriggerField(trigger_metadata, 'triggering_slack_channel_id')
  )
}

function extractAuthorSlackUserId(
  trigger_metadata: Record<string, unknown> | null,
): string | null {
  return (
    extractTriggerField(trigger_metadata, 'user') ??
    extractTriggerField(trigger_metadata, 'triggering_message_slack_user_id')
  )
}

// Maps the passive-path `author_type` Slack vocabulary onto the
// reactive-path `real_author_role` vocabulary so the audit dashboard's
// role-pill component sees the same value space across both shapes.
function deriveAuthorRoleFromAuthorType(
  authorType: string | null,
): string | null {
  if (!authorType) return null
  switch (authorType) {
    case 'client':
      return 'client'
    case 'team_member':
      return 'advisor'
    case 'ella':
      return 'ella'
    case 'bot':
    case 'workflow':
      return 'system'
    case 'unknown':
      return 'unresolvable'
    default:
      return null
  }
}

function extractAuthorRole(
  trigger_metadata: Record<string, unknown> | null,
): string | null {
  return (
    extractTriggerField(trigger_metadata, 'real_author_role') ??
    deriveAuthorRoleFromAuthorType(
      extractTriggerField(trigger_metadata, 'author_type'),
    )
  )
}

function extractAuthorName(
  trigger_metadata: Record<string, unknown> | null,
  userNameMap: Map<string, string>,
): string | null {
  // Reactive runs carry real_author_name directly (resolved at write
  // time via agents.ella.identity). Passive runs don't — look up the
  // speaker's slack_user_id against the prefetched clients/team_members
  // name map.
  const direct = extractTriggerField(trigger_metadata, 'real_author_name')
  if (direct) return direct
  const userId = extractAuthorSlackUserId(trigger_metadata)
  if (!userId) return null
  return userNameMap.get(userId) ?? null
}

async function fetchUserNameMap(
  supabase: ReturnType<typeof createAdminClient>,
  runs: RawRunRow[],
): Promise<Map<string, string>> {
  // Per-batch resolver for the speaker's slack_user_id. We only need to
  // resolve names for runs that don't already carry real_author_name in
  // their trigger_metadata (i.e. passive_monitor runs and any older
  // pre-Batch-1.5 reactive runs).
  const map = new Map<string, string>()
  const needsResolve = new Set<string>()
  for (const r of runs) {
    if (extractTriggerField(r.trigger_metadata, 'real_author_name')) continue
    const userId = extractAuthorSlackUserId(r.trigger_metadata)
    if (userId) needsResolve.add(userId)
  }
  if (needsResolve.size === 0) return map

  const userIds = Array.from(needsResolve)
  const { data: clients } = await supabase
    .from('clients')
    .select('slack_user_id, full_name')
    .in('slack_user_id', userIds)
    .is('archived_at', null)
  for (const c of clients ?? []) {
    if (c.slack_user_id && c.full_name) map.set(c.slack_user_id, c.full_name)
  }
  const { data: tms } = await supabase
    .from('team_members')
    .select('slack_user_id, full_name')
    .in('slack_user_id', userIds)
    .is('archived_at', null)
  for (const t of tms ?? []) {
    if (t.slack_user_id && t.full_name && !map.has(t.slack_user_id)) {
      map.set(t.slack_user_id, t.full_name)
    }
  }
  return map
}

async function fetchSlackResponseTexts(
  supabase: ReturnType<typeof createAdminClient>,
  runs: RawRunRow[],
): Promise<Map<string, string>> {
  // For anomaly A detection we need the full Slack-side response text
  // (agent_runs.output_summary truncates at 200 chars). Query
  // slack_messages for each run's channel + thread + Ella-author rows
  // landing shortly after the run start. Done as one batched query.
  const out = new Map<string, string>()
  const runsWithChannel = runs.filter(
    (r) => extractChannelId(r.trigger_metadata),
  )
  if (runsWithChannel.length === 0) return out

  // Build a per-channel + per-thread map: for each unique (channel,
  // thread_ts) compute the run's started_at + 5 min window.
  const channelToRuns = new Map<string, RawRunRow[]>()
  for (const r of runsWithChannel) {
    const ch = extractChannelId(r.trigger_metadata)!
    const arr = channelToRuns.get(ch) ?? []
    arr.push(r)
    channelToRuns.set(ch, arr)
  }

  for (const [ch, channelRuns] of Array.from(channelToRuns.entries())) {
    // Earliest run minus 1 min, latest run plus 5 min — bracket the
    // window we need to scan per channel.
    const minStarted = channelRuns
      .map((r: RawRunRow) => r.started_at)
      .sort()[0]
    const maxStarted = channelRuns
      .map((r: RawRunRow) => r.started_at)
      .sort()
      .slice(-1)[0]
    const fromTs = new Date(new Date(minStarted).getTime() - 60_000).toISOString()
    const toTs = new Date(new Date(maxStarted).getTime() + 5 * 60_000).toISOString()

    const { data: msgs } = await supabase
      .from('slack_messages')
      .select('slack_ts, slack_thread_ts, slack_user_id, text, sent_at')
      .eq('slack_channel_id', ch)
      .in('author_type', ['ella', 'bot'])
      .gte('sent_at', fromTs)
      .lte('sent_at', toTs)
      .order('sent_at', { ascending: true })

    for (const r of channelRuns) {
      const thread_ts = extractTriggerField(r.trigger_metadata, 'thread_ts')
      const startedMs = new Date(r.started_at).getTime()
      // Find first Ella/bot message in same thread (or same channel
      // if no thread) within 5 min after run start.
      const match = (msgs ?? []).find((m) => {
        const sentMs = new Date(m.sent_at).getTime()
        if (sentMs < startedMs) return false
        if (sentMs > startedMs + 5 * 60_000) return false
        // Prefer thread match when both have a thread_ts.
        if (thread_ts && m.slack_thread_ts) {
          return m.slack_thread_ts === thread_ts || m.slack_ts === thread_ts
        }
        // Otherwise just match the channel.
        return true
      })
      if (match) {
        out.set(r.id, match.text)
      }
    }
  }
  return out
}

async function fetchEscalationRunIds(
  supabase: ReturnType<typeof createAdminClient>,
  runIds: string[],
): Promise<Set<string>> {
  if (runIds.length === 0) return new Set()
  const { data: escs } = await supabase
    .from('escalations')
    .select('agent_run_id')
    .in('agent_run_id', runIds)
  return new Set((escs ?? []).map((e) => e.agent_run_id).filter((x): x is string => !!x))
}

function computeAnomalyFlags(args: {
  run: RawRunRow
  channelClientId: string | null
  slackResponseText: string | null
  hasEscalation: boolean
  lengthOutlierIds: Set<string>
}): AnomalyFlag[] {
  const flags: AnomalyFlag[] = []
  const { run, channelClientId, slackResponseText, hasEscalation, lengthOutlierIds } = args

  // Check A: [ESCALATE] in Slack response AND no escalations row.
  if (slackResponseText && slackResponseText.includes('[ESCALATE]') && !hasEscalation) {
    flags.push('A')
  }
  // Check B': real_author_id != channel-mapped client_id (or role=advisor).
  // The role read uses the adapter so passive runs' author_type maps
  // consistently (e.g. team_member -> advisor). For real_author_id the
  // reactive path writes it explicitly; passive runs don't carry an
  // equivalent (channel_client_id is on the metadata but represents
  // the CHANNEL's mapped client, not the speaker's resolved client id).
  // B' on passive runs effectively triggers when the resolved role is
  // 'advisor' — that matches the production design where a team_member
  // posting in a client channel under test_mode should be flagged.
  const realRole = extractAuthorRole(run.trigger_metadata)
  const realId = extractTriggerField(run.trigger_metadata, 'real_author_id')
  if (realRole === 'advisor' || (realRole === 'client' && channelClientId && realId && realId !== channelClientId)) {
    flags.push('B_prime')
  }
  // Check C: status='error'.
  if (run.status === 'error') flags.push('C')
  // Check D: top/bottom length outliers across the result window.
  if (lengthOutlierIds.has(run.id)) flags.push('D')
  // Check E: bare-mention trigger.
  if (run.trigger_type === 'bare_mention') flags.push('E')

  return flags
}

function computeLengthOutliers(runs: RawRunRow[], texts: Map<string, string>): Set<string> {
  // Top 5% + bottom 5% of Slack-response lengths. Fallback to
  // output_summary length when slack text isn't available.
  const lengths = runs
    .map((r) => {
      const t = texts.get(r.id) ?? r.output_summary ?? ''
      return { id: r.id, len: t.length }
    })
    .filter((x) => x.len > 0)
    .sort((a, b) => a.len - b.len)
  if (lengths.length < 6) return new Set() // Too few to outlier-flag.
  const k = Math.max(1, Math.floor(lengths.length * 0.05))
  const out = new Set<string>()
  for (let i = 0; i < k; i++) out.add(lengths[i].id)
  for (let i = lengths.length - k; i < lengths.length; i++) out.add(lengths[i].id)
  return out
}

// --- Public API ------------------------------------------------------------

export async function getEllaRunsList(
  filters: EllaRunsListFilters,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
): Promise<{ rows: EllaRunsListRow[]; total: number }> {
  const supabase = createAdminClient()

  let query = supabase
    .from('agent_runs')
    .select(
      'id,started_at,status,trigger_type,input_summary,output_summary,error_message,llm_input_tokens,llm_output_tokens,llm_cost_usd,duration_ms,llm_model,trigger_metadata',
      { count: 'exact' },
    )
    .eq('agent_name', 'ella')
    .order('started_at', { ascending: false })

  if (filters.from) query = query.gte('started_at', filters.from)
  if (filters.to) {
    const toEnd = new Date(filters.to)
    toEnd.setHours(23, 59, 59, 999)
    query = query.lte('started_at', toEnd.toISOString())
  }
  if (filters.statuses && filters.statuses.length) {
    query = query.in('status', filters.statuses)
  }

  // Pull enough rows for outlier computation across the window even
  // though we paginate at the end.
  const { data: rawRuns } = await query.range(0, 1000)
  const runs = (rawRuns ?? []) as RawRunRow[]

  const channelMap = await fetchChannelMap(supabase)
  const userNameMap = await fetchUserNameMap(supabase, runs)
  const responseTexts = await fetchSlackResponseTexts(supabase, runs)
  const escalationIds = await fetchEscalationRunIds(
    supabase,
    runs.map((r) => r.id),
  )
  const lengthOutliers = computeLengthOutliers(runs, responseTexts)

  // Project + filter (channel / role / anomaly filters happen in JS
  // since they touch joined data).
  let projected: EllaRunsListRow[] = runs.map((r) => {
    const ch = extractChannelId(r.trigger_metadata)
    const channelInfo = ch ? channelMap.get(ch) : undefined
    const slackText = responseTexts.get(r.id) ?? null
    const flags = computeAnomalyFlags({
      run: r,
      channelClientId: channelInfo?.client_id ?? null,
      slackResponseText: slackText,
      hasEscalation: escalationIds.has(r.id),
      lengthOutlierIds: lengthOutliers,
    })
    return {
      id: r.id,
      started_at: r.started_at,
      status: r.status,
      trigger_type: r.trigger_type,
      slack_channel_id: ch,
      channel_name: channelInfo?.name ?? null,
      channel_client_name: channelInfo?.client_name ?? null,
      real_author_role: extractAuthorRole(r.trigger_metadata),
      real_author_name: extractAuthorName(r.trigger_metadata, userNameMap),
      input_summary: r.input_summary,
      llm_input_tokens: r.llm_input_tokens,
      llm_output_tokens: r.llm_output_tokens,
      llm_cost_usd: r.llm_cost_usd,
      duration_ms: r.duration_ms,
      anomaly_flags: flags,
      slack_response_text: slackText,
      has_escalation: escalationIds.has(r.id),
    }
  })

  if (filters.channels && filters.channels.length) {
    const set = new Set(filters.channels)
    projected = projected.filter((r) => r.slack_channel_id && set.has(r.slack_channel_id))
  }
  if (filters.speaker_roles && filters.speaker_roles.length) {
    const set = new Set(filters.speaker_roles)
    projected = projected.filter((r) => {
      const role = (r.real_author_role ?? 'unknown') as
        | 'client'
        | 'advisor'
        | 'unresolvable'
        | 'unknown'
      return set.has(role)
    })
  }
  if (filters.anomalies && filters.anomalies.length) {
    const set = new Set(filters.anomalies)
    projected = projected.filter((r) => r.anomaly_flags.some((f) => set.has(f)))
  }

  const total = projected.length
  const paged = projected.slice(offset, offset + limit)
  return { rows: paged, total }
}

export async function getEllaRunDetail(id: string): Promise<EllaRunDetail | null> {
  const supabase = createAdminClient()
  const { data: row } = await supabase
    .from('agent_runs')
    .select('*')
    .eq('id', id)
    .eq('agent_name', 'ella')
    .single()
  if (!row) return null

  const r = row as RawRunRow
  const channelMap = await fetchChannelMap(supabase)
  const userNameMap = await fetchUserNameMap(supabase, [r])
  const ch = extractChannelId(r.trigger_metadata)
  const channelInfo = ch ? channelMap.get(ch) : undefined
  const responseTexts = await fetchSlackResponseTexts(supabase, [r])
  const escalationIds = await fetchEscalationRunIds(supabase, [r.id])

  // Reactive path stores the triggering message ts under `ts`; passive
  // path stores it under `triggering_message_ts`. thread_ts is reactive-
  // only — passive runs have no thread and the surrounding-thread-context
  // block below correctly short-circuits when thread_ts is null.
  const trigger_ts =
    extractTriggerField(r.trigger_metadata, 'ts') ??
    extractTriggerField(r.trigger_metadata, 'triggering_message_ts')
  const thread_ts = extractTriggerField(r.trigger_metadata, 'thread_ts')

  // Surrounding thread context — last 15 messages in same channel/thread
  // up to and including the trigger.
  let threadMessages: EllaRunDetail['thread_messages'] = []
  if (ch && thread_ts) {
    const { data: msgs } = await supabase
      .from('slack_messages')
      .select('slack_ts, slack_thread_ts, slack_user_id, author_type, text, sent_at')
      .eq('slack_channel_id', ch)
      .or(`slack_thread_ts.eq.${thread_ts},slack_ts.eq.${thread_ts}`)
      .order('sent_at', { ascending: true })
      .limit(20)

    const userIds = Array.from(
      new Set((msgs ?? []).map((m) => m.slack_user_id).filter((x): x is string => !!x)),
    )
    const nameMap = new Map<string, string>()
    if (userIds.length) {
      const { data: clients } = await supabase
        .from('clients')
        .select('slack_user_id, full_name')
        .in('slack_user_id', userIds)
        .is('archived_at', null)
      for (const c of clients ?? []) {
        if (c.slack_user_id) nameMap.set(c.slack_user_id, c.full_name)
      }
      const { data: tms } = await supabase
        .from('team_members')
        .select('slack_user_id, full_name')
        .in('slack_user_id', userIds)
        .is('archived_at', null)
      for (const t of tms ?? []) {
        if (t.slack_user_id && !nameMap.has(t.slack_user_id)) {
          nameMap.set(t.slack_user_id, t.full_name)
        }
      }
    }

    threadMessages = (msgs ?? []).map((m) => ({
      slack_ts: m.slack_ts,
      slack_user_id: m.slack_user_id,
      author_type: m.author_type,
      display_name: nameMap.get(m.slack_user_id) ?? null,
      text: m.text,
      sent_at: m.sent_at,
      is_trigger: m.slack_ts === trigger_ts,
    }))
  }

  // Escalation row.
  let escalation: EllaRunDetail['escalation'] = null
  if (escalationIds.has(r.id)) {
    const { data: esc } = await supabase
      .from('escalations')
      .select('id, reason, status, proposed_action, resolution, resolution_note, resolved_at, context')
      .eq('agent_run_id', r.id)
      .single()
    if (esc) {
      const ctx = (esc.context as Record<string, unknown>) ?? {}
      escalation = {
        id: esc.id,
        reason: esc.reason,
        status: esc.status,
        proposed_action: (esc.proposed_action as Record<string, unknown>) ?? null,
        resolution: (esc.resolution as Record<string, unknown>) ?? null,
        resolution_note: esc.resolution_note,
        resolved_at: esc.resolved_at,
        handoff_reasoning: typeof ctx['handoff_reasoning'] === 'string' ? (ctx['handoff_reasoning'] as string) : null,
      }
    }
  }

  const slackText = responseTexts.get(r.id) ?? null
  const lengthOutliers = computeLengthOutliers([r], responseTexts)
  const flags = computeAnomalyFlags({
    run: r,
    channelClientId: channelInfo?.client_id ?? null,
    slackResponseText: slackText,
    hasEscalation: escalationIds.has(r.id),
    lengthOutlierIds: lengthOutliers,
  })

  return {
    id: r.id,
    started_at: r.started_at,
    status: r.status,
    trigger_type: r.trigger_type,
    slack_channel_id: ch,
    channel_name: channelInfo?.name ?? null,
    channel_client_name: channelInfo?.client_name ?? null,
    real_author_role: extractAuthorRole(r.trigger_metadata),
    real_author_name: extractAuthorName(r.trigger_metadata, userNameMap),
    input_summary: r.input_summary,
    output_summary: r.output_summary,
    error_message: r.error_message,
    trigger_ts,
    thread_ts,
    trigger_metadata: r.trigger_metadata ?? {},
    llm_model: r.llm_model,
    llm_input_tokens: r.llm_input_tokens,
    llm_output_tokens: r.llm_output_tokens,
    llm_cost_usd: r.llm_cost_usd,
    duration_ms: r.duration_ms,
    anomaly_flags: flags,
    slack_response_text: slackText,
    has_escalation: escalationIds.has(r.id),
    thread_messages: threadMessages,
    escalation,
  }
}

export async function getEllaSummaryStats(): Promise<EllaSummaryStats> {
  const supabase = createAdminClient()
  const now = new Date()
  const todayStart = new Date(now)
  todayStart.setHours(0, 0, 0, 0)
  const weekStart = new Date(todayStart)
  weekStart.setDate(weekStart.getDate() - 6)
  const monthStart = new Date(todayStart)
  monthStart.setDate(monthStart.getDate() - 29)

  const { data: monthRuns } = await supabase
    .from('agent_runs')
    .select('id,started_at,status,llm_cost_usd,trigger_type,trigger_metadata,output_summary,error_message,llm_input_tokens,llm_output_tokens,duration_ms,llm_model,input_summary')
    .eq('agent_name', 'ella')
    .gte('started_at', monthStart.toISOString())
    .order('started_at', { ascending: false })

  const runs = (monthRuns ?? []) as RawRunRow[]
  const channelMap = await fetchChannelMap(supabase)
  const responseTexts = await fetchSlackResponseTexts(supabase, runs)
  const escalationIds = await fetchEscalationRunIds(
    supabase,
    runs.map((r) => r.id),
  )
  const lengthOutliers = computeLengthOutliers(runs, responseTexts)

  const todayMs = todayStart.getTime()
  const weekMs = weekStart.getTime()
  const total_today = runs.filter((r) => new Date(r.started_at).getTime() >= todayMs).length
  const total_week = runs.filter((r) => new Date(r.started_at).getTime() >= weekMs).length
  const total_month = runs.length

  const status_counts: Record<string, number> = {}
  for (const r of runs) status_counts[r.status] = (status_counts[r.status] ?? 0) + 1

  const cost_today = runs
    .filter((r) => new Date(r.started_at).getTime() >= todayMs)
    .reduce((sum, r) => sum + (r.llm_cost_usd ?? 0), 0)
  const cost_week = runs
    .filter((r) => new Date(r.started_at).getTime() >= weekMs)
    .reduce((sum, r) => sum + (r.llm_cost_usd ?? 0), 0)

  const anomaly_count_today = runs.filter((r) => {
    if (new Date(r.started_at).getTime() < todayMs) return false
    const ch = extractChannelId(r.trigger_metadata)
    const channelInfo = ch ? channelMap.get(ch) : undefined
    const flags = computeAnomalyFlags({
      run: r,
      channelClientId: channelInfo?.client_id ?? null,
      slackResponseText: responseTexts.get(r.id) ?? null,
      hasEscalation: escalationIds.has(r.id),
      lengthOutlierIds: lengthOutliers,
    })
    return flags.length > 0
  }).length

  return {
    total_today,
    total_week,
    total_month,
    status_counts,
    cost_today,
    cost_week,
    anomaly_count_today,
  }
}

export async function listChannelsWithEllaRuns(): Promise<Array<{ slack_channel_id: string; name: string }>> {
  const supabase = createAdminClient()
  // Pull distinct channels that have ≥1 Ella run via the
  // trigger_metadata.channel field. Done by fetching all Ella runs'
  // trigger_metadata.channel + dedupe in JS — fine at current scale
  // (28 V1 runs, hundreds/day projected post-2.3 still trivial).
  const { data: runs } = await supabase
    .from('agent_runs')
    .select('trigger_metadata')
    .eq('agent_name', 'ella')
  const channelIds = new Set<string>()
  for (const r of runs ?? []) {
    const ch = extractChannelId(r.trigger_metadata as Record<string, unknown> | null)
    if (ch) channelIds.add(ch)
  }
  if (channelIds.size === 0) return []
  const { data: channels } = await supabase
    .from('slack_channels')
    .select('slack_channel_id, name')
    .in('slack_channel_id', Array.from(channelIds))
  return (channels ?? []).map((c) => ({
    slack_channel_id: c.slack_channel_id,
    name: c.name,
  }))
}
