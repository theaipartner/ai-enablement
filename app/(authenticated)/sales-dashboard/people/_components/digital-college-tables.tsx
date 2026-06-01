'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type { DcAggregate, DcDrillRow } from '@/lib/db/funnel-digital-college'

// Client-side per-rep aggregate + per-meeting drill for the Digital College
// (low-ticket) closer. Mirrors the per-closer closer-tables.tsx pattern:
// sortable aggregate, click-to-drill (?dccloser=NAME), sortable drill.
//
// Columns (aggregate): Closer · Dials · Meetings · Shows · Base44 (M/Y) ·
// Wix (M/Y) · Closes. "Base" on the form = Base44.

type SortDir = 'asc' | 'desc' | null
type SortState<K extends string> = { key: K; dir: SortDir }

function useColumnSort<T, K extends string>(
  rows: T[],
  getKey: (row: T, key: K) => number | string | null | undefined,
): { sorted: T[]; state: SortState<K>; onToggle: (key: K) => void } {
  const [state, setState] = useState<SortState<K>>({ key: '' as K, dir: null })
  const sorted = useMemo(() => {
    if (state.dir === null) return rows
    const copy = rows.slice()
    copy.sort((a, b) => {
      const va = getKey(a, state.key)
      const vb = getKey(b, state.key)
      const aMissing = va == null || va === ''
      const bMissing = vb == null || vb === ''
      if (aMissing && bMissing) return 0
      if (aMissing) return 1
      if (bMissing) return -1
      if (typeof va === 'number' && typeof vb === 'number') return state.dir === 'asc' ? va - vb : vb - va
      const sa = String(va).toLowerCase()
      const sb = String(vb).toLowerCase()
      if (sa === sb) return 0
      return state.dir === 'asc' ? (sa < sb ? -1 : 1) : sa < sb ? 1 : -1
    })
    return copy
  }, [rows, state, getKey])
  function onToggle(key: K) {
    setState((prev) => {
      if (prev.key !== key) return { key, dir: 'desc' }
      if (prev.dir === 'desc') return { key, dir: 'asc' }
      return { key: '' as K, dir: null }
    })
  }
  return { sorted, state, onToggle }
}

function SortableHeader<K extends string>({
  label, sortKey, align = 'right', state, onToggle,
}: {
  label: string; sortKey: K; align?: 'left' | 'right'; state: SortState<K>; onToggle: (key: K) => void
}) {
  const active = state.key === sortKey && state.dir !== null
  const arrow = active ? (state.dir === 'asc' ? '▲' : '▼') : ''
  return (
    <button
      type="button"
      onClick={() => onToggle(sortKey)}
      className="geg-mono"
      style={{
        background: 'none', border: 'none', padding: 0, fontSize: 10, letterSpacing: '0.14em',
        textTransform: 'uppercase', color: active ? 'var(--color-geg-text-2)' : 'var(--color-geg-text-faint)',
        textAlign: align, cursor: 'pointer', display: 'inline-flex', gap: 6, alignItems: 'baseline',
        justifyContent: align === 'left' ? 'flex-start' : 'flex-end', width: '100%', fontFamily: 'inherit',
      }}
    >
      <span>{label}</span>
      {arrow ? <span style={{ fontSize: 8 }}>{arrow}</span> : null}
    </button>
  )
}

type AggSortKey =
  | 'name' | 'dials' | 'meetings' | 'shows'
  | 'b44m' | 'b44y' | 'wixm' | 'wixy' | 'closes'

// Closer | Dials | Meetings | Shows | Base44 M | Base44 Y | Wix M | Wix Y | Closes
const AGG_COLS = '1.4fr 0.7fr 0.8fr 0.7fr 0.7fr 0.7fr 0.7fr 0.7fr 0.8fr'

