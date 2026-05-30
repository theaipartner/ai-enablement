'use server'

// Creator-only soft-hide for a fake/mistaken lead on the Leads page.
// Sets close_leads.excluded_at; the lead-list cohort (getSpeedToLeadCohort)
// filters excluded_at IS NULL, so the lead drops out of the Leads page AND
// the Appointment Setting lead list (but NOT the per-rep Call Activity —
// the rep still dialed). Soft-hide (not delete) because close_leads is a
// Close mirror — see migration 0060. Reversible: clear excluded_at to
// un-hide.

import { revalidatePath } from 'next/cache'

import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'
import { createAdminClient } from '@/lib/supabase/admin'

export type HideLeadResult = { ok: true } | { ok: false; error: string }

const LEADS_PATH = '/sales-dashboard/leads'

// Hide a single lead by its Close id. Gated to the `creator` tier
// server-side — the UI also hides the control, but this is the
// authoritative check (a non-creator calling directly is rejected).
export async function hideTestLead(closeId: string): Promise<HideLeadResult> {
  if (!closeId || typeof closeId !== 'string') {
    return { ok: false, error: 'invalid_close_id' }
  }

  const access = await getCurrentUserAccessTier()
  if (!access || access.tier !== 'creator') {
    return { ok: false, error: 'forbidden' }
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('close_leads' as never)
    .update({
      excluded_at: new Date().toISOString(),
      excluded_by: access.team_member.email,
    } as never)
    .eq('close_id', closeId)

  if (error) return { ok: false, error: error.message }

  revalidatePath(LEADS_PATH)
  return { ok: true }
}
