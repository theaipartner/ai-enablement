import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { Window } from './sales-dashboard-shared'
import { getDateRangeFromWindow, type DateRange } from './funnel-window'

// Funnel · DIRECT bookings — the landing-page self-book link.
//
// ┌─ BOOKING LINK IDENTITIES (read before touching this — 2026-05-29) ─┐
// │ The LP's Calendly widget routes to ONE specific event type, and    │
// │ several look-alikes must NOT be counted as direct bookings:        │
// │                                                                    │
// │  • DIRECT / funnel link  →  name "Ai Partner Strategy Call"        │
// │       event_type 8f6795d3-992a-4cbd-b584-9ecaabb3938c   ✅ THIS    │
// │  • Aman SOLO call        →  name "AI Partner Strategy Call"        │
// │       event_type a596a1b1-…-53092036c2c5 (aman-theaipartner)  ✗    │
// │  • period variant        →  name "AI Partner Strategy Call."      │
// │       event_type 8ce6d7e4-…-8892b68ef205                     ✗    │
// │  • SETTER-LED bookings   →  name "Partnership Call w/ {closer}"   │
// │       (e.g. w/ Aman, w/ Adam) — a setter booked it, not direct ✗  │
// │                                                                    │
// │ We key on the event_type URI (stable id), NOT the name (casing    │
// │ drifts). Full reference: docs/schema/calendly_scheduled_events.md  │
// │ § Booking link identities.                                         │
// └────────────────────────────────────────────────────────────────────┘
//
// Live data: bookings land via the Calendly webhook (api/calendly_events.py
// → calendly_scheduled_events), so this is real-time, no polling lag.
//
// Booking lead-time: when a lead self-books, Calendly only offers TODAY,
// +1 day, or +2 days (verified 2026-05-29: a 45-day mix was 8 today / 33
// one-day / 23 two-day, nothing 3+). We surface that split.

// The funnel direct self-book event type ("Ai Partner Strategy Call").
export const DIRECT_BOOKING_EVENT_TYPE_URI =
  'https://api.calendly.com/event_types/8f6795d3-992a-4cbd-b584-9ecaabb3938c'

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

// Whole-day gap between booking-created and meeting-start, both in ET.
// 0 = same day, 1 = next day, 2 = two days out.
function daysOutEt(createdIso: string, startIso: string): number {
  const c = etDateStr(new Date(createdIso))
  const s = etDateStr(new Date(startIso))
  const [cy, cm, cd] = c.split('-').map((n) => parseInt(n, 10))
  const [sy, sm, sd] = s.split('-').map((n) => parseInt(n, 10))
  return Math.round((Date.UTC(sy, sm - 1, sd) - Date.UTC(cy, cm - 1, cd)) / 86_400_000)
}

type CalRow = {
  uri: string
  name: string | null
  status: string | null
  event_created_at: string
  start_time: string | null
  event_type_uri: string | null
}

async function loadDirectEvents(range: DateRange): Promise<CalRow[]> {
  const sb = createAdminClient()
  // Key on event_created_at (when the booking was made), per the
  // Engine-sheet convention — a booking made today for two days out
  // counts in today's funnel.
  const { data, error } = await sb
    .from('calendly_scheduled_events' as never)
    .select('uri, name, status, event_created_at, start_time, event_type_uri')
    .eq('event_type_uri', DIRECT_BOOKING_EVENT_TYPE_URI)
    .gte('event_created_at', range.startUtcIso)
    .lt('event_created_at', range.endUtcIso)
  if (error) throw new Error(`calendly_scheduled_events read failed: ${error.message}`)
  return (data ?? []) as unknown as CalRow[]
}

export type DirectBookings = {
  total: number        // all direct bookings created in the window (any status)
  today: number        // booked for same ET day
  oneDayOut: number    // booked for next ET day
  twoDaysOut: number   // booked for two ET days out
  trend: number[]      // 14-day daily series of new direct bookings
}

export async function getDirectBookings(arg: Window | DateRange): Promise<DirectBookings> {
  const range = resolveRange(arg)
  const rows = await loadDirectEvents(range)
  let today = 0
  let oneDayOut = 0
  let twoDaysOut = 0
  for (const r of rows) {
    if (!r.start_time) continue
    const d = daysOutEt(r.event_created_at, r.start_time)
    if (d === 0) today++
    else if (d === 1) oneDayOut++
    else if (d === 2) twoDaysOut++
  }

  // Trend: last 14 ET days of new direct bookings. Pull a wider UTC
  // window so the bordering ET days near the edge aren't truncated.
  const sb = createAdminClient()
  const trendStart = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString()
  const { data, error } = await sb
    .from('calendly_scheduled_events' as never)
    .select('event_created_at, event_type_uri')
    .eq('event_type_uri', DIRECT_BOOKING_EVENT_TYPE_URI)
    .gte('event_created_at', trendStart)
  if (error) throw new Error(`calendly trend read failed: ${error.message}`)
  const trendRows = (data ?? []) as unknown as Array<{ event_created_at: string }>

  const todayEtStr = etDateStr(new Date())
  const trend: number[] = []
  for (let i = 13; i >= 0; i--) {
    const key = addDaysToEtDateStr(todayEtStr, -i)
    trend.push(trendRows.filter((r) => etDateStr(new Date(r.event_created_at)) === key).length)
  }

  return { total: rows.length, today, oneDayOut, twoDaysOut, trend }
}
