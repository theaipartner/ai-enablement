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
  // List-page "Output" column source. Prefer non-empty output_summary
  // from agent_runs; fall back to the matching slack_messages text via
  // fetchSlackResponseTexts; null if neither available. Slack <@U...>
  // mentions resolved to readable @First Last form before this lands
  // here — table renders dumb.
  output_text: string | null
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
  // Single "surrounding messages" slot covering both reactive (in-thread)
  // and passive (last-N-in-channel) runs — Part 2 collapses the two
  // formerly-distinct rendering paths into one shape.
  thread_messages: Array<{
    slack_ts: string
    slack_user_id: string
    author_type: string
    display_name: string | null
    text: string
    sent_at: string
    is_trigger: boolean
  }>
  // Haiku decision metadata for passive_monitor runs. Read from
  // pending_ella_responses; falls back to trigger_metadata copies when
  // no row exists in the queue (skip decisions never land in the table).
  // Both null for reactive runs.
  haiku_decision: string | null
  haiku_reasoning: string | null
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
  // Response-scope counts: runs where Ella attempted to send a message
  // (status IN success/escalated/error AND haiku_decision != 'skip').
  // Passive-monitor skip-decision rows count as observations, not
  // responses — they're excluded here.
  total_today: number
  total_week: number
  total_month: number
  status_counts: Record<string, number>
  // Response-scope cost totals.
  cost_today: number
  cost_week: number
  cost_month: number
  // Out-of-scope cost: today's spend on Haiku-decided skip evaluations.
  // Surfaced separately on the Cost card so the response-scope total
  // stays the headline figure.
  skip_cost_today: number
  // status='error' counts within the response-scope window. error is
  // always in-scope; this is shorthand for "Ella tried and failed."
  errors_today: number
  errors_week: number
  errors_month: number
  // Still computed by the data layer; the redesigned summary band
  // doesn't surface it but future alert-source work may consume it
  // (intentional retention per Part 2 spec § Anomaly removal scope).
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
  const allRuns = (rawRuns ?? []) as RawRunRow[]

  // Response-scope filter: only runs where Ella actually attempted to
  // speak. Excludes passive_monitor evaluations where Haiku decided to
  // skip (Ella observed the message and chose silence — that's an
  // observation, not a response). Applied unconditionally per Decision
  // 1 of the list-polish spec: the page exists to show responses, not
  // every observation.
  //
  // Reactive @-mention runs have no `haiku_decision` field in
  // trigger_metadata (the IS NULL branch keeps them).
  const runs = allRuns.filter((r) => {
    if (!['success', 'escalated', 'error'].includes(r.status)) return false
    const haikuDecision = extractTriggerField(r.trigger_metadata, 'haiku_decision')
    if (haikuDecision === 'skip') return false
    return true
  })

  const channelMap = await fetchChannelMap(supabase)
  const userNameMap = await fetchUserNameMap(supabase, runs)
  const responseTexts = await fetchSlackResponseTexts(supabase, runs)
  const escalationIds = await fetchEscalationRunIds(
    supabase,
    runs.map((r) => r.id),
  )
  const lengthOutliers = computeLengthOutliers(runs, responseTexts)

  // Build a Slack-mention name map across every row's output text so
  // the "@U0XXXX" syntax in the Output column resolves to readable
  // "@First Last" form. One batched lookup against clients +
  // team_members; resolved at the data layer so the table component
  // stays dumb.
  const mentionedUserIds = new Set<string>()
  const mentionRegex = /<@(U[A-Z0-9]+)>/g
  for (const r of runs) {
    const text = (r.output_summary?.trim() || responseTexts.get(r.id) || '').toString()
    if (!text) continue
    let m: RegExpExecArray | null
    while ((m = mentionRegex.exec(text)) !== null) {
      mentionedUserIds.add(m[1])
    }
  }
  const mentionNameMap = new Map<string, string>()
  if (mentionedUserIds.size > 0) {
    const ids = Array.from(mentionedUserIds)
    const { data: mClients } = await supabase
      .from('clients')
      .select('slack_user_id, full_name')
      .in('slack_user_id', ids)
      .is('archived_at', null)
    for (const c of mClients ?? []) {
      if (c.slack_user_id && c.full_name) mentionNameMap.set(c.slack_user_id, c.full_name)
    }
    const { data: mTms } = await supabase
      .from('team_members')
      .select('slack_user_id, full_name')
      .in('slack_user_id', ids)
      .is('archived_at', null)
    for (const t of mTms ?? []) {
      if (t.slack_user_id && t.full_name && !mentionNameMap.has(t.slack_user_id)) {
        mentionNameMap.set(t.slack_user_id, t.full_name)
      }
    }
  }

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
    // Output column source: prefer non-empty output_summary, fall back
    // to fetched slack_messages text, else null. Slack mentions
    // (<@U...>) resolved to readable @First Last via the prebuilt name
    // map; unresolvable IDs stay in raw <@U...> form (don't strip on
    // miss — better to show the syntax than silently lose the mention).
    const rawOutput = r.output_summary?.trim() || slackText?.trim() || null
    const output_text = rawOutput
      ? rawOutput.replace(/<@(U[A-Z0-9]+)>/g, (full, uid) => {
          const name = mentionNameMap.get(uid)
          return name ? `@${name}` : full
        })
      : null

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
      output_text,
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

