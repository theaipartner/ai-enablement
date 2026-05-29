import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import {
  getAdsAggregateLive,
  clampAdsRange,
  ADS_FLOOR_ET,
  type AdsRange,
} from './funnel-ads'
import { getTypeformMetrics } from './funnel-typeform'
import {
  getCallActivityMetrics,
  getFmrTimeBlocks,
} from './funnel-appointment-setting'
import { getClosingActivity } from './funnel-closing'
import { getCloserBookings } from './funnel-calendly'
import { getPulseHistory } from './pulse-history'
import {
  dateRangeFromExplicit,
  todayEtDate,
  type DateRange,
} from './funnel-window'
import type { AggMetric, MetricFormatExt } from './funnel-mocks'

// Funnel page — Pulse-style activity dashboard.
//
// Each box is an independent activity snapshot for the selected date
// range. Within-box stage rates are OK (CTR within Ads, LP-conversion
// within Landing Page) but cross-box conversion math isn't surfaced
// — different cohorts touch each stage so % comparisons would mix
// populations. Cohort funnel is future work.

// ---------------------------------------------------------------------------
// Tile + box shapes
// ---------------------------------------------------------------------------

// Pulse-specific tile. Richer than the shared AggMetric so we can
// render the cost-per corner badge + the gold "anchor" tile style
// inline without touching every other funnel surface.
export type PulseTile = {
  id: string
  label: string
  value: number | null
  format: MetricFormatExt
  // Small "cost / X $4.83" corner badge. Rendered muted, top-right.
  secondary?: {
    label: string
    value: number | null
    format: MetricFormatExt
  }
  // Gold-edged tile to draw the eye (Adspend on the Ads box).
  highlight?: boolean
  // Tiny caption under the value — used for "since May 24 ET" on
  // FMR (cohort metric that doesn't move with the date picker).
  caption?: string
  // Rolling-7d historical context for the metric (yesterday value,
  // 7d average floored at 2026-05-24, 7-day daily series for a
  // sparkline). Populated by pulse-history.ts after the rest of the
  // tile is built. Null when we haven't wired history for this id.
  history?: import('./pulse-history').PulseHistory | null
}

export type FunnelBoxStatus = 'live' | 'stub'

export type FunnelBox = {
  id: 'ads' | 'landing-page' | 'appointment-setting' | 'closing'
  eyebrow: string
  title: string
  href: string | null
  status: FunnelBoxStatus
  // Grid of tiles inside the box. Tile count determines column layout
  // in page.tsx (3 across by default; the Appt Setting box explicitly
  // requests 3 columns × 2 rows for its 6 tiles).
  tiles: PulseTile[]
  // Optional footer line under the tile grid (e.g. canonical-path
  // reference, qualification rule). Renders muted.
  footer?: string
}

export type FunnelActivity = {
  range: DateRange
  adSpend: number          // total Meta spend over the range — drives most cost-per math
  boxes: FunnelBox[]
  // Two-tile ROAS strip rendered below the boxes — non-clickable,
  // separate visual block. Wiring is deliberately blank for now;
  // formulas already encoded so when we flip the placeholder switch
  // the numbers populate.
  roas: PulseTile[]
}

// Default range = TODAY ET (Drake 2026-05-29). Since the Cortana
// cutover, ads populate today intraday, so the pulse opens on the
// current day; every source's today-so-far is shown and restates as
// the day fills in.
export function resolveFunnelRange(
  startEtDate: string | undefined,
  endEtDate: string | undefined,
): DateRange {
  const today = todayEtDate()
  const s = startEtDate ?? today
  const e = endEtDate ?? today
  return dateRangeFromExplicit(s, e)
}

