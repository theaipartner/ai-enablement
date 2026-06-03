import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { LeadCycleRow } from './lead-tags'

// Funnel · Digital College sales tally (Drake 2026-06-03).
//
// Counts Digital College (low-ticket) SALES for the funnel screen, broken down
// two ways: by sale type (Base44 / Wix × Monthly / Yearly), by which funnel the
// lead came through (direct / setter / reactivation), AND by the sale's ORIGIN
// (where they became a DC lead).
//
// Sources — a DC sale lands on EITHER form (deduped to one row per lead):
//   - airtable_full_closer_report (form_type='New', call_outcome='Digital
//     College Closed') — the CURRENT path. Plans in `dc_plans`; `closer_names`
//     tells Robby's DC closes apart from a non-Robby HT-meeting downsell.
//   - airtable_digital_college_sales (closed='Yes') — the RETIRED dedicated DC
//     form (Robby's). Plans in `plans`.
// Plan flags are OR-ed across both forms per lead.
//
// Origin (precedence, per lead): a confirmation/triage `call_status` of
// 'Digital College booking' = a confirmed DC booking; 'Downsold' = downsold off
// a confirmation; an EOC 'Digital College Closed' by a non-Robby closer = a DC
// close from a high-ticket meeting; otherwise (Robby's close / dedicated form,
// no upstream DC-entry signal) = Robby direct.

export type DcPath = 'direct' | 'setter' | 'reactivation'
export type DcOrigin = 'confirmed_booking' | 'downsell' | 'ht_meeting' | 'robby_direct'

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
  // By which funnel the lead came through (mutually exclusive).
  byPath: { direct: DcPlanCounts; setter: DcPlanCounts; reactivation: DcPlanCounts }
  // By where the DC sale originated (mutually exclusive).
  byOrigin: Record<DcOrigin, DcPlanCounts>
  // All DC sales (= the sum of either breakdown).
  total: DcPlanCounts
}

type Flags = { base44Monthly: boolean; base44Yearly: boolean; wixMonthly: boolean; wixYearly: boolean }

// Per-lead signals gathered from the forms, used to derive plan flags + origin.
type SaleInfo = {
  flags: Flags
  hasDcBooking: boolean      // confirmation/triage call_status 'Digital College booking'
  hasDownsell: boolean       // confirmation call_status 'Downsold'
  hasNonRobbyEocClose: boolean // EOC 'Digital College Closed' by a non-Robby closer
}

function emptyCounts(): DcPlanCounts {
  return { base44Monthly: 0, base44Yearly: 0, wixMonthly: 0, wixYearly: 0, sales: 0 }
}

// Token-tolerant plan parse — Base44 if the label mentions "base", Wix if
// "wix"; monthly/yearly by "month" / "year"|"annual" (labels seen: "Base
// Monthly", "Base Yearly", "Wix Monthly", "Wix Yearly"). OR-s into the flags.
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

function isRobby(closerNames: string[] | null): boolean {
  return (closerNames ?? []).some((n) => (n ?? '').toLowerCase().includes('robby'))
}

