import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { LeadCycleRow } from './lead-tags'

// Funnel · Digital College sales tally (Drake 2026-06-03).
//
// Counts Digital College (low-ticket) SALES for the funnel screen, broken down
// two ways: by which funnel the lead came through (direct / setter /
// reactivation) and by the sale's ORIGIN (triage / confirmation / downsell /
// Robby direct). Each bucket shows the sale-type composition (Base44 / Wix ×
// Monthly / Yearly).
//
// ONLY PLAN-BACKED SALES COUNT (Drake 2026-06-03). A real DC close has a
// recorded plan; the tagger over-counts because it marks dc_closed from a bare
// EOC `call_outcome = 'Digital College Closed'` even when no plan was logged and
// the dedicated form says follow-up/DQ. So a DC-closed lead is only counted here
// when at least one plan parses (Base44/Wix × Mo/Yr). The excluded (plan-less)
// count is surfaced so the drop is visible, not silent.
//
// Sources — a DC sale lands on EITHER form (deduped to one row per lead):
//   - airtable_full_closer_report (form_type='New', call_outcome='Digital
//     College Closed') — plans in `dc_plans`; `closer_names` distinguishes
//     Robby's close from a non-Robby (Aman) HT-meeting downsell.
//   - airtable_digital_college_sales (closed='Yes') — the retired dedicated DC
//     form (Robby's). Plans in `plans`.
//
// Origin (precedence): a setter-triage `call_status='Digital College booking'`
// = triage; the same on a confirmation form (Closer Triage Form) = confirmation;
// a confirmation `Downsold` OR a non-Robby EOC DC close (downsold on a
// high-ticket call) = downsell; otherwise = Robby direct.

export type DcPath = 'direct' | 'setter' | 'reactivation'
export type DcOrigin = 'triage' | 'confirmation' | 'downsell' | 'robby'

export type DcPlanCounts = {
  base44Monthly: number
  base44Yearly: number
  wixMonthly: number
  wixYearly: number
  // Distinct plan-backed DC-sale leads in this bucket. A sale can carry more
  // than one plan (e.g. Base44 + Wix), so the plan fields can sum past `sales`.
  sales: number
}

export type DcSalesTally = {
  byPath: { direct: DcPlanCounts; setter: DcPlanCounts; reactivation: DcPlanCounts }
  byOrigin: Record<DcOrigin, DcPlanCounts>
  total: DcPlanCounts
  // DC-closed leads dropped for having no recorded plan (surfaced, not silent).
  excludedNoPlan: number
}

type Flags = { base44Monthly: boolean; base44Yearly: boolean; wixMonthly: boolean; wixYearly: boolean }

type SaleInfo = {
  flags: Flags
  dcBookingTriage: boolean        // 'Digital College booking' on a setter triage form
  dcBookingConfirmation: boolean  // 'Digital College booking' on a confirmation form
  hasDownsell: boolean            // confirmation 'Downsold'
  hasNonRobbyEocClose: boolean    // EOC DC close by a non-Robby closer (HT-meeting downsell)
}

function emptyCounts(): DcPlanCounts {
  return { base44Monthly: 0, base44Yearly: 0, wixMonthly: 0, wixYearly: 0, sales: 0 }
}

// Token-tolerant plan parse — Base44 if the label mentions "base", Wix if
// "wix"; monthly/yearly by "month" / "year"|"annual". OR-s into the flags.
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

function hasPlan(f: Flags | undefined): boolean {
  return !!f && (f.base44Monthly || f.base44Yearly || f.wixMonthly || f.wixYearly)
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
        dcBookingTriage: false,
        dcBookingConfirmation: false,
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
        .select('lead_id, form_type, call_status')
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
    for (const r of (tri.data ?? []) as unknown as Array<{ lead_id: string | null; form_type: string | null; call_status: string | null }>) {
      if (!r.lead_id) continue
      const cs = (r.call_status ?? '').toLowerCase()
      const isConfirmation = r.form_type === 'Closer Triage Form'
      if (cs.includes('digital college')) {
        if (isConfirmation) infoFor(r.lead_id).dcBookingConfirmation = true
        else infoFor(r.lead_id).dcBookingTriage = true
      }
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

// Mutually-exclusive origin (see header): triage > confirmation > downsell >
// robby. Downsell folds in a non-Robby EOC DC close (a high-ticket-meeting
// downsell) alongside an explicit confirmation 'Downsold'.
function dcOrigin(info: SaleInfo | undefined): DcOrigin {
  if (info?.dcBookingTriage) return 'triage'
  if (info?.dcBookingConfirmation) return 'confirmation'
  if (info?.hasDownsell || info?.hasNonRobbyEocClose) return 'downsell'
  return 'robby'
}

// DC-sales tally over the funnel's cohort cycles. Deduped to one row per lead;
// ONLY counts leads with a recorded plan (plan-less DC-closed leads are dropped
// and reported via excludedNoPlan).
export async function getDcSalesTally(cycles: LeadCycleRow[]): Promise<DcSalesTally> {
  const pathByLead = new Map<string, { path: DcPath; optInAt: string }>()
  for (const c of cycles) {
    if (!c.dcClosed) continue
    const prev = pathByLead.get(c.closeId)
    if (!prev || c.optInAt > prev.optInAt) pathByLead.set(c.closeId, { path: dcPath(c), optInAt: c.optInAt })
  }

  const tally: DcSalesTally = {
    byPath: { direct: emptyCounts(), setter: emptyCounts(), reactivation: emptyCounts() },
    byOrigin: { triage: emptyCounts(), confirmation: emptyCounts(), downsell: emptyCounts(), robby: emptyCounts() },
    total: emptyCounts(),
    excludedNoPlan: 0,
  }
  const leadIds = Array.from(pathByLead.keys())
  if (leadIds.length === 0) return tally

  const infoByLead = await loadDcSaleInfo(leadIds)
  const add = (b: DcPlanCounts, f: Flags) => {
    b.sales += 1
    if (f.base44Monthly) b.base44Monthly += 1
    if (f.base44Yearly) b.base44Yearly += 1
    if (f.wixMonthly) b.wixMonthly += 1
    if (f.wixYearly) b.wixYearly += 1
  }
  pathByLead.forEach(({ path }, leadId) => {
    const info = infoByLead.get(leadId)
    if (!hasPlan(info?.flags)) {
      tally.excludedNoPlan += 1
      return
    }
    const f = info!.flags
    add(tally.byPath[path], f)
    add(tally.byOrigin[dcOrigin(info)], f)
    add(tally.total, f)
  })
  return tally
}
