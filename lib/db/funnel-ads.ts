import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { AggMetric } from './funnel-mocks'
import { todayEtDate } from './funnel-window'

// Funnel · Ads stage — REAL data from `meta_ad_daily`.
//
// Range semantics (driven by the page's date-range picker):
//   - Lower bound: max(user-picked start, ADS_FLOOR_ET).
//   - Upper bound: min(user-picked end, yesterday ET). Meta's daily
//     row for "today" lands the morning AFTER, so the most recent
//     complete day is always yesterday.

// Hard floor — first day Zain's fixed source-sheet started landing
// usable data. Anything earlier is pre-process and excluded.
export const ADS_FLOOR_ET = '2026-05-24'

export type MetaAdDailyRow = {
  day: string
  amount_spent: number | null
  impressions: number | null
  unique_link_clicks: number | null
  link_clicks: number | null
  clicks_all: number | null
  frequency: number | null
  ctr: number | null
  cpm: number | null
  cost_per_unique_link_click: number | null
}

export type AdsRange = {
  startEtDate: string  // YYYY-MM-DD, inclusive (>= ADS_FLOOR_ET)
  endEtDate: string    // YYYY-MM-DD, inclusive (<= yesterday)
  // True when start > end (e.g. selected window = today, but today's
  // data lands tomorrow → no days in range yet). UI surfaces this so
  // the empty state reads "data lands tomorrow" instead of just "0".
  isEmptyRange: boolean
}

function yesterdayEtDate(): string {
  const today = todayEtDate()
  const [y, m, d] = today.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - 1)
  return dt.toISOString().slice(0, 10)
}

// Clamp a user-picked start/end pair into the effective range:
//   - lower bound: ADS_FLOOR_ET
//   - upper bound: yesterday ET (today's data lands tomorrow)
export function clampAdsRange(startEtDate: string, endEtDate: string): AdsRange {
  const start = startEtDate < ADS_FLOOR_ET ? ADS_FLOOR_ET : startEtDate
  const yesterday = yesterdayEtDate()
  const end = endEtDate > yesterday ? yesterday : endEtDate
  return {
    startEtDate: start,
    endEtDate: end,
    isEmptyRange: start > end,
  }
}

async function loadMetaRows(range: AdsRange): Promise<MetaAdDailyRow[]> {
  if (range.isEmptyRange) return []
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('meta_ad_daily' as never)
    .select('day, amount_spent, impressions, unique_link_clicks, link_clicks, clicks_all, frequency, ctr, cpm, cost_per_unique_link_click')
    .gte('day', range.startEtDate)
    .lte('day', range.endEtDate)
    .order('day', { ascending: true })
  if (error) throw new Error(`meta_ad_daily read failed: ${error.message}`)
  return (data ?? []) as unknown as MetaAdDailyRow[]
}

function sum(rows: MetaAdDailyRow[], field: keyof MetaAdDailyRow): number {
  let total = 0
  for (const r of rows) {
    const v = r[field]
    if (typeof v === 'number' && Number.isFinite(v)) total += v
    else if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n)) total += n
    }
  }
  return total
}

function avg(rows: MetaAdDailyRow[], field: keyof MetaAdDailyRow): number | null {
  let total = 0
  let count = 0
  for (const r of rows) {
    const v = r[field]
    if (typeof v === 'number' && Number.isFinite(v)) { total += v; count++ }
    else if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n)) { total += n; count++ }
    }
  }
  return count > 0 ? total / count : null
}

// Real impressions total — used by the funnel strip's Ads headline.
export async function getAdsImpressionsLive(range: AdsRange): Promise<number> {
  const rows = await loadMetaRows(range)
  return sum(rows, 'impressions')
}

// Daily impressions series — sparkline trend on the Ads detail page.
// Returns up to 14 most-recent points; pads with zeros only if the
// upstream is missing days entirely (mirror gaps).
export async function getAdsImpressionsTrend(range: AdsRange): Promise<number[]> {
  const rows = await loadMetaRows(range)
  const tail = rows.slice(-14)
  return tail.map((r) => Number(r.impressions ?? 0))
}

