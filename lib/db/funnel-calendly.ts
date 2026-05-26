import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { Window } from './sales-dashboard-shared'
import { getDateRangeFromWindow, type DateRange } from './funnel-window'

// Funnel · Calendly closer bookings — LP detail page section.
//
// The LP routes its Calendly widget to the *round-robin* AI Partner
// Strategy Call event, hosted via team URL:
//   https://calendly.com/d/ctzn-h5d-6bg/ai-partner-strategy-call
//
// The mirror's `calendly_event_types` catalog does NOT contain this
// event type — Calendly's `/event_types` endpoint omits team / round-
// robin types from the standard catalog (and the schema doc also
// notes ~58% of historical events reference retired event_type URIs
// absent from the active catalog). So we can't join by URI to the
// catalog directly.
//
// Strategy:
//   1. Match all scheduled_events whose name (case-insensitive)
//      starts with "ai partner strategy call".
//   2. Exclude the one event_type_uri we KNOW maps to the solo
//      version (calendly.com/aman-theaipartner/strategy-call,
//      uri ending in a596a1b1-...). Everything else is the team /
//      round-robin variant.
//
// As historical naming drifts ("AI Partner Strategy Call",
// "Ai Partner Strategy Call", "AI Partner Strategy Call.") all three
// patterns are non-Aman-solo and represent the round-robin bookings.

const NAME_PREFIX_LC = 'ai partner strategy call'

// Solo "AI Partner Strategy Call" hosted by Aman (calendly.com/
// aman-theaipartner/strategy-call). Pulled from
// calendly_event_types catalog. Confirmed via the mirror's
// scheduling_url. This is the URI to EXCLUDE.
const EXCLUDED_SOLO_URI =
  'https://api.calendly.com/event_types/a596a1b1-160e-4ebd-b820-53092036c2c5'

function resolveRange(arg: Window | DateRange): DateRange {
  if (typeof arg === 'string') return getDateRangeFromWindow(arg)
  return arg
}

function etDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

function addDaysToEtDateStr(etDate: string, days: number): string {
  const [y, m, d] = etDate.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

type CalRow = {
  uri: string
  name: string | null
  status: string | null
  event_created_at: string
  event_type_uri: string | null
}

async function loadCloserEvents(range: DateRange): Promise<CalRow[]> {
  const sb = createAdminClient()
  // Engine-sheet convention: key on event_created_at (when the
  // booking was created), not start_time. A booking made today for
  // next week counts in today's funnel. timestamptz column → filter
  // against the UTC ISO bounds.
  const { data, error } = await sb
    .from('calendly_scheduled_events' as never)
    .select('uri, name, status, event_created_at, event_type_uri')
    .gte('event_created_at', range.startUtcIso)
    .lt('event_created_at', range.endUtcIso)
  if (error) throw new Error(`calendly_scheduled_events read failed: ${error.message}`)
  const rows = (data ?? []) as unknown as CalRow[]
  return rows.filter((r) => {
    if (!r.name) return false
    if (!r.name.toLowerCase().startsWith(NAME_PREFIX_LC)) return false
    if (r.event_type_uri === EXCLUDED_SOLO_URI) return false
    return true
  })
}

export type CalendlyBookings = {
  total: number       // all closer bookings created in window (any status)
  active: number      // currently active (not canceled)
  canceled: number
  trend: number[]     // 14-day daily series of new bookings (any status)
}

export async function getCloserBookings(arg: Window | DateRange): Promise<CalendlyBookings> {
  const range = resolveRange(arg)
  const rows = await loadCloserEvents(range)
  let active = 0
  let canceled = 0
  for (const r of rows) {
    if (r.status === 'canceled') canceled++
    else active++
  }

  // Trend: last 14 ET days. Pull a wider UTC window so the bordering
  // ET days near the edge aren't truncated.
  const sb = createAdminClient()
  const trendStart = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await sb
    .from('calendly_scheduled_events' as never)
    .select('event_created_at, name, event_type_uri')
    .gte('event_created_at', trendStart)
  if (error) throw new Error(`calendly trend read failed: ${error.message}`)
  const trendRows = ((data ?? []) as unknown as CalRow[]).filter((r) => {
    if (!r.name) return false
    if (!r.name.toLowerCase().startsWith(NAME_PREFIX_LC)) return false
    if (r.event_type_uri === EXCLUDED_SOLO_URI) return false
    return true
  })

  const todayEtStr = etDateStr(new Date())
  const trend: number[] = []
  for (let i = 13; i >= 0; i--) {
    const key = addDaysToEtDateStr(todayEtStr, -i)
    trend.push(
      trendRows.filter((r) => etDateStr(new Date(r.event_created_at)) === key).length,
    )
  }

  return {
    total: rows.length,
    active,
    canceled,
    trend,
  }
}
