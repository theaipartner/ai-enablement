import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DcPlanCounts } from './funnel-dc'

// DC ads funnel — the Digital College paid-ads funnel (Meta instant-form
// opt-ins dialed by reps), on its own /sales-dashboard/dc-ads page. Sibling of
// the Outbound page's data layer (lib/db/funnel-revival.ts): same materialized-
// facts pattern, different membership + anchor (migrations 0122–0125).
//
// Three sources, all Supabase (never the Meta API from here):
//   dc_ads_funnel() / dc_ads_funnel_by_rep()  — per-lead facts rollups
//     (dc_ads_lead_facts: close_leads where funnel_name='Digital College' and
//     campaign_id ∈ meta_leadgen_campaigns, anchored at the form opt-in)
//   cortana_campaign_daily × meta_leadgen_campaigns — the AD SPEND in front of
//     the funnel, scoped to lead-form campaigns only
//   meta_form_leads — the Meta-side opt-in count (bridge-drift check: if the
//     Meta→Close bridge breaks, this keeps counting while the funnel stalls)

export type DcAdsFunnel = {
  optIns: number
  called: number
  connected: number
  booked: number
  bookedDc: number
  bookedHt: number
  showed: number
  closed: number
  closedPlans: DcPlanCounts
  cashUsd: number
  markedNoPlan: number
}

export type DcAdsSpeedBucket = { label: string; count: number; connected: number }

export type DcAdsCalled = {
  optIns: number
  called: number
  connected: number
  notCalled: number
  speed: DcAdsSpeedBucket[]
  speedN: number
  speedMedianMin: number | null
}

export type DcAdsHourBucket = { label: string; optIns: number; dials: number; connects: number }

export type DcAdsRepRow = {
  rep: string
  dials: number
  connections: number
  closes: number
  cash: number
}

export type DcAdsRepTotals = {
  closes: number
  base44Monthly: number
  base44Yearly: number
  wixMonthly: number
  wixYearly: number
}

export type DcAdsByRep = { reps: DcAdsRepRow[]; totals: DcAdsRepTotals }

const TOD_LABELS = ['12a', '2a', '4a', '6a', '8a', '10a', '12p', '2p', '4p', '6p', '8p', '10p']

// The page's ad-cascade selection (campaign → ad set → ad). Deepest wins —
// the RPC args carry only the deepest id, mirroring the Advertising Hub.
export type DcAdsEntityFilter = {
  campaignId?: string | null
  adsetId?: string | null
  adId?: string | null
}

function entityArgs(filter?: DcAdsEntityFilter): Record<string, unknown> {
  if (filter?.adId) return { p_ad_id: filter.adId }
  if (filter?.adsetId) return { p_adset_id: filter.adsetId }
  if (filter?.campaignId) return { p_campaign_id: filter.campaignId }
  return {}
}

type RawDcAds = {
  funnel: DcAdsFunnel
  called: Omit<DcAdsCalled, 'speed'> & { buckets: DcAdsSpeedBucket[] }
  timeOfDay: { optIns: number; dials: number; connects: number }[]
  activeFrom: string | null
  activeTo: string | null
}

// Cohort funnel + speed-to-dial + time-of-day, scoped by opt-in anchor (and
// optionally to one campaign/adset/ad).
export async function getDcAdsFunnel(
  range?: { startUtcIso: string; endUtcIso: string },
  filter?: DcAdsEntityFilter,
): Promise<{
  funnel: DcAdsFunnel
  called: DcAdsCalled
  timeOfDay: { buckets: DcAdsHourBucket[] }
  activeFrom: string | null
  activeTo: string | null
}> {
  const sb = createAdminClient()
  const args: Record<string, unknown> = { ...entityArgs(filter) }
  if (range) {
    args.p_start = range.startUtcIso
    args.p_end = range.endUtcIso
  }
  const { data, error } = await sb.rpc('dc_ads_funnel' as never, args as never)
  if (error) throw new Error(`dc_ads_funnel RPC failed: ${error.message}`)
  const r = data as unknown as RawDcAds

  return {
    funnel: r.funnel,
    called: {
      optIns: r.called.optIns,
      called: r.called.called,
      connected: r.called.connected,
      notCalled: r.called.notCalled,
      speed: r.called.buckets,
      speedN: r.called.speedN,
      speedMedianMin: r.called.speedMedianMin,
    },
    timeOfDay: {
      buckets: r.timeOfDay.map((b, i) => ({
        label: TOD_LABELS[i] ?? '',
        optIns: b.optIns,
        dials: b.dials,
        connects: b.connects,
      })),
    },
    activeFrom: r.activeFrom ?? null,
    activeTo: r.activeTo ?? null,
  }
}

