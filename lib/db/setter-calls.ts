import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

// Server-side data layer for the sales-dashboard Calls surface.
//
// HARD ISOLATION: this file is sales-only. It never reaches into the
// CS-side calls/clients tables and is never imported from any
// CS-side page. The data it returns is rendered ONLY on
// /sales-dashboard/calls/* — out of reach of Ella / retrieval.
//
// Sources joined:
//   - setter_call_transcripts (the recordings we've transcribed)
//   - close_calls           (raw call metadata — direction, duration)
//   - close_leads           (prospect display_name, status)
//   - team_members          (setter / closer identification)
//
// Joins are done via separate PostgREST queries + JS-side stitching
// rather than nested-select because PostgREST's FK-relationship
// detection breaks on tables that don't share a declared relationship
// (close_calls.user_id → team_members.close_user_id is not a real FK,
// just a denormalized link). For ~55 rows the round-trip cost is
// negligible.

export type SetterCallListRow = {
  close_call_id: string
  activity_at: string
  duration_s: number
  setter_user_id: string | null
  setter_name: string | null
  setter_role: string | null              // 'setter' | 'closer' (from team_members.sales_role)
  prospect_name: string | null
  prospect_lead_id: string | null
  direction: string | null
  confidence: number | null
  speaker_count: number | null
  has_review: boolean                     // true once setter_call_reviews lands (V2)
  deepgram_cost_usd: number | null
}

export type SetterCallListFilters = {
  // Filter to a specific Close user_id (matches close_calls.user_id).
  // Used by deep-links from the appointment-setting tables.
  setterCloseUserId?: string | null
}

/**
 * List transcribed setter calls. Newest first.
 *
 * Filters today: setter (close_calls.user_id). Date-range filter is
 * intentionally out of scope until call volume crosses a few hundred —
 * the list-page renders flat under that.
 */
export async function listSetterCalls(
  filters: SetterCallListFilters = {},
): Promise<SetterCallListRow[]> {
  const supabase = createAdminClient()

  // 1. Pull every transcript row, joined to close_calls for the
  //    operational metadata (activity_at, duration, lead_id, user_id).
  //    The (close_calls!setter_call_transcripts_close_call_id_fkey)
  //    nested select would work because we DO have a real FK on
  //    setter_call_transcripts.close_call_id → close_calls.close_id.
  //
  //    `as never` mirrors the convention used throughout lib/db when
  //    the generated `Database` type predates a table or column. The
  //    types file is regenerated via `supabase gen types typescript`
  //    — we should refresh it after this lands, separately.
  const { data: trxRows, error: trxErr } = await supabase
    .from('setter_call_transcripts' as never)
    .select(`
      close_call_id,
      duration_s,
      confidence,
      speaker_count,
      deepgram_cost_usd,
      close_calls!setter_call_transcripts_close_call_id_fkey (
        activity_at,
        lead_id,
        user_id,
        direction
      )
    `)
    .order('transcribed_at', { ascending: false })
  if (trxErr) throw trxErr

  type TrxRowRaw = {
    close_call_id: string
    duration_s: number
    confidence: number | null
    speaker_count: number | null
    deepgram_cost_usd: number | null
    close_calls: {
      activity_at: string
      lead_id: string | null
      user_id: string | null
      direction: string | null
    } | null
  }
  const rows = (trxRows ?? []) as unknown as TrxRowRaw[]
  if (rows.length === 0) return []

  // 2. Resolve setter (close_calls.user_id → team_members.close_user_id).
  const userIds = Array.from(
    new Set(rows.map((r) => r.close_calls?.user_id).filter((v): v is string => !!v)),
  )
  const userMap = new Map<string, { full_name: string; sales_role: string | null }>()
  if (userIds.length > 0) {
    const { data: tm } = await supabase
      .from('team_members' as never)
      .select('close_user_id, full_name, sales_role')
      .in('close_user_id' as never, userIds)
    for (const t of (tm ?? []) as unknown as Array<{
      close_user_id: string
      full_name: string
      sales_role: string | null
    }>) {
      userMap.set(t.close_user_id, { full_name: t.full_name, sales_role: t.sales_role })
    }
  }

  // 3. Resolve prospect (close_calls.lead_id → close_leads.display_name).
  const leadIds = Array.from(
    new Set(rows.map((r) => r.close_calls?.lead_id).filter((v): v is string => !!v)),
  )
  const leadMap = new Map<string, string>()
  if (leadIds.length > 0) {
    const { data: ld } = await supabase
      .from('close_leads' as never)
      .select('close_id, display_name')
      .in('close_id' as never, leadIds)
    for (const l of (ld ?? []) as unknown as Array<{
      close_id: string
      display_name: string | null
    }>) {
      if (l.display_name) leadMap.set(l.close_id, l.display_name)
    }
  }

  // Apply setter filter (JS-side — the close_calls.user_id lives one
  // join away from the transcript row, so PostgREST can't filter on it
  // directly in a single query without a view). Cheap at current volume.
  const filtered = filters.setterCloseUserId
    ? rows.filter((r) => r.close_calls?.user_id === filters.setterCloseUserId)
    : rows

  return filtered.map((r) => {
    const userId = r.close_calls?.user_id ?? null
    const leadId = r.close_calls?.lead_id ?? null
    const setter = userId ? userMap.get(userId) : null
    return {
      close_call_id: r.close_call_id,
      activity_at: r.close_calls?.activity_at ?? '',
      duration_s: r.duration_s,
      setter_user_id: userId,
      setter_name: setter?.full_name ?? null,
      setter_role: setter?.sales_role ?? null,
      prospect_name: leadId ? leadMap.get(leadId) ?? null : null,
      prospect_lead_id: leadId,
      direction: r.close_calls?.direction ?? null,
      confidence: r.confidence,
      speaker_count: r.speaker_count,
      // V2: flip true once setter_call_reviews row exists.
      has_review: false,
      deepgram_cost_usd: r.deepgram_cost_usd,
    }
  })
}