// Fetch the last N slack_messages in a channel up to and including a
// given timestamp. Used by getEllaRunDetail's passive-run surrounding-
// messages path. Returns oldest-first (ascending) so render order
// matches the thread-message path.
//
// Lookup order:
//   1. If beforeTs (a slack_ts) is present, find the matching row's
//      sent_at in slack_messages — this anchors the query window
//      precisely on the trigger message's wall-clock time.
//   2. If no match (the trigger predates the slack_messages backfill
//      or is a synthetic test ts), fall back to the run's started_at
//      as the anchor.
//
// Empty result is a valid signal: render an empty-state stub upstream
// rather than the dev-facing "synthetic test ts predating the backfill"
// placeholder that the V1 path showed.
async function fetchLastNChannelMessages(
  supabase: ReturnType<typeof createAdminClient>,
  channelId: string,
  beforeTs: string | null,
  fallbackTs: string,
  n: number,
): Promise<
  Array<{
    slack_ts: string
    slack_user_id: string
    author_type: string
    text: string
    sent_at: string
  }>
> {
  let anchor: string | null = null
  if (beforeTs) {
    const { data: triggerRow } = await supabase
      .from('slack_messages')
      .select('sent_at')
      .eq('slack_channel_id', channelId)
      .eq('slack_ts', beforeTs)
      .maybeSingle()
    anchor = (triggerRow as { sent_at?: string } | null)?.sent_at ?? null
  }
  if (!anchor) anchor = fallbackTs

  const { data: msgs } = await supabase
    .from('slack_messages')
    .select('slack_ts, slack_user_id, author_type, text, sent_at')
    .eq('slack_channel_id', channelId)
    .lte('sent_at', anchor)
    .order('sent_at', { ascending: false })
    .limit(n)

  // Re-sort ascending to match the thread-message render order.
  return [...(msgs ?? [])].reverse() as Array<{
    slack_ts: string
    slack_user_id: string
    author_type: string
    text: string
    sent_at: string
  }>
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

  // Surrounding messages — dual-mode per Part 2 spec § Decision 10.
  //
  //   Reactive runs (thread_ts present) → existing thread query, last
  //     ~20 messages in the thread. Identical to V1 behavior.
  //
  //   Passive runs (thread_ts null) → fetchLastNChannelMessages, last 5
  //     in the channel up to and including the trigger ts. Replaces the
  //     V1 placeholder copy ("Likely a synthetic test ts predating the
  //     backfill...") which was wrong for passive runs.
  //
  // Both paths converge on the same shape so the detail page renders
  // them through one component.
  type RawMsg = {
    slack_ts: string
    slack_user_id: string
    author_type: string
    text: string
    sent_at: string
  }
  let rawMsgs: RawMsg[] = []
  if (ch && thread_ts) {
    const { data: msgs } = await supabase
      .from('slack_messages')
      .select('slack_ts, slack_thread_ts, slack_user_id, author_type, text, sent_at')
      .eq('slack_channel_id', ch)
      .or(`slack_thread_ts.eq.${thread_ts},slack_ts.eq.${thread_ts}`)
      .order('sent_at', { ascending: true })
      .limit(20)
    rawMsgs = (msgs ?? []) as RawMsg[]
  } else if (ch) {
    rawMsgs = await fetchLastNChannelMessages(
      supabase,
      ch,
      trigger_ts,
      r.started_at,
      5,
    )
  }

  let threadMessages: EllaRunDetail['thread_messages'] = []
  if (rawMsgs.length > 0) {
    const userIds = Array.from(
      new Set(rawMsgs.map((m) => m.slack_user_id).filter((x): x is string => !!x)),
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

    threadMessages = rawMsgs.map((m) => ({
      slack_ts: m.slack_ts,
      slack_user_id: m.slack_user_id,
      author_type: m.author_type,
      display_name: nameMap.get(m.slack_user_id) ?? null,
      text: m.text,
      sent_at: m.sent_at,
      is_trigger: m.slack_ts === trigger_ts,
    }))
  }

  // Haiku decision lookup for passive_monitor runs. Read pending_ella_responses
  // by agent_run_id; fall back to trigger_metadata copies when no row
  // exists (skip decisions never land in the queue per the schema doc).
  let haiku_decision: string | null = null
  let haiku_reasoning: string | null = null
  if (r.trigger_type === 'passive_monitor') {
    const { data: pendingRow } = await supabase
      .from('pending_ella_responses')
      .select('haiku_decision, haiku_reasoning')
      .eq('agent_run_id', r.id)
      .maybeSingle()
    const typed = pendingRow as
      | { haiku_decision?: string | null; haiku_reasoning?: string | null }
      | null
    if (typed && (typed.haiku_decision || typed.haiku_reasoning)) {
      haiku_decision = typed.haiku_decision ?? null
      haiku_reasoning = typed.haiku_reasoning ?? null
    } else {
      // Fallback path: passive_dispatch writes the decision into
      // trigger_metadata at decision time; for skip decisions (which
      // never land in pending_ella_responses) this is the only record.
      haiku_decision = extractTriggerField(r.trigger_metadata, 'haiku_decision')
      haiku_reasoning = extractTriggerField(r.trigger_metadata, 'haiku_reasoning')
    }
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
    // The list-page output_text field is mention-resolved + falls back
    // to slack_response_text. Detail page doesn't render it directly
    // (it has its own "Ella's response" section that splits client-
    // facing from handoff), but EllaRunDetail extends EllaRunsListRow
    // so this field must be populated. Apply the same precedence + the
    // detail-page mention-name map would be a nice-to-have but isn't
    // needed today — the detail page reads slack_response_text raw.
    output_text: r.output_summary?.trim() || slackText?.trim() || null,
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
    haiku_decision,
    haiku_reasoning,
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

  // Response-scope predicate (matches getEllaRunsList's filter):
  // status IN (success/escalated/error) AND haiku_decision != 'skip'.
  // Skip-scope is the inverse — passive_monitor runs where Haiku
  // decided to stay silent.
  const isResponseScope = (r: RawRunRow): boolean => {
    if (!['success', 'escalated', 'error'].includes(r.status)) return false
    const haikuDecision = extractTriggerField(r.trigger_metadata, 'haiku_decision')
    if (haikuDecision === 'skip') return false
    return true
  }
  const isSkipScope = (r: RawRunRow): boolean => {
    return extractTriggerField(r.trigger_metadata, 'haiku_decision') === 'skip'
  }

  const responseRuns = runs.filter(isResponseScope)
  const skipRuns = runs.filter(isSkipScope)

  // total_* + cost_* + errors_* all reflect response scope. The Surface
  // band's headline is "what did Ella actually do" — observation noise
  // doesn't belong in the count or the cost figure.
  const total_today = responseRuns.filter((r) => new Date(r.started_at).getTime() >= todayMs).length
  const total_week = responseRuns.filter((r) => new Date(r.started_at).getTime() >= weekMs).length
  const total_month = responseRuns.length

  const status_counts: Record<string, number> = {}
  for (const r of responseRuns) status_counts[r.status] = (status_counts[r.status] ?? 0) + 1

  const cost_today = responseRuns
    .filter((r) => new Date(r.started_at).getTime() >= todayMs)
    .reduce((sum, r) => sum + (r.llm_cost_usd ?? 0), 0)
  const cost_week = responseRuns
    .filter((r) => new Date(r.started_at).getTime() >= weekMs)
    .reduce((sum, r) => sum + (r.llm_cost_usd ?? 0), 0)
  const cost_month = responseRuns.reduce((sum, r) => sum + (r.llm_cost_usd ?? 0), 0)

  // Skip-cost broken out separately on the Cost card hint line so the
  // headline figure stays response-scope while the observation-cost is
  // still visible. Only the today figure is broken out.
  const skip_cost_today = skipRuns
    .filter((r) => new Date(r.started_at).getTime() >= todayMs)
    .reduce((sum, r) => sum + (r.llm_cost_usd ?? 0), 0)

  // status='error' counts per window. status='error' is in response
  // scope by definition (Ella tried and failed); skip rows have
  // status='success' not 'error', so a plain filter against responseRuns
  // is correct.
  const errorsRuns = responseRuns.filter((r) => r.status === 'error')
  const errors_today = errorsRuns.filter(
    (r) => new Date(r.started_at).getTime() >= todayMs,
  ).length
  const errors_week = errorsRuns.filter(
    (r) => new Date(r.started_at).getTime() >= weekMs,
  ).length
  const errors_month = errorsRuns.length

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
    cost_month,
    skip_cost_today,
    errors_today,
    errors_week,
    errors_month,
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
