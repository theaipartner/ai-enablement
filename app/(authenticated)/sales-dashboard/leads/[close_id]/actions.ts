'use server'

// Save the free-text note on the per-lead page (lead_notes, migration 0090).
// One editable note per lead — the textarea's full text overwrites the prior
// note. Any authenticated team member can edit (shared scratchpad); the write
// is still gated server-side to a resolved team_members row.

import { revalidatePath } from 'next/cache'

import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'
import { createAdminClient } from '@/lib/supabase/admin'

export type SaveNoteResult =
  | { ok: true; updatedAt: string; updatedBy: string }
  | { ok: false; error: string }

const MAX_NOTE_LEN = 10_000

export async function saveLeadNote(closeId: string, note: string): Promise<SaveNoteResult> {
  if (!closeId || typeof closeId !== 'string') {
    return { ok: false, error: 'invalid_close_id' }
  }
  if (typeof note !== 'string') {
    return { ok: false, error: 'invalid_note' }
  }
  if (note.length > MAX_NOTE_LEN) {
    return { ok: false, error: 'note_too_long' }
  }

  // Any logged-in team member may edit; reject callers with no team_members row.
  const access = await getCurrentUserAccessTier()
  if (!access) {
    return { ok: false, error: 'forbidden' }
  }

  const updatedAt = new Date().toISOString()
  const updatedBy = access.team_member.full_name

  const admin = createAdminClient()
  const { error } = await admin
    .from('lead_notes' as never)
    .upsert(
      { close_id: closeId, note, updated_by: updatedBy, updated_at: updatedAt } as never,
      { onConflict: 'close_id' },
    )

  if (error) return { ok: false, error: error.message }

  revalidatePath(`/sales-dashboard/leads/${encodeURIComponent(closeId)}`)
  return { ok: true, updatedAt, updatedBy }
}
