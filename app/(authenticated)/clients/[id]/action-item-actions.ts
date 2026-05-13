'use server'

import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'

// Soft mark-done on a client's open action items, fired from the
// Action items box on the /clients/[id] detail page (per Clients
// Redesign mock § 2). No history row, no hard delete — the checkbox
// flips status between 'open' and 'done' and the row stays in
// call_action_items either way.
export async function setActionItemStatusAction(
  clientId: string,
  itemId: string,
  status: 'open' | 'done',
): Promise<{ success: true } | { success: false; error: string }> {
  const supabase = createAdminClient()
  const update: { status: string; completed_at: string | null } = {
    status,
    completed_at: status === 'done' ? new Date().toISOString() : null,
  }
  const { error } = await supabase
    .from('call_action_items')
    .update(update)
    .eq('id', itemId)
  if (error) return { success: false, error: error.message }
  revalidatePath(`/clients/${clientId}`)
  return { success: true }
}
