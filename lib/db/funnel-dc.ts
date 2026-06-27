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

// DC is modeled as Connects → Closed (Drake 2026-06-24): a "conversation" is any
// DC engagement, a "close" is a DC plan sold. Booked/Showed are no longer
// surfaced; downsell closes are merged into the close cohort.
export type DcFunnel = {
  connects: number // distinct leads with a DC conversation (lead_cycles.digital_college_at)
  closed: number // distinct leads with a DC close (dc_closed_at — ANY origin, downsells merged)
  closedPlans: DcPlanCounts // plan breakdown across all closed leads
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

export async function getDcFunnel(range: DateRange, formId?: string | null): Promise<DcFunnel> {
  const sb = createAdminClient()

  // DC stage flags from the tags (lead_cycles = unique leads), in window.
  // Connects (a DC conversation) = digital_college_at is set; Closed = a DC plan
  // was sold (dc_closed_at, ANY origin — downsell closes merged in, Drake
  // 2026-06-24). Booked/Showed are no longer surfaced (the columns remain).
  // formId scopes to the selected landing page (lead_cycles.source_form_id);
  // null = all landing pages.
  let q = sb
    .from('lead_cycles' as never)
    .select('close_id, digital_college_at, dc_closed_at')
    .gte('opt_in_at', range.startUtcIso)
    .lt('opt_in_at', range.endUtcIso)
  if (formId) q = q.eq('source_form_id', formId)
  const { data: cycles, error } = await q
  if (error) throw new Error(`lead_cycles DC read failed: ${error.message}`)
  const rows = (cycles ?? []) as unknown as Array<{
    close_id: string
    digital_college_at: string | null
    dc_closed_at: string | null
  }>

  // Per distinct lead (a re-opt lead can have >1 cycle — count the lead once).
  const connects = new Set<string>()
  const closed = new Set<string>()
  for (const r of rows) {
    if (r.digital_college_at) connects.add(r.close_id)
    if (r.dc_closed_at) closed.add(r.close_id)
  }

  // Plan breakdown for the closed leads — dc_plans on the closer report (any
  // closer; downsell closes are part of the same cohort now). Scoped to the
  // closed leads only.
  const closedPlans = emptyPlans()
  const closedIds = Array.from(closed)
  if (closedIds.length > 0) {
    const planRows = await fetchChunked<{ lead_id: string | null; dc_plans: string[] | null }>(
      closedIds,
      (chunk) => sb
        .from('airtable_full_closer_report' as never)
        .select('lead_id, dc_plans')
        .in('lead_id', chunk)
        .not('dc_plans', 'is', null) as never,
      'closer dc_plans read failed',
      100,
    )
    for (const f of planRows) {
      if (f.lead_id && closed.has(f.lead_id)) addPlan(closedPlans, f.dc_plans)
    }
  }

  return { connects: connects.size, closed: closed.size, closedPlans }
}

// Every Digital College program (Base44 / Wix × Monthly / Yearly) is a flat
// $300, so DC cash = $300 per plan unit sold (Drake 2026-06-05).
export const DC_PLAN_PRICE_USD = 300

export function dcPlanUnits(p: DcPlanCounts): number {
  return p.base44Monthly + p.base44Yearly + p.wixMonthly + p.wixYearly
}

