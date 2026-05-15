import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { Database } from '@/lib/supabase/types'

type ClientRow = Database['public']['Tables']['clients']['Row']

// Allowed fields for inline-save on the Clients detail page. The
// dashboard sections funnel through updateClient; anything outside this
// list is rejected to keep the editing surface tight (no accidental
// writes to metadata, slack_user_id, archived_at, etc.).
//
// Three columns are deliberately NOT in this list because they're
// edited via dedicated history-writing RPCs (M4 Chunk B2):
//   - status                → update_client_status_with_history
//   - journey_stage         → update_client_journey_stage_with_history
//   - csm_standing          → update_client_csm_standing_with_history
// Routing those edits through this function would skip the history-row
// insert. The whitelist enforces the invariant.
const UPDATABLE_FIELDS = [
  // Plain text
  'full_name',
  'email',
  'phone',
  'timezone',
  'country',
  'location',
  'occupation',
  'archetype',
  'arrears_note',
  'program_type',
  'notes',
  // Dates
  'start_date',
  // Numerics
  'birth_year',
  'contracted_revenue',
  'upfront_cash_collected',
  'arrears',
  // Enums
  'trustpilot_status',
  'ghl_adoption',
  // Three-state booleans
  'sales_group_candidate',
  'dfy_setting',
  // Two-state boolean toggles (M5.6 — cascade-owned for negative-status
  // transitions, manually flippable from the dashboard, not sticky)
  'accountability_enabled',
  'nps_enabled',
  // Arrays
  'tags',
] as const

export type UpdatableField = (typeof UPDATABLE_FIELDS)[number]

// Field-type metadata for value narrowing in updateClientField. Tells
// the Server Action what shape to validate before passing to updateClient.
export const FIELD_TYPES: Record<UpdatableField, FieldType> = {
  full_name: 'text',
  email: 'text',
  phone: 'text',
  timezone: 'text',
  country: 'text',
  location: 'text',
  occupation: 'text',
  archetype: 'text',
  arrears_note: 'text',
  program_type: 'text',
  notes: 'text',
  start_date: 'date',
  birth_year: 'integer',
  contracted_revenue: 'numeric',
  upfront_cash_collected: 'numeric',
  arrears: 'numeric_nonneg',
  trustpilot_status: 'enum_trustpilot',
  ghl_adoption: 'enum_ghl_adoption',
  sales_group_candidate: 'three_state_bool',
  dfy_setting: 'three_state_bool',
  accountability_enabled: 'boolean_toggle',
  nps_enabled: 'boolean_toggle',
  tags: 'string_array',
}

export type FieldType =
  | 'text'
  | 'date'
  | 'integer'
  | 'numeric'
  | 'numeric_nonneg'
  | 'enum_trustpilot'
  | 'enum_ghl_adoption'
  | 'three_state_bool'
  | 'boolean_toggle'
  | 'string_array'

export const GHL_ADOPTION_VALUES = [
  'never_adopted',
  'affiliate',
  'saas',
  'inactive',
] as const

// M5.5 multi-select filter shape. Each array represents OR-within;
// across-fields is AND. Empty arrays = no filter from that field.
//
// Status semantics:
//   - status === undefined / [] → no DB filter (show every status)
//   - status === ['active','paused','ghost', ...] → .in() clause
//
// The page-level readFilters injects the default trio
// (['active','paused','ghost']) when the URL param is absent — so the
// "default visit" call lands here with status populated. The explicit-
// empty UI state (?status=) lands here as []. Both cases are correct
// without extra logic in this file.
export type ClientsListFilters = {
  status?: string[]
  primary_csm_ids?: string[]
  csm_standing?: string[]
  nps_standing?: string[]
  trustpilot_status?: string[]
  // M5.7 — three additional dropdowns replacing M5.5's disabled placeholders.
  // country uses .in() against clients.country (USA/AUS today; nullable);
  // accountability/nps_toggle map 'on'|'off' strings to boolean .in() against
  // clients.accountability_enabled / clients.nps_enabled (M5.6 columns).
  country?: string[]
  accountability?: Array<'on' | 'off'>
  nps_toggle?: Array<'on' | 'off'>
  needs_review?: boolean
  // missing_slack === true → narrow to clients where slack_user_id OR
  // slack_channel_id is null. Computed read-time; no stored column.
  // Both badges (channel + user) on /clients[/[id]] feed off the same
  // two underlying nullable fields.
  missing_slack?: boolean
  search?: string
}

