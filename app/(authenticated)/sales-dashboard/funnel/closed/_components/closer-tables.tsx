'use client'

import Link from 'next/link'
import { useMemo, useState, useTransition } from 'react'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import { hideTestCloserBooking } from '../actions'
import { hideTestLead } from '../../../leads/actions'
import type {
  CloserScheduledAggregate,
  CloserScheduledDrillRow,
} from '@/lib/db/funnel-closing'

// Client-side per-closer aggregate table + per-call drill list, both
// sortable by clicking column headers. Mirrors the appointment-setting
// sortable-tables.tsx hook + header pattern (kept inline here for now;
// can extract a shared module if a third surface needs it).
//
// Sort state lives in the client component — the URL still owns
// selection (?closer=NAME). Click sort → toggles desc → asc → default;
// default uses the upstream order (most calls first for the closer
// table; most recent first for the drill).
//
// All "missing" / null values sort to the END regardless of direction.

// ----------------------------------------------------------------------
// Shared sort hook
// ----------------------------------------------------------------------

type SortDir = 'asc' | 'desc' | null
type SortState<K extends string> = { key: K; dir: SortDir }

function useColumnSort<T, K extends string>(
  rows: T[],
  getKey: (row: T, key: K) => number | string | null | undefined,
): {
  sorted: T[]
  state: SortState<K>
  onToggle: (key: K) => void
} {
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
      if (typeof va === 'number' && typeof vb === 'number') {
        return state.dir === 'asc' ? va - vb : vb - va
      }
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
      // asc → default (clear sort)
      return { key: '' as K, dir: null }
    })
  }

  return { sorted, state, onToggle }
}

function SortableHeader<K extends string>({
  label,
  sortKey,
  align = 'right',
  state,
  onToggle,
}: {
  label: string
  sortKey: K
  align?: 'left' | 'right'
  state: SortState<K>
  onToggle: (key: K) => void
}) {
  const active = state.key === sortKey && state.dir !== null
  const arrow = active ? (state.dir === 'asc' ? '▲' : '▼') : ''
  return (
    <button
      type="button"
      onClick={() => onToggle(sortKey)}
      className="geg-mono"
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: active ? 'var(--color-geg-text-2)' : 'var(--color-geg-text-faint)',
        textAlign: align,
        cursor: 'pointer',
        display: 'inline-flex',
        gap: 6,
        alignItems: 'baseline',
        justifyContent: align === 'left' ? 'flex-start' : 'flex-end',
        width: '100%',
        fontFamily: 'inherit',
      }}
    >
      <span>{label}</span>
      {arrow ? <span style={{ fontSize: 8 }}>{arrow}</span> : null}
    </button>
  )
}

// ----------------------------------------------------------------------
// Main exported component
// ----------------------------------------------------------------------

type AggSortKey =
  | 'name'
  | 'calls'
  | 'direct'
  | 'setter'
  | 'showed'
  | 'closed'
  | 'noShows'
  | 'upfront'

const AGG_COLS = '1.4fr 0.6fr 0.6fr 0.6fr 1.0fr 1.2fr 0.6fr 0.8fr'

