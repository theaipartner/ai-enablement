import 'server-only'

import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { getEstMonthStart } from '@/lib/time/est-periods'

// client_meetings is newer than the generated Supabase types (lib/supabase/
// types.ts lags the migration ledger — same as lead_cycles et al.), so we
// reach it through an untyped client handle and cast results to the local
// row shapes below. Contained to this file; revisit if types.ts is ever
// regenerated against the live schema.
function meetingsClient(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient
}

// Read layer for the client_meetings table (populated by
// api/client_meetings_sync_cron.py from Google Calendar). This is the
// source of truth for the per-client "meetings this month" metric and the
// month-by-month history on the client page — replacing the old
// Fathom-calls-based count. Months are bucketed on EST boundaries per
// ADR 0003 (store UTC, aggregate in America/New_York).

export type MeetingMonth = {
  month: string // 'YYYY-MM' (EST), stable key for the picker
  label: string // e.g. 'June 2026'
  count: number
}

// Meetings in the current EST month, keyed by client_id. One DB scan for
// the whole clients list. start_time has no upper bound because the cron
// only ever stores meetings that have already happened.
export async function getCurrentMonthMeetingCounts(): Promise<
  Map<string, number>
> {
  const supabase = meetingsClient()
  const monthStart = getEstMonthStart(0)
  const { data, error } = await supabase
    .from('client_meetings')
    .select('client_id')
    .gte('start_time', monthStart.toISOString())
  if (error) throw error

  const counts = new Map<string, number>()
  for (const row of (data ?? []) as Array<{ client_id: string }>) {
    counts.set(row.client_id, (counts.get(row.client_id) ?? 0) + 1)
  }
  return counts
}

// Per-month meeting counts for one client, newest month first, covering the
// last `months` EST months (index 0 = current month). Always returns a full
// `months`-length series so the picker has a complete dropdown even for
// months with zero meetings.
export async function getClientMeetingMonths(
  clientId: string,
  months = 12,
): Promise<MeetingMonth[]> {
  const supabase = meetingsClient()
  const earliest = getEstMonthStart(months - 1)
  const { data, error } = await supabase
    .from('client_meetings')
    .select('start_time')
    .eq('client_id', clientId)
    .gte('start_time', earliest.toISOString())
  if (error) throw error
  const starts = ((data ?? []) as Array<{ start_time: string }>).map(
    (r) => new Date(r.start_time),
  )

  const labelFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
    year: 'numeric',
  })
  const keyFmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
  })

  const series: MeetingMonth[] = []
  for (let i = 0; i < months; i++) {
    const bucketStart = getEstMonthStart(i)
    const bucketEnd = getEstMonthStart(i - 1) // first day of the next month
    const count = starts.filter(
      (d) => d >= bucketStart && d < bucketEnd,
    ).length
    series.push({
      month: keyFmt.format(bucketStart), // en-CA → 'YYYY-MM'
      label: labelFmt.format(bucketStart),
      count,
    })
  }
  return series
}
