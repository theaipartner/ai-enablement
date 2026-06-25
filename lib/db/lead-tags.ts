import 'server-only'

import { cache } from 'react'
import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'

// Reader for the persistent lead-tag system (lead_cycles / lead_cycle_stages,
// written by shared/lead_tagging.py). The ONE place the dashboard reads tags, so
// the funnel / roster / per-lead surfaces can't drift. Replaces the live-compute
// in leads.ts / leads-funnel.ts / lead-detail.ts.
//
// Roster + funnel notes (Drake 2026-06-02):
//   - Roster is ONE ROW PER PERSON, scoped to the CURRENT (latest) opt-in cycle.
//   - Funnel counts PER CYCLE (a re-opt is counted again) — see getLeadTagRows
//     which returns one row per cycle; the roster collapses to the latest.
//   - Status   = furthest stage in the CURRENT PHASE (reactive floor 'Eligible',
//                DQ overrides). "Where are they now."
//   - Latest   = furthest across BOTH phases of the current cycle. "Best this
//                cycle." Neither looks at prior cycles.
//   - HT-only: closed stages are HT closes; DC is excluded (DQ tag + reactive
//     block only), so a DC-closed lead reads its furthest HT stage, not "closed".

export type Phase = 'primary' | 'reactive'

export type CycleStages = {
  connectedAt: string | null
  bookedAt: string | null
  confirmedAt: string | null
  showedAt: string | null
  closedAt: string | null
  closeType: 'ht' | 'dc' | null
  // Disposition events (migration 0098) — independent of the monotonic ladder
  // above; read ONLY by the Disposition column, never the funnel.
  noShowAt: string | null
  followUpAt: string | null
}

export type LeadCycle = {
  optInAt: string
  optInSeq: number
  source: string
  qualified: boolean | null
  becameDirectAt: string | null
  reactivatedAt: string | null
  reactiveSource: string | null
  dqAt: string | null
  dqSource: string | null
  dcClosedAt: string | null
  primary: CycleStages | null
  reactive: CycleStages | null
}

export type LeadType = 'direct' | 'optin' | 'reactivation' | 'dq'

// Per-cycle roster/funnel projection. The roster keeps the latest per close_id;
// the funnel counts every row.
export type LeadCycleRow = {
  closeId: string
  optInAt: string
  optInSeq: number
  optInCount: number
  firstOptInAt: string
  latestOptInAt: string
  reOptIn: boolean
  leadType: LeadType
  connected: boolean
  statusWord: string
  latestStageWord: string
  closeType: 'ht' | 'dc' | null
  // Close MEETING time (lead_cycle_stages.closed_at = the closer form's
  // date_time_of_call) across phases, earliest. Caps the roster/funnel dial
  // count at the close. null = not closed. Uses the tagger's complete close
  // definition (all closer forms incl. old-format), so it caps old-format closes
  // the legacy New-form-only cap missed.
  closeTimeIso: string | null
  // Per-cycle qualification from the Typeform investment answer (>= $2k). The
  // roster's qualified column reads this (not close_leads.marketing_qualified).
  qualified: boolean | null
  // Digital College close (excluded from the HT stages) — for the per-box DC line.
  dcClosed: boolean
  // Funnel/filter primitives — the per-phase stage hits + membership flags, so
  // reachedStage/matchesType (below) can count this cycle in any box.
  becameDirect: boolean
  reactivatedAt: string | null
  // 'cold' | 'partnership_rebook' — how the lead reactivated. The funnel's
  // reactivation dial rule treats partnership_rebook specially (counts the
  // rebook-driving dial just before the anchor; see leads-funnel.ts).
  reactiveSource: string | null
  primaryHits: StageHits
  reactiveHits: StageHits | null
}

export type StageHits = { connected: boolean; booked: boolean; confirmed: boolean; showed: boolean; closed: boolean }
export type FunnelStage = 'connected' | 'booked' | 'confirmed' | 'showed' | 'closed'
export type LeadFilterType = 'direct' | 'setter' | 'reactivation'

function stageHits(s: CycleStages | null): StageHits {
  return {
    connected: !!s?.connectedAt, booked: !!s?.bookedAt, confirmed: !!s?.confirmedAt,
    showed: !!s?.showedAt, closed: !!s?.closedAt,
  }
}