export type ClientsListRow = ClientRow & {
  primary_csm_id: string | null
  primary_csm_name: string | null
  latest_health_score: number | null
  latest_health_tier: string | null
  last_call_date: string | null
  open_action_items_count: number
  overdue_action_items_count: number
  // M5.7 — meetings_this_month: count of calls in the current calendar month
  // (UTC). Computed JS-side from the existing nested calls select; no extra
  // round trip. inactive: true when last_call_date is null OR > 30 days ago.
  meetings_this_month: number
  inactive: boolean
  // 2026-05-15: Slack-hygiene fields surfaced for the missing-Slack
  // badges + filter. `slack_channel_id` comes from the joined
  // `slack_channels` nested select (most recent non-archived); null
  // when the client has no active channel. `slack_user_id` is a
  // direct column on `clients`. Both feed the warn-tier pills.
  slack_channel_id: string | null
}

// ----------------------------------------------------------------------
// getClientsList
// ----------------------------------------------------------------------
//
// Single round trip to PostgREST with nested selects, then JS-side
// derivation of the per-row aggregates the list view needs (latest
// health score, last call date, open / overdue action item counts,
// active primary CSM). DB-side filters: status / csm_standing /
// nps_standing / trustpilot_status (.in()), needs_review (tag
// containment), search (or-ilike on full_name + email). JS-side filter:
// primary_csm_ids (matched against the active primary CSM derived from
// the client_team_assignments join — can't be expressed as a PostgREST
// .in() because the value lives in a nested select).
//
// Volume note: ~197 active clients, each with ~10 calls + a handful of
// action items, comfortably fits in one PostgREST round trip. If volume
// grows past ~1000 clients or the join arrays balloon, swap this for a
// Postgres view or RPC — the call sites won't change.
export async function getClientsList(
  filters: ClientsListFilters = {},
): Promise<ClientsListRow[]> {
  const supabase = createAdminClient()

  let query = supabase
    .from('clients')
    .select(
      `
      *,
      client_team_assignments(
        role,
        assigned_at,
        unassigned_at,
        team_members(id, full_name)
      ),
      client_health_scores(score, tier, computed_at),
      calls!calls_primary_client_id_fkey(started_at),
      call_action_items!call_action_items_owner_client_id_fkey(id, status, due_date),
      slack_channels(slack_channel_id, is_archived, created_at)
    `,
    )
    .is('archived_at', null)

  // Status: when populated, .in() across the selected values.
  // Default-hide of churned/leave is now expressed by the UI's
  // STATUS_DEFAULT_SELECTED (active+paused+ghost) being injected at
  // readFilters time when the param is absent. An empty array here
  // means the user explicitly cleared all status checks → show all.
  if (filters.status && filters.status.length > 0) {
    query = query.in('status', filters.status)
  }
  if (filters.csm_standing && filters.csm_standing.length > 0) {
    query = query.in('csm_standing', filters.csm_standing)
  }
  if (filters.nps_standing && filters.nps_standing.length > 0) {
    query = query.in('nps_standing', filters.nps_standing)
  }
  if (filters.trustpilot_status && filters.trustpilot_status.length > 0) {
    query = query.in('trustpilot_status', filters.trustpilot_status)
  }
  if (filters.country && filters.country.length > 0) {
    query = query.in('country', filters.country)
  }
  if (filters.accountability && filters.accountability.length > 0) {
    const bools = filters.accountability.map((v) => v === 'on')
    query = query.in('accountability_enabled', bools)
  }
  if (filters.nps_toggle && filters.nps_toggle.length > 0) {
    const bools = filters.nps_toggle.map((v) => v === 'on')
    query = query.in('nps_enabled', bools)
  }
  if (filters.needs_review === true) {
    query = query.contains('tags', ['needs_review'])
  }
  // missing_slack is applied JS-side after the projection below —
  // `slack_channel_id` isn't a column on `clients` (it lives on the
  // joined slack_channels rows), so a PostgREST .or() across both
  // fields can't express the filter cleanly. JS-filter happens
  // post-select; cheap at ~200 clients.
  if (filters.search) {
    const q = filters.search.replace(/[%,]/g, '')
    query = query.or(`full_name.ilike.%${q}%,email.ilike.%${q}%`)
  }

  const { data, error } = await query
  if (error) throw error
  if (!data) return []

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  // M5.7 — month start (UTC) for the meetings_this_month aggregation, and
  // the 30-day-ago threshold for the inactivity flag. Both reuse the
  // existing calls.started_at nested select; no extra round trip.
  const now = new Date()
  const monthStart = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
  )
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  let rows: ClientsListRow[] = data.map((row) => {
    const assignments = (row.client_team_assignments ?? []) as Array<{
      role: string
      assigned_at: string
      unassigned_at: string | null
      team_members: { id: string; full_name: string } | null
    }>
    const activePrimaryCsm = assignments.find(
      (a) => a.role === 'primary_csm' && a.unassigned_at === null,
    )

    const scores = (row.client_health_scores ?? []) as Array<{
      score: number
      tier: string
      computed_at: string
    }>
    const latestScore =
      scores.length === 0
        ? null
        : scores.reduce((best, s) =>
            new Date(s.computed_at) > new Date(best.computed_at) ? s : best,
          )

    const calls = (row.calls ?? []) as Array<{ started_at: string }>
    const latestCall =
      calls.length === 0
        ? null
        : calls.reduce((best, c) =>
            new Date(c.started_at) > new Date(best.started_at) ? c : best,
          )
    const meetingsThisMonth = calls.filter(
      (c) => new Date(c.started_at) >= monthStart,
    ).length
    // Inactive when there are no calls at all OR the most recent call is
    // older than 30 days. Never-called clients land inactive a fortiori —
    // "no recent meeting" trivially applies when there's no meeting at all.
    const inactive =
      latestCall === null || new Date(latestCall.started_at) < thirtyDaysAgo

    const actionItems = (row.call_action_items ?? []) as Array<{
      id: string
      status: string
      due_date: string | null
    }>
    const openItems = actionItems.filter((a) => a.status === 'open')
    const overdueItems = openItems.filter(
      (a) => a.due_date !== null && new Date(a.due_date) < today,
    )

    // Resolve the active Slack channel for this client from the
    // nested join. Mirrors getClientById's "most recent non-archived"
    // pick. null when no active channel exists.
    const slackChannels = (row.slack_channels ?? []) as Array<{
      slack_channel_id: string
      is_archived: boolean
      created_at: string
    }>
    const activeChannel =
      slackChannels
        .filter((c) => !c.is_archived)
        .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))[0] ?? null

    // Strip the nested-select arrays from the row — they're already
    // captured in the derived fields below — and return a clean
    // ClientsListRow. Spread inherits all ClientRow columns (including
    // any added by future migrations) so we don't have to enumerate.
    const stripped = { ...(row as Record<string, unknown>) }
    delete stripped.client_team_assignments
    delete stripped.client_health_scores
    delete stripped.calls
    delete stripped.call_action_items
    delete stripped.slack_channels
    const client = stripped as unknown as ClientRow

    return {
      ...client,
      primary_csm_id: activePrimaryCsm?.team_members?.id ?? null,
      primary_csm_name: activePrimaryCsm?.team_members?.full_name ?? null,
      latest_health_score: latestScore?.score ?? null,
      latest_health_tier: latestScore?.tier ?? null,
      last_call_date: latestCall?.started_at ?? null,
      open_action_items_count: openItems.length,
      overdue_action_items_count: overdueItems.length,
      meetings_this_month: meetingsThisMonth,
      inactive,
      slack_channel_id: activeChannel?.slack_channel_id ?? null,
    }
  })

  if (filters.primary_csm_ids && filters.primary_csm_ids.length > 0) {
    const allowed = new Set(filters.primary_csm_ids)
    rows = rows.filter(
      (r) => r.primary_csm_id !== null && allowed.has(r.primary_csm_id),
    )
  }

  if (filters.missing_slack === true) {
    rows = rows.filter(
      (r) => r.slack_channel_id === null || r.slack_user_id === null,
    )
  }

  return rows
}

