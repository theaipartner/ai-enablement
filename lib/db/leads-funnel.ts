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
//   - direct lead   = self-booked the strategy-call link (tagBecameDirect; live
//                     fallback hasDirect || reactivatedAt). Direct and setter
//                     PARTITION the cohort (every cycle is exactly one).
//   - setter lead   = everyone else (never self-booked).
//   - reactivation  = tagReactivatedAt set (fallback reactivatedAt). CROSS-CUTS
//                     direct/setter — an opt-in lead that goes cold reactivates
//                     too, so it is NOT a subset of direct. The Reactivation box
//                     overlaps both Direct and Setter and reads the post-handover
//                     phase only.
//   - connected     = 1 per lead, form-OR-call (a ≥90s dial, a setter triage
//                     form, or a confirmed confirmation — r.connected); for
//                     Reactivation it's that signal scoped post-handover
//                     (r.reactConnected). Cumulative: a later stage back-fills
//                     it, so books never exceed connected.
//   - dials         = RAW outbound dials, capped at the lead's close (post-close
//                     fulfillment dials excluded); for Reactivation, only dials
//                     AFTER reactivatedAt (still capped at close).
//   - books/shows/closes for Reactivation use the plain flags: a reactivated lead
//     lost its strat spot, so any later partnership book / show / close is
//     inherently post-handover — no extra time-scoping needed.

// closesHt / closesDc split the closes node so each offer is visible
// (closesHt + closesDc === closes). DC closes feed connected/booked/shows
// monotonically via reachedStage, same as HT.
// dcCloses = cycles in the box that closed Digital College (kept OFF the HT
// ladder; rendered as a small "DC: N closed" line under the box).
export type TotalBox = {
  optIns: number; dials: number; connected: number; books: number; confirms: number; shows: number
  closes: number; closesHt: number; closesDc: number; dcCloses: number
}
export type DirectBox = {
  qualifiedOptIns: number; dials: number; books: number; connected: number; confirms: number; shows: number
  closes: number; closesHt: number; closesDc: number; dcCloses: number
}
export type PoolFunnelBox = {
  pool: number; qualified: number; unqualified: number
  dials: number; connected: number; books: number; shows: number
  closes: number; closesHt: number; closesDc: number; dcCloses: number
}

export type LeadsFunnel = {
  adspendUsd: number | null
  uniqueLinkClicks: number | null
  total: TotalBox
  direct: DirectBox
  setter: PoolFunnelBox
  reactivation: PoolFunnelBox
  // Integrity warnings (empty = clean). Surfaced as a banner on the Funnel page
  // so a silent miscount / cross-contamination can't hide as volume grows.
  warnings: string[]
}

// Funnel-integrity guard. Returns human-readable violations of invariants that
// MUST hold if the funnel is counting each lead once and bucketing cleanly.
// Empty = clean. A violation means a bug (double-count, mis-bucket, or a stage
// predicate that lets a later stage exceed an earlier one).
export function validateFunnel(f: LeadsFunnel, totalCycles: number, distinctLeads: number): string[] {
  const w: string[] = []

  // Monotonicity: within each box a later stage can't exceed an earlier one.
  // Total is special — Books MAY exceed Connected (a self-booked direct lead is
  // booked but not connected) — so Total checks the two chains that DO hold.
  const chain = (label: string, ...seq: [string, number][]) => {
    for (let i = 1; i < seq.length; i++) {
      if (seq[i][1] > seq[i - 1][1]) {
        w.push(`${label}: ${seq[i][0]} (${seq[i][1]}) > ${seq[i - 1][0]} (${seq[i - 1][1]}).`)
      }
    }
  }
  chain('Total', ['opt-ins', f.total.optIns], ['books', f.total.books], ['confirms', f.total.confirms], ['shows', f.total.shows], ['closes', f.total.closes])
  chain('Total', ['opt-ins', f.total.optIns], ['connected', f.total.connected])
  chain('Direct', ['books', f.direct.books], ['connected', f.direct.connected], ['confirms', f.direct.confirms], ['shows', f.direct.shows], ['closes', f.direct.closes])
  chain('Opt-in', ['pool', f.setter.pool], ['connected', f.setter.connected], ['books', f.setter.books], ['shows', f.setter.shows], ['closes', f.setter.closes])
  chain('Reactivation', ['pool', f.reactivation.pool], ['connected', f.reactivation.connected], ['books', f.reactivation.books], ['shows', f.reactivation.shows], ['closes', f.reactivation.closes])

  // Partition: every cycle is exactly Direct (became direct) or Opt-in. Direct
  // books == direct pool (every direct cycle self-booked), so the two must sum
  // to all opt-in cycles.
  if (f.direct.books + f.setter.pool !== f.total.optIns) {
    w.push(`Partition: Direct (${f.direct.books}) + Opt-in (${f.setter.pool}) ≠ opt-in cycles (${f.total.optIns}) — a cycle is mis-bucketed.`)
  }
  // Cycle/person identity: opt-in CYCLES ≥ distinct leads; the gap is exactly the
  // re-opt-in extra cycles (the roster is per-person, the funnel per-cycle).
  if (f.total.optIns < distinctLeads) {
    w.push(`opt-in cycles (${f.total.optIns}) < distinct leads (${distinctLeads}) — impossible (cycles can't be fewer than people).`)
  }
  return w
}