// Per-rep breakdown. ACTIVITY-scoped like outbound's: calls by activity_at,
// closes by form date, within [start, end). Unlike outbound (closers only),
// every rep with any activity is listed — the DC ads pool is dial-heavy and
// closes are the rare event.
export async function getDcAdsByRep(
  range: { startUtcIso: string; endUtcIso: string },
  filter?: DcAdsEntityFilter,
): Promise<DcAdsByRep> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('dc_ads_funnel_by_rep' as never, {
    p_start: range.startUtcIso,
    p_end: range.endUtcIso,
    ...entityArgs(filter),
  } as never)
  if (error) throw new Error(`dc_ads_funnel_by_rep RPC failed: ${error.message}`)
  const d = data as unknown as DcAdsByRep | null
  return {
    reps: d?.reps ?? [],
    totals: d?.totals ?? { closes: 0, base44Monthly: 0, base44Yearly: 0, wixMonthly: 0, wixYearly: 0 },
  }
}

// Which cortana_* mirror + entity ids feed the spend read for the active
// cascade selection. Deepest wins: ad → cortana_ad_daily, ad set →
// cortana_adset_daily, campaign → cortana_campaign_daily (that id only); no
// selection → cortana_campaign_daily over the whole meta_leadgen_campaigns set.
async function spendScope(
  filter?: DcAdsEntityFilter,
): Promise<{ table: string; ids: string[]; campaigns: number }> {
  const sb = createAdminClient()
  const { data: camps, error } = await sb
    .from('meta_leadgen_campaigns' as never)
    .select('campaign_id')
  if (error) throw new Error(`meta_leadgen_campaigns read failed: ${error.message}`)
  const all = ((camps ?? []) as Array<{ campaign_id: string }>).map((c) => c.campaign_id)
  if (filter?.adId) return { table: 'cortana_ad_daily', ids: [filter.adId], campaigns: all.length }
  if (filter?.adsetId) return { table: 'cortana_adset_daily', ids: [filter.adsetId], campaigns: all.length }
  if (filter?.campaignId)
    return { table: 'cortana_campaign_daily', ids: [filter.campaignId], campaigns: all.length }
  return { table: 'cortana_campaign_daily', ids: all, campaigns: all.length }
}

// Ad spend for the funnel's front node (Meta-API-fed cortana_* mirrors), scoped
// to the lead-form campaigns — or to the active cascade selection. ET calendar
// dates, inclusive.
export async function getDcAdsSpend(
  startEtDate: string,
  endEtDate: string,
  filter?: DcAdsEntityFilter,
): Promise<{ spendUsd: number; campaigns: number }> {
  const sb = createAdminClient()
  const scope = await spendScope(filter)
  if (scope.ids.length === 0) return { spendUsd: 0, campaigns: 0 }

  const { data, error } = await sb
    .from(scope.table as never)
    .select('spent')
    .in('platform_entity_id', scope.ids)
    .gte('day', startEtDate)
    .lte('day', endEtDate)
  if (error) throw new Error(`dc ads spend read failed: ${error.message}`)
  const spend = ((data ?? []) as Array<{ spent: number | null }>).reduce((a, r) => a + (r.spent ?? 0), 0)
  return { spendUsd: spend, campaigns: scope.campaigns }
}

// The last-5-days strip: per-ET-day cohort rows (opt-ins that day + lifetime
// progression + dials received), newest first — the DC sibling of the hub's
// getDailyFunnelTable, minus speed-to-lead and bookings. Pinned to the rolling
// strip regardless of the date picker; scoped to the cascade selection.
export type DcAdsDailyRow = {
  etDate: string
  spendUsd: number | null
  optIns: number
  called: number
  connected: number
  closed: number
  cashUsd: number
  dials: number
}

export async function getDcAdsDaily(
  endEtDate: string,
  filter?: DcAdsEntityFilter,
  days = 5,
): Promise<DcAdsDailyRow[]> {
  const sb = createAdminClient()
  const [{ data, error }, scope] = await Promise.all([
    sb.rpc('dc_ads_daily' as never, {
      p_end_et: endEtDate,
      p_days: days,
      ...entityArgs(filter),
    } as never),
    spendScope(filter),
  ])
  if (error) throw new Error(`dc_ads_daily RPC failed: ${error.message}`)
  const rows = (data ?? []) as unknown as Array<Omit<DcAdsDailyRow, 'spendUsd'>>
  if (rows.length === 0) return []

  const daySpend = new Map<string, number>()
  if (scope.ids.length > 0) {
    const etDates = rows.map((r) => r.etDate)
    const { data: spendRows, error: sErr } = await sb
      .from(scope.table as never)
      .select('day, spent')
      .in('platform_entity_id', scope.ids)
      .gte('day', etDates[etDates.length - 1])
      .lte('day', etDates[0])
    if (sErr) throw new Error(`dc ads daily spend read failed: ${sErr.message}`)
    for (const r of (spendRows ?? []) as Array<{ day: string; spent: number | null }>) {
      daySpend.set(r.day, (daySpend.get(r.day) ?? 0) + (r.spent ?? 0))
    }
  }
  return rows.map((r) => ({ ...r, spendUsd: daySpend.get(r.etDate) ?? null }))
}