// ----------------------------------------------------------------------
// getClientById
// ----------------------------------------------------------------------
//
// Detail view query. Returns null for missing or archived clients.
// Pulls everything the v3 7-section detail page needs in 7-8 round trips
// total: 1 main client query (with slack_channels + client_upsells
// embedded), 6 parallel queries (calls/action_items/health/nps/csm/team),
// plus 1 conditional slack_messages count when the client has a
// slack_user_id. The page renders directly from this shape.

type CallSummary = {
  id: string
  started_at: string
  title: string | null
  call_category: string
  duration_seconds: number | null
}

type ActionItem = {
  id: string
  description: string
  owner_type: string
  owner_team_member_id: string | null
  owner_client_id: string | null
  due_date: string | null
  call_id: string
  status: string
  completed_at: string | null
  extracted_at: string
}

type UpsellRow = Database['public']['Tables']['client_upsells']['Row']

export type ClientDetail = ClientRow & {
  // Existing fields, preserved for backward compat:
  recent_calls: CallSummary[] // derived: top 5 of all_calls
  open_action_items: ActionItem[] // derived: filter status='open' from all_action_items
  latest_health: {
    score: number
    tier: string
    factors: Database['public']['Tables']['client_health_scores']['Row']['factors']
    computed_at: string
  } | null
  latest_nps: {
    score: number
    submitted_at: string
  } | null
  active_primary_csm: {
    team_member_id: string
    team_member_name: string
    assigned_at: string
  } | null
  team_members: Array<{ id: string; full_name: string; email: string }>

  // New fields for the v3 detail page:
  all_calls: CallSummary[] // full list, started_at desc
  total_calls: number
  all_action_items: ActionItem[] // all statuses, extracted_at desc
  total_nps_submissions: number
  total_slack_messages: number // 0 if slack_user_id is null
  upsells: UpsellRow[] // sold_at desc nulls last
  slack_channel_id: string | null // most recently created active channel
  // M5.7 — derived from all_calls (no extra round trip). Same semantics as
  // ClientsListRow's fields: meetings_this_month is current calendar month
  // (UTC); inactive is true when no calls or latest > 30 days ago.
  meetings_this_month: number
  inactive: boolean
}

