import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { AggMetric } from './funnel-mocks'
import { todayEtDate } from './funnel-window'
import {
  HIGH_TICKET_AD_CAMPAIGN_TOKEN,
  isHighTicketCampaign,
} from './funnel-assets'

// Funnel · Ads stage — high-ticket-scoped ad metrics.
//
// SOURCE LOCK: spend/impressions/clicks are summed from ONLY the
// high-ticket funnel's campaigns (cortana_campaign_daily rows whose name
// carries the `Closer Funnel` token) rather than the account-wide
// `meta_ad_daily` total, so another funnel's ad spend (e.g. Digital
// College) can never inflate high-ticket numbers. Per-campaign data only
// reaches back to 2026-05-26; older days fall back to the `meta_ad_daily`
// account total (pre-cutover there was no separate ad funnel, so the
// account total IS high-ticket). See `loadMetaRows`.
//
// Range semantics (driven by the page's date-range picker):
//   - Lower bound: max(user-picked start, ADS_FLOOR_ET).
//   - Upper bound: min(user-picked end, today ET). Since the cutover
//     to the Cortana API (2026-05-29) today's row is populated
//     intraday (3-hour cron) and restates as Meta finalizes, so the
//     high end is no longer clamped back to yesterday.

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
  endEtDate: string    // YYYY-MM-DD, inclusive (<= today)
  // True when start > end (e.g. user picked a start after today). UI
  // surfaces this as an empty state rather than a misleading 0.
  isEmptyRange: boolean
}

// Clamp a user-picked start/end pair into the effective range:
//   - lower bound: ADS_FLOOR_ET
//   - upper bound: today ET (Cortana populates today intraday)
export function clampAdsRange(startEtDate: string, endEtDate: string): AdsRange {
  const start = startEtDate < ADS_FLOOR_ET ? ADS_FLOOR_ET : startEtDate
  const today = todayEtDate()
  const end = endEtDate > today ? today : endEtDate
  return {
    startEtDate: start,
    endEtDate: end,
    isEmptyRange: start > end,
  }
}