// Campaign → Ad Set → Ad hierarchy for the cascade chooser, built from the
// window's Meta form submissions (meta_form_leads carries every level's id AND
// name natively — no adset-name mirror lookup needed). Counts are form opt-ins.
export type DcAdNode = { adId: string; adName: string; count: number }
export type DcAdsetNode = { adsetId: string; adsetName?: string; count: number; ads: DcAdNode[] }
export type DcCampaignNode = {
  campaignId: string
  campaignName: string
  count: number
  adsets: DcAdsetNode[]
}
export type DcAdHierarchy = {
  campaigns: DcCampaignNode[]
  adsetsAll: DcAdsetNode[]
  adsAll: DcAdNode[]
}

export async function getDcAdsHierarchy(range: {
  startUtcIso: string
  endUtcIso: string
}): Promise<DcAdHierarchy> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('meta_form_leads' as never)
    .select('campaign_id, campaign_name, adset_id, adset_name, ad_id, ad_name')
    .not('ad_id', 'is', null)
    .gte('created_time', range.startUtcIso)
    .lt('created_time', range.endUtcIso)
    .limit(10000)
  if (error) throw new Error(`meta_form_leads hierarchy read failed: ${error.message}`)
  type Row = {
    campaign_id: string | null
    campaign_name: string | null
    adset_id: string | null
    adset_name: string | null
    ad_id: string
    ad_name: string | null
  }
  type AdsetAgg = { adsetName?: string; count: number; ads: Map<string, { adName: string; count: number }> }
  const camps = new Map<string, { campaignName: string; count: number; adsets: Map<string, AdsetAgg> }>()
  const adsetsAll = new Map<string, AdsetAgg>()
  const adsAll = new Map<string, { adName: string; count: number }>()
  const bump = (m: Map<string, AdsetAgg>, r: Row) => {
    const key = r.adset_id ?? '—'
    const a = m.get(key) ?? { adsetName: r.adset_name ?? undefined, count: 0, ads: new Map() }
    a.count += 1
    const ad = a.ads.get(r.ad_id) ?? { adName: r.ad_name ?? r.ad_id, count: 0 }
    ad.count += 1
    a.ads.set(r.ad_id, ad)
    m.set(key, a)
  }
  for (const r of ((data ?? []) as Row[])) {
    const cId = r.campaign_id ?? '—'
    const c = camps.get(cId) ?? { campaignName: r.campaign_name ?? cId, count: 0, adsets: new Map() }
    c.count += 1
    bump(c.adsets, r)
    camps.set(cId, c)
    bump(adsetsAll, r)
    const g = adsAll.get(r.ad_id) ?? { adName: r.ad_name ?? r.ad_id, count: 0 }
    g.count += 1
    adsAll.set(r.ad_id, g)
  }
  const adNodes = (ads: Map<string, { adName: string; count: number }>): DcAdNode[] => {
    const list = Array.from(ads.entries()).map(([adId, v]) => ({ adId, adName: v.adName, count: v.count }))
    // Meta reuses creative names — disambiguate duplicates with an id suffix.
    const names = new Map<string, number>()
    for (const a of list) names.set(a.adName, (names.get(a.adName) ?? 0) + 1)
    return list
      .map((a) => ((names.get(a.adName) ?? 0) > 1 ? { ...a, adName: `${a.adName} · …${a.adId.slice(-4)}` } : a))
      .sort((x, y) => y.count - x.count)
  }
  const adsetNodes = (m: Map<string, AdsetAgg>): DcAdsetNode[] =>
    Array.from(m.entries())
      .map(([adsetId, v]) => ({ adsetId, adsetName: v.adsetName, count: v.count, ads: adNodes(v.ads) }))
      .sort((x, y) => y.count - x.count)
  return {
    campaigns: Array.from(camps.entries())
      .map(([campaignId, v]) => ({ campaignId, campaignName: v.campaignName, count: v.count, adsets: adsetNodes(v.adsets) }))
      .sort((x, y) => y.count - x.count),
    adsetsAll: adsetNodes(adsetsAll),
    adsAll: adNodes(adsAll),
  }
}

// Meta-side opt-in count in the window (ad-attributed submissions in
// meta_form_leads). Compared against the funnel's Close-side optIns on the
// page: a growing gap = the Meta→Close bridge is dropping leads.
export async function getDcAdsMetaOptIns(range: {
  startUtcIso: string
  endUtcIso: string
}): Promise<number> {
  const sb = createAdminClient()
  const { count, error } = await sb
    .from('meta_form_leads' as never)
    .select('lead_id', { count: 'exact', head: true })
    .eq('is_organic', false)
    .gte('created_time', range.startUtcIso)
    .lt('created_time', range.endUtcIso)
  if (error) throw new Error(`meta_form_leads count failed: ${error.message}`)
  return count ?? 0
}