export function CloserScheduledTables({
  closers,
  aggregate,
  selectedCloser,
  drill,
  baseParams,
  canDelete,
}: {
  closers: CloserScheduledAggregate[]
  aggregate: CloserScheduledAggregate
  selectedCloser: string | null
  drill: CloserScheduledDrillRow[]
  // Serialized as a flat string so the server can hand a snapshot of
  // the URL params to a client component. We re-parse here.
  baseParams: string
  canDelete?: boolean
}) {
  const { sorted, state, onToggle } = useColumnSort<CloserScheduledAggregate, AggSortKey>(
    closers,
    (r, k) => {
      switch (k) {
        case 'name': return r.closerName
        case 'calls': return r.calls
        case 'direct': return r.directCalls
        case 'setter': return r.setterCalls
        case 'showed': return r.showed
        case 'closed': return r.closed
        case 'noShows': return r.noShows
        case 'upfront': return r.upfront
        default: return null
      }
    },
  )

  return (
    <div>
      {/* Header row */}
      <div style={{ display: 'grid', gridTemplateColumns: AGG_COLS, gap: 10, padding: '6px 0 10px', borderBottom: '1px solid var(--color-geg-border)' }}>
        <SortableHeader label="Closer" sortKey="name" align="left" state={state} onToggle={onToggle} />
        <SortableHeader label="Calls" sortKey="calls" state={state} onToggle={onToggle} />
        <SortableHeader label="Direct" sortKey="direct" state={state} onToggle={onToggle} />
        <SortableHeader label="Setter" sortKey="setter" state={state} onToggle={onToggle} />
        <SortableHeader label="Showed" sortKey="showed" state={state} onToggle={onToggle} />
        <SortableHeader label="Closes (HT/DC)" sortKey="closed" state={state} onToggle={onToggle} />
        <SortableHeader label="No shows" sortKey="noShows" state={state} onToggle={onToggle} />
        <SortableHeader label="Upfront" sortKey="upfront" state={state} onToggle={onToggle} />
      </div>

      {/* Aggregate row (italic, never sorts) */}
      <div style={{ display: 'grid', gridTemplateColumns: AGG_COLS, gap: 10, padding: '12px 0', borderBottom: '1px solid var(--color-geg-border)', alignItems: 'center' }}>
        <span className="geg-serif" style={{ fontSize: 14, fontStyle: 'italic', color: 'var(--color-geg-text-2)', letterSpacing: '-0.002em' }}>
          All closers
        </span>
        <Num value={aggregate.calls} accent />
        <Num value={aggregate.directCalls} />
        <Num value={aggregate.setterCalls} />
        <ShowedCell calls={aggregate.calls} showed={aggregate.showed} />
        <ClosesCell showed={aggregate.showed} closed={aggregate.closed} ht={aggregate.closedHt} dc={aggregate.closedDc} />
        <Num value={aggregate.noShows} />
        <Num value={compactUsd(aggregate.upfront)} />
      </div>

      {sorted.length === 0 ? (
        <div className="geg-serif" style={{ padding: '20px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 14 }}>
          No scheduled closer calls in this range.
        </div>
      ) : (
        sorted.map((c) => {
          const isSelected = selectedCloser === c.closerKey
          return (
            <div key={c.closerKey}>
              <RowLink baseParams={baseParams} closerKey={c.closerKey} isSelected={isSelected}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: AGG_COLS,
                    gap: 10,
                    padding: '12px 12px',
                    margin: '0 -12px',
                    borderBottom: '1px dashed var(--color-geg-border)',
                    alignItems: 'center',
                    background: isSelected ? 'var(--color-geg-bg)' : 'transparent',
                    borderRadius: isSelected ? 6 : 0,
                    cursor: 'pointer',
                  }}
                >
                  <span
                    className="geg-serif"
                    style={{ fontSize: 14, color: 'var(--color-geg-text)', letterSpacing: '-0.002em', fontWeight: isSelected ? 600 : 400 }}
                  >
                    {isSelected ? '▼ ' : '▸ '}{c.closerName}
                  </span>
                  <Num value={c.calls} accent />
                  <Num value={c.directCalls} />
                  <Num value={c.setterCalls} />
                  <ShowedCell calls={c.calls} showed={c.showed} />
                  <ClosesCell showed={c.showed} closed={c.closed} ht={c.closedHt} dc={c.closedDc} />
                  <Num value={c.noShows} />
                  <Num value={compactUsd(c.upfront)} />
                </div>
              </RowLink>
              {isSelected ? <CloserDrill calls={drill} closerName={c.closerName} canDelete={canDelete} /> : null}
            </div>
          )
        })
      )}
    </div>
  )
}