// Has this CYCLE reached `stage` within funnel `type`? (cumulative — the tagger's
// per-phase hits are already monotonic). null type = Total. Direct/opt-in count
// the furthest across BOTH phases (a post-handover show still counts for the
// direct lineage); reactivation counts the POST-handover (reactive) phase only.
export function reachedStage(row: LeadCycleRow, type: LeadFilterType | null, stage: FunnelStage): boolean {
  const P = row.primaryHits
  const R = row.reactiveHits
  if (type === 'reactivation') {
    if (stage === 'confirmed') return false // reactive funnel has no Confirmed node
    return !!R?.[stage]
  }
  // direct / setter(opt-in) / total — max across phases.
  return P[stage] || !!R?.[stage]
}

// Does this cycle belong to the given funnel type? direct = became direct;
// reactivation = lost its spot; setter(opt-in) = never went direct. null = Total.
export function matchesType(row: LeadCycleRow, type: LeadFilterType | null): boolean {
  if (type === 'direct') return row.becameDirect
  if (type === 'reactivation') return row.reactivatedAt !== null
  if (type === 'setter') return !row.becameDirect
  return true
}

function closedWord(t: 'ht' | 'dc' | null): string {
  return t === 'dc' ? 'Digital College' : t === 'ht' ? 'High Ticket' : 'Closed'
}

// Furthest stage in a single phase's stages → a display word, or null if nothing.
function phaseFurthest(s: CycleStages | null): string | null {
  if (!s) return null
  if (s.closedAt) return closedWord(s.closeType)
  if (s.showedAt) return 'Showed'
  if (s.confirmedAt) return 'Confirmed'
  if (s.bookedAt) return 'Booked'
  if (s.connectedAt) return 'Connected'
  return null
}

// leadType colour precedence: dq > reactivation > direct > optin. dq is
// suppressed by an HT close in the cycle (close-overrides-dq); DC never enters
// the stages so a DC-closed lead with a dq tag still reads dq (intended).
function deriveType(c: LeadCycle): { leadType: LeadType; isDq: boolean } {
  const htClosed = !!(c.primary?.closedAt || c.reactive?.closedAt)
  const isDq = !!c.dqAt && !htClosed
  if (isDq) return { leadType: 'dq', isDq }
  if (c.reactivatedAt) return { leadType: 'reactivation', isDq }
  if (c.becameDirectAt) return { leadType: 'direct', isDq }
  return { leadType: 'optin', isDq }
}

// Status = furthest in the CURRENT phase (reactive if reactivated, else primary),
// with the reactive floor 'Eligible' and DQ override.
function statusWord(c: LeadCycle): string {
  const { isDq } = deriveType(c)
  if (isDq) return 'DQ'
  if (c.reactivatedAt) return phaseFurthest(c.reactive) ?? 'Eligible'
  return phaseFurthest(c.primary) ?? '—'
}

// Disposition = the LATEST disposition by timestamp across both phases, plus the
// cycle-level DQ and the opt-in baseline (Drake 2026-06-24: a later DQ / booking /
// no-show changes how the lead reads — it's the most-recent state, not the
// furthest stage). No-show + follow-up (migration 0098) slot in by their own
// event time. Ties — the tagger back-fills connected/booked/confirmed to the
// show/close instant — break by ladder rank, so a closed lead reads its close,
// not a back-filled "Connected". Display-only; never feeds the funnel.
const DISPOSITION_RANK: Record<string, number> = {
  'Opted in': 0, Connected: 1, Booked: 2, 'No-show': 3, Confirmed: 4,
  Showed: 5, 'Follow-up': 6, Dequeued: 7,
  Closed: 8, 'High Ticket': 8, 'Digital College': 8,
}
function latestStageWord(c: LeadCycle): string {
  const events: Array<[string, string]> = []
  const add = (t: string | null, word: string) => { if (t) events.push([t, word]) }
  for (const s of [c.primary, c.reactive]) {
    if (!s) continue
    add(s.closedAt, closedWord(s.closeType))
    add(s.followUpAt, 'Follow-up')
    add(s.showedAt, 'Showed')
    add(s.noShowAt, 'No-show')
    add(s.confirmedAt, 'Confirmed')
    add(s.bookedAt, 'Booked')
    add(s.connectedAt, 'Connected')
  }
  add(c.dqAt, 'Dequeued')
  add(c.optInAt, 'Opted in')
  // Latest timestamp wins; equal timestamps break by ladder rank (more advanced).
  events.sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : (DISPOSITION_RANK[a[1]] ?? 0) - (DISPOSITION_RANK[b[1]] ?? 0),
  )
  return events.length ? events[events.length - 1][1] : 'Opted in'
}

function isConnected(c: LeadCycle): boolean {
  return !!(c.primary?.connectedAt || c.reactive?.connectedAt)
}

