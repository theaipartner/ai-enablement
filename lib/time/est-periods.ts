// Canonical EST/EDT calendar-period boundary helpers.
//
// The codebase-wide timezone standard (ADR 0003): timestamps are
// STORED in UTC; user-facing period boundaries + date-range
// aggregations are computed in America/New_York (DST-aware). This
// module is the single code home for those boundary computations —
// the cost hub, the Ella audit summary, and any future surface that
// needs "today / this week / this month in EST" imports from here
// rather than recomputing locally.
//
// Pure functions, no server dependency — safe to import from any
// server-side data layer. JavaScript's Intl handles DST transitions
// automatically; we never store or hardcode an offset.
//
// Period definitions (per ADR 0003):
//   - "today"  = EST start of the current calendar day → now.
//   - "week"   = most recent Monday 00:00 EST → now.
//   - "month"  = first of the current calendar month 00:00 EST → now.

// Returns the UTC offset of America/New_York at `at` in MINUTES
// (e.g., 240 during DST = UTC-4, 300 during standard time = UTC-5).
export function getEstOffsetMinutes(at: Date): number {
  // Get the time string for `at` in EST.
  const estFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = estFmt.formatToParts(at).reduce<Record<string, string>>(
    (acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value
      return acc
    },
    {},
  )
  const estDate = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    parseInt(parts.hour, 10) % 24, // Intl can return "24" for midnight in en-US
    parseInt(parts.minute, 10),
  )
  // Offset = UTC - EST.
  return Math.round((at.getTime() - estDate) / 60000)
}

// Returns a Date representing the start of `kind` (today / week /
// month) in America/New_York, as a UTC instant.
//
// Implementation: take current UTC date, compute its EST/EDT
// components via Intl.DateTimeFormat, then construct a Date for the
// desired period boundary in EST and convert back. JavaScript handles
// DST transitions automatically.
export function getEstPeriodBoundary(
  kind: 'today' | 'week' | 'month',
): Date {
  const now = new Date()
  // Get EST/EDT date parts (year / month / day / weekday).
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  })
  const parts = fmt.formatToParts(now).reduce<Record<string, string>>(
    (acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value
      return acc
    },
    {},
  )
  const year = parseInt(parts.year, 10)
  const month = parseInt(parts.month, 10) // 1-12
  const day = parseInt(parts.day, 10)
  const weekdayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  }
  const weekday = weekdayMap[parts.weekday] ?? 1

  let targetYear = year
  let targetMonth = month
  let targetDay = day

  if (kind === 'week') {
    // Roll back to most recent Monday. weekday=1 (Monday) → no change.
    const daysBack = weekday - 1
    const d = new Date(Date.UTC(year, month - 1, day))
    d.setUTCDate(d.getUTCDate() - daysBack)
    targetYear = d.getUTCFullYear()
    targetMonth = d.getUTCMonth() + 1
    targetDay = d.getUTCDate()
  } else if (kind === 'month') {
    targetDay = 1
  }
  // kind === 'today': use today's date as-is.

  // Construct the EST midnight as a string, then have Date parse it
  // in the EST/EDT zone. Easiest: use a known-good offset for the
  // target date, computed by formatting "noon" in EST.
  const noonEst = new Date(
    Date.UTC(targetYear, targetMonth - 1, targetDay, 12, 0, 0),
  )
  const offsetMinutes = getEstOffsetMinutes(noonEst)
  // EST is UTC minus N hours; midnight EST = N hours past UTC midnight
  // for the SAME calendar date. Construct: `Date.UTC(y, m-1, d, 0+offsetHours, 0+offsetMinutes)`.
  return new Date(
    Date.UTC(targetYear, targetMonth - 1, targetDay, 0, 0, 0)
      + offsetMinutes * 60 * 1000,
  )
}

// Returns the first day of the month `offsetMonths` BEFORE the current
// month (offsetMonths=0 = current month start; 1 = last month start),
// in EST, as a UTC instant. Used by cost-hub's history rollup to build
// month boundaries going back N months.
export function getEstMonthStart(offsetMonths: number): Date {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
  })
  const parts = fmt.formatToParts(now).reduce<Record<string, string>>(
    (acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value
      return acc
    },
    {},
  )
  const year = parseInt(parts.year, 10)
  const month = parseInt(parts.month, 10) // 1-12
  // Compute the offset target.
  const targetMonthZero = month - 1 - offsetMonths // 0-indexed
  const adjustedYear = year + Math.floor(targetMonthZero / 12)
  const adjustedMonth = ((targetMonthZero % 12) + 12) % 12 // 0-11

  const noonEst = new Date(Date.UTC(adjustedYear, adjustedMonth, 1, 12, 0, 0))
  const offsetMinutes = getEstOffsetMinutes(noonEst)
  return new Date(
    Date.UTC(adjustedYear, adjustedMonth, 1, 0, 0, 0)
      + offsetMinutes * 60 * 1000,
  )
}

// The America/New_York calendar date (year / month 1-12 / day) of a UTC
// instant. Used to walk day-by-day for the business-hours clock below.
function etCalendarDate(at: Date): { y: number; m: number; d: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = fmt.formatToParts(at).reduce<Record<string, string>>((acc, p) => {
    if (p.type !== 'literal') acc[p.type] = p.value
    return acc
  }, {})
  return { y: parseInt(parts.year, 10), m: parseInt(parts.month, 10), d: parseInt(parts.day, 10) }
}

// The [open, close) window on one ET calendar date as UTC instants. The
// ET→UTC offset is read at noon that day, which is correct for any hour in
// a 10:00–22:00 window — the DST switch happens at 02:00, well outside it,
// so a single day's offset applies to both bounds.
function etWindowForDate(
  y: number, m: number, d: number, openHour: number, closeHour: number,
): { open: number; close: number } {
  const noonEst = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  const offsetMs = getEstOffsetMinutes(noonEst) * 60 * 1000
  return {
    open: Date.UTC(y, m - 1, d, openHour, 0, 0) + offsetMs,
    close: Date.UTC(y, m - 1, d, closeHour, 0, 0) + offsetMs,
  }
}

// Seconds of elapsed time between `start` and `end` that fall inside the
// business-hours window (default 10:00–22:00 ET) on each calendar day,
// summed across days. DST-aware. The "speed-to-lead" clock: a lead that
// opts in at 01:00 ET and is first dialled at 12:00 ET counts 2h (the
// 10:00→12:00 slice), not 11h — overnight time isn't the team being slow.
// Time before `start` or after `end` is never counted; an interval wholly
// outside the window (e.g. 23:00→23:15) returns 0.
export function businessHoursElapsedSec(
  start: Date, end: Date, openHour = 10, closeHour = 22,
): number {
  const startMs = start.getTime()
  const endMs = end.getTime()
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return 0

  let total = 0
  let { y, m, d } = etCalendarDate(start)
  // Walk ET days from start's date forward. Bounded well above any real
  // opt-in→first-dial gap (the cohort caps outliers elsewhere anyway).
  for (let i = 0; i < 400; i++) {
    const { open, close } = etWindowForDate(y, m, d, openHour, closeHour)
    if (open >= endMs) break // this day's window starts after we're done
    const lo = Math.max(open, startMs)
    const hi = Math.min(close, endMs)
    if (hi > lo) total += (hi - lo) / 1000
    // Advance one calendar day (pure date arithmetic, tz-independent).
    const next = new Date(Date.UTC(y, m - 1, d + 1))
    y = next.getUTCFullYear(); m = next.getUTCMonth() + 1; d = next.getUTCDate()
  }
  return total
}
