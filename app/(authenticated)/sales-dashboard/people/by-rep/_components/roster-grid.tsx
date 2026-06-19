import Link from 'next/link'
import type { CallActivityResult, CallActivityRepRow } from '@/lib/db/funnel-appointment-setting'
import type { CloserScheduledResult, CloserScheduledAggregate } from '@/lib/db/funnel-closing'
import type { DigitalCollegeResult, DcAggregate } from '@/lib/db/funnel-digital-college'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'

// Talent · Roster (By Rep) — the per-person re-presentation of the existing
// Talent loaders. ONE block per human, keyed by Close user_id, unioning the
// setter row + closer row from Call Activity, the per-closer scheduled
// aggregate (showed / no-show / closed / cash), and the Digital College
// aggregate. No new data: this reads the exact same loader output the /people
// page reads, merged and reshaped. Drilldowns are NOT on the card — they live
// on the per-person detail view (?rep=) which reuses the existing tables.

export type RosterPerson = {
  userId: string
  name: string
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
): RosterPerson[] {
  const map = new Map<string, RosterPerson>()
  const ensure = (userId: string, name: string | null): RosterPerson => {
    let p = map.get(userId)
    if (!p) {
      p = {
        userId,
        name: name ?? userId,
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

  return all.filter((p) => p.score > 0).sort((a, b) => b.score - a.score)
}

// ---------------------------------------------------------------------------

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
}

function RoleChip({ label }: { label: string }) {
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 9,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-3)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 4,
        padding: '2px 6px',
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  )
}

function Stat({ label, value, accent }: { label: string; value: string | number; accent?: boolean }) {
  return (
    <div style={{ minWidth: 0 }}>
      <div
        className="geg-mono"
        style={{
          fontSize: 9,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-faint)',
          marginBottom: 3,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {label}
      </div>
      <div
        className="geg-numeric-serif"
        style={{
          fontSize: 17,
          lineHeight: '20px',
          letterSpacing: '-0.02em',
          color: accent ? 'var(--color-geg-accent)' : 'var(--color-geg-text)',
        }}
      >
        {value}
      </div>
    </div>
  )
}

function StatGroup({ eyebrow, children }: { eyebrow: string; children: React.ReactNode }) {
  return (
    <div>
      <div
        className="geg-mono"
        style={{
          fontSize: 9,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
          marginBottom: 8,
        }}
      >
        {eyebrow}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(58px, 1fr))', gap: '12px 14px' }}>
        {children}
      </div>
    </div>
  )
}

function PersonCard({ person, windowQs }: { person: RosterPerson; windowQs: string }) {
  const fam = person.isCloser ? 'closer' : 'setter'
  const qs = [windowQs, `rep=${encodeURIComponent(person.userId)}`, `repfam=${fam}`]
    .filter(Boolean)
    .join('&')

  const chips: string[] = []
  if (person.isSetter) chips.push('Setter')
  if (person.isCloser) chips.push('Closer')
  if (person.isDc) chips.push('Digital College')

  return (
    <Link
      href={`?${qs}`}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        padding: '20px 22px 22px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 12,
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <div
          className="geg-mono"
          style={{
            flexShrink: 0,
            width: 40,
            height: 40,
            borderRadius: '50%',
            background: 'var(--color-geg-bg)',
            border: '1px solid var(--color-geg-border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 13,
            letterSpacing: '0.04em',
            color: 'var(--color-geg-text-2)',
          }}
        >
          {initials(person.name)}
        </div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div
            className="geg-serif"
            style={{
              fontSize: 17,
              lineHeight: 1.1,
              color: 'var(--color-geg-text)',
              letterSpacing: '-0.01em',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {person.name}
          </div>
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
            {chips.map((c) => (
              <RoleChip key={c} label={c} />
            ))}
          </div>
        </div>
      </div>

      {/* Top-line dials / connected (only when the person has call activity) */}
      {person.setter || person.closer ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 14 }}>
          <Stat label="Dials" value={person.dials} accent />
          <Stat label="Connected" value={person.connected} />
        </div>
      ) : null}

      {/* Role-scoped stat groups */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {person.setter ? (
          <StatGroup eyebrow="Setting">
            <Stat label="HT Book" value={person.setter.htBookings} />
            <Stat label="DC Book" value={person.setter.dcBookings} />
            <Stat label="DC Close" value={person.setter.dcCloses} />
            <Stat label="Pipeline" value={person.setter.followUps} />
            <Stat label="DQ" value={person.setter.dqs} />
          </StatGroup>
        ) : null}

        {person.closer ? (
          <StatGroup eyebrow="Confirming">
            <Stat label="Confirmed" value={person.closer.confirmedBooks} />
            <Stat label="Resched" value={person.closer.confirmedNewTime} />
            <Stat label="Downsold" value={person.closer.downsellsOnCall} />
            <Stat label="Pipeline" value={person.closer.followUps} />
            <Stat label="DQ" value={person.closer.dqs} />
          </StatGroup>
        ) : null}

        {person.scheduled ? (
          <StatGroup eyebrow="Closing">
            <Stat label="Scheduled" value={person.scheduled.calls} />
            <Stat label="Showed" value={person.scheduled.showed} />
            <Stat label="No-show" value={person.scheduled.noShows} />
            <Stat label="Closed" value={person.scheduled.closed} />
            <Stat label="Upfront" value={compactUsd(person.scheduled.upfront)} />
          </StatGroup>
        ) : null}

        {person.dc ? (
          <StatGroup eyebrow="Digital College">
            <Stat label="DC Dials" value={person.dc.dials} />
            <Stat label="Meetings" value={person.dc.meetings} />
            <Stat label="Shows" value={person.dc.shows} />
            <Stat label="Closes" value={person.dc.closes} />
          </StatGroup>
        ) : null}
      </div>
    </Link>
  )
}

export function RosterGrid({ people, windowQs }: { people: RosterPerson[]; windowQs: string }) {
  if (people.length === 0) {
    return (
      <div
        className="geg-serif"
        style={{ padding: '48px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 15 }}
      >
        No rep activity in this range.
      </div>
    )
  }
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
        gap: 16,
        alignItems: 'start',
      }}
    >
      {people.map((p) => (
        <PersonCard key={p.userId} person={p} windowQs={windowQs} />
      ))}
    </div>
  )
}