const CYCLE_COLS =
  'close_id, opt_in_at, opt_in_seq, source, qualified, became_direct_at, reactive_at, reactive_source, dq_at, dq_source, dc_closed_at'
const STAGE_COLS =
  'close_id, opt_in_at, phase, connected_at, booked_at, confirmed_at, showed_at, closed_at, close_type, no_show_at, follow_up_at'
// IN-list chunk size. Keeps the PostgREST GET URL well under length limits
// (~200 close_ids ≈ 5 KB) while collapsing the old per-lead round-trips.
const ID_CHUNK = 200

type RawCycle = Record<string, string | number | boolean | null>
type RawStage = Record<string, string | null>

// Pure mapper: cycle rows + that lead's stage rows -> LeadCycle[]. The stage
// key (opt_in_at|phase) is unique WITHIN one lead, so this must be called
// per-lead (never across leads, whose opt_in_at values can collide).
function buildCycles(cycleRows: RawCycle[], stageRows: RawStage[]): LeadCycle[] {
  const byCyclePhase = new Map<string, CycleStages>()
  for (const s of stageRows) {
    byCyclePhase.set(`${s.opt_in_at}|${s.phase}`, {
      connectedAt: s.connected_at, bookedAt: s.booked_at, confirmedAt: s.confirmed_at,
      showedAt: s.showed_at, closedAt: s.closed_at, closeType: s.close_type as 'ht' | 'dc' | null,
      noShowAt: s.no_show_at, followUpAt: s.follow_up_at,
    })
  }
  return cycleRows.map((c) => ({
    optInAt: c.opt_in_at as string,
    optInSeq: c.opt_in_seq as number,
    source: c.source as string,
    qualified: (c.qualified as boolean | null) ?? null,
    becameDirectAt: (c.became_direct_at as string) ?? null,
    reactivatedAt: (c.reactive_at as string) ?? null,
    reactiveSource: (c.reactive_source as string) ?? null,
    dqAt: (c.dq_at as string) ?? null,
    dqSource: (c.dq_source as string) ?? null,
    dcClosedAt: (c.dc_closed_at as string) ?? null,
    primary: byCyclePhase.get(`${c.opt_in_at}|primary`) ?? null,
    reactive: byCyclePhase.get(`${c.opt_in_at}|reactive`) ?? null,
  }))
}

// Load every cycle (with both phase stage-rows) for one lead, newest cycle first.
export async function getLeadCycles(closeId: string): Promise<LeadCycle[]> {
  const sb = createAdminClient()
  const { data: cyc, error } = await sb
    .from('lead_cycles' as never)
    .select(CYCLE_COLS)
    .eq('close_id', closeId)
    .order('opt_in_at', { ascending: false })
  if (error) throw new Error(`lead-tags: cycles read failed: ${error.message}`)
  const cycleRows = (cyc ?? []) as unknown as RawCycle[]
  if (cycleRows.length === 0) return []

  const { data: st, error: stErr } = await sb
    .from('lead_cycle_stages' as never)
    .select(STAGE_COLS)
    .eq('close_id', closeId)
  if (stErr) throw new Error(`lead-tags: stages read failed: ${stErr.message}`)
  return buildCycles(cycleRows, (st ?? []) as unknown as RawStage[])
}

// Batched equivalent of getLeadCycles for MANY leads: two chunked IN-queries
// (cycles + stages) instead of 2 round-trips per lead. Returns cid ->
// LeadCycle[] (newest cycle first, matching getLeadCycles' contract).
async function getLeadCyclesByIds(ids: string[]): Promise<Map<string, LeadCycle[]>> {
  const sb = createAdminClient()
  const cycleRows: RawCycle[] = []
  const stageRows: RawStage[] = []
  for (let i = 0; i < ids.length; i += ID_CHUNK) {
    const chunk = ids.slice(i, i + ID_CHUNK)
    const [cycRes, stRes] = await Promise.all([
      sb.from('lead_cycles' as never).select(CYCLE_COLS).in('close_id', chunk),
      sb.from('lead_cycle_stages' as never).select(STAGE_COLS).in('close_id', chunk),
    ])
    if (cycRes.error) throw new Error(`lead-tags: cycles batch read failed: ${cycRes.error.message}`)
    if (stRes.error) throw new Error(`lead-tags: stages batch read failed: ${stRes.error.message}`)
    cycleRows.push(...((cycRes.data ?? []) as unknown as RawCycle[]))
    stageRows.push(...((stRes.data ?? []) as unknown as RawStage[]))
  }
  const cyclesByLead = new Map<string, RawCycle[]>()
  for (const r of cycleRows) {
    const cid = r.close_id as string
    const arr = cyclesByLead.get(cid)
    if (arr) arr.push(r); else cyclesByLead.set(cid, [r])
  }
  const stagesByLead = new Map<string, RawStage[]>()
  for (const s of stageRows) {
    const cid = s.close_id as string
    const arr = stagesByLead.get(cid)
    if (arr) arr.push(s); else stagesByLead.set(cid, [s])
  }
  const out = new Map<string, LeadCycle[]>()
  cyclesByLead.forEach((crows, cid) => {
    // Newest cycle first, matching getLeadCycles' `order opt_in_at desc`.
    crows.sort((a, b) => String(b.opt_in_at).localeCompare(String(a.opt_in_at)))
    out.set(cid, buildCycles(crows, stagesByLead.get(cid) ?? []))
  })
  return out
}