export async function getClientById(id: string): Promise<ClientDetail | null> {
  const supabase = createAdminClient()

  // Round 1: main client row + embedded slack_channels + client_upsells.
  // Embedding saves two round trips vs separate queries; volume is small
  // (most clients have 0-1 channels and 0-3 upsells).
  const { data: client, error } = await supabase
    .from('clients')
    .select(
      `
      *,
      slack_channels(slack_channel_id, is_archived, created_at),
      client_upsells(*)
    `,
    )
    .eq('id', id)
    .is('archived_at', null)
    .maybeSingle()
  if (error) throw error
  if (!client) return null

  type ChannelEmbed = {
    slack_channel_id: string
    is_archived: boolean
    created_at: string
  }
  const channels = (client.slack_channels ?? []) as ChannelEmbed[]
  const activeChannels = channels
    .filter((c) => !c.is_archived)
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )
  const slackChannelId = activeChannels[0]?.slack_channel_id ?? null

  const upsells = ((client.client_upsells ?? []) as UpsellRow[]).sort(
    (a, b) => {
      // sold_at desc nulls last
      if (a.sold_at === null && b.sold_at === null) return 0
      if (a.sold_at === null) return 1
      if (b.sold_at === null) return -1
      return new Date(b.sold_at).getTime() - new Date(a.sold_at).getTime()
    },
  )

  // Strip embeds off the client row before spreading into the result —
  // they're already captured in slackChannelId / upsells above.
  const clientRow = client as unknown as ClientRow & {
    slack_channels?: unknown
    client_upsells?: unknown
  }
  delete clientRow.slack_channels
  delete clientRow.client_upsells

  // Rounds 2-8: parallel block. The slack_messages count is conditional
  // on slack_user_id — when null, we resolve a sentinel inline so the
  // Promise.all stays one-shot.
  const slackUserId = clientRow.slack_user_id
  const slackMsgPromise: Promise<{
    count: number | null
    error: { message: string } | null
  }> = slackUserId
    ? (async () => {
        const r = await supabase
          .from('slack_messages')
          .select('*', { count: 'exact', head: true })
          .eq('slack_user_id', slackUserId)
        return { count: r.count, error: r.error }
      })()
    : Promise.resolve({
        count: 0 as number | null,
        error: null as { message: string } | null,
      })

  const [
    callsRes,
    actionItemsRes,
    healthRes,
    npsRes,
    assignmentRes,
    teamRes,
    slackMsgRes,
  ] = await Promise.all([
    supabase
      .from('calls')
      .select('id, started_at, title, call_category, duration_seconds', {
        count: 'exact',
      })
      .eq('primary_client_id', id)
      .order('started_at', { ascending: false }),
    // Fetch every action item extracted from any of the client's calls,
    // not just items where the client itself is the assigned owner. The
    // /clients/[id] Action items box surfaces items from the client's
    // coaching calls regardless of whether the assigned doer is the
    // client (owner_client_id), a CSM (owner_team_member_id), or unset.
    // The prior `.eq('owner_client_id', id)` filter dropped every item
    // assigned to a CSM, which is most of them — items extracted from
    // /calls/[id] never appeared on /clients/[id]. Use an inner-join on
    // calls + filter the joined call's primary_client_id to scope.
    supabase
      .from('call_action_items')
      .select(
        'id, description, owner_type, owner_team_member_id, owner_client_id, due_date, call_id, status, completed_at, extracted_at, calls!inner(primary_client_id)',
      )
      .eq('calls.primary_client_id', id)
      .order('extracted_at', { ascending: false }),
    supabase
      .from('client_health_scores')
      .select('score, tier, factors, computed_at')
      .eq('client_id', id)
      .order('computed_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('nps_submissions')
      .select('score, submitted_at', { count: 'exact' })
      .eq('client_id', id)
      .order('submitted_at', { ascending: false })
      .limit(1),
    supabase
      .from('client_team_assignments')
      .select('team_member_id, assigned_at, team_members(full_name)')
      .eq('client_id', id)
      .eq('role', 'primary_csm')
      .is('unassigned_at', null)
      .maybeSingle(),
    supabase
      .from('team_members')
      .select('id, full_name, email')
      .eq('is_active', true)
      .eq('is_csm', true)
      .is('archived_at', null)
      .order('full_name'),
    slackMsgPromise,
  ])

  if (callsRes.error) throw callsRes.error
  if (actionItemsRes.error) throw actionItemsRes.error
  if (healthRes.error) throw healthRes.error
  if (npsRes.error) throw npsRes.error
  if (assignmentRes.error) throw assignmentRes.error
  if (teamRes.error) throw teamRes.error
  if (slackMsgRes.error) throw slackMsgRes.error

  const allCalls = (callsRes.data ?? []) as CallSummary[]
  const totalCalls = callsRes.count ?? allCalls.length
  const recentCalls = allCalls.slice(0, 5)
  // M5.7 — meetings_this_month + inactive. Same semantics as the list view.
  const detailNow = new Date()
  const detailMonthStart = new Date(
    Date.UTC(detailNow.getUTCFullYear(), detailNow.getUTCMonth(), 1),
  )
  const detailThirtyDaysAgo = new Date(
    detailNow.getTime() - 30 * 24 * 60 * 60 * 1000,
  )
  const meetingsThisMonth = allCalls.filter(
    (c) => new Date(c.started_at) >= detailMonthStart,
  ).length
  const detailLatestStartedAt = allCalls[0]?.started_at ?? null
  const inactive =
    detailLatestStartedAt === null ||
    new Date(detailLatestStartedAt) < detailThirtyDaysAgo

  // Strip the joined `calls` field used only as a JOIN predicate — the
  // ActionItem type doesn't carry it, and downstream consumers don't
  // need it.
  const allActionItems = (actionItemsRes.data ?? []).map((row) => {
    const rest = { ...(row as Record<string, unknown>) }
    delete rest.calls
    return rest as unknown as ActionItem
  })
  const openActionItems = allActionItems.filter((item) => item.status === 'open')

  const npsRows = (npsRes.data ?? []) as Array<{
    score: number
    submitted_at: string
  }>
  const latestNps = npsRows[0] ?? null
  const totalNpsSubmissions = npsRes.count ?? 0

  const assignment = assignmentRes.data as
    | {
        team_member_id: string
        assigned_at: string
        team_members: { full_name: string } | null
      }
    | null

  return {
    ...clientRow,
    recent_calls: recentCalls,
    open_action_items: openActionItems,
    latest_health: healthRes.data ?? null,
    latest_nps: latestNps,
    active_primary_csm: assignment
      ? {
          team_member_id: assignment.team_member_id,
          team_member_name: assignment.team_members?.full_name ?? '',
          assigned_at: assignment.assigned_at,
        }
      : null,
    team_members: teamRes.data ?? [],
    all_calls: allCalls,
    total_calls: totalCalls,
    all_action_items: allActionItems,
    total_nps_submissions: totalNpsSubmissions,
    total_slack_messages: slackMsgRes.count ?? 0,
    upsells,
    slack_channel_id: slackChannelId,
    meetings_this_month: meetingsThisMonth,
    inactive,
  }
}

