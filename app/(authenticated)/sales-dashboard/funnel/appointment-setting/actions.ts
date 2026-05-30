'use server'

// Creator-only soft-hide for a test triage "call" on the per-rep Call
// Activity drill. Sets airtable_setter_triage_calls.excluded_at; the
// per-rep fetchers filter excluded_at IS NULL, so the row drops out of
// both the counts and the drill. Soft-hide (not delete) because the
// table is an Airtable mirror — see migration 0059 for the why.

import { revalidatePath } from 'next/cache'

import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'
import { createAdminClient } from '@/lib/supabase/admin'

export type HideTriageCallResult = { ok: true } | { ok: false; error: string }

const APPT_SETTING_PATH = '/sales-dashboard/funnel/appointment-setting'

// Hide a single triage-form row by its Airtable record_id. Gated to the
// `creator` tier server-side — the UI also hides the control, but this
// is the authoritative check (a non-creator calling the action directly
// is rejected here).
export async function hideTestTriageCall(recordId: string): Promise<HideTriageCallResult> {
  if (!recordId || typeof recordId !== 'string') {
    return { ok: false, error: 'invalid_record_id' }
  }

  const access = await getCurrentUserAccessTier()
  if (!access || access.tier !== 'creator') {
    return { ok: false, error: 'forbidden' }
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('airtable_setter_triage_calls' as never)
    .update({
      excluded_at: new Date().toISOString(),
      excluded_by: access.team_member.email,
    } as never)
    .eq('record_id', recordId)

  if (error) return { ok: false, error: error.message }

  revalidatePath(APPT_SETTING_PATH)
  return { ok: true }
}
