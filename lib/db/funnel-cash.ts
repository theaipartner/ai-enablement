import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'
import type { LeadRow } from './leads'
import { fetchChunked } from './query-parallel'
import { addPlan, emptyPlans, dcPlanUnits, DC_PLAN_PRICE_USD } from './funnel-dc'
import { getLeadCycleRows, matchesType, reachedStage, type LeadFilterType } from './lead-tags'

// Cash collected — HT + DC + total, with ROAS, for the window's unique-lead
// cohort. Sourced across both funnels:
//   - HT  = upfront amount_paid_today on the HT-closed leads' closer forms.
//   - DC  = $300 per DC plan unit (main funnel + downsells).
//   - ROAS = total cash / adspend (the HT funnel's Closer-Funnel adspend).

export type CashCollected = {
  htUpfrontUsd: number // amount_paid_today on the HT closes
  htContractUsd: number // full contract value (contract_amount_to_send)
  dcUsd: number // $300 × DC plan units — flat, same upfront & contract
  upfrontTotalUsd: number // htUpfront + dc
  contractTotalUsd: number // htContract + dc
  adspendUsd: number | null
  upfrontRoas: number | null
  contractRoas: number | null
}

function num(v: number | string | null | undefined): number {
  const n = typeof v === 'number' ? v : v != null ? Number(v) : 0
  return Number.isFinite(n) ? n : 0
}

// Per-funnel cash collected (Drake 2026-06-15). One CashCollected per funnel box
// so each funnel — Total / Direct / Setter-led / Reactivation — shows the cash it
// produced (HT + DC). ROAS is only meaningful on Total (adspend in the window
// drove the whole new-lead cohort, not a single sub-funnel), so only `total`
// carries adspend/ROAS; the others leave them null.
//
// Computed over the SAME cohort cycles the funnel boxes count (getLeadCycleRows,
// the verified reference path), using the IDENTICAL matchesType / reachedStage
// predicates — so a box's cash is exactly the cash of the closes that box shows.
// HT close set = reachedStage(type,'closed') (the stages are HT-only); DC close
// set = the dcClosed flag — mirroring leads-funnel's closesHt / dcCloses split.
export type FunnelCash = {
  total: CashCollected
  direct: CashCollected
  setter: CashCollected
  reactivation: CashCollected
}

export async function getFunnelCash(
  range: DateRange,
  rows: LeadRow[],
  adspendUsd: number | null,
  // When an ad/campaign filter is active, DC is excluded (it's the separate Robby
  // low-ticket campaign, not attributable to an HT ad) — same call as the old bar.
  opts?: { excludeDc?: boolean },
): Promise<FunnelCash> {
  const sb = createAdminClient()
  const rowIds = new Set(rows.map((r) => r.leadId))
  const cycles = (await getLeadCycleRows(range)).filter((c) => rowIds.has(c.closeId))

  type Sets = { ht: Set<string>; dc: Set<string> }
  const mk = (): Sets => ({ ht: new Set(), dc: new Set() })
  const sets: Record<'total' | 'direct' | 'setter' | 'reactivation', Sets> = {
    total: mk(), direct: mk(), setter: mk(), reactivation: mk(),
  }
  const assign = (key: keyof typeof sets, type: LeadFilterType | null) => {
    for (const c of cycles) {
      if (!matchesType(c, type)) continue
      if (reachedStage(c, type, 'closed')) sets[key].ht.add(c.closeId)
      if (c.dcClosed) sets[key].dc.add(c.closeId)
    }
  }
  assign('total', null)
  assign('direct', 'direct')
  assign('setter', 'setter')
  assign('reactivation', 'reactivation')

  // HT cash — one forms read over every HT-closed lead → per-lead upfront + contract.
  const htCash = new Map<string, { upfront: number; contract: number }>()
  const allHt = Array.from(sets.total.ht)
  if (allHt.length > 0) {
    const frows = await fetchChunked<{
      lead_id: string | null
      amount_paid_today_number: number | string | null
      amount_paid_today_currency: number | string | null
      contract_amount_to_send: number | string | null
    }>(
      allHt,
      (chunk) => sb
        .from('airtable_full_closer_report' as never)
        .select('lead_id, amount_paid_today_number, amount_paid_today_currency, contract_amount_to_send')
        .in('lead_id', chunk) as never,
      'funnel-cash HT read failed',
      100,
    )
    for (const f of frows) {
      if (!f.lead_id) continue
      const prev = htCash.get(f.lead_id) ?? { upfront: 0, contract: 0 }
      prev.upfront += num(f.amount_paid_today_number ?? f.amount_paid_today_currency)
      prev.contract += num(f.contract_amount_to_send)
      htCash.set(f.lead_id, prev)
    }
  }

  // DC cash — $300 per plan unit (flat), per-lead units from the closer report's
  // dc_plans. Skipped entirely under an ad filter (DC is the separate campaign).
  const dcUnits = new Map<string, number>()
  const allDc = opts?.excludeDc ? [] : Array.from(sets.total.dc)
  if (allDc.length > 0) {
    const drows = await fetchChunked<{ lead_id: string | null; dc_plans: string[] | null }>(
      allDc,
      (chunk) => sb
        .from('airtable_full_closer_report' as never)
        .select('lead_id, dc_plans')
        .in('lead_id', chunk)
        .not('dc_plans', 'is', null) as never,
      'funnel-cash DC read failed',
      100,
    )
    for (const f of drows) {
      if (!f.lead_id) continue
      const p = emptyPlans()
      addPlan(p, f.dc_plans)
      dcUnits.set(f.lead_id, (dcUnits.get(f.lead_id) ?? 0) + dcPlanUnits(p))
    }
  }

  const build = (s: Sets, withRoas: boolean): CashCollected => {
    let htUp = 0
    let htCon = 0
    for (const id of Array.from(s.ht)) {
      const c = htCash.get(id)
      if (c) { htUp += c.upfront; htCon += c.contract }
    }
    let units = 0
    if (!opts?.excludeDc) for (const id of Array.from(s.dc)) units += dcUnits.get(id) ?? 0
    const dc = units * DC_PLAN_PRICE_USD
    const upfrontTotalUsd = htUp + dc
    const contractTotalUsd = htCon + dc
    const ad = withRoas ? adspendUsd : null
    const roas = (t: number) => (ad != null && ad > 0 ? t / ad : null)
    return {
      htUpfrontUsd: htUp,
      htContractUsd: htCon,
      dcUsd: dc,
      upfrontTotalUsd,
      contractTotalUsd,
      adspendUsd: ad,
      upfrontRoas: roas(upfrontTotalUsd),
      contractRoas: roas(contractTotalUsd),
    }
  }

  return {
    total: build(sets.total, true),
    direct: build(sets.direct, false),
    setter: build(sets.setter, false),
    reactivation: build(sets.reactivation, false),
  }
}