// ----------------------------------------------------------------------
// updateClient
// ----------------------------------------------------------------------
//
// Inline-save target for Identity / Status / Notes sections. The
// allowed-field whitelist is enforced server-side to keep the edit
// surface tight and to prevent stray fields from sneaking in via a
// crafted Server Action call.
export async function updateClient(
  id: string,
  fields: Partial<Pick<ClientRow, UpdatableField>>,
): Promise<{ success: true } | { success: false; error: string }> {
  // Reject any keys outside the whitelist before passing through to
  // Supabase. Types are already constrained by the function signature,
  // but the runtime check defends against a crafted Server Action call.
  for (const key of Object.keys(fields)) {
    if (!(UPDATABLE_FIELDS as readonly string[]).includes(key)) {
      return { success: false, error: `Field not editable: ${key}` }
    }
  }

  if (Object.keys(fields).length === 0) {
    return { success: false, error: 'No valid fields to update.' }
  }

  const supabase = createAdminClient()
  const { error } = await supabase
    .from('clients')
    .update(fields)
    .eq('id', id)

  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ----------------------------------------------------------------------
// listAvailableCsms — every active CSM in the team_members table
// ----------------------------------------------------------------------
//
// Source of truth for the Primary CSM dropdown on /clients/[id]. Filter
// is is_csm=true + is_active=true + archived_at IS NULL — surfaces the
// four real CSMs (Scott Wilson, Nabeel Junaid, Lou Perez, Nico Sandoval)
// plus the Scott Chasing sentinel.
//
// Distinct from listActiveCsms() in lib/db/calls.ts, which goes via
// active client_team_assignments and surfaces "CSMs currently owning at
// least one client" — narrower set, used by the /calls filter dropdown.
// For an assignment editor, the dashboard wants every CSM available to
// be assigned, not just those who already own work.
//
// The same query lived inline in app/(authenticated)/clients/page.tsx
// for the list-page filter dropdown; this helper consolidates the
// definition so the detail page editor and the list page filter can't
// drift apart silently. (The list-page call site continues to inline
// the query for now — kept out of scope to avoid widening this spec's
// diff.)
export async function listAvailableCsms(): Promise<
  Array<{ id: string; full_name: string }>
> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('team_members')
    .select('id, full_name')
    .eq('is_active', true)
    .eq('is_csm', true)
    .is('archived_at', null)
    .order('full_name')
  if (error) throw error
  return (data ?? []) as Array<{ id: string; full_name: string }>
}