// ── Funnel membership + stage predicates (the SINGLE source of truth) ──────────
// The funnel boxes below AND the /leads roster filter both go through these, so
// a funnel bar's count always equals the roster it filters to when clicked.

// Lead-type filter values. 'direct' = self-booked a strat link (tagBecameDirect);
// 'setter' (a.k.a. opt-in) = everyone who never did — these two PARTITION the
// cohort. 'reactivation' (tagReactivatedAt set) CROSS-CUTS both: a reactivated
// lead is direct or setter by its self-booking, and the Reactivation box/filter
// pulls it in either way, reading the post-handover phase only. (Pre-tag, 'direct'
// was said to INCLUDE reactivation — no longer true under the tag model below.)
export type LeadFilterType = 'direct' | 'setter' | 'reactivation'
export type FunnelStage = 'connected' | 'booked' | 'confirmed' | 'showed' | 'closed'

// Tag-aware (latest cycle) with a live fallback when the lead has no cycle.
// Under the persistent-tag model 'direct' = became direct (reactivation is NO
// LONGER ⊂ direct — opt-in leads reactivate too), so the partition is clean:
// direct vs opt-in (setter) by direct-ness; reactivation cross-cuts.
export const isDirect = (r: LeadRow): boolean =>
  r.tagPrimaryHits ? r.tagBecameDirect : (r.hasDirect || r.reactivatedAt !== null)
export const isReact = (r: LeadRow): boolean =>
  r.tagPrimaryHits ? r.tagReactivatedAt !== null : r.reactivatedAt !== null
export const isSetter = (r: LeadRow): boolean => !isDirect(r)

// Does the lead belong to the given lead-type? (null = no type restriction = Total.)
export function matchesType(r: LeadRow, type: LeadFilterType | null): boolean {
  if (type === 'direct') return isDirect(r)
  if (type === 'reactivation') return isReact(r)
  if (type === 'setter') return isSetter(r)
  return true
}

// Has the lead REACHED `stage` within funnel `type` (cumulative — a later stage
// back-fills the earlier ones, so "showed" includes closes)? Mirrors the box
// definitions exactly. `type` null = Total (all leads). Membership (matchesType)
// is applied separately by the caller; this answers the stage question per type.
export function reachedStage(r: LeadRow, type: LeadFilterType | null, stage: FunnelStage): boolean {
  // Tag-aware (latest cycle): mirror the reader's per-cycle predicate. The
  // tagger's per-phase hits are already monotonic; reactivation reads the
  // post-handover (reactive) phase only, everything else the max across phases.
  if (r.tagPrimaryHits) {
    const P = r.tagPrimaryHits
    const R = r.tagReactiveHits
    if (type === 'reactivation') {
      if (stage === 'confirmed') return false
      return !!R?.[stage]
    }
    return P[stage] || !!R?.[stage]
  }

  // Live fallback (lead has no cycle).
  if (type === 'reactivation') {
    switch (stage) {
      case 'connected': return r.reactConnected || r.reactBooked || r.reactShowed || r.reactClosed
      case 'booked': return r.reactBooked || r.reactShowed || r.reactClosed
      case 'confirmed': return false
      case 'showed': return r.reactShowed || r.reactClosed
      case 'closed': return r.reactClosed
    }
  }
  if (type === 'direct') {
    switch (stage) {
      case 'connected': return r.connected || r.confirmed || r.showed || r.closed
      case 'booked': return true
      case 'confirmed': return r.confirmed || r.showed || r.closed
      case 'showed': return r.showed || r.closed
      case 'closed': return r.closed
    }
  }
  if (type === 'setter') {
    switch (stage) {
      case 'connected': return r.connectedEffective
      case 'booked': return r.hasPartnership || r.showed || r.closed
      case 'confirmed': return false
      case 'showed': return r.showed || r.closed
      case 'closed': return r.closed
    }
  }
  const booked = r.hasDirect || r.hasPartnership
  switch (stage) {
    case 'connected': return r.connectedEffective
    case 'booked': return booked || r.showed || r.closed
    case 'confirmed': return r.confirmed || r.showed || r.closed
    case 'showed': return r.showed || r.closed
    case 'closed': return r.closed
  }
}

