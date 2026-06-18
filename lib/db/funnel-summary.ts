import 'server-only'

import type { DateRange } from './funnel-window'
import { getAdsAggregateLive, clampAdsRange } from './funnel-ads'
import { getVslMetrics, getTypVideoMetrics, type VideoMetrics } from './funnel-lp'
import { getTypeformMetrics, type TypeformMetrics } from './funnel-typeform'
import { getLandingPage } from './landing-pages'

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

export async function getAdsLpSummary(range: DateRange, lpSlug: string | null): Promise<AdsLpSummary> {
  const lp = getLandingPage(lpSlug)
  const adsRange = clampAdsRange(range.startEtDate, range.endEtDate)

  const [ads, vsl, typVideo, typeform] = await Promise.all([
    getAdsAggregateLive(adsRange),
    getVslMetrics(range, lp.vsl),
    getTypVideoMetrics(range, lp.confirmVideoHashedId, lp.confirmVideoLabel),
    getTypeformMetrics(range, lp.typeformFormId),
  ])

  const num = (id: string): number | null => {
    const m = ads.find((x) => x.id === id)
    return typeof m?.value === 'number' && Number.isFinite(m.value) ? m.value : null
  }

  const lpVisits = num('unique-clicks') ?? 0
  const lpConversionPct = lpVisits > 0 ? (typeform.submits / lpVisits) * 100 : null

  return {
    ads: {
      adspend: num('adspend'),
      impressions: num('impressions'),
      uniqueClicks: num('unique-clicks'),
      ctr: num('ctr'),
      cpm: num('cpi'),
      cpcUnique: num('cpc-unique'),
      frequency: num('frequency'),
    },
    lpLabel: lp.label,
    lpVisits,
    lpConversionPct,
    vsl,
    typVideo,
    typeform,
  }
}