function RowLink({
  baseParams, closerKey, isSelected, children,
}: {
  baseParams: string
  closerKey: string
  isSelected: boolean
  children: React.ReactNode
}) {
  const sp = new URLSearchParams(baseParams)
  if (isSelected) sp.delete('closer')
  else sp.set('closer', closerKey)
  const qs = sp.toString()
  const href = qs ? `?${qs}` : '?'
  return (
    <Link href={href} scroll={false} style={{ textDecoration: 'none', color: 'inherit', display: 'block' }}>
      {children}
    </Link>
  )
}

// ----------------------------------------------------------------------
// Drill list — sortable
// ----------------------------------------------------------------------

type DrillSortKey =
  | 'prospect'
  | 'scheduled'
  | 'callType'
  | 'bookedBy'
  | 'showed'
  | 'closed'
  | 'upfront'

const DRILL_COLS = '1.3fr 1fr 0.7fr 1fr 0.6fr 0.9fr 0.7fr'

function CloserDrill({ calls, closerName, canDelete }: { calls: CloserScheduledDrillRow[]; closerName: string; canDelete?: boolean }) {
  // Cancelled bookings (fell-through: canceled / no-showed with no rebooking) are
  // already excluded from calls/showed/closed. Hidden by default so the drill
  // reads as just the live/worked meetings; the toggle shows them (Drake 2026-06-07).
  const [hideCancelled, setHideCancelled] = useState(true)
  const cancelledCount = useMemo(() => calls.filter((c) => c.cancelled).length, [calls])
  const visible = useMemo(
    () => (hideCancelled ? calls.filter((c) => !c.cancelled) : calls),
    [calls, hideCancelled],
  )
  const { sorted, state, onToggle } = useColumnSort<CloserScheduledDrillRow, DrillSortKey>(
    visible,
    (r, k) => {
      switch (k) {
        case 'prospect': return r.prospectName ?? null
        case 'scheduled': return r.scheduledTime
        case 'callType': return r.callType
        case 'bookedBy': return r.bookedBy ?? null
        // Encode for sorting: showed-best → no-show → missing.
        case 'showed':
          return r.showed === 'yes' ? 6
            : r.showed === 'short_follow' ? 5
            : r.showed === 'long_follow' ? 4
            : r.showed === 'reschedule' ? 3
            : r.showed === 'dq' ? 2
            : r.showed === 'no' ? 1 : null
        case 'closed':
          return r.closed === 'yes' ? 3 : r.closed === 'deposit' ? 2 : r.closed === 'no' ? 1 : null
        case 'upfront': return r.upfront
        default: return null
      }
    },
  )

  return (
    <div style={{ margin: '0 -12px 10px', padding: '14px 16px 16px', background: 'var(--color-geg-bg)', border: '1px solid var(--color-geg-border)', borderRadius: 8 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10, marginBottom: 10 }}>
        <div
          className="geg-mono"
          style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}
        >
          {closerName} · scheduled calls · {visible.length} {visible.length === 1 ? 'lead' : 'leads'} {state.dir === null ? '(most recent first)' : `· sorted ${state.dir}`}
        </div>
        {cancelledCount > 0 ? (
          <button
            type="button"
            onClick={() => setHideCancelled((v) => !v)}
            className="geg-mono"
            style={{ background: 'none', border: '1px solid var(--color-geg-border)', borderRadius: 6, padding: '3px 8px', fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text-2)', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >
            {hideCancelled ? `Show cancelled (${cancelledCount})` : `Hide cancelled (${cancelledCount})`}
          </button>
        ) : null}
      </div>
      {visible.length === 0 ? (
        <div className="geg-serif" style={{ padding: '14px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 14 }}>
          No scheduled calls in this range for this closer.
        </div>
      ) : (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: DRILL_COLS, gap: 10, padding: '6px 0 8px', borderBottom: '1px solid var(--color-geg-border)' }}>
            <SortableHeader label="Prospect" sortKey="prospect" align="left" state={state} onToggle={onToggle} />
            <SortableHeader label="Scheduled (ET)" sortKey="scheduled" align="left" state={state} onToggle={onToggle} />
            <SortableHeader label="Call type" sortKey="callType" align="left" state={state} onToggle={onToggle} />
            <SortableHeader label="Booked by" sortKey="bookedBy" align="left" state={state} onToggle={onToggle} />
            <SortableHeader label="Showed" sortKey="showed" align="left" state={state} onToggle={onToggle} />
            <SortableHeader label="Closed" sortKey="closed" align="left" state={state} onToggle={onToggle} />
            <SortableHeader label="Upfront" sortKey="upfront" state={state} onToggle={onToggle} />
          </div>
          {sorted.map((c) => {
            const dimmed = c.cancelled
            const rowInner = (
              <div
                style={{ display: 'grid', gridTemplateColumns: DRILL_COLS, gap: 10, padding: '9px 0', borderBottom: '1px dashed var(--color-geg-border)', alignItems: 'center', opacity: dimmed ? 0.62 : 1 }}
              >
                <ProspectCell name={c.prospectName} leadId={c.leadId} cancelled={c.cancelled} bookingCount={c.bookingCount} formOnly={c.formOnly} />
                <Cell text={formatEtTimestamp(c.scheduledTime)} mono />
                <Cell text={callTypeLabel(c.callType)} mono />
                <BookedByCell callType={c.callType} bookedBy={c.bookedBy} />
                <YesNoCell value={c.showed} cancelled={c.cancelled} />
                <ClosedTypeCell closed={c.closed} closeType={c.closeType} cancelled={c.cancelled} />
                <NumStr value={c.upfront == null ? <MissingTag /> : compactUsd(c.upfront)} />
              </div>
            )
            // Non-creators see the row exactly as before. The creator gets a
            // trailing gutter with a "hide" ×. A Calendly-backed row hides its
            // event (calendly_scheduled_events.excluded_at). A form-only row
            // (instant book, no Calendly event — e.g. a test close like Diesel)
            // has no event to hide, so it soft-hides the LEAD instead
            // (close_leads.excluded_at), which drops it from every sales view.
            if (!canDelete) return <div key={c.eventUri}>{rowInner}</div>
            const hideBtn = c.formOnly
              ? (c.leadId ? <HideTestLeadButton leadId={c.leadId} /> : null)
              : <HideTestBookingButton eventUri={c.eventUri} />
            return (
              <div key={c.eventUri} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ flex: 1, minWidth: 0 }}>{rowInner}</div>
                <div style={{ width: 22, flexShrink: 0, display: 'flex', justifyContent: 'center' }}>
                  {hideBtn}
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// Creator-only "hide test booking" ×. Soft-hides the backing Calendly
// event (server action re-checks creator tier). Confirms first to guard
// against misclicks; revalidatePath in the action refreshes the page.
function HideTestBookingButton({ eventUri }: { eventUri: string }) {
  const [pending, startTransition] = useTransition()
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!window.confirm('Hide this as a test booking? It will be removed from the per-closer drill and counts. (Soft-hide — recoverable in the database.)')) {
      return
    }
    startTransition(async () => {
      const res = await hideTestCloserBooking(eventUri)
      if (!res.ok) window.alert(`Could not hide this booking: ${res.error}`)
    })
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title="Hide this test booking (creator only)"
      aria-label="Hide this test booking"
      className="geg-mono"
      style={{
        cursor: pending ? 'default' : 'pointer',
        border: '1px solid var(--color-geg-border)',
        background: 'var(--color-geg-bg-elev)',
        color: 'var(--color-geg-text-faint)',
        borderRadius: 4,
        width: 18,
        height: 18,
        lineHeight: '14px',
        fontSize: 12,
        padding: 0,
        opacity: pending ? 0.5 : 1,
      }}
    >
      {pending ? '·' : '×'}
    </button>
  )
}

// Creator-only "hide test lead" × for a form-only meeting (no Calendly event
// to hide). Soft-hides the LEAD (close_leads.excluded_at), so it drops from
// every sales view — the right scope for a test lead like Diesel. Confirms
// first; the action re-checks creator tier and revalidates.
function HideTestLeadButton({ leadId }: { leadId: string }) {
  const [pending, startTransition] = useTransition()
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!window.confirm('Hide this as a test LEAD? It has no Calendly booking, so this soft-hides the whole lead — it will disappear from every sales view (leads, funnel, this drill). Recoverable in the database.')) {
      return
    }
    startTransition(async () => {
      const res = await hideTestLead(leadId)
      if (!res.ok) window.alert(`Could not hide this lead: ${res.error}`)
    })
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title="Hide this test lead (creator only) — no Calendly booking, hides the whole lead"
      aria-label="Hide this test lead"
      className="geg-mono"
      style={{
        cursor: pending ? 'default' : 'pointer',
        border: '1px solid var(--color-geg-border)',
        background: 'var(--color-geg-bg-elev)',
        color: 'var(--color-geg-text-faint)',
        borderRadius: 4,
        width: 18,
        height: 18,
        lineHeight: '14px',
        fontSize: 12,
        padding: 0,
        opacity: pending ? 0.5 : 1,
      }}
    >
      {pending ? '·' : '×'}
    </button>
  )
}

// ----------------------------------------------------------------------
// Primitives — local copies (these used to live in the page; moved here
// since the cells render inside this client component).
// ----------------------------------------------------------------------

function Num({ value, accent }: { value: number | string; accent?: boolean }) {
  return (
    <span
      className="geg-numeric-serif"
      style={{
        fontSize: 14,
        color: accent ? 'var(--color-geg-text)' : 'var(--color-geg-text-2)',
        letterSpacing: '-0.01em',
        textAlign: 'right',
      }}
    >
      {value}
    </span>
  )
}

function NumStr({ value }: { value: React.ReactNode }) {
  return (
    <span
      className="geg-numeric-serif"
      style={{
        fontSize: 14,
        color: 'var(--color-geg-text-2)',
        letterSpacing: '-0.01em',
        textAlign: 'right',
      }}
    >
      {value}
    </span>
  )
}

function Cell({ text, mono, missing }: { text: string; mono?: boolean; missing?: boolean }) {
  if (missing || text === '') return <MissingTag />
  const isDash = text === '—'
  return (
    <span
      className={mono ? 'geg-mono' : 'geg-serif'}
      style={{
        fontSize: mono ? 11 : 13,
        color: isDash ? 'var(--color-geg-text-faint)' : 'var(--color-geg-text-2)',
        letterSpacing: mono ? '0.04em' : '-0.002em',
        fontStyle: isDash ? 'italic' : 'normal',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {text}
    </span>
  )
}

function ShowedCell({ calls, showed }: { calls: number; showed: number }) {
  const pct = calls > 0 ? Math.round((showed / calls) * 100) : null
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 6 }}
      title={pct === null ? 'No scheduled calls' : `${showed} of ${calls} showed (${pct}%)`}
    >
      {pct !== null ? (
        <span className="geg-mono" style={{ fontSize: 9.5, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)' }}>
          →{pct}%
        </span>
      ) : null}
      <Num value={showed} />
    </span>
  )
}

function ClosesCell({ showed, closed, ht, dc }: { showed: number; closed: number; ht: number; dc: number }) {
  const pct = showed > 0 ? Math.round((closed / showed) * 100) : null
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'baseline', justifyContent: 'flex-end', gap: 6 }}
      title={pct === null ? 'No showed calls' : `${closed} of ${showed} showed closed (${pct}%) · ${ht} HT / ${dc} DC`}
    >
      {pct !== null ? (
        <span className="geg-mono" style={{ fontSize: 9.5, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)' }}>
          →{pct}%
        </span>
      ) : null}
      <Num value={closed} />
      <span className="geg-mono" style={{ fontSize: 9, color: 'var(--color-geg-text-faint)', letterSpacing: '0.04em' }}>
        {ht}HT / {dc}DC
      </span>
    </span>
  )
}

