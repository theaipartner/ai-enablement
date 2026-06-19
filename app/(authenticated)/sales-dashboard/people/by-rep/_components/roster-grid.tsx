'use client'

import { useState } from 'react'
import Link from 'next/link'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import type { RosterPerson } from './roster-data'

// Talent · Roster (By Rep) — the per-person card grid. One block per rep;
// click a block to open the per-person detail view (?rep=). Inactive reps are
// hidden by default; the "Show inactive" toggle reveals them. All blocks are
// rendered equal-height (grid-auto-rows: 1fr + card height: 100%).

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
        height: '100%',
        padding: '20px 22px 22px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 12,
        textDecoration: 'none',
        color: 'inherit',
        opacity: person.active ? 1 : 0.7,
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
          <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap', alignItems: 'center' }}>
            {chips.map((c) => (
              <RoleChip key={c} label={c} />
            ))}
            {!person.active ? <RoleChip label="Inactive" /> : null}
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
  const [showInactive, setShowInactive] = useState(false)

  const activeCount = people.filter((p) => p.active).length
  const inactiveCount = people.length - activeCount
  const shown = showInactive ? people : people.filter((p) => p.active)

  return (
    <div>
      {/* Toggle bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 18, gap: 12 }}>
        <div
          className="geg-mono"
          style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}
        >
          {activeCount} active{inactiveCount > 0 ? ` · ${inactiveCount} inactive` : ''}
        </div>
        <button
          type="button"
          onClick={() => setShowInactive((v) => !v)}
          className="geg-mono"
          aria-pressed={showInactive}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            padding: '7px 12px',
            background: showInactive ? 'var(--color-geg-accent-fill)' : 'transparent',
            border: `1px solid ${showInactive ? 'var(--color-geg-accent)' : 'var(--color-geg-border-strong)'}`,
            borderRadius: 6,
            fontSize: 11,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: showInactive ? 'var(--color-geg-accent)' : 'var(--color-geg-text-3)',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <span
            style={{
              width: 26,
              height: 14,
              borderRadius: 8,
              background: showInactive ? 'var(--color-geg-accent)' : 'var(--color-geg-border-strong)',
              position: 'relative',
              flexShrink: 0,
              transition: 'background 120ms ease',
            }}
          >
            <span
              style={{
                position: 'absolute',
                top: 2,
                left: showInactive ? 14 : 2,
                width: 10,
                height: 10,
                borderRadius: '50%',
                background: 'var(--color-geg-bg-elev)',
                transition: 'left 120ms ease',
              }}
            />
          </span>
          Show inactive
        </button>
      </div>

      {shown.length === 0 ? (
        <div
          className="geg-serif"
          style={{ padding: '48px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 15 }}
        >
          No rep activity in this range.
        </div>
      ) : (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))',
            gridAutoRows: '1fr',
            gap: 16,
            alignItems: 'stretch',
          }}
        >
          {shown.map((p) => (
            <PersonCard key={p.userId} person={p} windowQs={windowQs} />
          ))}
        </div>
      )}
    </div>
  )
}
