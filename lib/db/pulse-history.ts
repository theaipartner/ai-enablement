import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { getAdsAggregateLive } from './funnel-ads'
import { getCallActivityMetrics } from './funnel-appointment-setting'
import { getCloserBookings } from './funnel-calendly'
import { getClosingActivity } from './funnel-closing'
import { getTypeformMetrics } from './funnel-typeform'
import { dateRangeFromExplicit, todayEtDate } from './funnel-window'

// Pulse-page historical context. For every metric tile on
// /sales-dashboard/funnel, returns:
//
//   - yesterday: single-day value
//   - avg7d:     7-day rolling average (floor: 2026-05-24)
//   - trend7d:   daily values for a sparkline
//
// Math notes:
//   - For raw COUNT/SUM metrics (impressions, dials, visits, etc.),
//     avg7d is the plain mean of trend7d.
//   - For RATIO metrics (CTR, LP conversion, cost-per-X), avg7d is
//     VOLUME-WEIGHTED: sum(numerator_7d) / sum(denominator_7d). This
//     avoids low-volume days dragging the average around. The
//     sparkline still renders daily ratios — slightly different math,
//     but it's a visualization so directional is enough.
//   - For FMR (cohort metric since 5/24), the daily value is "leads
//     created on day X who ever responded" — i.e. the daily delta to
//     the cumulative cohort. yesterday + avg7d match that semantic.
//
// Window: max(today - 7d, 2026-05-24) → yesterday. Today is excluded
// because most upstream sources (Meta especially) restate the current
// day all day. Floor at 5/24 to match the rest of the Pulse page.
//
// Implementation: one fetch per day in parallel — re-uses the existing
// per-source aggregation functions instead of writing source-specific
// daily SQL. Costs ~6 round trips × 3 days (current window from 5/24
// to yesterday) in parallel; under a second wall time at current
// volume. When the window saturates at 7 days, ~6 × 7 = 42 round trips
// in parallel — still acceptable. Move to per-source GROUP BY day if
// page-load latency becomes a concern.

const PULSE_FLOOR_ET_DATE = '2026-05-24'

export type PulseHistory = {
  yesterday: number | null
  avg7d: number | null
  trend7d: number[]
}

/**
 * Returns a map keyed by Pulse tile id → PulseHistory.
 *
 * Tile ids match those set in getFunnelActivity (funnel-stages.ts).
 * A tile id missing from the map should render no history block.
 */
