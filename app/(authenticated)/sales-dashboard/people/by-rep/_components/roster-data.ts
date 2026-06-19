import type { CallActivityResult, CallActivityRepRow } from '@/lib/db/funnel-appointment-setting'
import type { CloserScheduledResult, CloserScheduledAggregate } from '@/lib/db/funnel-closing'
import type { DigitalCollegeResult, DcAggregate } from '@/lib/db/funnel-digital-college'

// Talent · Roster (By Rep) — data merge. Server-safe (no React), so it can be
// called from the server component while the grid that renders it is a client
// component. ONE record per human, keyed by Close user_id, unioning the setter
// row + closer row from Call Activity, the per-closer scheduled aggregate, and
// the Digital College aggregate. No new data: this reads the exact same loader
// output the /people page reads, merged and reshaped.

export type SalesRole = 'setter' | 'closer' | 'dc_closer' | 'other' | null

export type RosterPerson = {
  userId: string
  name: string
  active: boolean
  // Canonical role from team_members.sales_role — the single role the rep IS,
  // independent of which call families they happen to have activity in (a
  // closer who filed some triage forms is still just a closer). Drives the
  // single role chip + which crucial metrics the card surfaces.
  canonicalRole: SalesRole
  isSetter: boolean
  isCloser: boolean
  isDc: boolean
  setter: CallActivityRepRow | null
  closer: CallActivityRepRow | null
  scheduled: CloserScheduledAggregate | null
  dc: DcAggregate | null
  // Person-level rollups. Dials are total (identical across a both-rep's two
  // rows, so we take the max, not the sum); Connected is family-split, so a
  // both-rep's total connected is setter + closer.
  dials: number
  connected: number
  score: number
}

export function buildRoster(
  activity: CallActivityResult,
  scheduled: CloserScheduledResult,
  digitalCollege: DigitalCollegeResult,
  identity: Map<string, { active: boolean; role: SalesRole }>,
): RosterPerson[] {
  const map = new Map<string, RosterPerson>()
  const ensure = (userId: string, name: string | null): RosterPerson => {
    let p = map.get(userId)
    if (!p) {
      const id = identity.get(userId)
      p = {
        userId,
        name: name ?? userId,
        active: id?.active ?? false,
        canonicalRole: id?.role ?? null,
        isSetter: false,
        isCloser: false,
        isDc: false,
        setter: null,
        closer: null,
        scheduled: null,
        dc: null,
        dials: 0,
        connected: 0,
        score: 0,
      }
      map.set(userId, p)
    }
    // Prefer a real name over a bare user_id placeholder.
    if ((!p.name || p.name === p.userId) && name) p.name = name
    return p
  }

  for (const s of activity.setters) {
    if (!s.userId) continue
    const p = ensure(s.userId, s.name)
    p.setter = s
    p.isSetter = true
  }
  for (const c of activity.closers) {
    if (!c.userId) continue
    const p = ensure(c.userId, c.name)
    p.closer = c
    p.isCloser = true
  }
  for (const sc of scheduled.closers) {
    // 'ghost' = unresolved closer (not a real person) — skip it on the roster.
    if (!sc.closerKey || sc.closerKey === 'ghost') continue
    const p = ensure(sc.closerKey, sc.closerName)
    p.scheduled = sc
    p.isCloser = true
  }
  for (const d of digitalCollege.closers) {
    if (!d.closerKey) continue
    const p = ensure(d.closerKey, d.closerName)
    p.dc = d
    p.isDc = true
  }

  const all = Array.from(map.values())
  for (const p of all) {
    p.dials = Math.max(p.setter?.totalCalls ?? 0, p.closer?.totalCalls ?? 0)
    p.connected = (p.setter?.totalConnected ?? 0) + (p.closer?.totalConnected ?? 0)
    p.score =
      p.dials +
      p.connected +
      (p.scheduled?.calls ?? 0) +
      (p.scheduled?.closed ?? 0) * 5 +
      (p.dc?.dials ?? 0) +
      (p.dc?.meetings ?? 0) +
      (p.dc?.closes ?? 0) * 5
  }

  // Active reps first, then by activity score. (The grid hides inactive by
  // default; this ordering keeps the shown set stable when the toggle flips.)
  return all
    .filter((p) => p.score > 0)
    .sort((a, b) => Number(b.active) - Number(a.active) || b.score - a.score)
}
