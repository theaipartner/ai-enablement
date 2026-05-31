import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'
import type { LeadRow } from './leads'
import { getAdsAggregateLive, clampAdsRange } from './funnel-ads'

// Leads-page funnel stack (Drake 2026-05-31). Four stacked boxes computed over
// the SAME cohort the roster shows (rows are passed in already view-filtered, so
// the boxes and the list can't drift):
//
//   Total         adspend → opt-ins → dials → connected → books → shows → closes
//   Direct        qualified opt-ins → booked (= direct leads) → connected →
//                 confirms → shows → closes
//   Setter        pool (qual/unqual) → dials → connected → books → shows → closes
//   Reactivation  pool → dials → connected → books → shows → closes  (post-handover)
//
// Stage rules:
//   - direct lead   = ever booked the strategy-call link (hasDirect), or tagged
//                     reactivated (reactivation ⊂ direct).
//   - setter lead   = everyone else.
//   - reactivation  = reactivatedAt set.
//   - connected     = 1 per lead (anyCallConnected); for Reactivation it's a
//                     connected call AFTER reactivatedAt.
//   - dials         = RAW outbound dials, capped at the lead's close (post-close
//                     fulfillment dials excluded); for Reactivation, only dials
//                     AFTER reactivatedAt (still capped at close).
//   - books/shows/closes for Reactivation use the plain flags: a reactivated lead
//     lost its strat spot, so any later partnership book / show / close is
//     inherently post-handover — no extra time-scoping needed.

const CONNECTED_SEC = 90

export type TotalBox = {
  optIns: number; dials: number; connected: number; books: number; shows: number; closes: number
}
export type DirectBox = {
  qualifiedOptIns: number; books: number; connected: number; confirms: number; shows: number; closes: number
}
export type PoolFunnelBox = {
  pool: number; qualified: number; unqualified: number
  dials: number; connected: number; books: number; shows: number; closes: number
}

export type LeadsFunnel = {
  adspendUsd: number | null
  total: TotalBox
  direct: DirectBox
  setter: PoolFunnelBox
  reactivation: PoolFunnelBox
}

type DialWindows = {
  // Raw outbound dials with activity_at <= close (or all, if not closed).
  dialsBeforeClose: number
  // Outbound dials strictly after reactivatedAt, still capped at close.
  postReactDials: number
  // Any outbound connected (>=90s) dial after reactivatedAt.
  postReactConnected: boolean
}

// One outbound-call scan over the cohort → per-lead windowed dial counts.
async function scanDialWindows(
  leads: Array<{ leadId: string; reactivatedAt: string | null; closeTimeIso: string | null }>,
): Promise<Map<string, DialWindows>> {
  const out = new Map<string, DialWindows>()
  for (const l of leads) out.set(l.leadId, { dialsBeforeClose: 0, postReactDials: 0, postReactConnected: false })
  if (leads.length === 0) return out

  const reactById = new Map(leads.map((l) => [l.leadId, l.reactivatedAt]))
  const closeById = new Map(leads.map((l) => [l.leadId, l.closeTimeIso]))
  const sb = createAdminClient()
  const ids = leads.map((l) => l.leadId)

  for (let i = 0; i < ids.length; i += 100) {
    const chunk = ids.slice(i, i + 100)
    for (let from = 0; ; from += 1000) {
      const { data, error } = await sb
        .from('close_calls' as never)
        .select('lead_id, activity_at, duration, direction')
        .in('lead_id', chunk)
        .eq('direction', 'outbound')
        .range(from, from + 999)
      if (error) throw new Error(`leads-funnel: close_calls read failed: ${error.message}`)
      const calls = (data ?? []) as unknown as Array<{
        lead_id: string | null; activity_at: string; duration: number | null; direction: string | null
      }>
      for (const c of calls) {
        if (!c.lead_id) continue
        const w = out.get(c.lead_id)
        if (!w) continue
        const closeIso = closeById.get(c.lead_id) ?? null
        // Cap at close: a dial after the lead's close is fulfillment, not sales.
        if (closeIso && c.activity_at > closeIso) continue
        w.dialsBeforeClose += 1
        const reactIso = reactById.get(c.lead_id) ?? null
        if (reactIso && c.activity_at > reactIso) {
          w.postReactDials += 1
          if ((c.duration ?? 0) >= CONNECTED_SEC) w.postReactConnected = true
        }
      }
      if (calls.length < 1000) break
    }
  }
  return out
}

