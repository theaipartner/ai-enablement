import { createAdminClient } from '@/lib/supabase/admin'

// The free-text scratchpad note on the per-lead page (lead_notes, migration
// 0090). One editable note per Close lead; see the per-lead page's actions.ts
// for the save path.

export type LeadNote = {
  note: string
  updatedAt: string | null
  updatedBy: string | null
}

// Read a lead's note. Returns null when none has been saved yet (the editor
// then starts blank). Fail-soft — a read error yields null, never a thrown
// page render.
export async function getLeadNote(closeId: string): Promise<LeadNote | null> {
  if (!closeId) return null
  try {
    const sb = createAdminClient()
    const { data, error } = await sb
      .from('lead_notes' as never)
      .select('note, updated_at, updated_by')
      .eq('close_id', closeId)
      .maybeSingle()
    if (error) throw new Error(error.message)
    if (!data) return null
    const row = data as unknown as { note: string | null; updated_at: string | null; updated_by: string | null }
    return { note: row.note ?? '', updatedAt: row.updated_at, updatedBy: row.updated_by }
  } catch {
    return null
  }
}
