import 'server-only'

import { dateRangeFromExplicit, todayEtDate } from './funnel-window'
import { getSpeedToLeadCohort } from './funnel-appointment-setting'
import { getLeadsForRange, type LeadRow } from './leads'
import { getLeadsFunnel } from './leads-funnel'
import { getFunnelCash } from './funnel-cash'

// Marketing page — the "last N days" daily table (Drake 2026-06-18).
//
// A COHORT-based per-day funnel, deliberately distinct from the stacked
// Funnel above it:
//   - The Funnel answers any window via the date picker; this table is
//     pinned to a rolling last-N ET-calendar-day strip, INDEPENDENT of the
//     picker.
//   - Each row is the cohort that OPTED IN that day, and how far that day's
//     leads have since progressed (Leads → Connects → Booked → Showed →
//     Closed). Cohort-keyed (not activity-keyed) so every downstream count is
//     a clean subset of that day's Leads — "4 came in, ≤4 showed", never the
//     confusing "4 in / 6 showed" you'd get counting raw daily activity.
//
// Reuse over reinvention: each day calls the SAME getLeadsFunnel / getFunnelCash
// path the Funnel uses (single-day window), so the per-day numbers can't drift
// from the box above. The 5 days run concurrently. If this gets slow, promote to
// a GROUP-BY-day SQL function (the sales_funnel_counts pattern); JS is fine at 5
// small single-day windows.

export type DailyFunnelRow = {
  etDate: string // YYYY-MM-DD (ET)
  spendUsd: number | null
  leads: number
  connected: number
  booked: number
  showed: number
  closed: number
  cashUsd: number
  speedToLeadSec: number | null
  dials: number
}

export type DailyFunnelFilter = {
  adId?: string | null
  campaignId?: string | null
  adsetId?: string | null
}

const DAILY_TABLE_DAYS = 5

// Rolling last-N ET calendar dates, newest first. Pure date arithmetic on the
// Y/M/D parts (anchored at UTC midnight, whole-day steps) is exact for
// enumerating calendar-date strings — no instant/offset math needed.
function lastNEtDates(endEtDate: string, n: number): string[] {
  const [y, m, d] = endEtDate.split('-').map((v) => parseInt(v, 10))
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const dt = new Date(Date.UTC(y, m - 1, d))
    dt.setUTCDate(dt.getUTCDate() - i)
    out.push(dt.toISOString().slice(0, 10))
  }
  return out
}

// Deepest active selection wins (ad > ad set > campaign) — mirrors the Funnel
// page's own narrowing so the table scopes to exactly the same entity.
function filterRows(rows: LeadRow[], f: DailyFunnelFilter): LeadRow[] {
  if (f.adId) return rows.filter((r) => r.adId === f.adId)
  if (f.adsetId) return rows.filter((r) => r.adsetId === f.adsetId)
  if (f.campaignId) return rows.filter((r) => r.campaignId === f.campaignId)
  return rows
}

function funnelFilterOpts(f: DailyFunnelFilter) {
  if (f.adId) return { adId: f.adId }
  if (f.adsetId) return { adsetId: f.adsetId }
  if (f.campaignId) return { campaignId: f.campaignId }
  return {}
}

async function computeDay(etDate: string, filter: DailyFunnelFilter, filterActive: boolean, lpFormId: string | null): Promise<DailyFunnelRow> {
  const range = dateRangeFromExplicit(etDate, etDate)
  // Cohort + roster for this single day (cohort feeds Sp2L; rows feed cash and
  // the ad filter). Same spine the Funnel uses, so the leads can't drift.
  // lpFormId scopes the cohort to the selected landing page (null = all LPs).
  const cohort = await getSpeedToLeadCohort(range, null, lpFormId)
  const allRows = await getLeadsForRange(range, cohort)
  const rows = filterRows(allRows, filter)

  const funnel = await getLeadsFunnel(rows, range, funnelFilterOpts(filter))
  const cash = await getFunnelCash(range, rows, funnel.adspendUsd, { excludeDc: filterActive })

  // Sp2L = mean business-hours speed-to-lead over this day's CALLED leads,
  // scoped to the ad filter via the row set. speedSec is already
  // business-hours-clamped + 24h-capped, so the mean matches the cohort
  // aggregate when no filter is active.
  const rowIds = new Set(rows.map((r) => r.leadId))
  const speeds = cohort.rows
    .filter((c) => rowIds.has(c.leadId) && c.speedSec != null)
    .map((c) => c.speedSec as number)
  const speedToLeadSec = speeds.length ? speeds.reduce((a, b) => a + b, 0) / speeds.length : null

  const t = funnel.total
  return {
    etDate,
    spendUsd: funnel.adspendUsd,
    leads: t.optIns,
    connected: t.connected,
    booked: t.books,
    showed: t.shows,
    closed: t.closes,
    cashUsd: cash.total.upfrontTotalUsd,
    speedToLeadSec,
    dials: t.dials,
  }
}

// The last-N-days daily cohort funnel, newest first. `filter` carries the
// Marketing page's active ad-cascade selection so the strip scopes to the same
// entity as the funnel above (no selection → whole cohort).
export async function getDailyFunnelTable(
  filter: DailyFunnelFilter = {},
  lpFormId: string | null = null,
): Promise<DailyFunnelRow[]> {
  const days = lastNEtDates(todayEtDate(), DAILY_TABLE_DAYS)
  const filterActive = !!(filter.adId || filter.adsetId || filter.campaignId)
  return Promise.all(days.map((d) => computeDay(d, filter, filterActive, lpFormId)))
}