export async function getLeadsFunnel(rows: LeadRow[], range: DateRange): Promise<LeadsFunnel> {
  const isDirect = (r: LeadRow) => r.hasDirect || r.reactivatedAt !== null
  const isReact = (r: LeadRow) => r.reactivatedAt !== null
  const isSetter = (r: LeadRow) => !isDirect(r)

  const win = await scanDialWindows(
    rows.map((r) => ({ leadId: r.leadId, reactivatedAt: r.reactivatedAt, closeTimeIso: r.closeTimeIso })),
  )
  const dials = (r: LeadRow) => win.get(r.leadId)?.dialsBeforeClose ?? 0
  const postDials = (r: LeadRow) => win.get(r.leadId)?.postReactDials ?? 0
  const postConnected = (r: LeadRow) => win.get(r.leadId)?.postReactConnected ?? false

  const sum = (pred: (r: LeadRow) => boolean, val: (r: LeadRow) => number) =>
    rows.reduce((acc, r) => (pred(r) ? acc + val(r) : acc), 0)
  const count = (pred: (r: LeadRow) => boolean) => rows.reduce((acc, r) => (pred(r) ? acc + 1 : acc), 0)

  // Adspend for the window (Meta mirror). Provisional/empty → null.
  let adspendUsd: number | null = null
  try {
    const ads = await getAdsAggregateLive(clampAdsRange(range.startEtDate, range.endEtDate))
    adspendUsd = ads.find((m) => m.id === 'adspend')?.value ?? null
  } catch {
    adspendUsd = null
  }

  const total: TotalBox = {
    optIns: rows.length,
    dials: sum(() => true, dials),
    connected: count((r) => r.anyCallConnected),
    books: count((r) => r.hasDirect || r.hasPartnership),
    shows: count((r) => r.showed),
    closes: count((r) => r.closed),
  }

  const direct: DirectBox = {
    qualifiedOptIns: count((r) => r.qualified === 'qualified'),
    books: count(isDirect),
    connected: count((r) => isDirect(r) && r.anyCallConnected),
    confirms: count((r) => isDirect(r) && r.confirmed),
    shows: count((r) => isDirect(r) && r.showed),
    closes: count((r) => isDirect(r) && r.closed),
  }

  const setter: PoolFunnelBox = {
    pool: count(isSetter),
    qualified: count((r) => isSetter(r) && r.qualified === 'qualified'),
    unqualified: count((r) => isSetter(r) && r.qualified === 'non-qualified'),
    dials: sum(isSetter, dials),
    connected: count((r) => isSetter(r) && r.anyCallConnected),
    books: count((r) => isSetter(r) && r.hasPartnership),
    shows: count((r) => isSetter(r) && r.showed),
    closes: count((r) => isSetter(r) && r.closed),
  }

  const reactivation: PoolFunnelBox = {
    pool: count(isReact),
    qualified: count((r) => isReact(r) && r.qualified === 'qualified'),
    unqualified: count((r) => isReact(r) && r.qualified === 'non-qualified'),
    dials: sum(isReact, postDials),
    connected: count((r) => isReact(r) && postConnected(r)),
    books: count((r) => isReact(r) && r.hasPartnership),
    shows: count((r) => isReact(r) && r.showed),
    closes: count((r) => isReact(r) && r.closed),
  }

  return { adspendUsd, total, direct, setter, reactivation }
}
