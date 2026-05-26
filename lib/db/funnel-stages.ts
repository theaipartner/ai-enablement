import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import {
  getAdsAggregateLive,
  clampAdsRange,
  type AdsRange,
} from './funnel-ads'
import { getLpClarityMetrics } from './funnel-lp'
import { getTypeformMetrics } from './funnel-typeform'
import { getCallActivityMetrics } from './funnel-appointment-setting'
import { getClosingActivity } from './funnel-closing'
import {
  dateRangeFromExplicit,
  todayEtDate,
  type DateRange,
} from './funnel-window'
import type { AggMetric } from './funnel-mocks'

// Funnel page — Pulse-style activity dashboard (no funnel shape, no
// cross-stage conversions, no bottleneck calc).
//
// Each box is an INDEPENDENT activity snapshot for the selected date
// range. Stages can have their own within-box rates (CTR within Ads,
// VSL play rate within LP, etc.) — but no rates between boxes. The
// rationale: stages are "activity in this period," not a single
// cohort, so cross-stage % comparisons mix different lead populations.
// True cohort funnel is a future project.

export type FunnelBoxStatus = 'live' | 'stub'

export type FunnelBox = {
  id: 'ads' | 'landing-page' | 'appointment-setting' | 'closing'
  eyebrow: string
  title: string
  href: string | null
  status: FunnelBoxStatus
  // Optional hero metric rendered above the metric grid (big number).
  // Used on the Ads box to feature total adspend at the top.
  hero?: AggMetric
  // Six (or fewer) metric tiles inside the box. AggMetric is the
  // shared shape used by every stage-detail MetricsGrid.
  metrics: AggMetric[]
  // Optional footer line under the metric grid (e.g. cost-per math,
  // VSL hashed_id reference). Renders muted.
  footer?: string
}

export type FunnelActivity = {
  range: DateRange
  adSpend: number          // total Meta spend over the range — shown in legend
  boxes: FunnelBox[]
}

// Default range = yesterday ET. Picked because Meta lands the morning
// after, so "yesterday" is the most-recent fully-populated day across
// every source.
function yesterdayEtDate(): string {
  const today = todayEtDate()
  const [y, m, d] = today.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - 1)
  return dt.toISOString().slice(0, 10)
}

export function resolveFunnelRange(
  startEtDate: string | undefined,
  endEtDate: string | undefined,
): DateRange {
  const yesterday = yesterdayEtDate()
  const s = startEtDate ?? yesterday
  const e = endEtDate ?? yesterday
  return dateRangeFromExplicit(s, e)
}

