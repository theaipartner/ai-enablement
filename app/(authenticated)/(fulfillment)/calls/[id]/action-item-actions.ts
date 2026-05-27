'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'

// Server actions for the Confirm-flow UX on the call detail page. Three
// surface-area actions:
//
//   - updateActionItemDescription — edit one row's description text.
//   - deleteActionItem — hard delete by id (per Decision 6).
//   - commitPendingActionItemChanges — apply a batch of edits + deletes
//     in sequence, return the redirect target (the call's primary client
//     detail page, falling back to /calls when primary_client_id is null).
//
// No transaction wrapper: the rows are independent and partial-apply is
// acceptable behavior here (per Decision 7). The eventual Confirm
// button UI is responsible for handling first-error stops and re-
// fetching state to show what landed.
//
// No auth gate per-action — the (authenticated) route-group layout
// already gates the path. No history row writes: call_action_items
// don't have an audit log today.

export async function updateActionItemDescription(
  itemId: string,
  newDescription: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const trimmed = newDescription.trim()
  if (trimmed.length === 0) {
    return { success: false, error: 'Description cannot be empty' }
  }
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('call_action_items')
    .update({ description: trimmed })
    .eq('id', itemId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function deleteActionItem(
  itemId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('call_action_items')
    .delete()
    .eq('id', itemId)
  if (error) return { success: false, error: error.message }
  return { success: true }
}

export async function commitPendingActionItemChanges(
  callId: string,
  edits: Array<{ itemId: string; newDescription: string }>,
  deletes: string[],
): Promise<
  | { success: true; redirectUrl: string }
  | { success: false; error: string; redirectUrl: null }
> {
  for (const edit of edits) {
    const result = await updateActionItemDescription(
      edit.itemId,
      edit.newDescription,
    )
    if (!result.success) {
      return { success: false, error: result.error, redirectUrl: null }
    }
  }
  for (const itemId of deletes) {
    const result = await deleteActionItem(itemId)
    if (!result.success) {
      return { success: false, error: result.error, redirectUrl: null }
    }
  }

  // Resolve redirect target: the call's primary_client_id, falling
  // back to /calls when null. Defensive — the new UI is built around
  // client calls so primary_client_id should always be set, but the
  // fallback keeps the action useful for the rare orphan case.
  const supabase = createAdminClient()
  const { data: call } = await supabase
    .from('calls')
    .select('primary_client_id')
    .eq('id', callId)
    .maybeSingle()
  const primaryClientId = (call as { primary_client_id: string | null } | null)
    ?.primary_client_id
  const redirectUrl = primaryClientId
    ? `/clients/${primaryClientId}`
    : '/calls'

  revalidatePath(`/calls/${callId}`)
  if (primaryClientId) revalidatePath(`/clients/${primaryClientId}`)

  return { success: true, redirectUrl }
}