// Per-lead sale info (plan flags + origin signals) for the DC-sale leads.
async function loadDcSaleInfo(leadIds: string[]): Promise<Map<string, SaleInfo>> {
  const out = new Map<string, SaleInfo>()
  if (leadIds.length === 0) return out
  const infoFor = (id: string): SaleInfo => {
    let s = out.get(id)
    if (!s) {
      s = {
        flags: { base44Monthly: false, base44Yearly: false, wixMonthly: false, wixYearly: false },
        hasDcBooking: false,
        hasDownsell: false,
        hasNonRobbyEocClose: false,
      }
      out.set(id, s)
    }
    return s
  }
  const sb = createAdminClient()
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const [eoc, dc, tri] = await Promise.all([
      sb
        .from('airtable_full_closer_report' as never)
        .select('lead_id, call_outcome, closer_names, dc_plans')
        .eq('form_type', 'New')
        .in('lead_id', chunk),
      sb
        .from('airtable_digital_college_sales' as never)
        .select('lead_id, closed, plans')
        .is('excluded_at', null)
        .in('lead_id', chunk),
      sb
        .from('airtable_setter_triage_calls' as never)
        .select('lead_id, call_status')
        .is('excluded_at', null)
        .in('lead_id', chunk),
    ])
    if (eoc.error) throw new Error(`dc-sales: closer report read failed: ${eoc.error.message}`)
    if (dc.error) throw new Error(`dc-sales: digital college sales read failed: ${dc.error.message}`)
    if (tri.error) throw new Error(`dc-sales: triage/confirmation read failed: ${tri.error.message}`)

    for (const r of (eoc.data ?? []) as unknown as Array<{ lead_id: string | null; call_outcome: string | null; closer_names: string[] | null; dc_plans: string[] | null }>) {
      if (!r.lead_id) continue
      if (!(r.call_outcome ?? '').toLowerCase().includes('digital college closed')) continue
      const s = infoFor(r.lead_id)
      mergePlanFlags(s.flags, r.dc_plans)
      if (!isRobby(r.closer_names)) s.hasNonRobbyEocClose = true
    }
    for (const r of (dc.data ?? []) as unknown as Array<{ lead_id: string | null; closed: string | null; plans: string[] | null }>) {
      if (!r.lead_id) continue
      if ((r.closed ?? '').trim().toLowerCase() !== 'yes') continue
      mergePlanFlags(infoFor(r.lead_id).flags, r.plans)
    }
    for (const r of (tri.data ?? []) as unknown as Array<{ lead_id: string | null; call_status: string | null }>) {
      if (!r.lead_id) continue
      const cs = (r.call_status ?? '').toLowerCase()
      if (cs.includes('digital college')) infoFor(r.lead_id).hasDcBooking = true
      if (cs.includes('downsold')) infoFor(r.lead_id).hasDownsell = true
    }
  }
  return out
}

// Mutually-exclusive funnel path for a DC sale: reactivation > direct > setter.
function dcPath(c: LeadCycleRow): DcPath {
  if (c.reactivatedAt) return 'reactivation'
  if (c.becameDirect) return 'direct'
  return 'setter'
}

// Mutually-exclusive origin from the per-lead signals (see header for the rule).
function dcOrigin(info: SaleInfo | undefined): DcOrigin {
  if (info?.hasDcBooking) return 'confirmed_booking'
  if (info?.hasDownsell) return 'downsell'
  if (info?.hasNonRobbyEocClose) return 'ht_meeting'
  return 'robby_direct'
}

// DC-sales tally over the funnel's cohort cycles. Deduped to one row per lead
// (the lead's latest in-window DC-closed cycle decides its funnel path).
export async function getDcSalesTally(cycles: LeadCycleRow[]): Promise<DcSalesTally> {
  const pathByLead = new Map<string, { path: DcPath; optInAt: string }>()
  for (const c of cycles) {
    if (!c.dcClosed) continue
    const prev = pathByLead.get(c.closeId)
    if (!prev || c.optInAt > prev.optInAt) pathByLead.set(c.closeId, { path: dcPath(c), optInAt: c.optInAt })
  }

  const tally: DcSalesTally = {
    byPath: { direct: emptyCounts(), setter: emptyCounts(), reactivation: emptyCounts() },
    byOrigin: {
      confirmed_booking: emptyCounts(),
      downsell: emptyCounts(),
      ht_meeting: emptyCounts(),
      robby_direct: emptyCounts(),
    },
    total: emptyCounts(),
  }
  const leadIds = Array.from(pathByLead.keys())
  if (leadIds.length === 0) return tally

  const infoByLead = await loadDcSaleInfo(leadIds)
  const add = (b: DcPlanCounts, f: Flags | undefined) => {
    b.sales += 1
    if (f?.base44Monthly) b.base44Monthly += 1
    if (f?.base44Yearly) b.base44Yearly += 1
    if (f?.wixMonthly) b.wixMonthly += 1
    if (f?.wixYearly) b.wixYearly += 1
  }
  pathByLead.forEach(({ path }, leadId) => {
    const info = infoByLead.get(leadId)
    add(tally.byPath[path], info?.flags)
    add(tally.byOrigin[dcOrigin(info)], info?.flags)
    add(tally.total, info?.flags)
  })
  return tally
}