export async function getFunnelActivity(range: DateRange): Promise<FunnelActivity> {
  // Ads clamp: ADS_FLOOR_ET on the low end, yesterday on the high end.
  // Spend value drives the cost-per math in every box that wires it.
  const adsRange: AdsRange = clampAdsRange(range.startEtDate, range.endEtDate)

  const [ads, lp, typeform, callActivity, closing] = await Promise.all([
    getAdsAggregateLive(adsRange),
    getLpClarityMetrics(range),
    getTypeformMetrics(range),
    getCallActivityMetrics(range),
    getClosingActivity(range),
  ])

  const impressionsMetric = ads.find((m) => m.id === 'impressions')
  const adspendMetric = ads.find((m) => m.id === 'adspend')
  const impressions = typeof impressionsMetric?.value === 'number' ? impressionsMetric.value : 0
  const adSpend = typeof adspendMetric?.value === 'number' ? adspendMetric.value : 0

  // Volume-weighted CTR (unique link clicks / impressions). Comes from
  // getAdsAggregateLive — `percent_0_100`.
  const ctr = getMetricValue(ads, 'ctr')

  // Ads box layout: hero adspend on top (rendered with exact dollars-
  // and-cents in page.tsx), then three tiles below — Impressions,
  // Cost / unique click, CTR.
  const adsBox: FunnelBox = {
    id: 'ads',
    eyebrow: 'PULSE · ADS',
    title: 'Meta.',
    href: '/sales-dashboard/funnel/ads',
    status: 'live',
    hero: { id: 'adspend', label: 'Total adspend', value: adSpend, format: 'usd' },
    metrics: [
      { id: 'impressions', label: 'Impressions', value: impressions, format: 'integer' },
      { id: 'cpc-unique', label: 'Cost / unique click', value: getMetricValue(ads, 'cpc-unique'), format: 'usd' },
      { id: 'ctr', label: 'CTR', value: ctr, format: 'percent_0_100' },
    ],
    footer: adSpend > 0
      ? undefined
      : 'Meta lands the morning after — pick yesterday\'s date for real ad math.',
  }

  // Landing Page: funnel-volume counts with cost-per attribution.
  // Engagement metrics (avg time on LP, VSL play rate / avg watch /
  // plays) moved to the LP detail page — the box surfaces lead-funnel
  // counts only per Drake's "funnel metrics + cost-per for leads."
  const lpVisits = lp.visits
  const lpBox: FunnelBox = {
    id: 'landing-page',
    eyebrow: 'PULSE · LANDING PAGE',
    title: 'Landing page.',
    href: '/sales-dashboard/funnel/landing-pages',
    status: 'live',
    metrics: [
      { id: 'visits', label: 'LP visits', value: lpVisits, format: 'integer' },
      { id: 'cost-per-visit', label: 'Cost / visit', value: costPer(adSpend, lpVisits), format: 'usd' },
      { id: 'submits', label: 'Submits', value: typeform.submits, format: 'integer' },
      { id: 'cost-per-submit', label: 'Cost / submit', value: costPer(adSpend, typeform.submits), format: 'usd' },
      { id: 'qualified', label: 'Qualified submits ($2k+)', value: typeform.qualified, format: 'integer' },
      { id: 'cost-per-qualified', label: 'Cost / qualified', value: costPer(adSpend, typeform.qualified), format: 'usd' },
    ],
    footer: `Clarity path /lp-vsl  ·  qualified = budget ≥ $2,000 on Typeform`,
  }

  // Appointment Setting: surface the rolled-up activity counts from the
  // existing detail page's data layer.
  const settersAgg = callActivity.settersAggregate
  const closersAgg = callActivity.closersAggregate
  const totalDials = settersAgg.totalCalls + closersAgg.totalCalls
  const totalOver90s = settersAgg.totalOver90s + closersAgg.totalOver90s
  const totalBookings = settersAgg.bookings + closersAgg.bookings
  const totalDqs = settersAgg.dqs + closersAgg.dqs
  const totalDownsells = settersAgg.downsells + closersAgg.downsells

  const apptBox: FunnelBox = {
    id: 'appointment-setting',
    eyebrow: 'PULSE · APPOINTMENT SETTING',
    title: 'Appointment setting.',
    href: '/sales-dashboard/funnel/appointment-setting',
    status: 'live',
    metrics: [
      { id: 'triages', label: 'Triage forms', value: callActivity.totalFormsInWindow, format: 'integer' },
      { id: 'cost-per-triage', label: 'Cost / triage', value: costPer(adSpend, callActivity.totalFormsInWindow), format: 'usd' },
      { id: 'over90s', label: 'Calls > 90s', value: totalOver90s, format: 'integer' },
      { id: 'cost-per-over90s', label: 'Cost / call > 90s', value: costPer(adSpend, totalOver90s), format: 'usd' },
      { id: 'bookings', label: 'Bookings', value: totalBookings, format: 'integer' },
      { id: 'cost-per-booking', label: 'Cost / booking', value: costPer(adSpend, totalBookings), format: 'usd' },
    ],
    footer: `${totalDials} outbound dials  ·  ${totalDqs} DQ  ·  ${totalDownsells} downsell  ·  click through for per-rep detail`,
  }

  // Closing: live (closer form mirror is wired; cash is PROVISIONAL —
  // canonical cash-field ambiguity surfaced on the detail page).
  const closingAgg = closing.aggregate
  const closingBox: FunnelBox = {
    id: 'closing',
    eyebrow: 'PULSE · CLOSING',
    title: 'Closing.',
    href: '/sales-dashboard/funnel/closed',
    status: 'live',
    metrics: [
      { id: 'calls-logged', label: 'Calls logged', value: closingAgg.callsLogged, format: 'integer' },
      { id: 'cost-per-showed-call', label: 'Cost / showed call', value: costPer(adSpend, closingAgg.showed), format: 'usd' },
      { id: 'closed', label: 'Closed', value: closingAgg.closed, format: 'integer' },
      { id: 'cost-per-close', label: 'Cost / close', value: costPer(adSpend, closingAgg.closed), format: 'usd' },
      { id: 'upfront', label: 'Upfront collected', value: closing.money.upfrontCollected || null, format: 'usd' },
      { id: 'aov', label: 'AOV', value: closing.money.aov, format: 'usd' },
    ],
    footer: `Close rate ${closingAgg.closeRate == null ? '—' : (closingAgg.closeRate * 100).toFixed(1) + '%'}  ·  contract value ${closing.money.totalContractValue ? '$' + closing.money.totalContractValue.toLocaleString('en-US') : '—'}  ·  cash provisional — click through for per-closer drill.`,
  }

  return {
    range,
    adSpend,
    boxes: [adsBox, lpBox, apptBox, closingBox],
  }
}

function getMetricValue(ms: AggMetric[], id: string): number | null {
  const m = ms.find((x) => x.id === id)
  return typeof m?.value === 'number' ? m.value : null
}

function costPer(spend: number, count: number | null): number | null {
  if (count == null || count <= 0) return null
  if (spend <= 0) return null
  return spend / count
}