function callTypeLabel(t: CloserScheduledDrillRow['callType']): string {
  if (t === 'direct') return 'Direct'
  if (t === 'setter') return 'Setter'
  return t
}

function BookedByCell({
  callType,
  bookedBy,
}: {
  callType: CloserScheduledDrillRow['callType']
  bookedBy: string | null
}) {
  if (callType !== 'setter') {
    return (
      <span
        className="geg-mono"
        style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.04em' }}
        title={callType === 'direct' ? 'Ad attribution coming soon' : 'No booker (follow-up)'}
      >
        —
      </span>
    )
  }
  if (!bookedBy) return <MissingTag />
  return (
    <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.02em' }}>
      {bookedBy}
    </span>
  )
}

function YesNoCell({ value, cancelled }: { value: CloserScheduledDrillRow['showed']; cancelled?: boolean }) {
  if (cancelled) return <DashCell />
  if (value === null) return <MissingTag />
  const map: Record<NonNullable<CloserScheduledDrillRow['showed']>, { text: string; color: string }> = {
    yes: { text: 'Yes', color: 'var(--color-geg-pos)' },
    no: { text: 'No', color: 'var(--color-geg-neg)' },
    dq: { text: 'DQ', color: 'var(--color-geg-text-faint)' },
    reschedule: { text: 'Resched', color: 'var(--color-geg-text-3)' },
    short_follow: { text: 'ST follow', color: 'var(--color-geg-text-2)' },
    long_follow: { text: 'LT follow', color: 'var(--color-geg-text-2)' },
  }
  const { text, color } = map[value]
  return (
    <span className="geg-mono" style={{ fontSize: 11, color, letterSpacing: '0.04em' }}>
      {text}
    </span>
  )
}