// ---------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------

export type SetterCallWord = {
  word?: string
  punctuated_word?: string
  start: number
  end: number
  speaker?: number
  confidence?: number
}

export type SetterCallDetail = SetterCallListRow & {
  transcript_text: string
  words: SetterCallWord[]
  model: string
  deepgram_request_id: string
  transcribed_at: string
  // 30-day recording-expiry timestamp from close_calls.raw_payload.
  // Used to decide whether to surface a "play in Close" button.
  recording_expires_at: string | null
  // Direct link to view this call inside Close's web app.
  close_app_url: string
}

export async function getSetterCallById(
  closeCallId: string,
): Promise<SetterCallDetail | null> {
  const supabase = createAdminClient()

  const { data: trx, error } = await supabase
    .from('setter_call_transcripts' as never)
    .select(`
      close_call_id,
      transcript_text,
      words,
      model,
      deepgram_request_id,
      duration_s,
      confidence,
      speaker_count,
      deepgram_cost_usd,
      transcribed_at,
      close_calls!setter_call_transcripts_close_call_id_fkey (
        activity_at,
        lead_id,
        user_id,
        direction,
        raw_payload
      )
    `)
    .eq('close_call_id' as never, closeCallId)
    .maybeSingle()
  if (error) throw error
  if (!trx) return null

  type TrxRaw = {
    close_call_id: string
    transcript_text: string
    words: SetterCallWord[]
    model: string
    deepgram_request_id: string
    duration_s: number
    confidence: number | null
    speaker_count: number | null
    deepgram_cost_usd: number | null
    transcribed_at: string
    close_calls: {
      activity_at: string
      lead_id: string | null
      user_id: string | null
      direction: string | null
      raw_payload: Record<string, unknown> | null
    } | null
  }
  const row = trx as unknown as TrxRaw

  // Resolve setter + prospect with single round-trip each.
  const userId = row.close_calls?.user_id ?? null
  const leadId = row.close_calls?.lead_id ?? null

  let setter_name: string | null = null
  let setter_role: string | null = null
  if (userId) {
    const { data: tm } = await supabase
      .from('team_members' as never)
      .select('full_name, sales_role')
      .eq('close_user_id' as never, userId)
      .maybeSingle()
    if (tm) {
      const t = tm as unknown as { full_name: string; sales_role: string | null }
      setter_name = t.full_name
      setter_role = t.sales_role
    }
  }

  let prospect_name: string | null = null
  if (leadId) {
    const { data: ld } = await supabase
      .from('close_leads' as never)
      .select('display_name')
      .eq('close_id' as never, leadId)
      .maybeSingle()
    if (ld) {
      prospect_name = (ld as unknown as { display_name: string | null }).display_name
    }
  }

  const recording_expires_at =
    (row.close_calls?.raw_payload?.recording_expires_at as string | undefined) ?? null

  // Close's web app URL for the call (the recording_url we store, but
  // pointing at app.close.com which is what humans use to play audio).
  const close_app_url = `https://app.close.com/lead/${leadId ?? ''}/`

  return {
    close_call_id: row.close_call_id,
    activity_at: row.close_calls?.activity_at ?? '',
    duration_s: row.duration_s,
    setter_user_id: userId,
    setter_name,
    setter_role,
    prospect_name,
    prospect_lead_id: leadId,
    direction: row.close_calls?.direction ?? null,
    confidence: row.confidence,
    speaker_count: row.speaker_count,
    has_review: false,
    deepgram_cost_usd: row.deepgram_cost_usd,
    transcript_text: row.transcript_text,
    words: row.words ?? [],
    model: row.model,
    deepgram_request_id: row.deepgram_request_id,
    transcribed_at: row.transcribed_at,
    recording_expires_at,
    close_app_url,
  }
}