// Full /leads filter predicate. `types` is the multi-select lead-type filter
// (empty = no type restriction = Total). `stage` is the single cumulative
// threshold. A lead matches when it's in ANY selected type AND has reached the
// stage within that type's funnel (so "Direct · Showed" reads the stage with
// the Direct definition, "Reactivation · Showed" with the reactive one).
export function matchesLeadFilter(
  r: LeadRow,
  types: LeadFilterType[],
  stage: FunnelStage | null,
): boolean {
  if (types.length === 0) return !stage || reachedStage(r, null, stage)
  return types.some((t) => matchesType(r, t) && (!stage || reachedStage(r, t, stage)))
}

type DialWindows = {
  // Raw outbound dials with activity_at <= close (or all, if not closed).
  dialsBeforeClose: number
  // Outbound dials strictly after reactivatedAt, still capped at close.
  postReactDials: number
}

// One outbound-call scan over the cohort → per-lead windowed dial counts.
async function scanDialWindows(
  leads: Array<{ leadId: string; optInAt: string; reactivatedAt: string | null; closeTimeIso: string | null }>,
): Promise<Map<string, DialWindows>> {
  const out = new Map<string, DialWindows>()
  for (const l of leads) out.set(l.leadId, { dialsBeforeClose: 0, postReactDials: 0 })
  if (leads.length === 0) return out

  const optInById = new Map(leads.map((l) => [l.leadId, l.optInAt]))
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
        // Reset on re-opt-in: only count dials at/after the lead's latest
        // opt-in, so a prior journey's dials don't show on the current one.
        const optInIso = optInById.get(c.lead_id) ?? null
        if (optInIso && c.activity_at < optInIso) continue
        const closeIso = closeById.get(c.lead_id) ?? null
        // Cap at close: a dial after the lead's close is fulfillment, not sales.
        if (closeIso && c.activity_at > closeIso) continue
        w.dialsBeforeClose += 1
        const reactIso = reactById.get(c.lead_id) ?? null
        if (reactIso && c.activity_at > reactIso) {
          w.postReactDials += 1
        }
      }
      if (calls.length < 1000) break
    }
  }
  return out
}