function ClosedTypeCell({
  closed,
  closeType,
  cancelled,
}: {
  closed: CloserScheduledDrillRow['closed']
  closeType: 'ht' | 'dc' | null
  cancelled?: boolean
}) {
  if (cancelled) return <DashCell />
  if (closed === null) return <MissingTag />
  if (closed === 'no') {
    return (
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-neg)', letterSpacing: '0.04em' }}>
        No
      </span>
    )
  }
  if (closed === 'deposit') {
    return (
      <span
        className="geg-mono"
        style={{ fontSize: 11, color: 'var(--color-geg-warn)', letterSpacing: '0.04em' }}
        title="Deposit taken — partial, not a full close"
      >
        Deposit
      </span>
    )
  }
  const label = closeType === 'ht' ? 'High ticket' : closeType === 'dc' ? 'Digital college' : 'Closed'
  return (
    <span
      className="geg-mono"
      style={{ fontSize: 11, color: 'var(--color-geg-pos)', letterSpacing: '0.04em' }}
      title={closeType ? `Closed · ${label}` : 'Closed (payment_plan_type unknown)'}
    >
      {label}
    </span>
  )
}

// Canceled meeting → showed/closed are not applicable (no EOC will be filed),
// so render an em-dash rather than the "missing" tag.
function DashCell() {
  return (
    <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.04em' }}>
      —
    </span>
  )
}

