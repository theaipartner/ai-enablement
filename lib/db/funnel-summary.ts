import 'server-only'

import type { DateRange } from './funnel-window'
import { getAdsAggregateLive, clampAdsRange } from './funnel-ads'
import { getVslMetrics, getTypVideoMetrics, type VideoMetrics } from './funnel-lp'
import { getTypeformMetrics, type TypeformMetrics } from './funnel-typeform'
import { getLandingPage } from './landing-pages'
import { createAdminClient } from '@/lib/supabase/admin'

// Marketing page — the inline Ads + Landing-Page summary that replaced the two
// click-through detail pages (Drake 2026-06-18). Same window-scoped numbers the
// /funnel/ads and /funnel/landing-pages pages show, gathered in one read so the
// Marketing page can render them as a plain list under the daily table (no
// sparklines, no navigation). Scoped to the funnel's current date window.

export type AdsSummary = {
  adspend: number | null
  impressions: number | null
  uniqueClicks: number | null
  ctr: number | null // 0..100
  cpm: number | null
  cpcUnique: number | null
  frequency: number | null
}

export type AdsLpSummary = {
  ads: AdsSummary
  lpLabel: string
  lpVisits: number // Meta unique link clicks (single source of truth for LP visits)
  lpConversionPct: number | null // Typeform submits ÷ LP visits
  vsl: VideoMetrics
  typVideo: VideoMetrics
  typeform: TypeformMetrics
}

export type AdsCascadeFilter = { adId?: string | null; adsetId?: string | null; campaignId?: string | null }

// Whole-HT-funnel ads aggregate (no cascade selection) — the window-scoped
// numbers the Ads page shows, from the closer-funnel campaign sum.
async function adsSummaryWholeFunnel(range: DateRange): Promise<AdsSummary> {
  const ads = await getAdsAggregateLive(clampAdsRange(range.startEtDate, range.endEtDate))
  const num = (id: string): number | null => {
    const m = ads.find((x) => x.id === id)
    return typeof m?.value === 'number' && Number.isFinite(m.value) ? m.value : null
  }
  return {
    adspend: num('adspend'),
    impressions: num('impressions'),
    uniqueClicks: num('unique-clicks'),
    ctr: num('ctr'),
    cpm: num('cpi'),
    cpcUnique: num('cpc-unique'),
    frequency: num('frequency'),
  }
}

// Per-entity ads aggregate (cascade selection active) — sums the matching
// Cortana per-entity table (ad / ad set / campaign, all share the column set)
// over the window. Derived rates are recomputed from the summed base (frequency
// = Σimpressions/Σreach, CTR = Σunique_clicks/Σimpressions, etc.) rather than
// averaged. `unique_clicks` matches the funnel box's per-entity Link-clicks node.
async function adsSummaryForEntity(range: DateRange, table: string, entityId: string): Promise<AdsSummary> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from(table as never)
    .select('spent, impressions, reach, unique_clicks')
    .eq('platform_entity_id', entityId)
    .gte('day', range.startEtDate)
    .lte('day', range.endEtDate)
  if (error) throw new Error(`${table} read failed: ${error.message}`)
  const rows = (data ?? []) as unknown as Array<{ spent: unknown; impressions: unknown; reach: unknown; unique_clicks: unknown }>
  const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0)
  const spent = rows.reduce((a, r) => a + n(r.spent), 0)
  const impressions = rows.reduce((a, r) => a + n(r.impressions), 0)
  const reach = rows.reduce((a, r) => a + n(r.reach), 0)
  const uniqueClicks = rows.reduce((a, r) => a + n(r.unique_clicks), 0)
  return {
    adspend: spent,
    impressions,
    uniqueClicks,
    ctr: impressions > 0 ? (uniqueClicks / impressions) * 100 : null,
    cpm: impressions > 0 ? (spent / impressions) * 1000 : null,
    cpcUnique: uniqueClicks > 0 ? spent / uniqueClicks : null,
    frequency: reach > 0 ? impressions / reach : null,
  }
}

// Ads block scoped to the active cascade selection (deepest wins: ad > ad set >
// campaign), falling back to the whole-funnel aggregate when nothing's picked.
async function getAdsSummary(range: DateRange, filter: AdsCascadeFilter): Promise<AdsSummary> {
  try {
    if (filter.adId) return await adsSummaryForEntity(range, 'cortana_ad_daily', filter.adId)
    if (filter.adsetId) return await adsSummaryForEntity(range, 'cortana_adset_daily', filter.adsetId)
    if (filter.campaignId) return await adsSummaryForEntity(range, 'cortana_campaign_daily', filter.campaignId)
  } catch {
    // Fall through to the whole-funnel aggregate on any per-entity read error.
  }
  return adsSummaryWholeFunnel(range)
}

export async function getAdsLpSummary(
  range: DateRange,
  lpSlug: string | null,
  adsFilter: AdsCascadeFilter = {},
): Promise<AdsLpSummary> {
  const lp = getLandingPage(lpSlug)
  const filterActive = !!(adsFilter.adId || adsFilter.adsetId || adsFilter.campaignId)

  // wholeFunnel drives the LP block (LP visits = whole-funnel Meta unique link
  // clicks) — the landing-page section scopes to the LP dropdown + window only,
  // NOT the ad cascade. The ads block scopes to the cascade (entityAds when a
  // selection is active, else the same whole-funnel aggregate).
  const [wholeFunnel, entityAds, vsl, typVideo, typeform] = await Promise.all([
    adsSummaryWholeFunnel(range),
    filterActive ? getAdsSummary(range, adsFilter) : Promise.resolve(null),
    getVslMetrics(range, lp.vsl),
    getTypVideoMetrics(range, lp.confirmVideoHashedId, lp.confirmVideoLabel),
    getTypeformMetrics(range, lp.typeformFormId),
  ])

  const ads = entityAds ?? wholeFunnel
  const lpVisits = wholeFunnel.uniqueClicks ?? 0
  const lpConversionPct = lpVisits > 0 ? (typeform.submits / lpVisits) * 100 : null

  return {
    ads,
    lpLabel: lp.label,
    lpVisits,
    lpConversionPct,
    vsl,
    typVideo,
    typeform,
  }
}
