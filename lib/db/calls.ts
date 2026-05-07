import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { Database } from '@/lib/supabase/types'

type CallRow = Database['public']['Tables']['calls']['Row']

// Threshold below which the "Needs review" toggle includes a call. The
// data has a clean cliff at 0.7 — virtually no rows in the 0.7–0.8
// band, ~105 rows below 0.7. See gregory.md M3.3 build log for the
// distribution that justified the choice.
export const LOW_CONFIDENCE_THRESHOLD = 0.7

// Editable classification fields. Mirrors the CHECK constraint on
// call_classification_history.field_name (migration 0013). Anything
// outside this list is rejected before reaching the RPC.
const UPDATABLE_CLASSIFICATION_FIELDS = [
  'call_category',
  'call_type',
  'primary_client_id',
] as const
export type UpdatableClassificationField =
  (typeof UPDATABLE_CLASSIFICATION_FIELDS)[number]

export type CallsListFilters = {
  category?: string
  primary_client_id?: string
  needs_review?: boolean
  search?: string
}

export type CallsListRow = {
  id: string
  started_at: string
  title: string | null
  call_category: string
  call_type: string | null
  classification_confidence: number | null
  duration_seconds: number | null
  is_retrievable_by_client_agents: boolean
  primary_client_id: string | null
  primary_client_name: string | null
  participants: Array<{
    email: string
    display_name: string | null
    participant_role: string | null
  }>
}

// ----------------------------------------------------------------------
// getCallsList
// ----------------------------------------------------------------------
//
// Single PostgREST round trip with nested selects, then JS-side filter
// for the participant search (matches against name/email + title).
// Volume note: 560 calls today; one round trip pulls ~2800 participant
// rows comfortably. Same scaling trajectory as getClientsList — if
// volume goes past ~5000 calls, swap for a Postgres view.
export async function getCallsList(
  filters: CallsListFilters = {},
): Promise<CallsListRow[]> {
  const supabase = createAdminClient()

  let query = supabase.from('calls').select(
    `
      id,
      started_at,
      title,
      call_category,
      call_type,
      classification_confidence,
      duration_seconds,
      is_retrievable_by_client_agents,
      primary_client_id,
      primary_client:clients!calls_primary_client_id_fkey(id, full_name),
      call_participants(email, display_name, participant_role)
    `,
  )

  if (filters.category) {
    query = query.eq('call_category', filters.category)
  }
  if (filters.primary_client_id) {
    query = query.eq('primary_client_id', filters.primary_client_id)
  }
  if (filters.needs_review) {
    // Three-way OR: low confidence, unclassified category, or a
    // client-tagged call without a primary_client_id (the documented
    // F1.5 orphans). Nested and() per PostgREST OR syntax.
    query = query.or(
      [
        `classification_confidence.lt.${LOW_CONFIDENCE_THRESHOLD}`,
        `call_category.eq.unclassified`,
        `and(call_category.eq.client,primary_client_id.is.null)`,
      ].join(','),
    )
  }

  const { data, error } = await query
  if (error) throw error
  if (!data) return []

  let rows: CallsListRow[] = (data as unknown as Array<{
    id: string
    started_at: string
    title: string | null
    call_category: string
    call_type: string | null
    classification_confidence: number | null
    duration_seconds: number | null
    is_retrievable_by_client_agents: boolean
    primary_client_id: string | null
    primary_client: { id: string; full_name: string } | null
    call_participants: Array<{
      email: string
      display_name: string | null
      participant_role: string | null
    }> | null
  }>).map((row) => ({
    id: row.id,
    started_at: row.started_at,
    title: row.title,
    call_category: row.call_category,
    call_type: row.call_type,
    classification_confidence: row.classification_confidence,
    duration_seconds: row.duration_seconds,
    is_retrievable_by_client_agents: row.is_retrievable_by_client_agents,
    primary_client_id: row.primary_client_id,
    primary_client_name: row.primary_client?.full_name ?? null,
    participants: row.call_participants ?? [],
  }))

  if (filters.search) {
    const q = filters.search.toLowerCase()
    rows = rows.filter((row) => {
      if (row.title?.toLowerCase().includes(q)) return true
      return row.participants.some(
        (p) =>
          p.email.toLowerCase().includes(q) ||
          (p.display_name ?? '').toLowerCase().includes(q),
      )
    })
  }

  return rows
}

