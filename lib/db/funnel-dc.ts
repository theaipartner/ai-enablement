import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'
import { fetchChunked } from './query-parallel'

// Digital College funnel — tag-driven, unique leads only. Reads the DC fields
// written by the tagger (shared/lead_tagging.py) onto lead_cycles. lead_cycles
// IS the unique leads list, so a window query needs no extra cohort scoping.
//
// Closer-identity routed (Drake 2026-06-05):
//   - Main DC funnel = the DC closer (Robby/Adam): booked → showed → closed,
//     where SHOWED = a DC-closer form is present and CLOSED = a real plan was
//     selected (dc_close_origin = 'dc_closer').
//   - Downsell line = the HT closer (Aman) dipping into DC: dc_close_origin
//     'downsell_ht_meeting' / 'downsell_confirmation'. Shown separately, never
//     in the main DC funnel.
//   - Plan breakdown (Base44 / Wix × Monthly / Yearly) comes from the closer
//     report's "What plan did we get them on?" (dc_plans) for the closed leads.

export type DcPlanCounts = {
  base44Monthly: number
  base44Yearly: number
  wixMonthly: number
  wixYearly: number
}

export type DcFunnel = {
  booked: number
  showed: number
  closed: number // dc_closer closes (the main funnel)
  closedPlans: DcPlanCounts
  downsellHtMeeting: number
  downsellConfirmation: number
  downsellPlans: DcPlanCounts // plans on HT-meeting downsell closes
}

export function emptyPlans(): DcPlanCounts {
  return { base44Monthly: 0, base44Yearly: 0, wixMonthly: 0, wixYearly: 0 }
}

// Tolerant plan parse (mirrors funnel-digital-college.ts): Base44 if "base",
// Wix if "wix"; monthly/yearly by "month" / "year"|"annual".
export function addPlan(counts: DcPlanCounts, plans: string[] | null) {
  for (const raw of plans ?? []) {
    const p = (raw ?? '').toLowerCase()
    const isBase = p.includes('base')
    const isWix = p.includes('wix')
    const monthly = p.includes('month')
    const yearly = p.includes('year') || p.includes('annual')
    if (isBase && monthly) counts.base44Monthly += 1
    if (isBase && yearly) counts.base44Yearly += 1
    if (isWix && monthly) counts.wixMonthly += 1
    if (isWix && yearly) counts.wixYearly += 1
  }
}

// DC (low-ticket) closer name tokens. MUST stay in sync with
// shared/lead_tagging.py DC_CLOSER_NAMES. Robby is inactive but kept so his
// historical DC forms route correctly; Bradley + Josh added 2026-06-15.
const DC_CLOSER_TOKENS = ['robby', 'bradley', 'josh']

export async function getDcFunnel(range: DateRange): Promise<DcFunnel> {
  const sb = createAdminClient()

  // 1. DC stage flags from the tags (lead_cycles = unique leads), in window.
  const { data: cycles, error } = await sb
    .from('lead_cycles' as never)
    .select('close_id, dc_booked_at, dc_showed_at, dc_closed_at, dc_close_origin')
    .gte('opt_in_at', range.startUtcIso)
    .lt('opt_in_at', range.endUtcIso)
  if (error) throw new Error(`lead_cycles DC read failed: ${error.message}`)
  const rows = (cycles ?? []) as unknown as Array<{
    close_id: string
    dc_booked_at: string | null
    dc_showed_at: string | null
    dc_closed_at: string | null
    dc_close_origin: string | null
  }>

  // Per distinct lead (a re-opt lead can have >1 cycle — count the lead once).
  const booked = new Set<string>()
  const showed = new Set<string>()
  const closedCloser = new Set<string>()
  const downsellMeeting = new Set<string>()
  const downsellConfirm = new Set<string>()
  for (const r of rows) {
    if (r.dc_booked_at) booked.add(r.close_id)
    if (r.dc_showed_at) showed.add(r.close_id)
    if (r.dc_closed_at && r.dc_close_origin === 'dc_closer') closedCloser.add(r.close_id)
    if (r.dc_close_origin === 'downsell_ht_meeting') downsellMeeting.add(r.close_id)
    if (r.dc_close_origin === 'downsell_confirmation') downsellConfirm.add(r.close_id)
  }

  const closedPlans = emptyPlans()
  const downsellPlans = emptyPlans()

  // 2. Plan breakdown for the closed leads — dc_plans on the closer report,
  // routed by closer (Robby → main; HT closer → downsell). Scoped to the
  // closed cohort leads only.
  const planLeadIds = Array.from(new Set(Array.from(closedCloser).concat(Array.from(downsellMeeting))))
  if (planLeadIds.length > 0) {
    // Chunks fetched concurrently; plan counts accumulate per row, so order
    // doesn't matter (lead_id is also partitioned across chunks).
    const rows = await fetchChunked<{
      lead_id: string | null
      dc_plans: string[] | null
      closer_names: string[] | null
    }>(
      planLeadIds,
      (chunk) => sb
        .from('airtable_full_closer_report' as never)
        .select('lead_id, dc_plans, closer_names')
        .in('lead_id', chunk)
        .not('dc_plans', 'is', null) as never,
      'closer dc_plans read failed',
      100,
    )
    for (const f of rows) {
      if (!f.lead_id) continue
      const isCloser = (f.closer_names ?? []).some((n) => {
        const ln = (n ?? '').toLowerCase()
        return DC_CLOSER_TOKENS.some((t) => ln.includes(t))
      })
      if (isCloser && closedCloser.has(f.lead_id)) addPlan(closedPlans, f.dc_plans)
      else if (!isCloser && downsellMeeting.has(f.lead_id)) addPlan(downsellPlans, f.dc_plans)
    }
  }

  return {
    booked: booked.size,
    showed: showed.size,
    closed: closedCloser.size,
    closedPlans,
    downsellHtMeeting: downsellMeeting.size,
    downsellConfirmation: downsellConfirm.size,
    downsellPlans,
  }
}

// Every Digital College program (Base44 / Wix × Monthly / Yearly) is a flat
// $300, so DC cash = $300 per plan unit sold (Drake 2026-06-05).
export const DC_PLAN_PRICE_USD = 300

export function dcPlanUnits(p: DcPlanCounts): number {
  return p.base44Monthly + p.base44Yearly + p.wixMonthly + p.wixYearly
}

