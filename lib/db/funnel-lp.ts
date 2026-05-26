import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { Window } from './sales-dashboard-shared'
import {
  totalForRange,
  type RollingPoint,
  type IsolationDebug,
} from './clarity-window'
import { getDateRangeFromWindow, type DateRange } from './funnel-window'

// Funnel · Landing Page stage — consolidated detail page data layer.
//
// Sources (all LIVE from the mirror, no mocks):
//   - clarity_metrics_daily  — LP visits + avg time on LP (rolling-3
//                              isolation; see clarity-window.ts).
//   - wistia_media_daily     — VSL + Confirmation video play rate and
//                              average view duration.
//
// Typeform metrics (submits / qualified / completion-time) and
// Calendly closer bookings live in sibling files:
//   - lib/db/funnel-typeform.ts
//   - lib/db/funnel-calendly.ts
//
// The LP detail page imports from all three to assemble its sections.

// Canonical LP path. Updated 2026-05-25 — Zain's new Clarity project
// tracks /lp-vsl (main LP + VSL); old /lp is no longer active.
const CANONICAL_LP_PATH = '/lp-vsl'

// Canonical thank-you / call-confirmed page. Engine sheet row 37 ("Avg
// Time on Thank-You Page") reads `EngagementTime.active_time` for this
// path. Mirrors THANK_YOU_PAGE_PATH in ingestion/clarity/__init__.py.
const CANONICAL_TYP_PATH = '/lp-confirmation'

// Default Wistia hashed_ids.
//
// VSL on the LP: "VSL Vídeo Motion - Nabeel (Horizontal) Direct
//   Closer Funnel" (i1173gx76b). Drake's "currently using" pointer.
//   Alternate variants exist (Horizontal v2, Vertical, etc.) — the
//   LP page exposes a selector stub but only this one is wired.
//
// TYP (confirmation page) video: "3 - Nabeel - Confirm Video"
//   (fbgjxwe62y).
const DEFAULT_VSL_HASHED_ID = 'i1173gx76b'
const TYP_HASHED_ID = 'fbgjxwe62y'

// Selector options surfaced on the LP page. Only DEFAULT is wired
// for primary display; the others are placeholders for the future
// per-VSL dropdown.
export const VSL_OPTIONS: { hashedId: string; label: string }[] = [
  { hashedId: 'i1173gx76b', label: 'Vídeo Motion · Nabeel (Horizontal) · Direct Closer Funnel' },
  { hashedId: 'nbump1crwb', label: 'Vídeo Motion · Nabeel (Horizontal) v2' },
  { hashedId: '2gc753jbtp', label: 'Vídeo Motion · Nabeel (Horizontal)' },
  { hashedId: 'hl3p239yx2', label: 'Vídeo Motion · Nabeel (Vertical)' },
]

// Pull 60 days of Clarity so the rolling-3 recurrence has runway.
const CLARITY_HISTORY_DAYS = 60

function historyStartDate(): string {
  return new Date(Date.now() - CLARITY_HISTORY_DAYS * 24 * 60 * 60 * 1000)
    .toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Clarity
// ---------------------------------------------------------------------------

type ClarityRow = {
  snapshot_date: string
  url_path: string
  metric_name: string
  total_session_count: number | null
  active_time: number | null
}

// Pull both the canonical rolling-3 rows AND the per-day variants
// (`_1d` / `_2d` suffixes) the perday script captures. The data
// layer derives per-day values from the suffixed rows and falls back
// to rolling-3 isolation for older dates.
const CLARITY_METRIC_NAMES_TO_PULL = [
  'Traffic',
  'EngagementTime',
  'Traffic_1d',
  'EngagementTime_1d',
  'Traffic_2d',
  'EngagementTime_2d',
] as const

async function loadClarityRows(): Promise<ClarityRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('clarity_metrics_daily' as never)
    .select('snapshot_date, url_path, metric_name, total_session_count, active_time')
    .gte('snapshot_date', historyStartDate())
    .in('metric_name', CLARITY_METRIC_NAMES_TO_PULL as unknown as string[])
  if (error) throw new Error(`clarity_metrics_daily read failed: ${error.message}`)
  return (data ?? []) as unknown as ClarityRow[]
}

