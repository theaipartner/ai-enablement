'use server'

// Admin actions for the sales-rep verify page (/sales-dashboard/reps).
//
// A candidate is an Airtable "Sales Team Member" row mirrored into
// `sales_rep_candidates` (migration 0109). Three actions:
//   - saveRepDraft     — persist in-progress field values (status='draft'); the
//                        card stays open. For reps not yet in Close/Calendly.
//   - completeRep      — finalize: write/upsert the team_members row (so the rep
//                        auto-appears on every per-rep surface via the existing
//                        joins), then mark the verification 'completed'.
//   - deleteRepCandidate — dismiss a test/junk candidate (status='deleted').
//
// All three are admin-gated server-side (the layout also gates, but a direct
// call must be rejected too). access_tier is always 'csm' for a sales rep — the
// verify form never sets a tier.

import { revalidatePath } from 'next/cache'

import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'
import { createAdminClient } from '@/lib/supabase/admin'
import type { SalesRole } from '@/lib/db/sales-rep-verify'

const REPS_PATH = '/sales-dashboard/reps'

export type RepActionResult = { ok: true } | { ok: false; error: string }

export type RepDraftInput = {
  airtableRecordId: string
  fullName: string | null
  salesRole: SalesRole | null
  email: string | null
  closeUserId: string | null
  calendlyEventTypeUri: string | null
}

const VALID_ROLES: SalesRole[] = ['setter', 'closer', 'dc_closer']

function clean(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length ? t : null
}

async function requireAdmin() {
  const access = await getCurrentUserAccessTier()
  if (!access || !tierAtLeast(access.tier, 'admin')) return null
  return access
}

// Save (or update) an in-progress draft. No required fields — the point of Save
// is to persist a partially-filled card.
export async function saveRepDraft(input: RepDraftInput): Promise<RepActionResult> {
  const recordId = clean(input.airtableRecordId)
  if (!recordId) return { ok: false, error: 'invalid_record_id' }

  const access = await requireAdmin()
  if (!access) return { ok: false, error: 'forbidden' }

  const role = input.salesRole
  if (role && !VALID_ROLES.includes(role)) {
    return { ok: false, error: 'invalid_sales_role' }
  }

  const admin = createAdminClient()
  const { error } = await admin
    .from('sales_rep_verifications' as never)
    .upsert(
      {
        airtable_record_id: recordId,
        status: 'draft',
        full_name: clean(input.fullName),
        sales_role: role ?? null,
        email: clean(input.email),
        close_user_id: clean(input.closeUserId),
        calendly_event_type_uri: clean(input.calendlyEventTypeUri),
        updated_by: access.team_member.email,
      } as never,
      { onConflict: 'airtable_record_id' } as never,
    )

  if (error) return { ok: false, error: error.message }
  revalidatePath(REPS_PATH)
  return { ok: true }
}

// Finalize: write the team_members row, then mark the verification complete.
// Requires full_name, sales_role, email, close_user_id (Calendly stays optional).
export async function completeRep(input: RepDraftInput): Promise<RepActionResult> {
  const recordId = clean(input.airtableRecordId)
  if (!recordId) return { ok: false, error: 'invalid_record_id' }

  const access = await requireAdmin()
  if (!access) return { ok: false, error: 'forbidden' }

  const fullName = clean(input.fullName)
  const role = input.salesRole
  const email = clean(input.email)
  const closeUserId = clean(input.closeUserId)
  const calendly = clean(input.calendlyEventTypeUri)

  if (!fullName) return { ok: false, error: 'full_name_required' }
  if (!role || !VALID_ROLES.includes(role)) {
    return { ok: false, error: 'sales_role_required' }
  }
  if (!email) return { ok: false, error: 'email_required' }
  if (!closeUserId) return { ok: false, error: 'close_user_id_required' }

  const admin = createAdminClient()

  // Find an existing non-archived team_members row to update (re-verify), by
  // airtable_user_id first, then email. Otherwise insert a fresh row.
  const { data: existingRows } = await admin
    .from('team_members' as never)
    .select('id, airtable_user_id, email')
    .or(`airtable_user_id.eq.${recordId},email.ilike.${email}`)
    .is('archived_at', null)

  const existing = ((existingRows ?? []) as Array<Record<string, unknown>>)[0]

  const fields = {
    full_name: fullName,
    email,
    role: 'sales',
    sales_role: role,
    airtable_user_id: recordId,
    close_user_id: closeUserId,
    calendly_event_type_uri: calendly,
    access_tier: 'csm',
    is_active: true,
  }

  let teamMemberId: string
  if (existing) {
    teamMemberId = existing.id as string
    const { error } = await admin
      .from('team_members' as never)
      .update(fields as never)
      .eq('id', teamMemberId)
    if (error) return { ok: false, error: error.message }
  } else {
    const { data: inserted, error } = await admin
      .from('team_members' as never)
      .insert(fields as never)
      .select('id')
      .single()
    if (error) return { ok: false, error: error.message }
    teamMemberId = (inserted as Record<string, unknown>).id as string
  }

  const { error: verErr } = await admin
    .from('sales_rep_verifications' as never)
    .upsert(
      {
        airtable_record_id: recordId,
        status: 'completed',
        full_name: fullName,
        sales_role: role,
        email,
        close_user_id: closeUserId,
        calendly_event_type_uri: calendly,
        team_member_id: teamMemberId,
        updated_by: access.team_member.email,
      } as never,
      { onConflict: 'airtable_record_id' } as never,
    )
  if (verErr) return { ok: false, error: verErr.message }

  revalidatePath(REPS_PATH)
  revalidatePath('/sales-dashboard/people')
  return { ok: true }
}

// Dismiss a test/junk candidate. Sticky across re-sync (the mirror cron never
// writes sales_rep_verifications).
export async function deleteRepCandidate(
  airtableRecordId: string,
): Promise<RepActionResult> {
  const recordId = clean(airtableRecordId)
  if (!recordId) return { ok: false, error: 'invalid_record_id' }

  const access = await requireAdmin()
  if (!access) return { ok: false, error: 'forbidden' }

  const admin = createAdminClient()
  const { error } = await admin
    .from('sales_rep_verifications' as never)
    .upsert(
      {
        airtable_record_id: recordId,
        status: 'deleted',
        updated_by: access.team_member.email,
      } as never,
      { onConflict: 'airtable_record_id' } as never,
    )

  if (error) return { ok: false, error: error.message }
  revalidatePath(REPS_PATH)
  return { ok: true }
}