// ----------------------------------------------------------------------
// getCallById
// ----------------------------------------------------------------------
//
// Detail view query. Pulls the call row, primary client, full
// participant list (with matched client + team_member names), action
// items (with owner resolution), and the summary document content.
// Returns null for missing calls; archived isn't a concept on calls.
//
// The summary lives in `documents` where document_type='call_summary'
// and metadata.call_id matches — see gregory.md M3.3 build log for
// the spec correction (`calls.summary` is empty for all current rows;
// content lives in documents).
export type CallParticipant = {
  id: string
  email: string
  display_name: string | null
  participant_role: string | null
  client_id: string | null
  matched_client_name: string | null
  team_member_id: string | null
  matched_team_member_name: string | null
}

export type CallActionItem = {
  id: string
  description: string
  owner_type: string
  owner_client_id: string | null
  owner_client_name: string | null
  owner_team_member_id: string | null
  owner_team_member_name: string | null
  status: string
  due_date: string | null
  completed_at: string | null
}

export type CallReviewItem = {
  description: string
  evidence: string
}

export type CallReviewDodgedItem = CallReviewItem & {
  who: string
}

export type CallReview = {
  pain_points: CallReviewItem[]
  wins: CallReviewItem[]
  dodged_questions: CallReviewDodgedItem[]
  sentiment_arc: string
  generated_at: string
}

export type CallDetail = CallRow & {
  primary_client: { id: string; full_name: string } | null
  participants: CallParticipant[]
  action_items: CallActionItem[]
  summary_text: string | null
  call_review: CallReview | null
}

export async function getCallById(id: string): Promise<CallDetail | null> {
  const supabase = createAdminClient()

  const { data: call, error } = await supabase
    .from('calls')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) throw error
  if (!call) return null

  const [
    participantsRes,
    actionItemsRes,
    summaryRes,
    reviewRes,
    primaryClientRes,
  ] = await Promise.all([
      supabase
        .from('call_participants')
        .select(
          `
          id,
          email,
          display_name,
          participant_role,
          client_id,
          team_member_id,
          client:clients(full_name),
          team_member:team_members(full_name)
        `,
        )
        .eq('call_id', id),
      supabase
        .from('call_action_items')
        .select(
          `
          id,
          description,
          owner_type,
          owner_client_id,
          owner_team_member_id,
          status,
          due_date,
          completed_at,
          owner_client:clients!call_action_items_owner_client_id_fkey(full_name),
          owner_team_member:team_members!call_action_items_owner_team_member_id_fkey(full_name)
        `,
        )
        .eq('call_id', id)
        .order('extracted_at', { ascending: true }),
      supabase
        .from('documents')
        .select('content')
        .eq('document_type', 'call_summary')
        .filter('metadata->>call_id', 'eq', id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      // call_review: parallel fetch alongside summary. Same metadata
      // join pattern (filter on metadata->>call_id). Pulled separately
      // because content is JSON-serialized and we need created_at as
      // the "Generated at" timestamp on the dashboard.
      supabase
        .from('documents')
        .select('content, created_at')
        .eq('document_type', 'call_review')
        .filter('metadata->>call_id', 'eq', id)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      call.primary_client_id
        ? supabase
            .from('clients')
            .select('id, full_name')
            .eq('id', call.primary_client_id)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ])

  if (participantsRes.error) throw participantsRes.error
  if (actionItemsRes.error) throw actionItemsRes.error
  if (summaryRes.error) throw summaryRes.error
  if (reviewRes.error) throw reviewRes.error
  if (primaryClientRes.error) throw primaryClientRes.error

  const participants: CallParticipant[] = (
    (participantsRes.data ?? []) as Array<{
      id: string
      email: string
      display_name: string | null
      participant_role: string | null
      client_id: string | null
      team_member_id: string | null
      client: { full_name: string } | null
      team_member: { full_name: string } | null
    }>
  ).map((row) => ({
    id: row.id,
    email: row.email,
    display_name: row.display_name,
    participant_role: row.participant_role,
    client_id: row.client_id,
    matched_client_name: row.client?.full_name ?? null,
    team_member_id: row.team_member_id,
    matched_team_member_name: row.team_member?.full_name ?? null,
  }))

  const action_items: CallActionItem[] = (
    (actionItemsRes.data ?? []) as Array<{
      id: string
      description: string
      owner_type: string
      owner_client_id: string | null
      owner_team_member_id: string | null
      status: string
      due_date: string | null
      completed_at: string | null
      owner_client: { full_name: string } | null
      owner_team_member: { full_name: string } | null
    }>
  ).map((row) => ({
    id: row.id,
    description: row.description,
    owner_type: row.owner_type,
    owner_client_id: row.owner_client_id,
    owner_client_name: row.owner_client?.full_name ?? null,
    owner_team_member_id: row.owner_team_member_id,
    owner_team_member_name: row.owner_team_member?.full_name ?? null,
    status: row.status,
    due_date: row.due_date,
    completed_at: row.completed_at,
  }))

  const call_review = parseCallReview(reviewRes.data)

  return {
    ...call,
    primary_client: primaryClientRes.data ?? null,
    participants,
    action_items,
    summary_text: summaryRes.data?.content ?? null,
    call_review,
  }
}

