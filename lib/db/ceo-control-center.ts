// CEO Control Center data layer.
//
// Real numbers for total active clients + month-to-date ad spend.
// New Cash / Backend Cash are placeholders rendered in the page until
// the revenue wiring lands.

import { createAdminClient } from '@/lib/supabase/admin'
import { getEstPeriodBoundary } from '@/lib/time/est-periods'

export type CeoControlCenterData = {
  total_active_clients: number
  ad_spend_mtd: number
  ad_spend_period_label: string
}

export async function getCeoControlCenterData(): Promise<CeoControlCenterData> {
  const supabase = createAdminClient()
  const monthStartEt = getEstPeriodBoundary('month')

  // Format the month-start as a YYYY-MM-DD date in EST for the
  // meta_ad_daily.day column (date type). Use Intl rather than the
  // ISO substring to honor the EST boundary correctly across DST.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const monthStartDate = fmt.format(monthStartEt) // "YYYY-MM-DD"

  const [{ count: totalActiveClients }, { data: adSpendRows }] = await Promise.all([
    supabase
      .from('clients')
      .select('id', { count: 'exact', head: true })
      .eq('status', 'active')
      .is('archived_at', null),
    supabase
      .from('meta_ad_daily' as never)
      .select('amount_spent')
      .gte('day', monthStartDate),
  ])

  const adSpendMtd = ((adSpendRows ?? []) as Array<{ amount_spent: number | string | null }>)
    .reduce((sum, r) => sum + (Number(r.amount_spent) || 0), 0)

  const monthLabel = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'long',
  }).format(monthStartEt)

  return {
    total_active_clients: totalActiveClients ?? 0,
    ad_spend_mtd: adSpendMtd,
    ad_spend_period_label: `${monthLabel} MTD`,
  }
}