// Aggregate metric block matching the AggMetric shape consumed by the
// stage-detail MetricsGrid. Six headline metrics per Drake's spec.
// Each metric also carries a per-day `trend` array (in calendar order)
// for the in-cell sparkline.
export type AdsAggMetric = AggMetric & { trend: number[] }

export async function getAdsAggregateLive(range: AdsRange): Promise<AdsAggMetric[]> {
  const rows = await loadMetaRows(range)
  const totalSpend = sum(rows, 'amount_spent')
  const totalImpressions = sum(rows, 'impressions')
  const totalUniqueClicks = sum(rows, 'unique_link_clicks')
  const cpm = totalImpressions > 0 ? (totalSpend / totalImpressions) * 1000 : null
  const cpcUnique = totalUniqueClicks > 0 ? totalSpend / totalUniqueClicks : null
  const frequency = avg(rows, 'frequency')

  // Per-day series for the in-cell sparkline. Rows are already in
  // ascending day order from loadMetaRows.
  const impressionsTrend = rows.map((r) => numericOrZero(r.impressions))
  const spendTrend = rows.map((r) => numericOrZero(r.amount_spent))
  const frequencyTrend = rows.map((r) => numericOrZero(r.frequency))
  const uniqueClicksTrend = rows.map((r) => numericOrZero(r.unique_link_clicks))
  const cpmTrend = rows.map((r) => numericOrZero(r.cpm))
  const cpcUniqueTrend = rows.map((r) => numericOrZero(r.cost_per_unique_link_click))

  return [
    { id: 'impressions', label: 'Total impressions', value: totalImpressions, format: 'integer', trend: impressionsTrend },
    { id: 'adspend', label: 'Total adspend', value: totalSpend, format: 'usd', trend: spendTrend },
    { id: 'frequency', label: 'Frequency', value: frequency, format: 'decimal', trend: frequencyTrend },
    { id: 'unique-clicks', label: 'Unique link clicks', value: totalUniqueClicks, format: 'integer', trend: uniqueClicksTrend },
    { id: 'cpi', label: 'CPM', value: cpm, format: 'usd_precise', trend: cpmTrend },
    { id: 'cpc-unique', label: 'Cost per unique click', value: cpcUnique, format: 'usd', trend: cpcUniqueTrend },
  ]
}

function numericOrZero(v: number | string | null | undefined): number {
  if (v == null) return 0
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

// Per-day breakdown — feeds the daily table on the Ads detail page.
// One row per day in the clamped range, sorted most-recent first.
export type AdsDailyRow = {
  day: string                          // YYYY-MM-DD ET
  spend: number | null
  impressions: number | null
  uniqueClicks: number | null
  ctr: number | null                   // 0..100
  cpm: number | null
  cpcUnique: number | null
  frequency: number | null
}

export async function getAdsDaily(range: AdsRange): Promise<AdsDailyRow[]> {
  const rows = await loadMetaRows(range)
  const out: AdsDailyRow[] = rows.map((r) => {
    const impressions = numericOrNull(r.impressions)
    const linkClicks = numericOrNull(r.link_clicks) ?? numericOrNull(r.unique_link_clicks)
    const ctr = impressions && impressions > 0 && linkClicks != null
      ? (linkClicks / impressions) * 100
      : numericOrNull(r.ctr)
    return {
      day: r.day,
      spend: numericOrNull(r.amount_spent),
      impressions,
      uniqueClicks: numericOrNull(r.unique_link_clicks),
      ctr,
      cpm: numericOrNull(r.cpm),
      cpcUnique: numericOrNull(r.cost_per_unique_link_click),
      frequency: numericOrNull(r.frequency),
    }
  })
  out.sort((a, b) => (a.day < b.day ? 1 : -1))
  return out
}

function numericOrNull(v: number | string | null | undefined): number | null {
  if (v == null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