// Sum a (metric_name, url_path, field) across rows for one snapshot_date.
function snapshotSum(
  rows: ClarityRow[],
  snapshotDate: string,
  metricName: string,
  urlPath: string,
  field: 'total_session_count' | 'active_time',
): number {
  let total = 0
  for (const r of rows) {
    if (r.snapshot_date !== snapshotDate) continue
    if (r.metric_name !== metricName) continue
    if (r.url_path !== urlPath) continue
    const v = r[field]
    if (typeof v === 'number' && Number.isFinite(v)) total += v
  }
  return total
}

// Build a per-day {date → value} map from the _1d / _2d / canonical
// rolling-3 suffixed rows.
//
// Today's value     = snapshot's `<metric>_1d` total.
// Yesterday's value = snapshot's `<metric>_2d` total − today's.
// 2-days-ago value  = snapshot's `<metric>` (rolling-3) − snapshot's `<metric>_2d`.
//
// Returns the three most recent ET-anchored dates that have data, or
// fewer if the suffixed rows aren't there yet (the deployed cron hasn't
// been updated to write them yet — until then only the canonical row
// exists and we leave the per-day map empty so callers can fall back).
function buildPerDayMap(
  rows: ClarityRow[],
  metricBase: 'Traffic' | 'EngagementTime',
  urlPath: string,
  field: 'total_session_count' | 'active_time',
): Map<string, number> {
  const out = new Map<string, number>()
  // Find the most recent snapshot_date that has the _1d variant for
  // this path — that's the snapshot whose per-day decomposition we'll
  // emit. Older snapshots are ignored (we'd need their own _1d/_2d to
  // reconstruct per-day; the algo is snapshot-relative, not cumulative).
  let latestSnapshot: string | null = null
  for (const r of rows) {
    if (r.metric_name !== `${metricBase}_1d`) continue
    if (r.url_path !== urlPath) continue
    if (latestSnapshot === null || r.snapshot_date > latestSnapshot) {
      latestSnapshot = r.snapshot_date
    }
  }
  if (latestSnapshot === null) return out

  const v1 = snapshotSum(rows, latestSnapshot, `${metricBase}_1d`, urlPath, field)
  const v2 = snapshotSum(rows, latestSnapshot, `${metricBase}_2d`, urlPath, field)
  const v3 = snapshotSum(rows, latestSnapshot, metricBase, urlPath, field)

  // Snapshot date == the "today" anchor of when the cron ran. Walk back
  // for yesterday + 2-days-ago. Floor at 0 — Clarity can revise recent
  // numbers slightly and the deltas can occasionally go negative.
  const today = latestSnapshot
  const yesterday = addDaysToEtDateStr(today, -1)
  const twoDaysAgo = addDaysToEtDateStr(today, -2)
  out.set(today, Math.max(0, v1))
  out.set(yesterday, Math.max(0, v2 - v1))
  out.set(twoDaysAgo, Math.max(0, v3 - v2))
  return out
}

// Sum the per-day map over [startEtDate, endEtDate] (inclusive).
function sumPerDay(map: Map<string, number>, startEtDate: string, endEtDate: string): number {
  let total = 0
  map.forEach((value, date) => {
    if (date >= startEtDate && date <= endEtDate) total += value
  })
  return total
}

