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

type RawDcAds = {
  funnel: DcAdsFunnel
  called: Omit<DcAdsCalled, 'speed'> & { buckets: DcAdsSpeedBucket[] }
  timeOfDay: { optIns: number; dials: number; connects: number }[]
  activeFrom: string | null
  activeTo: string | null
}

// Cohort funnel + speed-to-dial + time-of-day, scoped by opt-in anchor.
export async function getDcAdsFunnel(range?: { startUtcIso: string; endUtcIso: string }): Promise<{
  funnel: DcAdsFunnel
  called: DcAdsCalled
  timeOfDay: { buckets: DcAdsHourBucket[] }
  activeFrom: string | null
  activeTo: string | null
}> {
  const sb = createAdminClient()
  const args: Record<string, unknown> = {}
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
export async function getDcAdsByRep(range: {
  startUtcIso: string
  endUtcIso: string
}): Promise<DcAdsByRep> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('dc_ads_funnel_by_rep' as never, {
    p_start: range.startUtcIso,
    p_end: range.endUtcIso,
  } as never)
  if (error) throw new Error(`dc_ads_funnel_by_rep RPC failed: ${error.message}`)
  const d = data as unknown as DcAdsByRep | null
  return {
    reps: d?.reps ?? [],
    totals: d?.totals ?? { closes: 0, base44Monthly: 0, base44Yearly: 0, wixMonthly: 0, wixYearly: 0 },
  }
}

// Ad spend for the funnel's front node: cortana_campaign_daily (level=campaign,
// Meta-API-fed) summed over ONLY the lead-form campaigns (meta_leadgen_campaigns
// — the adset-discriminator scoping set). ET calendar dates, inclusive.
export async function getDcAdsSpend(
  startEtDate: string,
  endEtDate: string,
): Promise<{ spendUsd: number; campaigns: number }> {
  const sb = createAdminClient()
  const { data: camps, error: cErr } = await sb
    .from('meta_leadgen_campaigns' as never)
    .select('campaign_id')
  if (cErr) throw new Error(`meta_leadgen_campaigns read failed: ${cErr.message}`)
  const ids = ((camps ?? []) as Array<{ campaign_id: string }>).map((c) => c.campaign_id)
  if (ids.length === 0) return { spendUsd: 0, campaigns: 0 }

  const { data, error } = await sb
    .from('cortana_campaign_daily' as never)
    .select('spent')
    .in('platform_entity_id', ids)
    .gte('day', startEtDate)
    .lte('day', endEtDate)
  if (error) throw new Error(`dc ads spend read failed: ${error.message}`)
  const spend = ((data ?? []) as Array<{ spent: number | null }>).reduce((a, r) => a + (r.spent ?? 0), 0)
  return { spendUsd: spend, campaigns: ids.length }
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