function MissingTag() {
  return (
    <span
      className="geg-mono"
      style={{ fontSize: 10, fontStyle: 'italic', color: 'var(--color-geg-text-faint)', letterSpacing: '0.04em' }}
      title="No EOC form submitted yet — value will populate once the closer files the form."
    >
      missing
    </span>
  )
}

// Prospect cell — one row per lead, with an optional state tag. The
// number is the lead's net booking count (every attempt on a valid link,
// across calendars; a cancel / no-show / reschedule each made a fresh
// booking), shown only at ≥2:
//   · Cancelled / Cancelled ×N → no live slot left (every booking canceled
//        or no-showed). ×N shows total attempts so you can see how many
//        times they bailed. Dimmed; excluded from aggregates.
//   · ×N badge   → still live, but booked N times (rescheduled/rebooked).
//   · (nothing)  → a single clean booking.
// cancelled wins over the count (a fallen-through lead reads as cancelled
// even if they'd bounced around the calendar first).
function ProspectCell({
  name,
  leadId,
  cancelled,
  bookingCount,
  formOnly,
}: {
  name: string | null
  leadId: string | null
  cancelled: boolean
  bookingCount: number
  formOnly?: boolean
}) {
  const isDash = !name
  // The badge number is the lead's net booking count (every attempt on a
  // valid link, across calendars). Shown only when they've booked ≥2× —
  // a single clean booking gets nothing. cancelled (no live slot left, a
  // no-show counts as cancel) shows the red tag, otherwise the neutral one.
  const showCount = bookingCount >= 2
  const nameStyle = {
    fontSize: 13,
    color: isDash ? 'var(--color-geg-text-faint)' : 'var(--color-geg-text-2)',
    letterSpacing: '-0.002em',
    fontStyle: isDash ? 'italic' : ('normal' as const),
    whiteSpace: 'nowrap' as const,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    textDecoration: 'none',
  }
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        minWidth: 0,
      }}
    >
      {leadId ? (
        <Link
          href={`/sales-dashboard/leads/${encodeURIComponent(leadId)}`}
          className="geg-serif"
          style={{ ...nameStyle, color: 'var(--color-geg-text)' }}
          title="Open lead"
        >
          {name}
        </Link>
      ) : (
        <span className="geg-serif" style={nameStyle}>{name ?? '—'}</span>
      )}
      {formOnly ? <FormOnlyTag /> : null}
      {cancelled ? (
        <CancelledTag count={showCount ? bookingCount : null} />
      ) : showCount ? (
        <RebookingTag count={bookingCount} />
      ) : null}
    </span>
  )
}

