import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { LeadCycleRow } from './lead-tags'

// Funnel · Digital College sales tally (Drake 2026-06-03).
//
// Counts Digital College (low-ticket) SALES for the funnel screen, broken down
// by sale type (Base44 / Wix × Monthly / Yearly) and by which funnel the sale
// came from (direct / setter / reactivation). The funnel's per-box `dcCloses`
// already shows the count; this adds the plan-type composition under it.
//
// Sources — a DC sale lands on EITHER form (deduped to one row per lead):
//   - airtable_full_closer_report (form_type='New', call_outcome='Digital
//     College Closed') — the CURRENT path (Aman's downsell + Robby's closes
//     since 2026-06-02 file the regular closer EOC). Plans in `dc_plans`.
//   - airtable_digital_college_sales (closed='Yes') — the RETIRED dedicated DC
//     form. Plans in `plans`.
// Plan flags are OR-ed across both forms per lead.

export type DcPath = 'direct' | 'setter' | 'reactivation'

export type DcPlanCounts = {
  base44Monthly: number
  base44Yearly: number
  wixMonthly: number
  wixYearly: number
  // Distinct DC-sale leads in this bucket. A sale can carry more than one plan
  // (e.g. Base44 + Wix), so the plan fields can sum to more than `sales`.
  sales: number
}

export type DcSalesTally = {
  direct: DcPlanCounts
  setter: DcPlanCounts
  reactivation: DcPlanCounts
  // direct + setter + reactivation (the paths are mutually exclusive here).
  total: DcPlanCounts
}

type Flags = { base44Monthly: boolean; base44Yearly: boolean; wixMonthly: boolean; wixYearly: boolean }

function emptyCounts(): DcPlanCounts {
  return { base44Monthly: 0, base44Yearly: 0, wixMonthly: 0, wixYearly: 0, sales: 0 }
}

// Token-tolerant plan parse — Base44 if the label mentions "base", Wix if
// "wix"; monthly/yearly by "month" / "year"|"annual" (labels seen: "Base
// Monthly", "Base Yearly", "Wix Monthly", "Wix Yearly"). Mirrors
// funnel-digital-college.ts planFlags. OR-s into the lead's running flags.
function mergePlanFlags(into: Flags, plans: string[] | null): void {
  for (const raw of plans ?? []) {
    const p = (raw ?? '').toLowerCase()
    const isBase = p.includes('base')
    const isWix = p.includes('wix')
    const monthly = p.includes('month')
    const yearly = p.includes('year') || p.includes('annual')
    if (isBase && monthly) into.base44Monthly = true
    if (isBase && yearly) into.base44Yearly = true
    if (isWix && monthly) into.wixMonthly = true
    if (isWix && yearly) into.wixYearly = true
  }
}

// Plan flags per DC-sale lead, OR-ed across BOTH forms. Keyed by lead_id.
async function loadDcPlanFlags(leadIds: string[]): Promise<Map<string, Flags>> {
  const out = new Map<string, Flags>()
  if (leadIds.length === 0) return out
  const flagsFor = (id: string): Flags => {
    let f = out.get(id)
    if (!f) {
      f = { base44Monthly: false, base44Yearly: false, wixMonthly: false, wixYearly: false }
      out.set(id, f)
    }
    return f
  }
  const sb = createAdminClient()
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const [eoc, dc] = await Promise.all([
      sb
        .from('airtable_full_closer_report' as never)
        .select('lead_id, call_outcome, dc_plans')
        .eq('form_type', 'New')
        .in('lead_id', chunk),
      sb
        .from('airtable_digital_college_sales' as never)
        .select('lead_id, closed, plans')
        .is('excluded_at', null)
        .in('lead_id', chunk),
    ])
    if (eoc.error) throw new Error(`dc-sales: closer report read failed: ${eoc.error.message}`)
    if (dc.error) throw new Error(`dc-sales: digital college sales read failed: ${dc.error.message}`)
    for (const r of (eoc.data ?? []) as unknown as Array<{ lead_id: string | null; call_outcome: string | null; dc_plans: string[] | null }>) {
      if (!r.lead_id) continue
      if (!(r.call_outcome ?? '').toLowerCase().includes('digital college closed')) continue
      mergePlanFlags(flagsFor(r.lead_id), r.dc_plans)
    }
    for (const r of (dc.data ?? []) as unknown as Array<{ lead_id: string | null; closed: string | null; plans: string[] | null }>) {
      if (!r.lead_id) continue
      if ((r.closed ?? '').trim().toLowerCase() !== 'yes') continue
      mergePlanFlags(flagsFor(r.lead_id), r.plans)
    }
  }
  return out
}

// Mutually-exclusive path for a DC sale: reactivation > direct > setter. The
// funnel boxes overlap (reactivation ⊂ direct), but a SALE came from one path,
// so the tally partitions cleanly.
function dcPath(c: LeadCycleRow): DcPath {
  if (c.reactivatedAt) return 'reactivation'
  if (c.becameDirect) return 'direct'
  return 'setter'
}

// DC-sales tally over the funnel's cohort cycles: Base44/Wix × Monthly/Yearly
// counts bucketed by funnel path. Deduped to one row per lead (the lead's
// latest in-window DC-closed cycle decides its path).
export async function getDcSalesTally(cycles: LeadCycleRow[]): Promise<DcSalesTally> {
  const pathByLead = new Map<string, { path: DcPath; optInAt: string }>()
  for (const c of cycles) {
    if (!c.dcClosed) continue
    const prev = pathByLead.get(c.closeId)
    if (!prev || c.optInAt > prev.optInAt) pathByLead.set(c.closeId, { path: dcPath(c), optInAt: c.optInAt })
  }

  const tally: DcSalesTally = {
    direct: emptyCounts(),
    setter: emptyCounts(),
    reactivation: emptyCounts(),
    total: emptyCounts(),
  }
  const leadIds = Array.from(pathByLead.keys())
  if (leadIds.length === 0) return tally

  const flagsByLead = await loadDcPlanFlags(leadIds)
  const add = (b: DcPlanCounts, f: Flags | undefined) => {
    b.sales += 1
    if (f?.base44Monthly) b.base44Monthly += 1
    if (f?.base44Yearly) b.base44Yearly += 1
    if (f?.wixMonthly) b.wixMonthly += 1
    if (f?.wixYearly) b.wixYearly += 1
  }
  pathByLead.forEach(({ path }, leadId) => {
    const f = flagsByLead.get(leadId)
    add(tally[path], f)
    add(tally.total, f)
  })
  return tally
}
