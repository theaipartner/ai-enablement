import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'

// Per-rep EOD reader for the roster detail page. Resolves the rep's
// close_user_id → airtable_user_id (team_members) and returns that rep's EOD
// entries (airtable_rep_eods) whose date falls in the selected window, newest
// first. Sparse today (only a few reps fill them) — most reps return []. The
// display renders the labeled fields straight from `fields` (the Airtable
// record), so new EOD-form fields show up with no code change.

export type RepEod = {
  recordId: string
  kind: 'setter' | 'closer'
  eodDate: string | null
  fields: Record<string, unknown>
}

export async function getRepEods(
  range: DateRange,
  closeUserId: string,
): Promise<RepEod[]> {
  const admin = createAdminClient()

  const { data: tm } = await admin
    .from('team_members' as never)
    .select('airtable_user_id')
    .eq('close_user_id', closeUserId)
    .is('archived_at', null)
    .maybeSingle()
  const airtableId = (tm as Record<string, unknown> | null)?.airtable_user_id as
    | string
    | undefined
  if (!airtableId) return []

  const { data } = await admin
    .from('airtable_rep_eods' as never)
    .select('record_id, kind, eod_date, fields_raw')
    .eq('rep_record_id', airtableId)
    .gte('eod_date', range.startEtDate)
    .lte('eod_date', range.endEtDate)
    .order('eod_date', { ascending: false })

  return ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
    recordId: r.record_id as string,
    kind: r.kind as 'setter' | 'closer',
    eodDate: (r.eod_date as string) ?? null,
    fields: (r.fields_raw as Record<string, unknown>) ?? {},
  }))
}