// ----------------------------------------------------------------------
// changePrimaryCsm
// ----------------------------------------------------------------------
//
// Atomic swap via the change_primary_csm Postgres function (migration
// 0014). The function archives the existing active primary_csm
// assignment for the client (sets unassigned_at = now()) and inserts
// a new active row with the new team_member_id, all in one
// transaction. Preserves history per gregory.md detail-view §3.
//
// `current_user_team_member_id` is reserved for an audit-log column
// in V1.1 — kept in the signature now so callers don't refactor
// later. Not passed to the RPC in V1.
export async function changePrimaryCsm(
  client_id: string,
  new_team_member_id: string,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _current_user_team_member_id?: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const supabase = createAdminClient()
  const { error } = await supabase.rpc('change_primary_csm', {
    p_client_id: client_id,
    p_new_team_member_id: new_team_member_id,
  })
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ----------------------------------------------------------------------
// History-writing edits (M4 Chunk B2)
// ----------------------------------------------------------------------
//
// Three thin wrappers around the migration 0018 RPCs. Each performs an
// atomic update + history-row insert in a single transaction (or a
// no-op when the value is unchanged). changed_by is null in V1 — auth
// context isn't wired through to Server Actions yet (followup logged).

export async function updateClientStatusWithHistory(
  client_id: string,
  new_status: string,
  changed_by: string | null = null,
  note: string | null = null,
): Promise<{ success: true } | { success: false; error: string }> {
  const supabase = createAdminClient()
  // Type-gen mints p_changed_by / p_note as required strings even though
  // the SQL declares default null — same quirk as update_call_classification
  // (lib/db/calls.ts). Cast through unknown.
  const { error } = await supabase.rpc('update_client_status_with_history', {
    p_client_id: client_id,
    p_new_status: new_status,
    p_changed_by: changed_by as unknown as string,
    p_note: note as unknown as string,
  })
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function updateClientJourneyStageWithHistory(
  client_id: string,
  new_journey_stage: string | null,
  changed_by: string | null = null,
  note: string | null = null,
): Promise<{ success: true } | { success: false; error: string }> {
  const supabase = createAdminClient()
  const { error } = await supabase.rpc(
    'update_client_journey_stage_with_history',
    {
      p_client_id: client_id,
      p_new_journey_stage: new_journey_stage as unknown as string,
      p_changed_by: changed_by as unknown as string,
      p_note: note as unknown as string,
    },
  )
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function updateClientCsmStandingWithHistory(
  client_id: string,
  new_csm_standing: 'happy' | 'content' | 'at_risk' | 'problem' | null,
  changed_by: string | null = null,
  note: string | null = null,
): Promise<{ success: true } | { success: false; error: string }> {
  const supabase = createAdminClient()
  const { error } = await supabase.rpc(
    'update_client_csm_standing_with_history',
    {
      p_client_id: client_id,
      p_new_csm_standing: new_csm_standing as unknown as string,
      p_changed_by: changed_by as unknown as string,
      p_note: note as unknown as string,
    },
  )
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ----------------------------------------------------------------------
// insertNpsSubmission — manual NPS-score entry from Section 2
// ----------------------------------------------------------------------
export async function insertNpsSubmission(
  client_id: string,
  score: number,
  feedback: string | null = null,
  recorded_by: string | null = null,
): Promise<{ success: true } | { success: false; error: string }> {
  const supabase = createAdminClient()
  const { error } = await supabase.rpc('insert_nps_submission', {
    p_client_id: client_id,
    p_score: score,
    p_feedback: feedback as unknown as string,
    p_recorded_by: recorded_by as unknown as string,
  })
  if (error) return { success: false, error: error.message }
  return { success: true }
}

// ----------------------------------------------------------------------
// updateClientProfileField — read-modify-write on clients.metadata
// ----------------------------------------------------------------------
//
// Section 5 (Profile & Background) fields live in
// clients.metadata.profile.* (jsonb sub-object), not as columns. V1
// uses application-layer read-modify-write rather than jsonb_set so the
// merge logic stays visible in TypeScript. Race risk: concurrent
// edits to different metadata.profile.* fields can clobber each other
// (followup logged). Top-level metadata keys (alternate_emails,
// alternate_names, etc.) are preserved by spreading the existing object.
//
// Allowed paths: 'niche', 'offer', 'traffic_strategy', and the four
// nested SWOT paths under profile.swot.*. Anything else is rejected.
const ALLOWED_PROFILE_PATHS = [
  'niche',
  'offer',
  'traffic_strategy',
  'swot.strengths',
  'swot.weaknesses',
  'swot.opportunities',
  'swot.threats',
] as const

export type ProfilePath = (typeof ALLOWED_PROFILE_PATHS)[number]

export function isProfilePath(value: string): value is ProfilePath {
  return (ALLOWED_PROFILE_PATHS as readonly string[]).includes(value)
}

export async function updateClientProfileField(
  client_id: string,
  path: ProfilePath,
  value: string | null,
): Promise<{ success: true } | { success: false; error: string }> {
  const supabase = createAdminClient()

  const { data: row, error: readErr } = await supabase
    .from('clients')
    .select('metadata')
    .eq('id', client_id)
    .maybeSingle()
  if (readErr) return { success: false, error: readErr.message }
  if (!row) return { success: false, error: 'Client not found.' }

  const metadata =
    (row.metadata as Record<string, unknown> | null) ?? {}
  const profile =
    typeof metadata.profile === 'object' && metadata.profile !== null
      ? { ...(metadata.profile as Record<string, unknown>) }
      : {}

  const cleanValue = value === null || value.trim() === '' ? null : value

  if (path.startsWith('swot.')) {
    const swotKey = path.slice('swot.'.length)
    const swot =
      typeof profile.swot === 'object' && profile.swot !== null
        ? { ...(profile.swot as Record<string, unknown>) }
        : {}
    if (cleanValue === null) {
      delete swot[swotKey]
    } else {
      swot[swotKey] = cleanValue
    }
    profile.swot = swot
  } else {
    if (cleanValue === null) {
      delete profile[path]
    } else {
      profile[path] = cleanValue
    }
  }

  // Spread existing metadata first so we don't clobber alternate_emails,
  // alternate_names, or any other top-level keys. Cast through unknown
  // because metadata is typed as Json (a recursive union) but our
  // dynamic-key intermediate object widens to Record<string, unknown>;
  // shape is structurally fine — just satisfying the typer.
  const newMetadata = { ...metadata, profile } as unknown as ClientRow['metadata']

  const { error: writeErr } = await supabase
    .from('clients')
    .update({ metadata: newMetadata })
    .eq('id', client_id)
  if (writeErr) return { success: false, error: writeErr.message }
  return { success: true }
}

// ----------------------------------------------------------------------
// updateClientAlternateEmails — read-modify-write on clients.metadata
// ----------------------------------------------------------------------
//
// Section 1 (Identity) — metadata.alternate_emails is editable from the
// dashboard as a comma-separated text field. The Server Action handles
// the split/trim/drop-empty pre-processing; this function just writes
// the resulting array. No dedup, no validation by design — matches the
// editability pattern of every other field on the page.
//
// Same race window as updateClientProfileField: concurrent edits to
// different metadata.* keys can clobber each other (V1-accepted, see
// followups). Top-level metadata keys (alternate_names, profile, etc.)
// preserved by spreading the existing object.
export async function updateClientAlternateEmails(
  client_id: string,
  emails: string[],
): Promise<{ success: true } | { success: false; error: string }> {
  const supabase = createAdminClient()

  const { data: row, error: readErr } = await supabase
    .from('clients')
    .select('metadata')
    .eq('id', client_id)
    .maybeSingle()
  if (readErr) return { success: false, error: readErr.message }
  if (!row) return { success: false, error: 'Client not found.' }

  const metadata =
    (row.metadata as Record<string, unknown> | null) ?? {}

  const newMetadata = {
    ...metadata,
    alternate_emails: emails,
  } as unknown as ClientRow['metadata']

  const { error: writeErr } = await supabase
    .from('clients')
    .update({ metadata: newMetadata })
    .eq('id', client_id)
  if (writeErr) return { success: false, error: writeErr.message }
  return { success: true }
}