export async function getLeadsFunnel(
  rows: LeadRow[],
  range: DateRange,
  opts?: { adId?: string | null },
): Promise<LeadsFunnel> {
  // Count PER CYCLE from the persistent tags (a re-opt double-counts). Scope to
  // the leads the page passed (respects the view filter); the dials bracket +
  // the integrity identity use the per-PERSON rows. HT-only: closes are HT
  // closes (DC is excluded from the tags), so closesDc is always 0.
  const { getLeadCycleRows, reachedStage: rs, matchesType: mt } = await import('./lead-tags')
  const rowIds = new Set(rows.map((r) => r.leadId))
  const cycles = (await getLeadCycleRows(range)).filter((c) => rowIds.has(c.closeId))
  const qualByLead = new Map(rows.map((r) => [r.leadId, r.qualified]))

  const win = await scanDialWindows(
    rows.map((r) => ({ leadId: r.leadId, optInAt: r.optInAt, reactivatedAt: r.reactivatedAt, closeTimeIso: r.closeTimeIso })),
  )

  const countCyc = (type: LeadFilterType | null, stage: FunnelStage) =>
    cycles.reduce((a, c) => (mt(c, type) && rs(c, type, stage) ? a + 1 : a), 0)
  const poolCyc = (type: LeadFilterType) => cycles.filter((c) => mt(c, type)).length
  const qual = (type: LeadFilterType | null, q: string) =>
    cycles.filter((c) => mt(c, type) && qualByLead.get(c.closeId) === q).length
  const closesCyc = (type: LeadFilterType | null) => {
    const n = countCyc(type, 'closed')
    return { closes: n, closesHt: n, closesDc: 0 } // HT-only (DC excluded from the tags)
  }
  // DC closes in the box (off the HT ladder) — the small "DC: N closed" line.
  const dcClosesCyc = (type: LeadFilterType | null) =>
    cycles.filter((c) => mt(c, type) && c.dcClosed).length
  // Dials are a per-lead bracket, not a stage — sum over DISTINCT leads in the
  // box so a re-opt lead's dials aren't double-counted.
  const dialsFor = (type: LeadFilterType | null, post = false) => {
    const seen = new Set<string>()
    let n = 0
    for (const c of cycles) {
      if (!mt(c, type) || seen.has(c.closeId)) continue
      seen.add(c.closeId)
      const w = win.get(c.closeId)
      n += post ? (w?.postReactDials ?? 0) : (w?.dialsBeforeClose ?? 0)
    }
    return n
  }

  let adspendUsd: number | null = null
  let uniqueLinkClicks: number | null = null
  if (opts?.adId) {
    // Per-ad view: THIS ad's own spend + unique clicks over the window (from
    // cortana_ad_daily by Meta ad id), so the Adspend node and every cost-per-X
    // read correctly for the selected ad — not the account-wide total.
    try {
      const sb = createAdminClient()
      const { data, error } = await sb
        .from('cortana_ad_daily' as never)
        .select('spent, unique_clicks')
        .eq('platform_entity_id', opts.adId)
        .gte('day', range.startEtDate)
        .lte('day', range.endEtDate)
      if (error) throw new Error(error.message)
      const adRows = (data ?? []) as unknown as Array<{ spent: number | string | null; unique_clicks: number | string | null }>
      if (adRows.length > 0) {
        adspendUsd = adRows.reduce((a, r) => a + (Number(r.spent ?? 0) || 0), 0)
        uniqueLinkClicks = adRows.reduce((a, r) => a + (Number(r.unique_clicks ?? 0) || 0), 0)
      }
    } catch {
      adspendUsd = null
      uniqueLinkClicks = null
    }
  } else {
    try {
      const ads = await getAdsAggregateLive(clampAdsRange(range.startEtDate, range.endEtDate))
      adspendUsd = ads.find((m) => m.id === 'adspend')?.value ?? null
      uniqueLinkClicks = ads.find((m) => m.id === 'unique-clicks')?.value ?? null
    } catch {
      adspendUsd = null
      uniqueLinkClicks = null
    }
  }

  const total: TotalBox = {
    optIns: cycles.length,
    dials: dialsFor(null),
    connected: countCyc(null, 'connected'),
    books: countCyc(null, 'booked'),
    confirms: countCyc(null, 'confirmed'),
    shows: countCyc(null, 'showed'),
    ...closesCyc(null),
    dcCloses: dcClosesCyc(null),
  }
  const direct: DirectBox = {
    // ALL qualified opt-in cycles (the pool eligible to book a direct strat
    // call), NOT just the ones that booked — so Booked reads as a subset of it.
    qualifiedOptIns: qual(null, 'qualified'),
    dials: dialsFor('direct'),
    books: countCyc('direct', 'booked'),
    connected: countCyc('direct', 'connected'),
    confirms: countCyc('direct', 'confirmed'),
    shows: countCyc('direct', 'showed'),
    ...closesCyc('direct'),
    dcCloses: dcClosesCyc('direct'),
  }
  const setter: PoolFunnelBox = {
    pool: poolCyc('setter'),
    qualified: qual('setter', 'qualified'),
    unqualified: qual('setter', 'non-qualified'),
    dials: dialsFor('setter'),
    connected: countCyc('setter', 'connected'),
    books: countCyc('setter', 'booked'),
    shows: countCyc('setter', 'showed'),
    ...closesCyc('setter'),
    dcCloses: dcClosesCyc('setter'),
  }
  // Reactivation cross-cuts (a reactivated lead is also in Direct or Opt-in);
  // every stage is the POST-handover (reactive) phase only.
  const reactivation: PoolFunnelBox = {
    pool: poolCyc('reactivation'),
    qualified: qual('reactivation', 'qualified'),
    unqualified: qual('reactivation', 'non-qualified'),
    dials: dialsFor('reactivation', true),
    connected: countCyc('reactivation', 'connected'),
    books: countCyc('reactivation', 'booked'),
    shows: countCyc('reactivation', 'showed'),
    ...closesCyc('reactivation'),
    dcCloses: dcClosesCyc('reactivation'),
  }

  const funnel: LeadsFunnel = { adspendUsd, uniqueLinkClicks, total, direct, setter, reactivation, warnings: [] }
  funnel.warnings = validateFunnel(funnel, cycles.length, new Set(cycles.map((c) => c.closeId)).size)
  return funnel
}
