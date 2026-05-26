// Clarity rolling-3-day windowing math.
//
// Each row in clarity_metrics_daily is a TRAILING-3-DAY total for the
// recorded snapshot_date. Schema doc:
//
//   "Each `snapshot_date` represents a 3-day rolling sum at that
//    observation time, NOT a single day."
//
// That is, for the true single-day value D_n on date n:
//
//   snapshot[n] = D_n + D_{n-1} + D_{n-2}
//
// To render Today / Week / Month figures honestly we need to isolate
// single-day values, then sum across the requested window.
//
// Single-day isolation — rearrange the relation:
//
//   D_n = snapshot[n] - D_{n-1} - D_{n-2}
//
// Recursive over the full snapshot series, starting from the earliest
// date in the dataset. Bootstrap: the very first snapshot has no
// preceding days to subtract, so we assume an even split:
//
//   D_0 = D_{-1} = D_{-2} = snapshot[0] / 3
//
// Even-split is a low-information prior that biases nothing; the
// recursion is EXACT for every day from snapshot[1] onwards (modulo
// the propagation of the bootstrap error, which decays as more
// snapshots arrive since the bootstrap contribution only sits in the
// first 2 isolated days).
//
// Missing snapshot dates (cron gaps): forward-fill — if snapshot[n] is
// absent, treat it as snapshot[n-1] (no new info that day), so the
// missing day's D rolls forward as zero new single-day signal. This is
// the right call for 1-day blips; if the gap exceeds Clarity's
// 3-day-history window it becomes a permanent data hole (per schema
// doc § "no backfill possible") — the page will just show fewer days.
//
// Average-of-ratio metrics (e.g. avg time on page = active_time /
// sessions): apply isolation to NUMERATOR and DENOMINATOR separately,
// then ratio at the end:
//
//   avgTime_window = sum(D_active_time over window) / sum(D_sessions over window)
//
// Don't ratio per-snapshot first — that gives equally-weighted day
// averages instead of session-weighted, and is wrong when traffic is
// non-uniform.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RollingPoint = {
  date: string          // YYYY-MM-DD
  value: number         // the rolling-3-day total Clarity returned
}

export type DailyPoint = {
  date: string
  value: number         // the isolated single-day value (D_n)
}

export type IsolationDebug = {
  bootstrapDate: string | null
  bootstrapValue: number         // snapshot[0] before division by 3
  bootstrapPerDay: number        // snapshot[0] / 3
  forwardFilledDates: string[]   // dates where we backfilled the snapshot
  daysIsolated: number
}

// ---------------------------------------------------------------------------
// Date helpers — work in UTC (snapshot_date is UTC per schema doc)
// ---------------------------------------------------------------------------

