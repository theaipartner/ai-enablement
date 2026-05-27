'use server'

import { revalidatePath } from 'next/cache'
import {
  updateCallClassification,
  type UpdatableClassificationField,
} from '@/lib/db/calls'

// Wraps the update_call_classification RPC. No per-action auth gate —
// the (authenticated) route-group layout already gates the path.
//
// currentUserTeamMemberId is intentionally null in V1: the auth.users
// → team_members resolution is not yet wired (best-effort by email
// per migration 0013's column comment). The history row records null
// for changed_by until that resolution lands.
export async function updateCallClassificationAction(
  callId: string,
  changes: Partial<Record<UpdatableClassificationField, string | null>>,
): Promise<
  | {
      success: true
      fields_changed: number
      history_rows_written: number
      auto_cleared_primary_client_id: boolean
    }
  | { success: false; error: string }
> {
  const result = await updateCallClassification(callId, changes, null)
  if (result.success) {
    revalidatePath(`/calls/${callId}`)
    revalidatePath('/calls')
  }
  return result
}
