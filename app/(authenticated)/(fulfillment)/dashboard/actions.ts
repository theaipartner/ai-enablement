'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { mergeClient, type MergeResult } from '@/lib/db/merge'
import {
  updateClientStatusWithHistory,
  updateClientCsmStandingWithHistory,
} from '@/lib/db/clients'

// Server actions for the dashboard "Needs Review" box. Three dispositions
// on an auto-created (needs_review-tagged) client:
//   - clear the tag        → dashboardClearNeedsReviewAction
//   - merge into a client  → dashboardMergeNeedsReviewAction
//   - delete (soft-archive)→ dashboardArchiveNeedsReviewAction
//
// All three guard on the source actually carrying the needs_review tag,
// so this surface can never touch a real (already-reviewed) client even
// if a stale id is replayed. The dashboard page is force-dynamic, so a
// router.refresh() on the client re-runs the server fetch; revalidatePath
// is belt-and-suspenders for the cached /clients surfaces.

type ActionResult = { success: true } | { success: false; error: string }

async function requireNeedsReview(
  clientId: string,
): Promise<
  | { ok: true; tags: string[]; metadata: Record<string, unknown> }
  | { ok: false; error: string }
> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('clients')
    .select('tags, metadata')
    .eq('id', clientId)
    .maybeSingle()
  if (error || !data) {
    return { ok: false, error: error?.message ?? 'Client not found' }
  }
  const tags: string[] = Array.isArray(data.tags) ? data.tags : []
  if (!tags.includes('needs_review')) {
    return { ok: false, error: 'Client is not flagged needs_review' }
  }
  const metadata = (data.metadata as Record<string, unknown> | null) ?? {}
  return { ok: true, tags, metadata }
}

export async function dashboardClearNeedsReviewAction(
  clientId: string,
): Promise<ActionResult> {
  const guard = await requireNeedsReview(clientId)
  if (!guard.ok) return { success: false, error: guard.error }

  const newTags = guard.tags.filter((t) => t !== 'needs_review')
  const newMetadata = {
    ...guard.metadata,
    needs_review_cleared_at: new Date().toISOString(),
  }

  const supabase = createAdminClient()
  const { error } = await supabase
    .from('clients')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ tags: newTags, metadata: newMetadata as any })
    .eq('id', clientId)
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard')
  revalidatePath('/clients')
  revalidatePath(`/clients/${clientId}`)
  return { success: true }
}

export async function dashboardArchiveNeedsReviewAction(
  clientId: string,
): Promise<ActionResult> {
  const guard = await requireNeedsReview(clientId)
  if (!guard.ok) return { success: false, error: guard.error }

  const supabase = createAdminClient()
  const { error } = await supabase
    .from('clients')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', clientId)
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard')
  revalidatePath('/clients')
  return { success: true }
}

export async function dashboardMergeNeedsReviewAction(
  sourceClientId: string,
  targetClientId: string,
): Promise<
  { success: true; result: MergeResult } | { success: false; error: string }
> {
  const result = await mergeClient(sourceClientId, targetClientId)
  if (result.success) {
    revalidatePath('/dashboard')
    revalidatePath('/clients')
    revalidatePath(`/clients/${targetClientId}`)
  }
  return result
}

// --- Ghost client flag actions --------------------------------------------

// "Mark ghost" — flip status active → ghost via the same history+cascade RPC
// the client page uses. The cascade (CSM reassignment, accountability/NPS
// disable, csm_standing=at_risk, history row) fires exactly as elsewhere.
export async function dashboardMarkGhostAction(
  clientId: string,
): Promise<ActionResult> {
  const result = await updateClientStatusWithHistory(clientId, 'ghost')
  if (result.success) {
    revalidatePath('/dashboard')
    revalidatePath('/clients')
    revalidatePath(`/clients/${clientId}`)
  }
  return result
}

