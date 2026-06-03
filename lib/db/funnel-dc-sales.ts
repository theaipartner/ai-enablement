import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

// Funnel · Digital College sales tally (Drake 2026-06-03).
//
// Counts Digital College (low-ticket) SALES, broken down by which funnel the
// lead came through (direct / setter / reactivation) and by the sale's ORIGIN
// (triage / confirmation / downsell / Robby direct), each with the sale-type
// composition (Base44 / Wix × Monthly / Yearly).
//
// SINGLE SOURCE = the closer EOC. Robby files the regular closer report now, so
// the dedicated Digital College form (airtable_digital_college_sales) is UNWIRED
// — a DC sale is an `airtable_full_closer_report` row (form_type='New',
// call_outcome='Digital College Closed') WITH a recorded plan. Sourcing from the
// EOC directly (not the lead-tag cohort) is deliberate: the tagger misses leads
// (e.g. Kareem Memnon has no lead_cycles row at all), so a cohort-driven count
// dropped real sales. Plan-less DC closes are excluded (and reported via
// excludedNoPlan) because the EOC outcome is set even when no sale happened.
//
// All-time (not window-scoped): DC volume is tiny and the EOC call-date is
// unreliable (mis-entered future dates), so the tally shows every real DC sale.
//
// Path (from close_leads, NOT the tagger — uniform across all leads incl. ones
// the tagger skipped): reactivated_at set = reactivation; else direct_call_booked
// = direct; else setter.
//
// Origin (precedence): a setter-triage `call_status='Digital College booking'` =
// triage; the same on a confirmation form (Closer Triage Form) = confirmation; a
// confirmation `Downsold` OR a non-Robby EOC DC close (downsold on a high-ticket
// call) = downsell; otherwise = Robby direct.

export type DcPath = 'direct' | 'setter' | 'reactivation'
export type DcOrigin = 'triage' | 'confirmation' | 'downsell' | 'robby'

export type DcPlanCounts = {
  base44Monthly: number
  base44Yearly: number
  wixMonthly: number
  wixYearly: number
  // Distinct DC-sale leads in this bucket. A sale can carry more than one plan
  // (e.g. Base44 + Wix), so the plan fields can sum past `sales`.
  sales: number
}

export type DcSalesTally = {
  byPath: { direct: DcPlanCounts; setter: DcPlanCounts; reactivation: DcPlanCounts }
  byOrigin: Record<DcOrigin, DcPlanCounts>
  total: DcPlanCounts
  // EOC DC closes dropped for having no recorded plan (surfaced, not silent).
  excludedNoPlan: number
}

type Flags = { base44Monthly: boolean; base44Yearly: boolean; wixMonthly: boolean; wixYearly: boolean }