export async function getFunnelActivity(range: DateRange): Promise<FunnelActivity> {
  // Ads clamp: ADS_FLOOR_ET on the low end, today on the high end.
  // Spend value drives the cost-per math in every box that wires it.
  const adsRange: AdsRange = clampAdsRange(range.startEtDate, range.endEtDate)

  const [ads, typeform, callActivity, closing, calendly, fmr, cohortSpend, history] = await Promise.all([
    getAdsAggregateLive(adsRange),
    // Clarity dropped from Pulse 2026-05-27 — LP visits now reads
    // Meta unique-link-clicks from `ads`. The LP detail page still
    // pulls Clarity for time-on-page metrics; that lives there, not
    // on the funnel overview.
    getTypeformMetrics(range),
    getCallActivityMetrics(range),
    getClosingActivity(range),
    getCloserBookings(range),
    getFmrTimeBlocks(),
    getCohortAdspendSinceFloor(),
    // Rolling-7d historical context for the sparkline + yesterday +
    // 7d-avg footer on every tile. Map keyed by tile id; tiles
    // missing from the map render no history block.
    getPulseHistory(),
  ])

  const impressionsMetric = ads.find((m) => m.id === 'impressions')
  const adspendMetric = ads.find((m) => m.id === 'adspend')
  const impressions = typeof impressionsMetric?.value === 'number' ? impressionsMetric.value : 0
  const adSpend = typeof adspendMetric?.value === 'number' ? adspendMetric.value : 0
  const ctr = getMetricValue(ads, 'ctr')

  // ─── Ads ──────────────────────────────────────────────────────────────
  // Four tiles, no hero. Adspend sits last and renders gold-highlighted
  // — the metric we want the eye to land on after scanning the volume +
  // efficiency tiles.
  const adsBox: FunnelBox = {
    id: 'ads',
    eyebrow: 'PULSE · ADS',
    title: 'Meta.',
    href: '/sales-dashboard/funnel/ads',
    status: 'live',
    tiles: [
      { id: 'impressions', label: 'Impressions', value: impressions, format: 'integer' },
      { id: 'cpc-unique', label: 'Cost / unique click', value: getMetricValue(ads, 'cpc-unique'), format: 'usd_precise' },
      { id: 'ctr', label: 'CTR', value: ctr, format: 'percent_0_100' },
      { id: 'adspend', label: 'Total adspend', value: adSpend, format: 'usd_precise', highlight: true },
    ],
    footer: adSpend > 0
      ? undefined
      : 'Today\'s spend builds through the day as Meta finalizes — pick a past day for a complete picture.',
  }

  // ─── Landing Page ──────────────────────────────────────────────────────
  // Funnel-volume counts with cost-per attribution rendered as the
  // corner badge on each tile. Five tiles: Visits / Submits / Qualified /
  // Bookings / Conversion (visits → submits %).
  //
  // 2026-05-27: LP visits switched from Clarity to Meta unique link
  // clicks (Drake — keeps a single source of truth for "people who
  // clicked through to the LP" and aligns with the Meta-side
  // cost / unique-click metric). LP conversion is submits / visits
  // (Drake 2026-05-27 evening — bookings come later in the funnel
  // and have their own tile; LP's job is to drive Typeform submits).
  const lpVisits = getMetricValue(ads, 'unique-clicks') ?? 0
  const lpBookings = calendly.total
  const lpConversion = lpVisits > 0 ? (typeform.submits / lpVisits) * 100 : null
  const lpBox: FunnelBox = {
    id: 'landing-page',
    eyebrow: 'PULSE · LANDING PAGE',
    title: 'Landing page.',
    href: '/sales-dashboard/funnel/landing-pages',
    status: 'live',
    tiles: [
      { id: 'visits', label: 'LP visits', value: lpVisits, format: 'integer',
        secondary: { label: 'cost / visit', value: costPer(adSpend, lpVisits), format: 'usd_precise' } },
      { id: 'submits', label: 'Submits', value: typeform.submits, format: 'integer',
        secondary: { label: 'cost / submit', value: costPer(adSpend, typeform.submits), format: 'usd_precise' } },
      { id: 'qualified', label: 'Qualified submits ($2k+)', value: typeform.qualified, format: 'integer',
        secondary: { label: 'cost / qualified', value: costPer(adSpend, typeform.qualified), format: 'usd_precise' } },
      { id: 'bookings', label: 'Bookings', value: lpBookings, format: 'integer',
        secondary: { label: 'cost / booking', value: costPer(adSpend, lpBookings), format: 'usd_precise' } },
      { id: 'lp-conversion', label: 'LP conversion', value: lpConversion, format: 'percent_0_100' },
    ],
    footer: `Visits = Meta unique link clicks  ·  qualified = budget ≥ $2,000 on Typeform  ·  conversion = submits / visits`,
  }

  // ─── Appointment Setting ───────────────────────────────────────────────
  // Six tiles, 3×2 grid. FMR is cohort-based (since May 24 ET) and
  // doesn't move with the date picker — captioned accordingly.
  // "Triages" intentionally = calls > 90s in window (Drake's
  // definition; airtable forms can lag the call, so >90s is the
  // honest signal of an actual conversation).
  const settersAgg = callActivity.settersAggregate
  const closersAgg = callActivity.closersAggregate
  const totalDials = settersAgg.totalCalls + closersAgg.totalCalls
  const totalOver90s = settersAgg.totalOver90s + closersAgg.totalOver90s
  // Post 2026-05-27 form redesign:
  //   - "Booked meetings" tile = HT bookings the setter set up (the
  //     identity rename of the old "Confirmed Booked with Closer").
  //     Closer-side `confirmedBooks` is a CLOSE (a sale), conceptually
  //     different from a booking, so it doesn't roll up here.
  //   - "Downsells" tile = any DC outcome (setter booked into a DC
  //     call OR closer sold DC live on the call).
  const totalBookings = settersAgg.htBookings
  const totalDqs = settersAgg.dqs + closersAgg.dqs
  const totalDownsells = settersAgg.dcBookings + closersAgg.downsellsOnCall
  const fmrCount = fmr.cohortEverReplied

  const apptBox: FunnelBox = {
    id: 'appointment-setting',
    eyebrow: 'PULSE · APPOINTMENT SETTING',
    title: 'Appointment setting.',
    href: '/sales-dashboard/funnel/appointment-setting',
    status: 'live',
    tiles: [
      { id: 'fmr', label: 'First message responses', value: fmrCount, format: 'integer',
        caption: 'cohort since May 24 ET',
        secondary: { label: 'cost / FMR', value: costPer(cohortSpend, fmrCount), format: 'usd_precise' } },
      { id: 'triages', label: 'Triages (calls > 90s)', value: totalOver90s, format: 'integer',
        secondary: { label: 'cost / triage', value: costPer(adSpend, totalOver90s), format: 'usd_precise' } },
      { id: 'dials', label: 'Dials', value: totalDials, format: 'integer',
        secondary: { label: 'cost / dial', value: costPer(adSpend, totalDials), format: 'usd_precise' } },
      { id: 'dqs', label: 'DQs', value: totalDqs, format: 'integer' },
      { id: 'downsells', label: 'Downsells', value: totalDownsells, format: 'integer',
        secondary: { label: 'cost / downsell', value: costPer(adSpend, totalDownsells), format: 'usd_precise' } },
      { id: 'booked', label: 'Booked meetings', value: totalBookings, format: 'integer',
        secondary: { label: 'cost / booking', value: costPer(adSpend, totalBookings), format: 'usd_precise' } },
    ],
    footer: `Triages = outbound + inbound calls over 90s by setters & closers  ·  click through for per-rep detail`,
  }

  // ─── Closing ──────────────────────────────────────────────────────────
  // Short: Showed / Closed / Cash collected. Cost-per on the first two.
  const closingAgg = closing.aggregate
  const closingBox: FunnelBox = {
    id: 'closing',
    eyebrow: 'PULSE · CLOSING',
    title: 'Closing.',
    href: '/sales-dashboard/funnel/closed',
    status: 'live',
    tiles: [
      { id: 'showed', label: 'Showed', value: closingAgg.showed, format: 'integer',
        secondary: { label: 'cost / showed', value: costPer(adSpend, closingAgg.showed), format: 'usd_precise' } },
      { id: 'closed', label: 'Closed', value: closingAgg.closed, format: 'integer',
        secondary: { label: 'cost / closed', value: costPer(adSpend, closingAgg.closed), format: 'usd_precise' } },
      { id: 'cash-collected', label: 'Cash collected', value: closing.money.upfrontCollected || null, format: 'usd_precise' },
    ],
    footer: `Close rate ${closingAgg.closeRate == null ? '—' : (closingAgg.closeRate * 100).toFixed(1) + '%'}  ·  contract value ${closing.money.totalContractValue ? '$' + closing.money.totalContractValue.toLocaleString('en-US') : '—'}  ·  cash provisional — click through for per-closer drill.`,
  }

  // ─── ROAS strip ────────────────────────────────────────────────────────
  // Two non-clickable tiles below all four boxes. Wiring is intentionally
  // blank for now — `value: null` renders as "—". The cost-side anchor
  // is in-range adspend; the cash side wants in-range cash-landed (not
  // wired yet — see footer note) and the revenue side wants in-range
  // contract value (likewise pending).
  const roas: PulseTile[] = [
    { id: 'roas-cash', label: 'ROAS · Cash landed', value: null, format: 'decimal',
      caption: 'cash collected ÷ adspend' },
    { id: 'roas-revenue', label: 'ROAS · Revenue', value: null, format: 'decimal',
      caption: 'contract value ÷ adspend' },
  ]

  // Attach rolling-7d history to every tile by id. ROAS tiles stay
  // un-hydrated (history map doesn't include null-value metrics).
  const allBoxes = [adsBox, lpBox, apptBox, closingBox]
  for (const box of allBoxes) {
    for (const tile of box.tiles) {
      tile.history = history.get(tile.id) ?? null
    }
  }

  return {
    range,
    adSpend,
    boxes: allBoxes,
    roas,
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getMetricValue(ms: AggMetric[], id: string): number | null {
  const m = ms.find((x) => x.id === id)
  return typeof m?.value === 'number' ? m.value : null
}

function costPer(spend: number, count: number | null): number | null {
  if (count == null || count <= 0) return null
  if (spend <= 0) return null
  return spend / count
}

// Total Meta adspend since ADS_FLOOR_ET (May 24, 2026 — also the FMR
// cohort floor). Used as the denominator for FMR cost-per, since
// FMR is a cohort metric and pairing it with date-range adspend
// would understate the cost.
async function getCohortAdspendSinceFloor(): Promise<number> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('meta_ad_daily' as never)
    .select('amount_spent')
    .gte('day', ADS_FLOOR_ET)
  if (error) throw new Error(`cohort adspend read failed: ${error.message}`)
  let total = 0
  for (const r of (data ?? []) as unknown as Array<{ amount_spent: number | string | null }>) {
    const v = r.amount_spent
    if (typeof v === 'number' && Number.isFinite(v)) total += v
    else if (typeof v === 'string') {
      const n = Number(v)
      if (Number.isFinite(n)) total += n
    }
  }
  return total
}
