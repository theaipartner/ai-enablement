import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

// Reads lead_tag_runs for the admin retag-log page. The page is EXCEPTION-ONLY:
// it surfaces runs that errored OR produced an anomaly (a set-once identity tag
// that changed/regressed = a bug/drift signal). Routine successful runs are not
// shown — only counted for the 24h context strip. See shared/lead_tagging.py +
// migration 0068.

export type TagAnomaly = { close_id: string; kind: string; detail: string }

export type TagRunException = {
  id: number
  ran_at: string
  trigger: string
  lead_count: number | null
  ok: boolean
  error: string | null
  anomalies: TagAnomaly[] | null
  duration_ms: number | null
}

export type LeadTagLog = {
  exceptions: TagRunException[]
  lastRunAt: string | null
  runsLast24h: number
  errorsLast24h: number
}

export async function getLeadTagLog(): Promise<LeadTagLog> {
  const sb = createAdminClient()

  // Exception feed — errored OR anomalous, newest first.
  const { data: exc, error: excErr } = await sb
    .from('lead_tag_runs' as never)
    .select('id, ran_at, trigger, lead_count, ok, error, anomalies, duration_ms')
    .or('ok.eq.false,anomalies.not.is.null')
    .order('ran_at', { ascending: false })
    .limit(100)
  if (excErr) throw new Error(`lead-tag-log: exception feed read failed: ${excErr.message}`)

  // 24h context — total runs + error count, so a clean page still shows the
  // tagger is alive (last run time) and the volume it's handling.
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  const { data: recent, error: recentErr } = await sb
    .from('lead_tag_runs' as never)
    .select('ok, ran_at')
    .gte('ran_at', since)
  if (recentErr) throw new Error(`lead-tag-log: 24h context read failed: ${recentErr.message}`)

  const { data: latest } = await sb
    .from('lead_tag_runs' as never)
    .select('ran_at')
    .order('ran_at', { ascending: false })
    .limit(1)

  const recentRows = (recent ?? []) as unknown as Array<{ ok: boolean }>
  return {
    exceptions: (exc ?? []) as unknown as TagRunException[],
    lastRunAt: ((latest ?? []) as unknown as Array<{ ran_at: string }>)[0]?.ran_at ?? null,
    runsLast24h: recentRows.length,
    errorsLast24h: recentRows.filter((r) => !r.ok).length,
  }
}
