'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { mergeClient, type MergeResult } from '@/lib/db/merge'

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