export function DigitalCollegeTables({
  closers, aggregate, selectedCloser, drill, baseParams,
}: {
  closers: DcAggregate[]
  aggregate: DcAggregate
  selectedCloser: string | null
  drill: DcDrillRow[]
  baseParams: string
}) {
  const { sorted, state, onToggle } = useColumnSort<DcAggregate, AggSortKey>(closers, (r, k) => {
    switch (k) {
      case 'name': return r.closerName
      case 'dials': return r.dials
      case 'meetings': return r.meetings
      case 'shows': return r.shows
      case 'b44m': return r.base44Monthly
      case 'b44y': return r.base44Yearly
      case 'wixm': return r.wixMonthly
      case 'wixy': return r.wixYearly
      case 'closes': return r.closes
      default: return null
    }
  })

  return (
    <div>
      <div style={{ display: 'grid', gridTemplateColumns: AGG_COLS, gap: 10, padding: '6px 0 10px', borderBottom: '1px solid var(--color-geg-border)' }}>
        <SortableHeader label="Closer" sortKey="name" align="left" state={state} onToggle={onToggle} />
        <SortableHeader label="Dials" sortKey="dials" state={state} onToggle={onToggle} />
        <SortableHeader label="Meetings" sortKey="meetings" state={state} onToggle={onToggle} />
        <SortableHeader label="Shows" sortKey="shows" state={state} onToggle={onToggle} />
        <SortableHeader label="B44 Mo" sortKey="b44m" state={state} onToggle={onToggle} />
        <SortableHeader label="B44 Yr" sortKey="b44y" state={state} onToggle={onToggle} />
        <SortableHeader label="Wix Mo" sortKey="wixm" state={state} onToggle={onToggle} />
        <SortableHeader label="Wix Yr" sortKey="wixy" state={state} onToggle={onToggle} />
        <SortableHeader label="Closes" sortKey="closes" state={state} onToggle={onToggle} />
      </div>

      {/* Aggregate row */}
      <div style={{ display: 'grid', gridTemplateColumns: AGG_COLS, gap: 10, padding: '12px 0', borderBottom: '1px solid var(--color-geg-border)', alignItems: 'center' }}>
        <span className="geg-serif" style={{ fontSize: 14, fontStyle: 'italic', color: 'var(--color-geg-text-2)', letterSpacing: '-0.002em' }}>
          All DC closers
        </span>
        <Num value={aggregate.dials} />
        <Num value={aggregate.meetings} accent />
        <ShowsCell meetings={aggregate.meetings} shows={aggregate.shows} />
        <Num value={aggregate.base44Monthly} />
        <Num value={aggregate.base44Yearly} />
        <Num value={aggregate.wixMonthly} />
        <Num value={aggregate.wixYearly} />
        <Num value={aggregate.closes} accent />
      </div>

      {sorted.length === 0 ? (
        <div className="geg-serif" style={{ padding: '20px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 14 }}>
          No Digital College meetings in this range.
        </div>
      ) : (
        sorted.map((c) => {
          const isSelected = selectedCloser === c.closerName
          return (
            <div key={c.closerName}>
              <RowLink baseParams={baseParams} closerName={c.closerName} isSelected={isSelected}>
                <div
                  style={{
                    display: 'grid', gridTemplateColumns: AGG_COLS, gap: 10, padding: '12px 12px', margin: '0 -12px',
                    borderBottom: '1px dashed var(--color-geg-border)', alignItems: 'center',
                    background: isSelected ? 'var(--color-geg-bg)' : 'transparent', borderRadius: isSelected ? 6 : 0, cursor: 'pointer',
                  }}
                >
                  <span className="geg-serif" style={{ fontSize: 14, color: 'var(--color-geg-text)', letterSpacing: '-0.002em', fontWeight: isSelected ? 600 : 400 }}>
                    {isSelected ? '▼ ' : '▸ '}{c.closerName}
                  </span>
                  <Num value={c.dials} />
                  <Num value={c.meetings} accent />
                  <ShowsCell meetings={c.meetings} shows={c.shows} />
                  <Num value={c.base44Monthly} />
                  <Num value={c.base44Yearly} />
                  <Num value={c.wixMonthly} />
                  <Num value={c.wixYearly} />
                  <Num value={c.closes} accent />
                </div>
              </RowLink>
              {isSelected ? <DcDrill rows={drill} closerName={c.closerName} /> : null}
            </div>
          )
        })
      )}
    </div>
  )
}

function RowLink({
  baseParams, closerName, isSelected, children,
}: {
  baseParams: string; closerName: string; isSelected: boolean; children: React.ReactNode
}) {
  const sp = new URLSearchParams(baseParams)
  if (isSelected) sp.delete('dccloser')
  else sp.set('dccloser', closerName)
  const qs = sp.toString()
  const href = qs ? `?${qs}` : '?'
  return (
    <Link href={href} scroll={false} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
      {children}
    </Link>
  )
}

// ----------------------------------------------------------------------
// Drill
// ----------------------------------------------------------------------

type DrillSortKey = 'prospect' | 'scheduled' | 'bookedBy' | 'showed' | 'outcome' | 'plans'

// Prospect | Scheduled | Booked by | Showed | Outcome | Plans
const DRILL_COLS = '1.3fr 1fr 1fr 0.7fr 0.9fr 1.4fr'

function DcDrill({ rows, closerName }: { rows: DcDrillRow[]; closerName: string }) {
  const { sorted, state, onToggle } = useColumnSort<DcDrillRow, DrillSortKey>(rows, (r, k) => {
    switch (k) {
      case 'prospect': return r.prospectName ?? null
      case 'scheduled': return r.scheduledTime ?? null
      case 'bookedBy': return r.bookedBy ?? null
      case 'showed': return r.showed ? 1 : 0
      case 'outcome':
        return r.outcome === 'closed' ? 3 : r.outcome === 'follow_up' ? 2 : r.outcome === 'dq' ? 1 : null
      case 'plans': return planLabel(r) || null
      default: return null
    }
  })

  return (
    <div style={{ margin: '0 -12px 10px', padding: '14px 16px 16px', background: 'var(--color-geg-bg)', border: '1px solid var(--color-geg-border)', borderRadius: 8 }}>
      <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 10 }}>
        {closerName} · Digital College meetings · {rows.length} {rows.length === 1 ? 'lead' : 'leads'} {state.dir === null ? '(most recent first)' : `· sorted ${state.dir}`}
      </div>
      {rows.length === 0 ? (
        <div className="geg-serif" style={{ padding: '14px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 14 }}>
          No Digital College meetings in this range.
        </div>
      ) : (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: DRILL_COLS, gap: 10, padding: '6px 0 8px', borderBottom: '1px solid var(--color-geg-border)' }}>
            <SortableHeader label="Prospect" sortKey="prospect" align="left" state={state} onToggle={onToggle} />
            <SortableHeader label="Scheduled (ET)" sortKey="scheduled" align="left" state={state} onToggle={onToggle} />
            <SortableHeader label="Booked by" sortKey="bookedBy" align="left" state={state} onToggle={onToggle} />
            <SortableHeader label="Showed" sortKey="showed" align="left" state={state} onToggle={onToggle} />
            <SortableHeader label="Outcome" sortKey="outcome" align="left" state={state} onToggle={onToggle} />
            <SortableHeader label="Plans" sortKey="plans" align="left" state={state} onToggle={onToggle} />
          </div>
          {sorted.map((r) => (
            <div key={r.key} style={{ display: 'grid', gridTemplateColumns: DRILL_COLS, gap: 10, padding: '9px 0', borderBottom: '1px dashed var(--color-geg-border)', alignItems: 'center' }}>
              <ProspectCell name={r.prospectName} leadId={r.leadId} hasLink={r.hasMeetingLink} hasForm={r.showed} />
              <Cell text={formatEtTimestamp(r.scheduledTime)} mono />
              <BookedByCell bookedBy={r.bookedBy} />
              <ShowedTag showed={r.showed} />
              <OutcomeTag outcome={r.outcome} />
              <PlansCell row={r} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ----------------------------------------------------------------------
// Primitives
// ----------------------------------------------------------------------

function Num({ value, accent }: { value: number | string; accent?: boolean }) {
  return (
    <span className="geg-numeric-serif" style={{ fontSize: 14, color: accent ? 'var(--color-geg-text)' : 'var(--color-geg-text-2)', letterSpacing: '-0.01em', textAlign: 'right' }}>
      {value}
    </span>
  )
}

function Cell({ text, mono }: { text: string; mono?: boolean }) {
  const isDash = text === '—'
  return (
    <span
      className={mono ? 'geg-mono' : 'geg-serif'}
      style={{
        fontSize: mono ? 11 : 13, color: isDash ? 'var(--color-geg-text-faint)' : 'var(--color-geg-text-2)',
        letterSpacing: mono ? '0.04em' : '-0.002em', fontStyle: isDash ? 'italic' : 'normal',
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
      }}
    >
      {text}
    </span>
  )
}

function ShowsCell({ meetings, shows }: { meetings: number; shows: number }) {
  const pct = meetings > 0 ? Math.round((shows / meetings) * 100) : null
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 6 }} title={pct === null ? 'No meetings' : `${shows} of ${meetings} showed (${pct}%)`}>
      {pct !== null ? (
        <span className="geg-mono" style={{ fontSize: 9.5, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)' }}>→{pct}%</span>
      ) : null}
      <Num value={shows} />
    </span>
  )
}

function ProspectCell({ name, leadId, hasLink, hasForm }: { name: string | null; leadId: string | null; hasLink: boolean; hasForm: boolean }) {
  const isDash = !name
  const baseStyle = {
    fontSize: 13, letterSpacing: '-0.002em', fontStyle: isDash ? ('italic' as const) : ('normal' as const),
    whiteSpace: 'nowrap' as const, overflow: 'hidden', textOverflow: 'ellipsis', textDecoration: 'none',
  }
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      {leadId ? (
        <Link
          href={`/sales-dashboard/leads/${encodeURIComponent(leadId)}`}
          className="geg-serif"
          style={{ ...baseStyle, color: 'var(--color-geg-text)' }}
          title="Open lead"
        >
          {name}
        </Link>
      ) : (
        <span className="geg-serif" style={{ ...baseStyle, color: isDash ? 'var(--color-geg-text-faint)' : 'var(--color-geg-text-2)' }}>
          {name ?? '—'}
        </span>
      )}
      {hasLink && !hasForm ? (
        <span
          className="geg-mono"
          title="Booked via Calendly, no form filed yet — counts as a meeting but not a show (no-show until a form is entered)."
          style={{ flexShrink: 0, fontSize: 8.5, letterSpacing: '0.06em', padding: '1px 5px', borderRadius: 4, border: '1px solid var(--color-geg-border)', background: 'var(--color-geg-bg-elev)', color: 'var(--color-geg-text-3)' }}
        >
          no form
        </span>
      ) : null}
    </span>
  )
}

function BookedByCell({ bookedBy }: { bookedBy: string | null }) {
  if (!bookedBy) {
    return (
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.04em' }} title="Self-set / no setter on the form">
        —
      </span>
    )
  }
  return (
    <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.02em' }}>
      {bookedBy}
    </span>
  )
}

function ShowedTag({ showed }: { showed: boolean }) {
  return (
    <span className="geg-mono" style={{ fontSize: 11, color: showed ? 'var(--color-geg-pos)' : 'var(--color-geg-text-faint)', letterSpacing: '0.04em' }} title={showed ? 'A form was filed — showed.' : 'No form yet — no-show / pending.'}>
      {showed ? 'Yes' : 'No'}
    </span>
  )
}

function OutcomeTag({ outcome }: { outcome: DcDrillRow['outcome'] }) {
  if (outcome === null) {
    return <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.04em' }} title="No form filed yet">missing</span>
  }
  const map = {
    closed: { text: 'Closed', color: 'var(--color-geg-pos)', title: 'Closed? = Yes — a Digital College close.' },
    follow_up: { text: 'Follow up', color: 'var(--color-geg-text-2)', title: 'Showed, not closed — following up.' },
    dq: { text: 'DQ', color: 'var(--color-geg-text-faint)', title: 'Disqualified (Follow Up? = No on the form).' },
  } as const
  const { text, color, title } = map[outcome]
  return (
    <span className="geg-mono" style={{ fontSize: 11, color, letterSpacing: '0.04em' }} title={title}>
      {text}
    </span>
  )
}

function planLabel(r: DcDrillRow): string {
  const parts: string[] = []
  if (r.base44Monthly) parts.push('Base44 Mo')
  if (r.base44Yearly) parts.push('Base44 Yr')
  if (r.wixMonthly) parts.push('Wix Mo')
  if (r.wixYearly) parts.push('Wix Yr')
  return parts.join(' · ')
}

function PlansCell({ row }: { row: DcDrillRow }) {
  const label = planLabel(row)
  if (!label) {
    return <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.04em' }}>—</span>
  }
  return (
    <span className="geg-mono" style={{ fontSize: 10.5, color: 'var(--color-geg-text-2)', letterSpacing: '0.02em', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={row.plans.join(', ')}>
      {label}
    </span>
  )
}

function formatEtTimestamp(iso: string | null): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(iso))
}