// "Remove notification" — dismiss the ghost flag for this client by stamping
// metadata.ghost_dismissed_at. The flag stays hidden until the client posts
// again in their channel (any message after the dismissal un-hides it). Does
// not touch status or any other field.
export async function dashboardDismissGhostFlagAction(
  clientId: string,
): Promise<ActionResult> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('clients')
    .select('metadata')
    .eq('id', clientId)
    .maybeSingle()
  if (error || !data) {
    return { success: false, error: error?.message ?? 'Client not found' }
  }
  const metadata = (data.metadata as Record<string, unknown> | null) ?? {}
  const newMetadata = {
    ...metadata,
    ghost_dismissed_at: new Date().toISOString(),
  }
  const { error: writeErr } = await supabase
    .from('clients')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .update({ metadata: newMetadata as any })
    .eq('id', clientId)
  if (writeErr) return { success: false, error: writeErr.message }

  revalidatePath('/dashboard')
  revalidatePath('/clients')
  return { success: true }
}

// Set a client's CSM standing from the digest modal (history + cascade via
// the shared RPC). Thin wrapper that also revalidates the dashboard.
export async function dashboardSetCsmStandingAction(
  clientId: string,
  standing: 'happy' | 'content' | 'at_risk' | 'problem',
): Promise<ActionResult> {
  const result = await updateClientCsmStandingWithHistory(clientId, standing)
  if (result.success) {
    revalidatePath('/dashboard')
    revalidatePath('/clients')
    revalidatePath(`/clients/${clientId}`)
  }
  return result
}

// --- Missing Slack IDs actions --------------------------------------------

// Set clients.slack_user_id (Slack "U…" id). Trims; rejects empty.
export async function dashboardSetSlackUserIdAction(
  clientId: string,
  slackUserId: string,
): Promise<ActionResult> {
  const value = slackUserId.trim()
  if (!value) return { success: false, error: 'Slack user ID is required' }

  const supabase = createAdminClient()
  const { error } = await supabase
    .from('clients')
    .update({ slack_user_id: value })
    .eq('id', clientId)
  if (error) return { success: false, error: error.message }

  revalidatePath('/dashboard')
  revalidatePath('/clients')
  revalidatePath(`/clients/${clientId}`)
  return { success: true }
}

// Link a Slack channel id to a client by inserting (or re-attaching) a
// slack_channels row. Mirrors the onboarding RPC defaults: name = client
// full_name, is_private=false, passive monitoring on. Refuses to steal a
// channel already linked to a different client.
export async function dashboardLinkSlackChannelAction(
  clientId: string,
  slackChannelId: string,
): Promise<ActionResult> {
  const channelId = slackChannelId.trim()
  if (!channelId) return { success: false, error: 'Slack channel ID is required' }

  const supabase = createAdminClient()

  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('full_name')
    .eq('id', clientId)
    .maybeSingle()
  if (clientErr || !client) {
    return { success: false, error: clientErr?.message ?? 'Client not found' }
  }
  const name = client.full_name ?? channelId

  const { data: existing, error: existErr } = await supabase
    .from('slack_channels')
    .select('id, client_id')
    .eq('slack_channel_id', channelId)
    .maybeSingle()
  if (existErr) return { success: false, error: existErr.message }

  if (existing) {
    if (existing.client_id && existing.client_id !== clientId) {
      return {
        success: false,
        error: 'That channel is already linked to another client',
      }
    }
    const { error: updErr } = await supabase
      .from('slack_channels')
      .update({ client_id: clientId, is_archived: false, name })
      .eq('id', existing.id)
    if (updErr) return { success: false, error: updErr.message }
  } else {
    const { error: insErr } = await supabase.from('slack_channels').insert({
      slack_channel_id: channelId,
      client_id: clientId,
      name,
      is_private: false,
      is_archived: false,
      passive_monitoring_enabled: true,
      metadata: { created_via: 'dashboard_missing_slack' },
    })
    if (insErr) return { success: false, error: insErr.message }
  }

  revalidatePath('/dashboard')
  revalidatePath('/clients')
  revalidatePath(`/clients/${clientId}`)
  return { success: true }
}