function parseDate(iso: string): Date {
  // Pin to UTC midnight to avoid TZ-induced day drift.
  return new Date(`${iso}T00:00:00Z`)
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function addDays(iso: string, days: number): string {
  const d = parseDate(iso)
  d.setUTCDate(d.getUTCDate() + days)
  return formatDate(d)
}

function todayUtc(): string {
  return formatDate(new Date())
}

function daysBetween(startIso: string, endIso: string): number {
  const start = parseDate(startIso).getTime()
  const end = parseDate(endIso).getTime()
  return Math.round((end - start) / 86_400_000)
}

// ---------------------------------------------------------------------------
// Single-day isolation
// ---------------------------------------------------------------------------

// Given an array of rolling-3-day points sorted ascending by date,
// produce a same-length array of isolated single-day values.
//
// Output is a daily series from the earliest snapshot date to the
// latest snapshot date (or `endDate` if provided). Missing dates in
// the input are forward-filled (snapshot[n] := snapshot[n-1]).
//
// IMPORTANT: the bootstrap pseudo-fills D_{-1} and D_{-2}, which means
// the FIRST two isolated values (the earliest two days) inherit some
// bootstrap error. Past day 2 of the series the recursion is exact.
export function isolateDailyValues(
  rollingPoints: RollingPoint[],
  options: { endDate?: string } = {},
): { daily: DailyPoint[]; debug: IsolationDebug } {
  const debug: IsolationDebug = {
    bootstrapDate: null,
    bootstrapValue: 0,
    bootstrapPerDay: 0,
    forwardFilledDates: [],
    daysIsolated: 0,
  }

  if (rollingPoints.length === 0) {
    return { daily: [], debug }
  }

  // Sort + dedupe by date (keep first encountered if duplicates).
  const seen = new Set<string>()
  const sorted = rollingPoints
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .filter((p) => {
      if (seen.has(p.date)) return false
      seen.add(p.date)
      return true
    })

  const firstDate = sorted[0].date
  const lastDate = options.endDate ?? sorted[sorted.length - 1].date
  // Don't isolate past today (UTC) — there's no meaningful Clarity
  // snapshot for a future day.
  const today = todayUtc()
  const effectiveLastDate = lastDate > today ? today : lastDate

  if (effectiveLastDate < firstDate) {
    return { daily: [], debug }
  }

  // Build a dense snapshot map keyed by date for O(1) lookup.
  const snapshotByDate = new Map<string, number>()
  for (const p of sorted) snapshotByDate.set(p.date, p.value)

  // Forward-fill missing dates between firstDate and effectiveLastDate.
  // For each missing date we copy the most recent prior snapshot, which
  // implies the cron missed but the underlying data didn't move.
  let lastSeenSnapshot = sorted[0].value
  const dense: RollingPoint[] = []
  for (let cursor = firstDate; cursor <= effectiveLastDate; cursor = addDays(cursor, 1)) {
    const recorded = snapshotByDate.get(cursor)
    if (recorded === undefined) {
      debug.forwardFilledDates.push(cursor)
      dense.push({ date: cursor, value: lastSeenSnapshot })
    } else {
      lastSeenSnapshot = recorded
      dense.push({ date: cursor, value: recorded })
    }
  }

  // Bootstrap.
  const bootstrap = dense[0]
  debug.bootstrapDate = bootstrap.date
  debug.bootstrapValue = bootstrap.value
  debug.bootstrapPerDay = bootstrap.value / 3

  // Isolate. dPrev1 = D_{n-1}, dPrev2 = D_{n-2}.
  // Initial state: pretend the two days before the first snapshot
  // had value bootstrapPerDay each.
  let dPrev2 = debug.bootstrapPerDay
  let dPrev1 = debug.bootstrapPerDay
  const daily: DailyPoint[] = []
  for (let i = 0; i < dense.length; i++) {
    const point = dense[i]
    const dN = point.value - dPrev1 - dPrev2
    // Floor at 0 — negative isolated values are a sign the rolling
    // figure dropped below previous days' total (can happen when
    // Clarity refines a recent-day aggregate downward). Clamp rather
    // than propagate a negative.
    const clamped = dN < 0 ? 0 : dN
    daily.push({ date: point.date, value: clamped })
    dPrev2 = dPrev1
    dPrev1 = clamped
  }

  debug.daysIsolated = daily.length
  return { daily, debug }
}

// ---------------------------------------------------------------------------
// Window summation
// ---------------------------------------------------------------------------

export type WindowDays = 1 | 7 | 30

// Sum the isolated single-day values over the trailing `windowDays`
// from the latest day available in the series.
//
// If the series doesn't have `windowDays` worth of history, the sum
// covers however many days are available — the page is responsible for
// noting "partial window" if it cares to.
export function sumOverWindow(daily: DailyPoint[], windowDays: WindowDays): number {
  if (daily.length === 0) return 0
  const lastIdx = daily.length - 1
  const startIdx = Math.max(0, lastIdx - (windowDays - 1))
  let total = 0
  for (let i = startIdx; i <= lastIdx; i++) total += daily[i].value
  return total
}

// Convenience: convert from the dashboard's Window enum.
export function windowDaysFromWindow(window: '1d' | '7d' | '30d'): WindowDays {
  if (window === '1d') return 1
  if (window === '7d') return 7
  return 30
}

// Sum isolated single-day values across an inclusive [startDate, endDate]
// range. Dates are YYYY-MM-DD strings. Days outside the isolated
// series (no data) contribute zero.
//
// Use this when the caller has an arbitrary date range (e.g. from a
// user-selected date picker) rather than a rolling N-day window.
export function sumOverRange(
  daily: DailyPoint[],
  startDate: string,
  endDate: string,
): number {
  let total = 0
  for (const p of daily) {
    if (p.date >= startDate && p.date <= endDate) total += p.value
  }
  return total
}

// ---------------------------------------------------------------------------
// All-in-one: from rolling rows → window total.
//
// Most callers want a single number for the selected window. Build the
// isolated daily series + sum it. Returns the total, the isolated
// series (so callers can render a sparkline), and the debug record
// (so the report can prove the math worked).
// ---------------------------------------------------------------------------

export function totalForWindow(
  rollingPoints: RollingPoint[],
  window: '1d' | '7d' | '30d',
  options: { endDate?: string } = {},
): { total: number; daily: DailyPoint[]; debug: IsolationDebug } {
  const { daily, debug } = isolateDailyValues(rollingPoints, options)
  const total = sumOverWindow(daily, windowDaysFromWindow(window))
  return { total, daily, debug }
}

// Date-range-explicit variant of totalForWindow. Sums the isolated
// daily values that fall inside [startDate, endDate] inclusive (ET
// calendar dates). Used by the LP page's calendar-anchored window
// math + the date-range picker.
export function totalForRange(
  rollingPoints: RollingPoint[],
  startDate: string,
  endDate: string,
): { total: number; daily: DailyPoint[]; debug: IsolationDebug } {
  // Cap isolation at endDate so the recurrence doesn't walk past the
  // user's selected upper bound.
  const { daily, debug } = isolateDailyValues(rollingPoints, { endDate })
  const total = sumOverRange(daily, startDate, endDate)
  return { total, daily, debug }
}