function buildRollingSeries(
  rows: ClarityRow[],
  metricName: string,
  urlPath: string,
  field: 'total_session_count' | 'active_time',
): RollingPoint[] {
  const byDate = new Map<string, number>()
  for (const r of rows) {
    if (r.metric_name !== metricName) continue
    if (r.url_path !== urlPath) continue
    const v = r[field]
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    byDate.set(r.snapshot_date, (byDate.get(r.snapshot_date) ?? 0) + v)
  }
  return Array.from(byDate.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

// ---------------------------------------------------------------------------
// Wistia
// ---------------------------------------------------------------------------

type WistiaRow = {
  hashed_id: string
  day: string
  play_rate: number | null
  played_time_seconds: number | null
  plays_filtered: number | null
  // `updated_at`, NOT `synced_at`. The upsert in the pipeline doesn't
  // include synced_at in its update set, so synced_at on existing
  // rows is frozen at INSERT time (typically backfill). `updated_at`
  // is trigger-managed and bumps on every UPDATE — that's the column
  // that actually shows when the cron last touched this row.
  updated_at?: string | null
}

// Wistia's `day` column is in ACCOUNT-LOCAL TZ (ET for this account).
// Filter against the ET-anchored date strings so the window aligns
// with what Wistia's own UI shows.
async function loadWistiaRows(hashedIds: string[], range: DateRange): Promise<WistiaRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('wistia_media_daily' as never)
    .select('hashed_id, day, play_rate, played_time_seconds, plays_filtered, updated_at')
    .in('hashed_id', hashedIds)
    .gte('day', range.startEtDate)
    .lte('day', range.endEtDate)
  if (error) throw new Error(`wistia_media_daily read failed: ${error.message}`)
  return (data ?? []) as unknown as WistiaRow[]
}

function sumW(rows: WistiaRow[], field: 'played_time_seconds' | 'plays_filtered'): number {
  let total = 0
  for (const r of rows) {
    const v = r[field]
    if (typeof v === 'number' && Number.isFinite(v)) total += v
  }
  return total
}

// Volume-weighted play_rate across rows. Each row's play_rate is a
// 0-1 fraction (plays / unique_loads). Weighting by plays_filtered
// gives a play-volume-weighted average; per the schema doc this is
// the recommended cross-row aggregation.
function weightedPlayRate(rows: WistiaRow[]): number | null {
  let totalWeighted = 0
  let totalWeight = 0
  for (const r of rows) {
    const w = r.plays_filtered
    const p = r.play_rate
    if (typeof p !== 'number' || !Number.isFinite(p)) continue
    if (typeof w === 'number' && Number.isFinite(w) && w > 0) {
      totalWeighted += p * w
      totalWeight += w
    } else {
      // Day with engagement metadata but no plays_filtered — count
      // with weight 1 so it still contributes.
      totalWeighted += p
      totalWeight += 1
    }
  }
  return totalWeight > 0 ? totalWeighted / totalWeight : null
}

export type VideoMetrics = {
  label: string
  hashedId: string
  playRate: number | null            // 0-1 fraction
  avgViewDurationSec: number | null  // seconds per play
  totalPlays: number                 // sum of plays_filtered
  trendPlays: number[]               // last 14 days
  // ISO timestamp of the most recent cron pull that touched a row in
  // the active window. Renders as a "data as of" footer so the cron
  // lag is visible (Wistia UI is live; our mirror is every 3h).
  lastSyncedAt: string | null
}

async function getVideoMetrics(
  hashedId: string,
  label: string,
  range: DateRange,
): Promise<VideoMetrics> {
  const windowRows = await loadWistiaRows([hashedId], range)
  const playsTotal = sumW(windowRows, 'plays_filtered')
  const playedTotal = sumW(windowRows, 'played_time_seconds')
  const avgViewDur = playsTotal > 0 ? playedTotal / playsTotal : null
  const playRate = weightedPlayRate(windowRows)
  // Latest updated_at across the rows in the window. Renders as a
  // "data as of" stamp. Wistia API returns settled per-day numbers
  // that the cron re-pulls every 3h, so updated_at is the honest
  // signal of "when did we last refresh from Wistia."
  let lastSyncedAt: string | null = null
  for (const r of windowRows) {
    if (!r.updated_at) continue
    if (lastSyncedAt === null || r.updated_at > lastSyncedAt) lastSyncedAt = r.updated_at
  }

  // 14-day trend uses Wistia's ET `day` column; anchor 14 days back
  // from today's ET date.
  const sb = createAdminClient()
  const todayEt = formatEtDate(new Date())
  const trendStart = addDaysToEtDateStr(todayEt, -13)
  const { data, error } = await sb
    .from('wistia_media_daily' as never)
    .select('day, plays_filtered')
    .eq('hashed_id', hashedId)
    .gte('day', trendStart)
  if (error) throw new Error(`wistia trend read failed: ${error.message}`)
  const trendRows = (data ?? []) as unknown as { day: string; plays_filtered: number | null }[]
  const trend: number[] = []
  for (let i = 13; i >= 0; i--) {
    const key = addDaysToEtDateStr(todayEt, -i)
    const row = trendRows.find((r) => r.day === key)
    trend.push(row?.plays_filtered ?? 0)
  }

  return {
    label,
    hashedId,
    playRate,
    avgViewDurationSec: avgViewDur,
    totalPlays: playsTotal,
    trendPlays: trend,
    lastSyncedAt,
  }
}

function formatEtDate(d: Date): string {
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

// ---------------------------------------------------------------------------
// Public surface
// ---------------------------------------------------------------------------

// Resolve a Window-or-DateRange caller arg into a concrete DateRange.
// Strip page still passes Window; LP page passes DateRange (from
// the date picker). Internal fetchers always work in DateRange.
function resolveRange(arg: Window | DateRange): DateRange {
  if (typeof arg === 'string') return getDateRangeFromWindow(arg)
  return arg
}

// LP visit count for the funnel strip. Single number, ET-anchored.
export async function getLpVisitsLive(arg: Window | DateRange): Promise<number> {
  const range = resolveRange(arg)
  const rows = await loadClarityRows()
  const series = buildRollingSeries(rows, 'Traffic', CANONICAL_LP_PATH, 'total_session_count')
  const { total } = totalForRange(series, range.startEtDate, range.endEtDate)
  return Math.round(total)
}

export async function getLpVisitsLiveWithDebug(arg: Window | DateRange): Promise<{
  total: number
  debug: IsolationDebug
  rolling: RollingPoint[]
}> {
  const range = resolveRange(arg)
  const rows = await loadClarityRows()
  const series = buildRollingSeries(rows, 'Traffic', CANONICAL_LP_PATH, 'total_session_count')
  const { total, debug } = totalForRange(series, range.startEtDate, range.endEtDate)
  return { total: Math.round(total), debug, rolling: series }
}

export async function getLpVisitsTrend(): Promise<number[]> {
  const rows = await loadClarityRows()
  const series = buildRollingSeries(rows, 'Traffic', CANONICAL_LP_PATH, 'total_session_count')
  if (series.length === 0) return []
  const todayEt = formatEtDate(new Date())
  const start = addDaysToEtDateStr(todayEt, -29) // 30-day-ish history for the trend
  const { daily } = totalForRange(series, start, todayEt)
  return daily.slice(-14).map((p) => Math.round(p.value))
}

export type LpClarityMetrics = {
  visits: number
  avgTimeOnLpSec: number | null
  avgTimeOnTypSec: number | null
  trendVisits: number[]
  canonicalPath: string
  canonicalTypPath: string
}

export async function getLpClarityMetrics(arg: Window | DateRange): Promise<LpClarityMetrics> {
  const range = resolveRange(arg)
  const rows = await loadClarityRows()

  // Per-day maps decomposed from `_1d` / `_2d` / canonical suffixed
  // rows. Covers the last 3 days from the most recent snapshot. For
  // ranges that fall entirely within those 3 days, this gives clean
  // per-day values; for older ranges we still fall back to the
  // rolling-3 isolation below.
  const lpVisitsPerDay = buildPerDayMap(rows, 'Traffic', CANONICAL_LP_PATH, 'total_session_count')
  const lpActivePerDay = buildPerDayMap(rows, 'EngagementTime', CANONICAL_LP_PATH, 'active_time')
  const typVisitsPerDay = buildPerDayMap(rows, 'Traffic', CANONICAL_TYP_PATH, 'total_session_count')
  const typActivePerDay = buildPerDayMap(rows, 'EngagementTime', CANONICAL_TYP_PATH, 'active_time')

  const hasPerDayLp = lpVisitsPerDay.size > 0
  const hasPerDayTyp = typVisitsPerDay.size > 0

  // LP visits + avg time. Prefer the per-day map when the snapshot's
  // _1d/_2d rows are present (post per-day-cron-rollout); fall back
  // to the rolling-3 isolation for older snapshots / pre-rollout data.
  let visits: number, activeTotal: number, trafficDaily: { date: string; value: number }[]
  if (hasPerDayLp) {
    visits = sumPerDay(lpVisitsPerDay, range.startEtDate, range.endEtDate)
    activeTotal = sumPerDay(lpActivePerDay, range.startEtDate, range.endEtDate)
    const pairs: { date: string; value: number }[] = []
    lpVisitsPerDay.forEach((value, date) => pairs.push({ date, value }))
    trafficDaily = pairs.sort((a, b) => a.date.localeCompare(b.date))
  } else {
    const trafficSeries = buildRollingSeries(rows, 'Traffic', CANONICAL_LP_PATH, 'total_session_count')
    const engagementSeries = buildRollingSeries(rows, 'EngagementTime', CANONICAL_LP_PATH, 'active_time')
    const t = totalForRange(trafficSeries, range.startEtDate, range.endEtDate)
    const e = totalForRange(engagementSeries, range.startEtDate, range.endEtDate)
    visits = t.total
    activeTotal = e.total
    trafficDaily = t.daily
  }
  const avgTime = visits > 0 ? activeTotal / visits : null

  // TYP avg time — same pattern, different path.
  let typVisits: number, typActiveTotal: number
  if (hasPerDayTyp) {
    typVisits = sumPerDay(typVisitsPerDay, range.startEtDate, range.endEtDate)
    typActiveTotal = sumPerDay(typActivePerDay, range.startEtDate, range.endEtDate)
  } else {
    const typTrafficSeries = buildRollingSeries(rows, 'Traffic', CANONICAL_TYP_PATH, 'total_session_count')
    const typEngagementSeries = buildRollingSeries(rows, 'EngagementTime', CANONICAL_TYP_PATH, 'active_time')
    typVisits = totalForRange(typTrafficSeries, range.startEtDate, range.endEtDate).total
    typActiveTotal = totalForRange(typEngagementSeries, range.startEtDate, range.endEtDate).total
  }
  const avgTimeOnTyp = typVisits > 0 ? typActiveTotal / typVisits : null

  const trend = trafficDaily.slice(-14).map((p) => Math.round(p.value))
  return {
    visits: Math.round(visits),
    avgTimeOnLpSec: avgTime,
    avgTimeOnTypSec: avgTimeOnTyp,
    trendVisits: trend,
    canonicalPath: CANONICAL_LP_PATH,
    canonicalTypPath: CANONICAL_TYP_PATH,
  }
}

// Per-LP table — group Clarity Traffic snapshots by url_path.
export type LpRow = {
  id: string
  urlPath: string
  visits: number
  avgTime: number | null
  conv: number | null
}

export async function getLpRowsLive(arg: Window | DateRange, submitsCount: number): Promise<LpRow[]> {
  const range = resolveRange(arg)
  const rows = await loadClarityRows()
  const pathSet = new Set<string>()
  for (const r of rows) {
    if (r.metric_name !== 'Traffic') continue
    if (r.url_path === '__total__') continue
    pathSet.add(r.url_path)
  }
  const paths = Array.from(pathSet)

  const out: LpRow[] = []
  for (const path of paths) {
    const trafficSeries = buildRollingSeries(rows, 'Traffic', path, 'total_session_count')
    const engagementSeries = buildRollingSeries(rows, 'EngagementTime', path, 'active_time')
    const { total: visits } = totalForRange(trafficSeries, range.startEtDate, range.endEtDate)
    const { total: activeTotal } = totalForRange(engagementSeries, range.startEtDate, range.endEtDate)
    const avgTime = visits > 0 ? activeTotal / visits : null
    out.push({
      id: path,
      urlPath: path,
      visits: Math.round(visits),
      avgTime,
      conv: path === CANONICAL_LP_PATH && visits > 0 ? (submitsCount / visits) * 100 : null,
    })
  }
  out.sort((a, b) => b.visits - a.visits)
  return out.slice(0, 10)
}

// VSL metrics for the LP detail page. Single-video version; the
// dropdown stub on the page calls this with whichever option the
// user selects.
export async function getVslMetrics(arg: Window | DateRange, hashedId?: string): Promise<VideoMetrics> {
  const id = hashedId ?? DEFAULT_VSL_HASHED_ID
  const label = VSL_OPTIONS.find((o) => o.hashedId === id)?.label ?? 'VSL'
  return getVideoMetrics(id, label, resolveRange(arg))
}

// Confirmation video (TYP-side).
export async function getTypVideoMetrics(arg: Window | DateRange): Promise<VideoMetrics> {
  return getVideoMetrics(TYP_HASHED_ID, '3 · Nabeel · Confirm Video', resolveRange(arg))
}