// Form-only meeting: a closer EOC with no Calendly booking (an instant book).
function FormOnlyTag() {
  return (
    <span
      className="geg-mono"
      title="Instant book — meeting filed from the closer form with no Calendly booking."
      style={{
        fontSize: 9,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-2)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 4,
        padding: '1px 5px',
        whiteSpace: 'nowrap',
      }}
    >
      form only
    </span>
  )
}

function CancelledTag({ count }: { count: number | null }) {
  return (
    <span
      className="geg-mono"
      title={
        count
          ? `Fell through — no live booking left. This lead booked ${count} times total (cancels + no-shows + rebookings). Excluded from calls/showed/closed.`
          : 'Booking was canceled / no-showed with no rebooking — fell through. Excluded from calls/showed/closed.'
      }
      style={{
        flexShrink: 0,
        fontSize: 8.5,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        padding: '1px 5px',
        borderRadius: 4,
        border: '1px solid var(--color-geg-neg-border)',
        background: 'var(--color-geg-neg-fill)',
        color: 'var(--color-geg-neg)',
      }}
    >
      {count ? `Cancelled ×${count}` : 'Cancelled'}
    </span>
  )
}

function RebookingTag({ count }: { count: number }) {
  return (
    <span
      className="geg-mono"
      title={`This lead has booked ${count} times (every booking attempt on a valid link, across calendars).`}
      style={{
        flexShrink: 0,
        fontSize: 8.5,
        letterSpacing: '0.06em',
        padding: '1px 5px',
        borderRadius: 4,
        border: '1px solid var(--color-geg-border)',
        background: 'var(--color-geg-bg)',
        color: 'var(--color-geg-text-3)',
      }}
    >
      ×{count}
    </span>
  )
}

function formatEtTimestamp(iso: string): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso))
}