// Account-wide daily totals (meta_ad_daily). Used ONLY as the fallback for
// days that predate the per-campaign mirror — see `loadMetaRows`.
async function loadAccountRows(range: AdsRange): Promise<MetaAdDailyRow[]> {
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

// Raw per-campaign-per-day row from the Cortana mirror.
type CampaignDayRow = {
  day: string
  entity_name: string | null
  spent: number | null
  impressions: number | null
  reach: number | null
  clicks: number | null
  inline_link_clicks: number | null
  unique_inline_link_clicks: number | null
}

// High-ticket-scoped daily rows synthesized from cortana_campaign_daily:
// per day, sum ONLY the Closer-Funnel campaigns into the MetaAdDailyRow
// shape (so all downstream aggregation is unchanged). Rate columns are
// recomputed from that day's scoped totals. Returns a day→row map holding
// only days that have campaign data.
async function loadFunnelScopedCampaignRows(range: AdsRange): Promise<Map<string, MetaAdDailyRow>> {
  if (range.isEmptyRange) return new Map()
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('cortana_campaign_daily' as never)
    .select('day, entity_name, spent, impressions, reach, clicks, inline_link_clicks, unique_inline_link_clicks')
    .gte('day', range.startEtDate)
    .lte('day', range.endEtDate)
  if (error) throw new Error(`cortana_campaign_daily read failed: ${error.message}`)
  const rows = (data ?? []) as unknown as CampaignDayRow[]

  type Acc = { spend: number; impr: number; reach: number; clicksAll: number; linkClicks: number; uniqueLinkClicks: number }
  const byDay = new Map<string, Acc>()
  // Guard: spend on campaign-data days that did NOT match the high-ticket
  // token. During the single-funnel era this is ~$0; a non-trivial value
  // means either another funnel is running ads (expected once Digital
  // College launches — wire it its own scope) OR a high-ticket campaign was
  // mis-named (would otherwise silently vanish from spend). Logged, not
  // thrown, so the page never breaks.
  const unmatched = new Map<string, number>()
  let unmatchedSpend = 0
  for (const r of rows) {
    const spent = numericOrZero(r.spent)
    if (!isHighTicketCampaign(r.entity_name)) {
      if (spent > 0) {
        const key = r.entity_name ?? '(unnamed)'
        unmatchedSpend += spent
        unmatched.set(key, (unmatched.get(key) ?? 0) + spent)
      }
      continue
    }
    const a = byDay.get(r.day) ?? { spend: 0, impr: 0, reach: 0, clicksAll: 0, linkClicks: 0, uniqueLinkClicks: 0 }
    a.spend += spent
    a.impr += numericOrZero(r.impressions)
    a.reach += numericOrZero(r.reach)
    a.clicksAll += numericOrZero(r.clicks)
    a.linkClicks += numericOrZero(r.inline_link_clicks)
    a.uniqueLinkClicks += numericOrZero(r.unique_inline_link_clicks)
    byDay.set(r.day, a)
  }

  if (unmatchedSpend > 1) {
    const top = Array.from(unmatched.entries())
      .sort((x, y) => y[1] - x[1])
      .slice(0, 5)
      .map(([n, s]) => `${n} ($${s.toFixed(2)})`)
      .join('; ')
    console.warn(
      `[funnel-ads] $${unmatchedSpend.toFixed(2)} of campaign spend did not match the ` +
        `'${HIGH_TICKET_AD_CAMPAIGN_TOKEN}' token and is EXCLUDED from high-ticket adspend: ${top}`,
    )
  }

  const out = new Map<string, MetaAdDailyRow>()
  Array.from(byDay.entries()).forEach(([day, a]) => {
    out.set(day, {
      day,
      amount_spent: a.spend,
      impressions: a.impr,
      unique_link_clicks: a.uniqueLinkClicks,
      link_clicks: a.linkClicks,
      clicks_all: a.clicksAll,
      frequency: a.reach > 0 ? a.impr / a.reach : null,
      ctr: a.impr > 0 ? (a.linkClicks / a.impr) * 100 : null,
      cpm: a.impr > 0 ? (a.spend / a.impr) * 1000 : null,
      cost_per_unique_link_click: a.uniqueLinkClicks > 0 ? a.spend / a.uniqueLinkClicks : null,
    })
  })
  return out
}

// The funnel-scoped daily rows the whole module consumes. Per day, prefer
// the high-ticket campaign sum (cortana_campaign_daily); for days with no
// campaign data yet (before 2026-05-26), fall back to the meta_ad_daily
// account total. Same MetaAdDailyRow shape and ascending order as before,
// so every downstream aggregate/trend/table is unchanged — only the source
// is locked to the high-ticket funnel.
async function loadMetaRows(range: AdsRange): Promise<MetaAdDailyRow[]> {
  if (range.isEmptyRange) return []
  const [accountRows, campaignByDay] = await Promise.all([
    loadAccountRows(range),
    loadFunnelScopedCampaignRows(range),
  ])
  const accountByDay = new Map(accountRows.map((r) => [r.day, r]))
  const dayKeys = Array.from(
    new Set(Array.from(accountByDay.keys()).concat(Array.from(campaignByDay.keys()))),
  )
  const out: MetaAdDailyRow[] = []
  dayKeys.forEach((day) => {
    const row = campaignByDay.get(day) ?? accountByDay.get(day)
    if (row) out.push(row)
  })
  out.sort((a, b) => (a.day < b.day ? -1 : 1))
  return out
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
  // CTR = unique link clicks / impressions. Drake's spec — not Meta's
  // native ctr (which uses link_clicks-all). Renders 0..100.
  const ctr = totalImpressions > 0 ? (totalUniqueClicks / totalImpressions) * 100 : null
  const frequency = avg(rows, 'frequency')

  // Per-day series for the in-cell sparkline. Rows are already in
  // ascending day order from loadMetaRows.
  const impressionsTrend = rows.map((r) => numericOrZero(r.impressions))
  const spendTrend = rows.map((r) => numericOrZero(r.amount_spent))
  const frequencyTrend = rows.map((r) => numericOrZero(r.frequency))
  const uniqueClicksTrend = rows.map((r) => numericOrZero(r.unique_link_clicks))
  const cpmTrend = rows.map((r) => numericOrZero(r.cpm))
  const cpcUniqueTrend = rows.map((r) => numericOrZero(r.cost_per_unique_link_click))
  const ctrTrend = rows.map((r) => {
    const imp = numericOrZero(r.impressions)
    const uc = numericOrZero(r.unique_link_clicks)
    return imp > 0 ? (uc / imp) * 100 : 0
  })

  return [
    { id: 'impressions', label: 'Total impressions', value: totalImpressions, format: 'integer', trend: impressionsTrend },
    // Adspend + Cost-per-unique-click render with exact dollars-and-
    // cents (usd_precise) — compact-USD rounded sub-$1K values down
    // to whole dollars (e.g. $4.83 → "$5"), which Drake wants
    // suppressed for these two metrics.
    { id: 'adspend', label: 'Total adspend', value: totalSpend, format: 'usd_precise', trend: spendTrend },
    { id: 'frequency', label: 'Frequency', value: frequency, format: 'decimal', trend: frequencyTrend },
    { id: 'unique-clicks', label: 'Unique link clicks', value: totalUniqueClicks, format: 'integer', trend: uniqueClicksTrend },
    { id: 'cpi', label: 'CPM', value: cpm, format: 'usd_precise', trend: cpmTrend },
    { id: 'cpc-unique', label: 'Cost per unique click', value: cpcUnique, format: 'usd_precise', trend: cpcUniqueTrend },
    { id: 'ctr', label: 'CTR', value: ctr, format: 'percent_0_100', trend: ctrTrend },
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

// Last-7-days Meta unique-link-clicks trend for the LP detail page
// headline sparkline. Source-of-truth swap: LP visits is now Meta
// unique-link-clicks (Drake 2026-05-27), so its sparkline reads from
// meta_ad_daily, not Clarity. Same 7-day rolling convention as the
// Pulse tiles. Returns the daily series oldest→newest; pads with
// zeros only if meta_ad_daily has gaps inside the 7-day window.
export async function getAdsUniqueClicksTrend7d(): Promise<number[]> {
  // Hard cap at the ADS_FLOOR_ET so we never include days from before
  // tracking started — mirrors the Pulse history floor.
  const today = todayEtDate()
  const sevenAgo = (() => {
    const [y, m, d] = today.split('-').map((n) => parseInt(n, 10))
    const dt = new Date(Date.UTC(y, m - 1, d))
    dt.setUTCDate(dt.getUTCDate() - 7)
    return dt.toISOString().slice(0, 10)
  })()
  const start = sevenAgo > ADS_FLOOR_ET ? sevenAgo : ADS_FLOOR_ET
  // Upper bound = yesterday (Meta data lands the morning after).
  const yesterday = (() => {
    const [y, m, d] = today.split('-').map((n) => parseInt(n, 10))
    const dt = new Date(Date.UTC(y, m - 1, d))
    dt.setUTCDate(dt.getUTCDate() - 1)
    return dt.toISOString().slice(0, 10)
  })()
  if (start > yesterday) return []

  // Funnel-scoped via loadMetaRows — the 7-day window is entirely within
  // the per-campaign era, so this is the high-ticket unique-link-clicks
  // series (the LP-visits proxy), not the account total.
  const rows = await loadMetaRows({ startEtDate: start, endEtDate: yesterday, isEmptyRange: false })
  return rows.map((r) => numericOrNull(r.unique_link_clicks) ?? 0)
}
