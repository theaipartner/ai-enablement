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
export type TotalBox = {
  optIns: number; dials: number; connected: number; books: number; shows: number
  closes: number; closesHt: number; closesDc: number
}
export type DirectBox = {
  qualifiedOptIns: number; dials: number; books: number; connected: number; confirms: number; shows: number
  closes: number; closesHt: number; closesDc: number
}
export type PoolFunnelBox = {
  pool: number; qualified: number; unqualified: number
  dials: number; connected: number; books: number; shows: number
  closes: number; closesHt: number; closesDc: number
}

export type LeadsFunnel = {
  adspendUsd: number | null
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
export function validateFunnel(f: LeadsFunnel, rows: LeadRow[]): string[] {
  const w: string[] = []

  // (1) Per-lead-once: the cohort must have no duplicate lead rows (every box
  //     counts per row, so a dup row would double-count that lead everywhere).
  const seen = new Set<string>()
  let dups = 0
  for (const r of rows) {
    if (seen.has(r.leadId)) dups++
    else seen.add(r.leadId)
  }
  if (dups > 0) w.push(`${dups} duplicate lead row(s) in the cohort — leads would double-count.`)

  // (2) Monotonicity: within each box a later stage can't exceed an earlier one.
  //     (Total is the exception — Books MAY exceed Connected by design, since a
  //     self-booked direct lead is booked but not connected — so Total checks
  //     the two chains that DO hold rather than one straight ladder.)
  const chain = (label: string, ...seq: [string, number][]) => {
    for (let i = 1; i < seq.length; i++) {
      if (seq[i][1] > seq[i - 1][1]) {
        w.push(`${label}: ${seq[i][0]} (${seq[i][1]}) > ${seq[i - 1][0]} (${seq[i - 1][1]}).`)
      }
    }
  }
  chain('Total', ['opt-ins', f.total.optIns], ['connected', f.total.connected], ['shows', f.total.shows], ['closes', f.total.closes])
  chain('Total', ['opt-ins', f.total.optIns], ['books', f.total.books], ['shows', f.total.shows])
  chain('Direct', ['books', f.direct.books], ['connected', f.direct.connected], ['confirms', f.direct.confirms], ['shows', f.direct.shows], ['closes', f.direct.closes])
  chain('Setter', ['pool', f.setter.pool], ['connected', f.setter.connected], ['books', f.setter.books], ['shows', f.setter.shows], ['closes', f.setter.closes])
  chain('Reactivation', ['pool', f.reactivation.pool], ['connected', f.reactivation.connected], ['books', f.reactivation.books], ['shows', f.reactivation.shows], ['closes', f.reactivation.closes])

  // (3) Partition: every lead is exactly one of Direct or Setter, so the two
  //     pools must sum to the whole cohort.
  if (f.direct.books + f.setter.pool !== f.total.optIns) {
    w.push(`Partition: Direct (${f.direct.books}) + Setter (${f.setter.pool}) ≠ opt-ins (${f.total.optIns}) — a lead is mis-bucketed or counted in both.`)
  }
  // (4) Reactivation ⊂ Direct — the reactive pool can't exceed direct bookings.
  if (f.reactivation.pool > f.direct.books) {
    w.push(`Reactivation pool (${f.reactivation.pool}) > Direct books (${f.direct.books}) — reactivation should be a subset of direct.`)
  }
  return w
}

// ── Funnel membership + stage predicates (the SINGLE source of truth) ──────────
// The funnel boxes below AND the /leads roster filter both go through these, so
// a funnel bar's count always equals the roster it filters to when clicked.

// Lead-type filter values. 'direct' INCLUDES reactivation (reactivation ⊂
// direct — a reactivated lead is still originally a direct booking), matching
// the Direct funnel box. 'reactivation' is the post-handover subset; 'setter'
// (a.k.a. opt-in) is everyone who never booked the strat link.
export type LeadFilterType = 'direct' | 'setter' | 'reactivation'
export type FunnelStage = 'connected' | 'booked' | 'confirmed' | 'showed' | 'closed'

export const isDirect = (r: LeadRow): boolean => r.hasDirect || r.reactivatedAt !== null
export const isReact = (r: LeadRow): boolean => r.reactivatedAt !== null
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
  if (type === 'reactivation') {
    switch (stage) {
      case 'connected': return r.reactConnected || r.reactBooked || r.reactShowed || r.reactClosed
      case 'booked': return r.reactBooked || r.reactShowed || r.reactClosed
      case 'confirmed': return false // reactive funnel has no Confirmed stage
      case 'showed': return r.reactShowed || r.reactClosed
      case 'closed': return r.reactClosed
    }
  }
  if (type === 'direct') {
    switch (stage) {
      case 'connected': return r.connected || r.confirmed || r.showed || r.closed
      case 'booked': return true // every direct lead has booked, by definition
      case 'confirmed': return r.confirmed || r.showed || r.closed
      case 'showed': return r.showed || r.closed
      case 'closed': return r.closed
    }
  }
  if (type === 'setter') {
    switch (stage) {
      // Setter connected = a setter booking (hasPartnership) counts, plus the
      // raw connect / show / close. This is connectedEffective.
      case 'connected': return r.connectedEffective
      case 'booked': return r.hasPartnership || r.showed || r.closed
      case 'confirmed': return false // setter funnel has no Confirmed stage
      case 'showed': return r.showed || r.closed
      case 'closed': return r.closed
    }
  }
  // Total (all leads).
  const booked = r.hasDirect || r.hasPartnership
  switch (stage) {
    // A PURE DIRECT booking is NOT a connection, so Connected uses
    // connectedEffective (which excludes hasDirect) while Booked includes it —
    // Books can therefore exceed Connected in Total, by design.
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

export async function getLeadsFunnel(rows: LeadRow[], range: DateRange): Promise<LeadsFunnel> {
  const win = await scanDialWindows(
    rows.map((r) => ({ leadId: r.leadId, optInAt: r.optInAt, reactivatedAt: r.reactivatedAt, closeTimeIso: r.closeTimeIso })),
  )
  const dials = (r: LeadRow) => win.get(r.leadId)?.dialsBeforeClose ?? 0
  const postDials = (r: LeadRow) => win.get(r.leadId)?.postReactDials ?? 0

  const sum = (pred: (r: LeadRow) => boolean, val: (r: LeadRow) => number) =>
    rows.reduce((acc, r) => (pred(r) ? acc + val(r) : acc), 0)
  const count = (pred: (r: LeadRow) => boolean) => rows.reduce((acc, r) => (pred(r) ? acc + 1 : acc), 0)
  // Closes split by offer for a given funnel type: a lead that reached the
  // closed stage, counted into ht/dc by its closeType.
  const closesOf = (type: LeadFilterType | null, member: (r: LeadRow) => boolean = () => true) => {
    let ht = 0, dc = 0
    for (const r of rows) {
      if (!member(r) || !reachedStage(r, type, 'closed')) continue
      if (r.closeType === 'dc') dc++
      else ht++ // 'ht' or null (a close with unknown offer falls to HT)
    }
    return { closes: ht + dc, closesHt: ht, closesDc: dc }
  }

  // Adspend for the window (Meta mirror). Provisional/empty → null.
  let adspendUsd: number | null = null
  try {
    const ads = await getAdsAggregateLive(clampAdsRange(range.startEtDate, range.endEtDate))
    adspendUsd = ads.find((m) => m.id === 'adspend')?.value ?? null
  } catch {
    adspendUsd = null
  }

  // Every box's stage counts go through reachedStage (the shared predicate), so
  // a bar's count equals exactly the roster it filters to when clicked. Stages
  // are cumulative/monotonic: a later stage back-fills the earlier ones, and
  // "connected" is form-OR-call, so books never exceed connected.
  const total: TotalBox = {
    optIns: rows.length,
    dials: sum(() => true, dials),
    connected: count((r) => reachedStage(r, null, 'connected')),
    books: count((r) => reachedStage(r, null, 'booked')),
    shows: count((r) => reachedStage(r, null, 'showed')),
    ...closesOf(null),
  }

  // Direct funnel — each stage counted ONCE per lead and CUMULATIVE: reaching a
  // later stage implies every earlier one, so the ladder is monotonic
  // (books ≥ connected ≥ confirms ≥ shows ≥ closes). A lead that confirmed in
  // direct, fell through to reactive, then showed/closed still reads
  // Booked·Confirmed·Showed·Closed here. Why each later stage back-fills the
  // earlier ones rather than relying on the raw flag:
  //   - confirmed: confirmation allows a sub-90s call (§5.2), and a showed/closed
  //     lead necessarily confirmed — so showed/closed back-fill confirms.
  //   - connected: a strat-call show/close is a Calendly/Zoom meeting, not a ≥90s
  //     close_calls outbound dial, so anyCallConnected is often false for leads
  //     who clearly engaged — confirmed/showed/closed back-fill connected to keep
  //     the rendered ladder from inverting.
  // A reactive re-book never adds a second direct Booked (books = count(isDirect),
  // one per lead). showed/closed are optInAt-scoped, so post-reactivation
  // outcomes already count here (they're originally direct leads).
  const direct: DirectBox = {
    qualifiedOptIns: count((r) => r.qualified === 'qualified'),
    dials: sum(isDirect, dials),
    books: count((r) => isDirect(r) && reachedStage(r, 'direct', 'booked')),
    connected: count((r) => isDirect(r) && reachedStage(r, 'direct', 'connected')),
    confirms: count((r) => isDirect(r) && reachedStage(r, 'direct', 'confirmed')),
    shows: count((r) => isDirect(r) && reachedStage(r, 'direct', 'showed')),
    ...closesOf('direct', isDirect),
  }

  const setter: PoolFunnelBox = {
    pool: count(isSetter),
    qualified: count((r) => isSetter(r) && r.qualified === 'qualified'),
    unqualified: count((r) => isSetter(r) && r.qualified === 'non-qualified'),
    dials: sum(isSetter, dials),
    connected: count((r) => isSetter(r) && reachedStage(r, 'setter', 'connected')),
    books: count((r) => isSetter(r) && reachedStage(r, 'setter', 'booked')),
    shows: count((r) => isSetter(r) && reachedStage(r, 'setter', 'showed')),
    ...closesOf('setter', isSetter),
  }

  // Reactivation funnel — fully POST-handover: every stage counts only activity
  // after the lead lost its strat spot (reactivatedAt). dials/connected are
  // already post-react via scanDialWindows; books/shows/closes use the
  // post-react signals from leads.ts (a pre-handover partnership booking or
  // show/close belongs to Direct, not here). Cumulative + monotonic like the
  // Direct box: reaching a later stage back-fills the earlier ones
  // (books ≥ connected ≥ shows ≥ closes), so a post-react show/close that isn't
  // mirrored by a ≥90s dial or a captured partnership booking still reads
  // correctly rather than inverting the ladder.
  const reactivation: PoolFunnelBox = {
    pool: count(isReact),
    qualified: count((r) => isReact(r) && r.qualified === 'qualified'),
    unqualified: count((r) => isReact(r) && r.qualified === 'non-qualified'),
    dials: sum(isReact, postDials),
    connected: count((r) => isReact(r) && reachedStage(r, 'reactivation', 'connected')),
    books: count((r) => isReact(r) && reachedStage(r, 'reactivation', 'booked')),
    shows: count((r) => isReact(r) && reachedStage(r, 'reactivation', 'showed')),
    ...closesOf('reactivation', isReact),
  }

  const funnel: LeadsFunnel = { adspendUsd, total, direct, setter, reactivation, warnings: [] }
  funnel.warnings = validateFunnel(funnel, rows)
  return funnel
}