function emptyCounts(): DcPlanCounts {
  return { base44Monthly: 0, base44Yearly: 0, wixMonthly: 0, wixYearly: 0, sales: 0 }
}
function emptyFlags(): Flags {
  return { base44Monthly: false, base44Yearly: false, wixMonthly: false, wixYearly: false }
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
function hasPlan(f: Flags): boolean {
  return f.base44Monthly || f.base44Yearly || f.wixMonthly || f.wixYearly
}
function isRobby(closerNames: string[] | null): boolean {
  return (closerNames ?? []).some((n) => (n ?? '').toLowerCase().includes('robby'))
}

type LeadMeta = { path: DcPath }
type OriginSig = { triage: boolean; confirmation: boolean; downsell: boolean }

// Path from close_leads (tagger-independent so leads the tagger skipped still
// classify): reactivation > direct > setter.
function leadPath(reactivatedAt: string | null, directCallBooked: string | null): DcPath {
  if (reactivatedAt != null) return 'reactivation'
  if ((directCallBooked ?? '').trim().toLowerCase() === 'yes') return 'direct'
  return 'setter'
}

export async function getDcSalesTally(): Promise<DcSalesTally> {
  const sb = createAdminClient()
  const tally: DcSalesTally = {
    byPath: { direct: emptyCounts(), setter: emptyCounts(), reactivation: emptyCounts() },
    byOrigin: { triage: emptyCounts(), confirmation: emptyCounts(), downsell: emptyCounts(), robby: emptyCounts() },
    total: emptyCounts(),
    excludedNoPlan: 0,
  }

  // 1. DC closes = EOC 'Digital College Closed' rows. Dedup per lead (plan flags
  //    OR-ed; a non-Robby closer flags an HT-meeting downsell).
  const { data: eocData, error: eocErr } = await sb
    .from('airtable_full_closer_report' as never)
    .select('lead_id, closer_names, dc_plans')
    .eq('form_type', 'New')
    .ilike('call_outcome', '%digital college closed%')
    .range(0, 4999)
  if (eocErr) throw new Error(`dc-sales: closer report read failed: ${eocErr.message}`)
  const saleLeads = new Map<string, { flags: Flags; hasNonRobbyEocClose: boolean }>()
  for (const r of (eocData ?? []) as unknown as Array<{ lead_id: string | null; closer_names: string[] | null; dc_plans: string[] | null }>) {
    if (!r.lead_id) continue
    let s = saleLeads.get(r.lead_id)
    if (!s) { s = { flags: emptyFlags(), hasNonRobbyEocClose: false }; saleLeads.set(r.lead_id, s) }
    mergePlanFlags(s.flags, r.dc_plans)
    if (!isRobby(r.closer_names)) s.hasNonRobbyEocClose = true
  }
  const leadIds = Array.from(saleLeads.keys())
  if (leadIds.length === 0) return tally

  // 2. close_leads — path signals + drop test / soft-hidden / placeholder leads.
  const leadMeta = new Map<string, LeadMeta>()
  // 3. Origin signals from the triage/confirmation forms.
  const originSig = new Map<string, OriginSig>()
  const originFor = (id: string): OriginSig => {
    let o = originSig.get(id)
    if (!o) { o = { triage: false, confirmation: false, downsell: false }; originSig.set(id, o) }
    return o
  }
  for (let i = 0; i < leadIds.length; i += 100) {
    const chunk = leadIds.slice(i, i + 100)
    const [cl, tri] = await Promise.all([
      sb
        .from('close_leads' as never)
        .select('close_id, display_name, reactivated_at, direct_call_booked, excluded_at')
        .in('close_id', chunk),
      sb
        .from('airtable_setter_triage_calls' as never)
        .select('lead_id, form_type, call_status')
        .is('excluded_at', null)
        .in('lead_id', chunk),
    ])
    if (cl.error) throw new Error(`dc-sales: close_leads read failed: ${cl.error.message}`)
    if (tri.error) throw new Error(`dc-sales: triage/confirmation read failed: ${tri.error.message}`)
    for (const r of (cl.data ?? []) as unknown as Array<{ close_id: string; display_name: string | null; reactivated_at: string | null; direct_call_booked: string | null; excluded_at: string | null }>) {
      if (r.excluded_at != null) continue
      if ((r.display_name ?? '').trim().toLowerCase() === 'test') continue
      leadMeta.set(r.close_id, { path: leadPath(r.reactivated_at, r.direct_call_booked) })
    }
    for (const r of (tri.data ?? []) as unknown as Array<{ lead_id: string | null; form_type: string | null; call_status: string | null }>) {
      if (!r.lead_id) continue
      const cs = (r.call_status ?? '').toLowerCase()
      if (cs.includes('digital college')) {
        if (r.form_type === 'Closer Triage Form') originFor(r.lead_id).confirmation = true
        else originFor(r.lead_id).triage = true
      }
      if (cs.includes('downsold')) originFor(r.lead_id).downsell = true
    }
  }

  // 4. Aggregate. A lead missing from close_leads (placeholder / hidden / test)
  //    is dropped entirely; a real lead with no plan is excluded + counted.
  const add = (b: DcPlanCounts, f: Flags) => {
    b.sales += 1
    if (f.base44Monthly) b.base44Monthly += 1
    if (f.base44Yearly) b.base44Yearly += 1
    if (f.wixMonthly) b.wixMonthly += 1
    if (f.wixYearly) b.wixYearly += 1
  }
  saleLeads.forEach((s, leadId) => {
    const meta = leadMeta.get(leadId)
    if (!meta) return
    if (!hasPlan(s.flags)) { tally.excludedNoPlan += 1; return }
    const o = originSig.get(leadId)
    const origin: DcOrigin = o?.triage
      ? 'triage'
      : o?.confirmation
        ? 'confirmation'
        : o?.downsell || s.hasNonRobbyEocClose
          ? 'downsell'
          : 'robby'
    add(tally.byPath[meta.path], s.flags)
    add(tally.byOrigin[origin], s.flags)
    add(tally.total, s.flags)
  })
  return tally
}