// Parse the JSON-serialized review document content. Defensive:
// returns null + logs a warning rather than crashing the page if
// the row exists but the content isn't parseable as the expected
// shape. Real failures here would be a regression in the writer
// (agents/call_reviewer/persistence.py), not user-recoverable.
function parseCallReview(
  row: { content: string | null; created_at: string } | null,
): CallReview | null {
  if (!row || !row.content) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(row.content)
  } catch (err) {
    console.warn('call_review JSON.parse failed:', err)
    return null
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as { pain_points?: unknown }).pain_points) ||
    !Array.isArray((parsed as { wins?: unknown }).wins) ||
    !Array.isArray(
      (parsed as { dodged_questions?: unknown }).dodged_questions,
    ) ||
    typeof (parsed as { sentiment_arc?: unknown }).sentiment_arc !==
      'string'
  ) {
    console.warn('call_review shape invalid:', parsed)
    return null
  }
  const obj = parsed as {
    pain_points: CallReviewItem[]
    wins: CallReviewItem[]
    dodged_questions: CallReviewDodgedItem[]
    sentiment_arc: string
  }
  return {
    pain_points: obj.pain_points,
    wins: obj.wins,
    dodged_questions: obj.dodged_questions,
    sentiment_arc: obj.sentiment_arc,
    generated_at: row.created_at,
  }
}

// ----------------------------------------------------------------------
// updateCallClassification
// ----------------------------------------------------------------------
//
// Atomic update of (call_category, call_type, primary_client_id) +
// per-changed-field call_classification_history rows via the
// update_call_classification Postgres function (migration 0016).
//
// Behavior baked into the function (not the caller's responsibility):
//   - Server-side primary_client_id auto-clear when category changes
//     to non-client. Generates a separate history row for the clear.
//   - is_retrievable_by_client_agents auto-derived (true iff
//     category='client' AND primary_client_id IS NOT NULL).
//   - classification_method auto-set to 'manual' on any change.
//   - No-op silently when no fields differ from the current row.
//
// `currentUserTeamMemberId` is best-effort: passing null is fine and
// expected for V1 (auth.users → team_members resolution is not yet
// wired). The history row's changed_by accepts null per migration 0013.
export async function updateCallClassification(
  callId: string,
  changes: Partial<Record<UpdatableClassificationField, string | null>>,
  currentUserTeamMemberId?: string | null,
): Promise<
  | {
      success: true
      fields_changed: number
      history_rows_written: number
      auto_cleared_primary_client_id: boolean
    }
  | { success: false; error: string }
> {
  // Reject any keys outside the editable whitelist before reaching the
  // RPC. The function would also fail (CHECK constraint on
  // field_name), but failing early gives a clean error message instead
  // of a Postgres constraint message bubbling to the UI.
  for (const key of Object.keys(changes)) {
    if (!(UPDATABLE_CLASSIFICATION_FIELDS as readonly string[]).includes(key)) {
      return { success: false, error: `Field not editable: ${key}` }
    }
  }

  const supabase = createAdminClient()
  // The migration declares p_changed_by as `uuid default null`, so
  // omitting it from the args / passing null is correct at the SQL
  // boundary. The 2026-05 supabase type generator drops the default-null
  // and types the arg as a required string; cast through unknown to
  // pass null without satisfying the regenerated type. Behavior is
  // unchanged at runtime; this is a type-gen quirk, not a real
  // nullability change.
  const { data, error } = await supabase.rpc('update_call_classification', {
    p_call_id: callId,
    p_changes: changes,
    p_changed_by: (currentUserTeamMemberId ?? null) as unknown as string,
  })

  if (error) return { success: false, error: error.message }

  const result = data as unknown as {
    fields_changed: number
    history_rows_written: number
    auto_cleared_primary_client_id: boolean
  }
  return {
    success: true,
    fields_changed: result.fields_changed,
    history_rows_written: result.history_rows_written,
    auto_cleared_primary_client_id: result.auto_cleared_primary_client_id,
  }
}