export async function getPulseHistory(): Promise<Map<string, PulseHistory>> {
  const today = todayEtDate()
  const yesterday = subtractDayEt(today, 1)
  const windowStart = maxDate(subtractDayEt(today, 7), PULSE_FLOOR_ET_DATE)
  const days = enumerateDaysInclusive(windowStart, yesterday)

  if (days.length === 0) {
    return new Map()
  }

  // Fetch per-day aggregations in parallel. Each day spawns ~6 source
  // fetches; awaiting one big Promise.all collapses every fetch into
  // the same network burst.
  const perDay = await Promise.all(days.map(fetchDay))
  const fmrDaily = await fetchFmrDaily(days)

  // Helpers for assembling each metric history
  const series = (extractor: (d: DayAgg) => number | null): number[] =>
    perDay.map((d) => extractor(d) ?? 0)
  const mean = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs.reduce((a, b) => a + b, 0) / xs.length
  const last = (xs: number[]): number | null =>
    xs.length === 0 ? null : xs[xs.length - 1]

  // Volume-weighted ratio. Returns null when denominator is 0.
  const ratio7d = (
    numExtract: (d: DayAgg) => number | null,
    denExtract: (d: DayAgg) => number | null,
    scale: number = 1,
  ): number | null => {
    const num = perDay.reduce((s, d) => s + (numExtract(d) ?? 0), 0)
    const den = perDay.reduce((s, d) => s + (denExtract(d) ?? 0), 0)
    return den > 0 ? (num / den) * scale : null
  }
  const ratioDaily = (
    numExtract: (d: DayAgg) => number | null,
    denExtract: (d: DayAgg) => number | null,
    scale: number = 1,
  ): number[] =>
    perDay.map((d) => {
      const den = denExtract(d) ?? 0
      const num = numExtract(d) ?? 0
      return den > 0 ? (num / den) * scale : 0
    })
  const lastRatio = (
    numExtract: (d: DayAgg) => number | null,
    denExtract: (d: DayAgg) => number | null,
    scale: number = 1,
  ): number | null => {
    const last = perDay[perDay.length - 1]
    if (!last) return null
    const den = denExtract(last) ?? 0
    const num = numExtract(last) ?? 0
    return den > 0 ? (num / den) * scale : null
  }

  const map = new Map<string, PulseHistory>()

  // ─── Ads box ──────────────────────────────────────────────────────
  {
    const trend = series((d) => d.ads.impressions)
    map.set('impressions', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }
  {
    const trend = series((d) => d.ads.adspend)
    map.set('adspend', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }
  {
    // CTR = unique_link_clicks / impressions * 100 (Drake's spec)
    const trend = ratioDaily((d) => d.ads.uniqueLinkClicks, (d) => d.ads.impressions, 100)
    map.set('ctr', {
      yesterday: lastRatio((d) => d.ads.uniqueLinkClicks, (d) => d.ads.impressions, 100),
      avg7d: ratio7d((d) => d.ads.uniqueLinkClicks, (d) => d.ads.impressions, 100),
      trend7d: trend,
    })
  }
  {
    // Cost per unique link click = spend / unique_link_clicks
    const trend = ratioDaily((d) => d.ads.adspend, (d) => d.ads.uniqueLinkClicks)
    map.set('cpc-unique', {
      yesterday: lastRatio((d) => d.ads.adspend, (d) => d.ads.uniqueLinkClicks),
      avg7d: ratio7d((d) => d.ads.adspend, (d) => d.ads.uniqueLinkClicks),
      trend7d: trend,
    })
  }

  // ─── Landing Page box ─────────────────────────────────────────────
  {
    // LP visits = Meta unique link clicks (Drake 2026-05-27 — single
    // source of truth, aligns with cost / unique-click).
    const trend = series((d) => d.ads.uniqueLinkClicks)
    map.set('visits', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }
  {
    const trend = series((d) => d.typeform.submits)
    map.set('submits', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }
  {
    const trend = series((d) => d.typeform.qualified)
    map.set('qualified', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }
  {
    const trend = series((d) => d.calendly.total)
    map.set('bookings', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }
  {
    // LP conversion = submits / visits * 100. Drake 2026-05-27 —
    // bookings come later in the funnel and have their own tile; LP's
    // job is to drive Typeform submits. Denominator is Meta unique
    // link clicks (per the visits source swap). Volume-weighted 7d avg.
    const trend = ratioDaily((d) => d.typeform.submits, (d) => d.ads.uniqueLinkClicks, 100)
    map.set('lp-conversion', {
      yesterday: lastRatio((d) => d.typeform.submits, (d) => d.ads.uniqueLinkClicks, 100),
      avg7d: ratio7d((d) => d.typeform.submits, (d) => d.ads.uniqueLinkClicks, 100),
      trend7d: trend,
    })
  }

  // ─── Appointment Setting box ─────────────────────────────────────
  {
    // FMR = leads created on day X who ever responded (SMS OR first
    // dial answered >= 90s). Drake's unified definition.
    const trend = days.map((d) => fmrDaily.get(d) ?? 0)
    map.set('fmr', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }
  {
    const trend = series((d) => d.calls.totalOver90s)
    map.set('triages', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }
  {
    const trend = series((d) => d.calls.totalDials)
    map.set('dials', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }
  {
    const trend = series((d) => d.calls.dqs)
    map.set('dqs', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }
  {
    const trend = series((d) => d.calls.downsells)
    map.set('downsells', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }
  {
    const trend = series((d) => d.calls.bookings)
    map.set('booked', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }

  // ─── Closing box ──────────────────────────────────────────────────
  {
    const trend = series((d) => d.closing.showed)
    map.set('showed', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }
  {
    const trend = series((d) => d.closing.closed)
    map.set('closed', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }
  {
    const trend = series((d) => d.closing.upfrontCollected)
    map.set('cash-collected', { yesterday: last(trend), avg7d: mean(trend), trend7d: trend })
  }

  return map
}

// ---------------------------------------------------------------------
// Per-day aggregation
// ---------------------------------------------------------------------

type DayAgg = {
  day: string
  ads: {
    impressions: number | null
    adspend: number | null
    uniqueLinkClicks: number | null
  }
  typeform: { submits: number | null; qualified: number | null }
  calendly: { total: number | null }
  calls: {
    totalDials: number | null
    totalOver90s: number | null
    bookings: number | null
    dqs: number | null
    downsells: number | null
  }
  closing: {
    showed: number | null
    closed: number | null
    upfrontCollected: number | null
  }
}

async function fetchDay(day: string): Promise<DayAgg> {
  const range = dateRangeFromExplicit(day, day)

  // Ads needs its own AdsRange shape — but for a single-day query
  // the clamp produces (day, day) as-is when day <= yesterday.
  // dateRangeFromExplicit doesn't return an AdsRange directly; call
  // getAdsAggregateLive with a synthesized AdsRange-equivalent.
  const adsRange = { startEtDate: day, endEtDate: day, isEmptyRange: false }

  const [ads, typeform, calls, closing, calendly] = await Promise.all([
    getAdsAggregateLive(adsRange),
    // Clarity dropped 2026-05-27 — LP visits sources from ads.unique-clicks.
    getTypeformMetrics(range),
    getCallActivityMetrics(range),
    getClosingActivity(range),
    getCloserBookings(range),
  ])

  const adsImp = pickAgg(ads, 'impressions')
  const adsSpend = pickAgg(ads, 'adspend')
  const adsUlc = pickAgg(ads, 'unique-clicks')

  // Combined setters + closers totals (mirrors getFunnelActivity).
  // Same mapping as funnel-stages.ts after the 2026-05-27 form split:
  //   bookings  = setter HT bookings only (closer confirmedBooks is a
  //               close, not a booking)
  //   downsells = setter DC bookings + closer downsells-on-call
  const settersAgg = calls.settersAggregate
  const closersAgg = calls.closersAggregate
  const totalDials = settersAgg.totalCalls + closersAgg.totalCalls
  const totalOver90s = settersAgg.totalOver90s + closersAgg.totalOver90s
  const totalBookings = settersAgg.htBookings
  const totalDqs = settersAgg.dqs + closersAgg.dqs
  const totalDownsells = settersAgg.dcBookings + closersAgg.downsellsOnCall

  return {
    day,
    ads: { impressions: adsImp, adspend: adsSpend, uniqueLinkClicks: adsUlc },
    typeform: { submits: typeform.submits ?? null, qualified: typeform.qualified ?? null },
    calendly: { total: calendly.total ?? null },
    calls: {
      totalDials,
      totalOver90s,
      bookings: totalBookings,
      dqs: totalDqs,
      downsells: totalDownsells,
    },
    closing: {
      showed: closing.aggregate.showed,
      closed: closing.aggregate.closed,
      upfrontCollected: closing.money.upfrontCollected,
    },
  }
}

// Pull a value out of an AdsAggMetric[] — `id` matches the field set
// in funnel-ads.ts. unique-link-clicks isn't returned by the aggregate
// directly, so we don't try to find it here.
function pickAgg(
  ads: Array<{ id: string; value: number | string | null | undefined }>,
  id: string,
): number | null {
  const m = ads.find((x) => x.id === id)
  if (!m) return null
  const v = m.value
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return null
}

// ---------------------------------------------------------------------
// FMR daily series — leads created on day X who ever responded.
// ---------------------------------------------------------------------
//
// "Responded" mirrors the unified definition from funnel-appointment-
// setting.ts: any inbound SMS at any time OR first outbound dial
// answered (>= 90s) at any time.

const FMR_DIAL_CONNECTED_SEC = 90

async function fetchFmrDaily(days: string[]): Promise<Map<string, number>> {
  const sb = createAdminClient()
  if (days.length === 0) return new Map()

  const windowStart = `${days[0]}T00:00:00-04:00`
  const windowEnd = `${days[days.length - 1]}T23:59:59-04:00`
  // Window covers the lead-creation range. Inbound SMS + first dials
  // pulled WITHOUT a date filter on themselves (lead created on day X
  // can be responded to later) — bounded by the lead universe instead.

  // Cohort leads in window.
  const leads: Array<{ close_id: string; date_created: string }> = []
  {
    let from = 0
    for (;;) {
      const { data, error } = await sb
        .from('close_leads' as never)
        .select('close_id, date_created')
        .gte('date_created', windowStart)
        .lte('date_created', windowEnd)
        .order('date_created', { ascending: true })
        .range(from, from + 999)
      if (error) throw new Error(`pulse-history: close_leads read failed: ${error.message}`)
      const rows = (data ?? []) as unknown as Array<{ close_id: string; date_created: string }>
      if (rows.length === 0) break
      leads.push(...rows)
      if (rows.length < 1000) break
      from += 1000
    }
  }
  if (leads.length === 0) return new Map(days.map((d) => [d, 0]))

  const leadIds = leads.map((l) => l.close_id)
  const idSet = new Set(leadIds)

  // Inbound SMS for cohort — flat any-time presence check.
  const everInbound = new Set<string>()
  {
    let from = 0
    for (;;) {
      const { data, error } = await sb
        .from('close_sms' as never)
        .select('lead_id')
        .eq('direction', 'inbound')
        .in('lead_id' as never, leadIds)
        .range(from, from + 999)
      if (error) throw new Error(`pulse-history: close_sms read failed: ${error.message}`)
      const rows = (data ?? []) as unknown as Array<{ lead_id: string | null }>
      if (rows.length === 0) break
      for (const r of rows) if (r.lead_id) everInbound.add(r.lead_id)
      if (rows.length < 1000) break
      from += 1000
    }
  }

  // First outbound dial per cohort lead — earliest activity_at, with
  // its duration. The .order is ascending so the first row per
  // lead_id IS the first dial. Track which leads have a connected
  // first dial (duration >= 90).
  const firstDialAnswered = new Set<string>()
  const firstDialSeen = new Set<string>()
  {
    let from = 0
    for (;;) {
      const { data, error } = await sb
        .from('close_calls' as never)
        .select('lead_id, duration, activity_at')
        .eq('direction', 'outbound')
        .in('lead_id' as never, leadIds)
        .order('activity_at', { ascending: true })
        .range(from, from + 999)
      if (error) throw new Error(`pulse-history: close_calls read failed: ${error.message}`)
      const rows = (data ?? []) as unknown as Array<{
        lead_id: string | null
        duration: number | null
        activity_at: string
      }>
      if (rows.length === 0) break
      for (const r of rows) {
        if (!r.lead_id || !idSet.has(r.lead_id)) continue
        if (firstDialSeen.has(r.lead_id)) continue
        firstDialSeen.add(r.lead_id)
        if ((r.duration ?? 0) >= FMR_DIAL_CONNECTED_SEC) {
          firstDialAnswered.add(r.lead_id)
        }
      }
      if (rows.length < 1000) break
      from += 1000
    }
  }

  // Bucket lead.date_created by ET-calendar-day; count those who
  // qualify as responded.
  const counts = new Map<string, number>(days.map((d) => [d, 0]))
  for (const lead of leads) {
    const day = etCalendarDay(lead.date_created)
    if (!counts.has(day)) continue
    const responded =
      everInbound.has(lead.close_id) || firstDialAnswered.has(lead.close_id)
    if (responded) counts.set(day, (counts.get(day) ?? 0) + 1)
  }
  return counts
}

// ---------------------------------------------------------------------
// Date helpers — ET-aware
// ---------------------------------------------------------------------

function subtractDayEt(et: string, days: number): string {
  // ET date math: parse YYYY-MM-DD, treat as UTC midnight, subtract,
  // re-format. Safe because we never cross a DST boundary within the
  // arithmetic (we're just shifting calendar days).
  const [y, m, d] = et.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() - days)
  return dt.toISOString().slice(0, 10)
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b
}

function enumerateDaysInclusive(startEt: string, endEt: string): string[] {
  if (startEt > endEt) return []
  const out: string[] = []
  let cur = startEt
  // Hard cap to prevent any unexpected runaway loop.
  for (let i = 0; i < 60 && cur <= endEt; i++) {
    out.push(cur)
    cur = subtractDayEt(cur, -1)
  }
  return out
}

function etCalendarDay(iso: string): string {
  // Format an instant in America/New_York as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(iso))
}
