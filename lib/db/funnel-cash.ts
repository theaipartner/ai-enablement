import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'
import { type DcFunnel, dcPlanUnits, DC_PLAN_PRICE_USD } from './funnel-dc'

// Cash collected — a funnel-wide summary (HT + DC + total) with ROAS, for the
// window's unique-lead cohort. Its own thing, sourced across both funnels:
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

export async function getCashCollected(
  range: DateRange,
  dc: DcFunnel,
  adspendUsd: number | null,
): Promise<CashCollected> {
  const sb = createAdminClient()

  // HT-closed leads (close_type='ht') in window → upfront + contract cash.
  const { data: closedRows, error } = await sb
    .from('lead_cycle_stages' as never)
    .select('close_id')
    .not('closed_at', 'is', null)
    .eq('close_type', 'ht')
    .gte('opt_in_at', range.startUtcIso)
    .lt('opt_in_at', range.endUtcIso)
  if (error) throw new Error(`HT-closed read failed: ${error.message}`)
  const htLeads = Array.from(new Set(((closedRows ?? []) as unknown as Array<{ close_id: string }>).map((r) => r.close_id)))

  let htUpfrontUsd = 0
  let htContractUsd = 0
  for (let i = 0; i < htLeads.length; i += 100) {
    const chunk = htLeads.slice(i, i + 100)
    const { data, error: perr } = await sb
      .from('airtable_full_closer_report' as never)
      .select('lead_id, amount_paid_today_number, amount_paid_today_currency, contract_amount_to_send')
      .in('lead_id', chunk)
    if (perr) throw new Error(`HT cash read failed: ${perr.message}`)
    for (const f of (data ?? []) as unknown as Array<{
      amount_paid_today_number: number | string | null
      amount_paid_today_currency: number | string | null
      contract_amount_to_send: number | string | null
    }>) {
      htUpfrontUsd += num(f.amount_paid_today_number ?? f.amount_paid_today_currency)
      htContractUsd += num(f.contract_amount_to_send)
    }
  }

  // DC is a flat $300 per program, so upfront and contract are the same.
  const dcUsd = (dcPlanUnits(dc.closedPlans) + dcPlanUnits(dc.downsellPlans)) * DC_PLAN_PRICE_USD
  const upfrontTotalUsd = htUpfrontUsd + dcUsd
  const contractTotalUsd = htContractUsd + dcUsd
  const roas = (total: number) => (adspendUsd != null && adspendUsd > 0 ? total / adspendUsd : null)
  return {
    htUpfrontUsd,
    htContractUsd,
    dcUsd,
    upfrontTotalUsd,
    contractTotalUsd,
    adspendUsd: adspendUsd ?? null,
    upfrontRoas: roas(upfrontTotalUsd),
    contractRoas: roas(contractTotalUsd),
  }
}
