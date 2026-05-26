import 'server-only'

import { getEstPeriodBoundary } from '@/lib/time/est-periods'
import type { Window } from './sales-dashboard-shared'

// Calendar-anchored, ET-resolved date range for the funnel page.
//
// Why this exists: every Funnel fetcher used to do
// `new Date(Date.now() - N * 24h).toISOString().slice(0, 10)` which
// gives a ROLLING window anchored to UTC midnight. That contradicted:
//   - The window-switcher labels ("Since start of today / week /
//     month") which imply CALENDAR boundaries, not rolling.
//   - ADR 0003 "store UTC, render ET" — period boundaries are
//     ET-anchored (America/New_York, DST-aware).
//   - Wistia's `day` column, which is in ACCOUNT-LOCAL-TZ (ET for
//     this team). When mine used UTC and Wistia used ET, totals
//     drifted by 0–2 calendar days depending on time-of-day.
//
// The `DateRange` shape carries both an ET date-string boundary
// (for Wistia's `day` and Clarity's `snapshot_date`) AND a UTC ISO
// instant (for `timestamptz` columns like `typeform_responses.
// submitted_at` and `calendly_scheduled_events.event_created_at`).

export type DateRange = {
  // ET calendar dates, inclusive on both ends. Filter Wistia's
  // `day` column and Clarity's `snapshot_date` against these.
  startEtDate: string  // YYYY-MM-DD
  endEtDate: string    // YYYY-MM-DD
  // UTC ISO instants matching the same boundary.
  //   startUtcIso = ET 00:00 on startEtDate  (inclusive)
  //   endUtcIso   = current `now()`           (exclusive upper)
  // Use these for `timestamptz` columns.
  startUtcIso: string
  endUtcIso: string
}

// Format a UTC instant as a YYYY-MM-DD date string in ET.
function formatEtDate(d: Date): string {
  // en-CA gives ISO-style YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

// Convert a Window (1d / 7d / 30d) into the ET-anchored DateRange.
//
// Per WINDOW_LABELS in sales-dashboard-shared.ts:
//   '1d'  = "Since start of today"        → ET midnight today → now
//   '7d'  = "Since start of this week"    → Monday 00:00 ET   → now
//   '30d' = "Since start of this month"   → 1st 00:00 ET      → now
export function getDateRangeFromWindow(window: Window): DateRange {
  const periodKind = window === '1d' ? 'today' : window === '7d' ? 'week' : 'month'
  const startUtc = getEstPeriodBoundary(periodKind)
  const nowUtc = new Date()
  return {
    startEtDate: formatEtDate(startUtc),
    endEtDate: formatEtDate(nowUtc),
    startUtcIso: startUtc.toISOString(),
    endUtcIso: nowUtc.toISOString(),
  }
}

// Build a DateRange from explicit ET date strings (used by the date-
// range picker on the LP page).
//
// Both ends are inclusive ET calendar dates. `startUtcIso` is 00:00
// ET on startEtDate; `endUtcIso` is 00:00 ET on the day AFTER
// endEtDate (exclusive upper for `timestamptz` filters).
export function dateRangeFromExplicit(startEtDate: string, endEtDate: string): DateRange {
  // Parse the dates as ET-anchored midnight by computing the UTC
  // offset for "noon" of each date (offset is constant over the day
  // except across DST transitions, and noon is always inside the
  // same date in either zone).
  const startUtc = etDateMidnightToUtc(startEtDate)
  // Exclusive upper: midnight ET of the day after endEtDate.
  const endNext = addDaysToEtDate(endEtDate, 1)
  const endUtc = etDateMidnightToUtc(endNext)
  return {
    startEtDate,
    endEtDate,
    startUtcIso: startUtc.toISOString(),
    endUtcIso: endUtc.toISOString(),
  }
}

function etDateMidnightToUtc(etDate: string): Date {
  // Construct noon UTC on that date, format in ET to recover offset,
  // then subtract the offset minutes from the constructed UTC date.
  const [y, m, d] = etDate.split('-').map((n) => parseInt(n, 10))
  // Noon UTC of the same calendar date — used only to read the
  // offset for that day (handles DST correctly).
  const noonUtc = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    hour12: false,
  })
  const etHourOnNoonUtc = parseInt(fmt.format(noonUtc), 10) % 24
  // ET hour at noon UTC = 12 - offset_hours. So offset_hours = 12 - etHourOnNoonUtc.
  const offsetHours = 12 - etHourOnNoonUtc
  // Midnight ET in UTC = midnight UTC of same date + offset_hours
  return new Date(Date.UTC(y, m - 1, d, offsetHours, 0, 0))
}

function addDaysToEtDate(etDate: string, days: number): string {
  const [y, m, d] = etDate.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

// Parse a YYYY-MM-DD string. Returns null if malformed.
export function parseEtDateString(raw: string | string[] | undefined): string | null {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (!v) return null
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null
  // Light sanity: parseable as Date.
  const [y, m, d] = v.split('-').map((n) => parseInt(n, 10))
  if (m < 1 || m > 12 || d < 1 || d > 31) return null
  const test = new Date(Date.UTC(y, m - 1, d))
  if (Number.isNaN(test.getTime())) return null
  return v
}

// Today's ET date as YYYY-MM-DD.
export function todayEtDate(): string {
  return formatEtDate(new Date())
}

// Inclusive day count between two ET date strings, e.g. for sizing
// the Clarity isolation window.
export function daysInRange(range: DateRange): number {
  const [y1, m1, d1] = range.startEtDate.split('-').map((n) => parseInt(n, 10))
  const [y2, m2, d2] = range.endEtDate.split('-').map((n) => parseInt(n, 10))
  const a = Date.UTC(y1, m1 - 1, d1)
  const b = Date.UTC(y2, m2 - 1, d2)
  return Math.round((b - a) / 86_400_000) + 1
}
