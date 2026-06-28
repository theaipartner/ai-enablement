import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type {
  RepCandidate,
  CloseUserOption,
  SalesRole,
} from './sales-rep-verify-shared'

// Sales-rep verify page (/sales-dashboard/reps) data layer (server-only).
//
// A new sales rep first appears in the Airtable "Sales Team Member" table; a
// Python cron mirrors it into `sales_rep_candidates` (migration 0109). This
// reads the FORWARD-ONLY set (created on/after the cutoff) that isn't already
// mapped into team_members, joined with any in-progress verification draft, so
// an admin can resolve the Close link + email + role and Complete — which writes
// the team_members row (see ./actions). Also reads `close_users` for the picker.
//
// Types + the role-default helper live in ./sales-rep-verify-shared (the Client
// Component imports those; it can't import this server-only module).
//
// The cutoff MUST stay in lockstep with VERIFY_CUTOFF in
// api/sales_rep_candidates_sync_cron.py.
export const SALES_REP_VERIFY_CUTOFF = '2026-06-27T00:00:00.000Z'

export type { RepCandidate, CloseUserOption, SalesRole }

// The candidates awaiting verification: forward-only, not yet a team_member,
// not dismissed/completed. A row with a 'draft' verification is shown as
// in-progress (Save was used); 'completed'/'deleted' rows are filtered out.
export async function getRepCandidates(): Promise<RepCandidate[]> {
  const admin = createAdminClient()

  const [candRes, verRes, tmRes] = await Promise.all([
    admin
      .from('sales_rep_candidates' as never)
      .select(
        'airtable_record_id, full_name, job_title, airtable_created_at, is_active',
      )
      .gte('airtable_created_at', SALES_REP_VERIFY_CUTOFF)
      .order('airtable_created_at', { ascending: false }),
    admin
      .from('sales_rep_verifications' as never)
      .select(
        'airtable_record_id, status, full_name, sales_role, email, close_user_id, calendly_event_type_uri, updated_by, updated_at',
      ),
    admin
      .from('team_members' as never)
      .select('airtable_user_id')
      .not('airtable_user_id', 'is', null)
      .is('archived_at', null),
  ])

  const candidates = (candRes.data ?? []) as Array<Record<string, unknown>>
  const verifications = (verRes.data ?? []) as Array<Record<string, unknown>>
  const teamMembers = (tmRes.data ?? []) as Array<Record<string, unknown>>

  const verByRecord = new Map<string, Record<string, unknown>>()
  for (const v of verifications) {
    verByRecord.set(v.airtable_record_id as string, v)
  }
  const mappedRecordIds = new Set(
    teamMembers.map((t) => t.airtable_user_id as string),
  )

  const out: RepCandidate[] = []
  for (const c of candidates) {
    const recordId = c.airtable_record_id as string
    // Already a team member → fully verified, drop it.
    if (mappedRecordIds.has(recordId)) continue
    const v = verByRecord.get(recordId)
    const status = v?.status as string | undefined
    // Dismissed or already completed → drop it.
    if (status === 'deleted' || status === 'completed') continue

    out.push({
      airtableRecordId: recordId,
      fullName: (c.full_name as string) ?? null,
      jobTitle: (c.job_title as string) ?? null,
      airtableCreatedAt: (c.airtable_created_at as string) ?? null,
      status: status === 'draft' ? 'draft' : null,
      draft: v
        ? {
            fullName: (v.full_name as string) ?? null,
            salesRole: (v.sales_role as SalesRole) ?? null,
            email: (v.email as string) ?? null,
            closeUserId: (v.close_user_id as string) ?? null,
            calendlyEventTypeUri: (v.calendly_event_type_uri as string) ?? null,
            updatedBy: (v.updated_by as string) ?? null,
            updatedAt: (v.updated_at as string) ?? null,
          }
        : null,
    })
  }
  return out
}

// The Close-user roster for the picker (mirrored daily by close_users_sync_cron).
export async function getCloseUsersForPicker(): Promise<CloseUserOption[]> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('close_users' as never)
    .select('close_user_id, email, full_name')
    .order('full_name', { ascending: true })

  return ((data ?? []) as Array<Record<string, unknown>>).map((u) => ({
    closeUserId: u.close_user_id as string,
    email: (u.email as string) ?? null,
    fullName: (u.full_name as string) ?? null,
  }))
}
