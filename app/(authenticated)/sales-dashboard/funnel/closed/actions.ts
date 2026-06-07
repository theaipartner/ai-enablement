'use server'

// Creator-only soft-hide for a test booking on the Closing per-closer
// scheduled-calls drill. Sets calendly_scheduled_events.excluded_at;
// getClosingScheduledList filters excluded_at IS NULL, so the booking
// drops out of both the drill and the per-closer aggregates. Soft-hide
// (not delete) because the table is a Calendly mirror — see migration
// 0060 for the why.

import { revalidatePath } from 'next/cache'

import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'
import { createAdminClient } from '@/lib/supabase/admin'

export type HideBookingResult = { ok: true } | { ok: false; error: string }

const CLOSED_PATH = '/sales-dashboard/funnel/closed'

// Hide a single booking by its Calendly event URI. Gated to the
// `creator` tier server-side (the UI also hides the control, but this is
// the authoritative check).
export async function hideTestCloserBooking(eventUri: string): Promise<HideBookingResult> {
  if (!eventUri || typeof eventUri !== 'string') {
    return { ok: false, error: 'invalid_event_uri' }
  }

  const access = await getCurrentUserAccessTier()
  if (!access || access.tier !== 'creator') {
    return { ok: false, error: 'forbidden' }
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('calendly_scheduled_events' as never)
    .update({
      excluded_at: new Date().toISOString(),
      excluded_by: access.team_member.email,
    } as never)
    .eq('uri', eventUri)

  if (error) return { ok: false, error: error.message }

  revalidatePath(CLOSED_PATH)
  revalidatePath('/sales-dashboard/people')   // the per-closer drill lives here now
  return { ok: true }
}