// Per-cycle rows for all leads whose opt-in falls in the range. The funnel counts
// every row; the roster collapses to the latest cycle per close_id (see
// collapseToLatest). opt-in count / first / latest are per-lead (across cycles).
//
// Wrapped in React.cache so the funnel page's two callers (getLeadsForRange +
// getLeadsFunnel, same `range` object) share ONE computation per request.
export const getLeadCycleRows = cache(async (range: DateRange): Promise<LeadCycleRow[]> => {
  const sb = createAdminClient()
  // All cycles for leads that have ANY cycle in the window — so per-lead first/
  // latest/count are complete even when an earlier cycle predates the window.
  const { data: inWin } = await sb
    .from('lead_cycles' as never)
    .select('close_id')
    .gte('opt_in_at', range.startUtcIso)
    .lt('opt_in_at', range.endUtcIso)
  const ids = Array.from(new Set(((inWin ?? []) as unknown as Array<{ close_id: string }>).map((r) => r.close_id)))
  if (ids.length === 0) return []

  const byLead = await getLeadCyclesByIds(ids)
  const rows: LeadCycleRow[] = []
  for (const cid of ids) {
    const cycles = byLead.get(cid)
    if (!cycles || cycles.length === 0) continue
    const sorted = [...cycles].sort((a, b) => a.optInAt.localeCompare(b.optInAt))
    const firstOptInAt = sorted[0].optInAt
    const latestOptInAt = sorted[sorted.length - 1].optInAt
    const optInCount = sorted.length
    for (const c of cycles) {
      if (c.optInAt < range.startUtcIso || c.optInAt >= range.endUtcIso) continue
      const { leadType } = deriveType(c)
      rows.push({
        closeId: cid, optInAt: c.optInAt, optInSeq: c.optInSeq, optInCount,
        firstOptInAt, latestOptInAt, reOptIn: optInCount > 1,
        leadType, connected: isConnected(c),
        statusWord: statusWord(c), latestStageWord: latestStageWord(c),
        closeType: c.primary?.closeType || c.reactive?.closeType || null,
        qualified: c.qualified,
        closeTimeIso: (() => {
          // HT close (stage closed_at) OR DC close (dc_closed_at) — the dial cap
          // covers BOTH offers, mirroring leads.ts's HT-or-DC closeTime. The
          // tagger's closed_at is HT-only, so dcClosedAt must be folded in or DC
          // closes would lose their cap.
          const t = [c.primary?.closedAt, c.reactive?.closedAt, c.dcClosedAt].filter((x): x is string => !!x)
          return t.length ? t.slice().sort()[0] : null
        })(),
        dcClosed: !!c.dcClosedAt,
        becameDirect: !!c.becameDirectAt,
        reactivatedAt: c.reactivatedAt,
        reactiveSource: c.reactiveSource,
        primaryHits: stageHits(c.primary),
        reactiveHits: c.reactive ? stageHits(c.reactive) : null,
      })
    }
  }
  return rows
})

// Roster view: one row per person = their LATEST in-window cycle.
export function collapseToLatest(rows: LeadCycleRow[]): LeadCycleRow[] {
  const latest = new Map<string, LeadCycleRow>()
  for (const r of rows) {
    const prev = latest.get(r.closeId)
    if (!prev || r.optInAt > prev.optInAt) latest.set(r.closeId, r)
  }
  return Array.from(latest.values())
}

// Helpers re-exported for the per-lead page's journey rendering.
export { phaseFurthest, deriveType, statusWord, latestStageWord, closedWord }
