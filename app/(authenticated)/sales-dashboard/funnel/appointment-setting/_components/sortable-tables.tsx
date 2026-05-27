'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'
import type {
  CallActivityDrillRow,
  CallActivityRepRow,
  SpeedToLeadCohortRow,
} from '@/lib/db/funnel-appointment-setting'
import { RepLinkPreservingParams } from '../rep-link'

// Sortable drill / aggregate tables for the appointment-setting page.
// Each table owns local sort state via the shared `useColumnSort`
// hook below. Click a header to toggle asc → desc → default (the
// "default" path preserves the upstream sort the server already
// applied — typically most-recent-first).
//
// Layout: every table renders all rows inside a `max-height` /
// `overflow-y: auto` container so the user scrolls instead of
// clicking "see more". Sticky headers keep the column labels in
// view while scrolling.

// ---------------------------------------------------------------------------
// Shared sort primitives
// ---------------------------------------------------------------------------

type SortDir = 'asc' | 'desc' | null
type SortState<K extends string> = { key: K; dir: SortDir }

// Returns the row list sorted by current state, plus a click handler
// for headers. `getKey(row, key)` extracts the value to sort on. Null
// / undefined values always sort to the END regardless of direction
// (so "no value" rows don't push real data off the visible area).
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
      if (aMissing) return 1   // nulls always last
      if (bMissing) return -1
      if (typeof va === 'number' && typeof vb === 'number') {
        return state.dir === 'asc' ? va - vb : vb - va
      }
      const sa = String(va).toLowerCase()
      const sb = String(vb).toLowerCase()
      if (sa === sb) return 0
      return state.dir === 'asc'
        ? sa < sb ? -1 : 1
        : sa < sb ? 1 : -1
    })
    return copy
  }, [rows, state, getKey])

  function onToggle(key: K) {
    setState((prev) => {
      if (prev.key !== key) return { key, dir: 'desc' }
      if (prev.dir === 'desc') return { key, dir: 'asc' }
      // asc → default
      return { key: '' as K, dir: null }
    })
  }

  return { sorted, state, onToggle }
}

function SortableHeader<K extends string>({
  label,
  sortKey,
  align,
  state,
  onToggle,
}: {
  label: string
  sortKey: K
  align?: 'left' | 'right' | 'center'
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
        textAlign: align ?? 'right',
        cursor: 'pointer',
        display: 'inline-flex',
        gap: 6,
        alignItems: 'baseline',
        justifyContent: align === 'left' ? 'flex-start' : align === 'center' ? 'center' : 'flex-end',
        width: '100%',
      }}
    >
      <span>{label}</span>
      {arrow ? <span style={{ fontSize: 8 }}>{arrow}</span> : null}
    </button>
  )
}

function Num({ value, accent }: { value: string; accent?: boolean }) {
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

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) {
    const m = Math.floor(sec / 60)
    const s = Math.round(sec % 60)
    return s === 0 ? `${m}m` : `${m}m ${s}s`
  }
  // Speed-to-lead can be many hours; render as "Xh Ym" so a 1123-min
  // value reads "18h 43m" instead of an opaque minutes total.
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec - h * 3600) / 60)
  return m === 0 ? `${h}h` : `${h}h ${m}m`
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

// Wraps a tbody-equivalent in a vertical-scroll container.
function ScrollBody({ children, maxHeight }: { children: React.ReactNode; maxHeight: number }) {
  return (
    <div style={{ maxHeight, overflowY: 'auto', paddingRight: 4 }}>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Speed-to-lead drill — leads list under the speed cohort stats
// ---------------------------------------------------------------------------

type SpeedSortKey = 'prospect' | 'created' | 'speed' | 'over90s' | 'caller'

const SPEED_COLS = '1.5fr 1.1fr 0.9fr 0.8fr 1.2fr'

export function SpeedToLeadDrillTable({
  rows,
  activeCaller,
}: {
  rows: SpeedToLeadCohortRow[]
  activeCaller: string | null
}) {
  const { sorted, state, onToggle } = useColumnSort<SpeedToLeadCohortRow, SpeedSortKey>(
    rows,
    (r, k) => {
      switch (k) {
        case 'prospect': return r.prospectName ?? null
        case 'created': return r.leadCreatedAt
        // Treat "not yet called" as +∞ for sort purposes so it lands at
        // the slowest end of the spectrum rather than always-last:
        //   asc  → fastest, slowest, then not-called
        //   desc → not-called, then slowest, then fastest
        // This way the desc sort doubles as a "show me who hasn't been
        // called yet" view without scrolling to the bottom. Drake's
        // call 2026-05-27.
        case 'speed': return r.speedSec ?? Number.MAX_SAFE_INTEGER
        case 'over90s': return r.firstCallAt ? (r.anyCallConnected ? 2 : 1) : null
        case 'caller': return r.callerName ?? null
        default: return null
      }
    },
  )

  if (rows.length === 0) {
    return (
      <div
        className="geg-serif"
        style={{ padding: '20px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 14 }}
      >
        No leads in cohort{activeCaller ? ' for this caller' : ''}.
      </div>
    )
  }

  return (
    <div style={{ padding: '14px 16px', background: 'var(--color-geg-bg-elev)', border: '1px solid var(--color-geg-border)', borderRadius: 10 }}>
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
          marginBottom: 10,
        }}
      >
        {rows.length} leads {state.dir === null ? '· most recent first call first' : `· sorted by ${headerLabelForSpeed(state.key)} ${state.dir}`}
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: SPEED_COLS,
          gap: 10,
          padding: '6px 0 8px',
          borderBottom: '1px solid var(--color-geg-border)',
          position: 'sticky',
          top: 0,
          background: 'var(--color-geg-bg-elev)',
          zIndex: 1,
        }}
      >
        <SortableHeader label="Prospect" sortKey="prospect" align="left" state={state} onToggle={onToggle} />
        <SortableHeader label="Created (ET)" sortKey="created" align="left" state={state} onToggle={onToggle} />
        <SortableHeader label="Time to call" sortKey="speed" align="left" state={state} onToggle={onToggle} />
        <SortableHeader label="Connected" sortKey="over90s" align="left" state={state} onToggle={onToggle} />
        <SortableHeader label="Caller" sortKey="caller" align="left" state={state} onToggle={onToggle} />
      </div>
      <ScrollBody maxHeight={520}>
        {sorted.map((r) => (
          <div
            key={r.leadId}
            style={{
              display: 'grid',
              gridTemplateColumns: SPEED_COLS,
              gap: 10,
              padding: '8px 0',
              borderBottom: '1px dashed var(--color-geg-border)',
              alignItems: 'center',
            }}
          >
            <span
              className="geg-serif"
              style={{ fontSize: 13, color: 'var(--color-geg-text-2)', letterSpacing: '-0.002em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
              title={r.leadId}
            >
              {r.prospectName ?? <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>(no name)</span>}
            </span>
            <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>
              {formatEtTimestamp(r.leadCreatedAt)}
            </span>
            <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>
              {r.speedSec !== null ? (
                <>
                  {formatDuration(r.speedSec)}
                  {/* First-two-dials connect signal — setters double-dial,
                      so this captures "did we get them in the first
                      attempt cycle." Muted bracket so it doesn't compete
                      with the time value. */}
                  <span style={{ color: 'var(--color-geg-text-faint)', marginLeft: 4 }}>
                    ({r.firstTwoDialsConnected ? 'yes' : 'no'})
                  </span>
                </>
              ) : (
                <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>not yet called</span>
              )}
            </span>
            <span
              className="geg-mono"
              style={{
                fontSize: 11,
                letterSpacing: '0.04em',
                color: r.anyCallConnected
                  ? 'var(--color-geg-pos)'
                  : r.firstCallAt
                    ? 'var(--color-geg-neg)'
                    : 'var(--color-geg-text-faint)',
              }}
              title="Yes when ANY outbound call to this lead has connected (>=90s) at any time."
            >
              {r.firstCallAt ? (r.anyCallConnected ? 'Yes' : 'No') : '—'}
            </span>
            <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>
              {r.callerName ?? (r.callerUserId ? r.callerUserId.slice(0, 13) + '…' : <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>—</span>)}
            </span>
          </div>
        ))}
      </ScrollBody>
    </div>
  )
}

function headerLabelForSpeed(k: SpeedSortKey): string {
  return ({ prospect: 'prospect', created: 'created', speed: 'time to call', over90s: 'connected', caller: 'caller' } as Record<SpeedSortKey, string>)[k]
}

// ---------------------------------------------------------------------------
// Per-rep call-activity drill — calls + form-only rows for a single rep
// ---------------------------------------------------------------------------

type CallSortKey = 'prospect' | 'duration' | 'outcome' | 'callAt'

const CALL_DRILL_COLS = '1.6fr 0.8fr 1.4fr 1.2fr'

export function CallActivityDrillTable({
  calls,
  repName,
}: {
  calls: CallActivityDrillRow[]
  repName: string
}) {
  const { sorted, state, onToggle } = useColumnSort<CallActivityDrillRow, CallSortKey>(
    calls,
    (r, k) => {
      switch (k) {
        case 'prospect': return r.prospectName ?? null
        case 'duration': return r.noMatchingCall ? null : r.durationSec
        case 'outcome': return r.bookingStatus ?? null
        case 'callAt': return r.callAt || null
        default: return null
      }
    },
  )

  return (
    <div
      style={{
        margin: '0 -12px 8px',
        padding: '14px 16px 16px',
        background: 'var(--color-geg-bg)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 8,
      }}
    >
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
          marginBottom: 10,
        }}
      >
        {repName} · per-call detail · calls over 90s + form-only rows · {calls.length} {state.dir === null ? 'most recent first' : `sorted ${state.dir}`}
      </div>
      {calls.length === 0 ? (
        <div
          className="geg-serif"
          style={{ padding: '20px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 14 }}
        >
          No calls over 90s in this range for this rep.
        </div>
      ) : (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: CALL_DRILL_COLS,
              gap: 10,
              padding: '6px 0 8px',
              borderBottom: '1px solid var(--color-geg-border)',
              position: 'sticky',
              top: 0,
              background: 'var(--color-geg-bg)',
              zIndex: 1,
            }}
          >
            <SortableHeader label="Prospect" sortKey="prospect" align="left" state={state} onToggle={onToggle} />
            <SortableHeader label="Duration" sortKey="duration" state={state} onToggle={onToggle} />
            <SortableHeader label="Outcome" sortKey="outcome" align="left" state={state} onToggle={onToggle} />
            <SortableHeader label="Time called (ET)" sortKey="callAt" align="left" state={state} onToggle={onToggle} />
          </div>
          <ScrollBody maxHeight={460}>
            {sorted.map((c) => (
              // Wrap the whole row in a Link to the setter-call detail
              // page when there's an actual Close call backing it.
              // Form-only rows (noMatchingCall=true) have no audio /
              // transcript so we render a plain div. The detail page
              // 404s gracefully if a transcript hasn't landed yet
              // (cron may not have caught up — runs every 15 min).
              <CallDrillRow key={c.callId} call={c} />
            ))}
          </ScrollBody>
        </>
      )}
    </div>
  )
}

// Per-row renderer for the call-drill table. Extracted so we can swap
// the outer element between a Next/Link (when the row maps to a real
// Close call that should be transcribed) and a plain div (when the row
// is a form-only artifact with no audio).
function CallDrillRow({ call: c }: { call: CallActivityDrillRow }) {
  const baseStyle: React.CSSProperties = {
    display: 'grid',
    gridTemplateColumns: CALL_DRILL_COLS,
    gap: 10,
    padding: '8px 0',
    borderBottom: '1px dashed var(--color-geg-border)',
    alignItems: 'center',
  }

  const cells = (
    <>
      <span
        className="geg-serif"
        style={{
          fontSize: 13,
          color: 'var(--color-geg-text-2)',
          letterSpacing: '-0.002em',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
        }}
        title={c.leadId}
      >
        {c.prospectName ?? (
          <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>(no name)</span>
        )}
        {c.noMatchingCall ? (
          <span
            className="geg-mono"
            title="No call to match — EOC was filled but no over-90s call by this rep is in Close for this lead in this window"
            style={{
              fontSize: 9,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              padding: '1px 6px',
              borderRadius: 4,
              border: '1px solid var(--color-geg-border)',
              color: 'var(--color-geg-text-faint)',
              background: 'var(--color-geg-bg)',
              cursor: 'help',
            }}
          >
            no call
          </span>
        ) : null}
      </span>
      <Num value={c.noMatchingCall ? '—' : formatDuration(c.durationSec)} accent />
      <span
        className="geg-mono"
        style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}
      >
        {c.bookingStatus ?? (
          <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>Missing</span>
        )}
      </span>
      <span
        className="geg-mono"
        style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}
      >
        {formatEtTimestamp(c.callAt)}
      </span>
    </>
  )

  // Form-only rows: no audio, render a static div.
  if (c.noMatchingCall) {
    return <div style={baseStyle}>{cells}</div>
  }

  return (
    <Link
      href={`/sales-dashboard/calls/${encodeURIComponent(c.callId)}`}
      style={{ ...baseStyle, textDecoration: 'none', color: 'inherit' }}
    >
      {cells}
    </Link>
  )
}

// ---------------------------------------------------------------------------
// Per-rep aggregate table — rep rows with click-to-drill expansion
// ---------------------------------------------------------------------------

type RepSortKey =
  | 'name'
  | 'totalCalls'
  | 'over90s'
  | 'bookings'
  | 'dqs'
  | 'downsells'
  | 'followUps'
  | 'missing'

const REP_COLS = '1.7fr 0.8fr 0.8fr 0.8fr 0.8fr 0.9fr 0.9fr 0.9fr'

export function PerRepCallActivityTable({
  label,
  aggregate,
  rows,
  selectedRep,
  drill,
}: {
  label: string
  aggregate: CallActivityRepRow
  rows: CallActivityRepRow[]
  selectedRep: string | null
  drill: CallActivityDrillRow[]
}) {
  const { sorted, state, onToggle } = useColumnSort<CallActivityRepRow, RepSortKey>(
    rows,
    (r, k) => {
      switch (k) {
        case 'name': return r.name ?? null
        case 'totalCalls': return r.totalCalls
        case 'over90s': return r.totalOver90s
        case 'bookings': return r.bookings
        case 'dqs': return r.dqs
        case 'downsells': return r.downsells
        case 'followUps': return r.followUps
        case 'missing': return r.missing
        default: return null
      }
    },
  )

  return (
    <div style={{ padding: '18px 22px', background: 'var(--color-geg-bg-elev)', border: '1px solid var(--color-geg-border)', borderRadius: 10 }}>
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
          marginBottom: 12,
        }}
      >
        {label}
      </div>
      <div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: REP_COLS,
            gap: 10,
            padding: '6px 0 8px',
            borderBottom: '1px solid var(--color-geg-border)',
            position: 'sticky',
            top: 0,
            background: 'var(--color-geg-bg-elev)',
            zIndex: 1,
          }}
        >
          <SortableHeader label="Rep" sortKey="name" align="left" state={state} onToggle={onToggle} />
          <SortableHeader label="Calls" sortKey="totalCalls" state={state} onToggle={onToggle} />
          <SortableHeader label="Connected" sortKey="over90s" state={state} onToggle={onToggle} />
          <SortableHeader label="Books" sortKey="bookings" state={state} onToggle={onToggle} />
          <SortableHeader label="Downsell" sortKey="downsells" state={state} onToggle={onToggle} />
          <SortableHeader label="Follow-up" sortKey="followUps" state={state} onToggle={onToggle} />
          <SortableHeader label="DQs" sortKey="dqs" state={state} onToggle={onToggle} />
          <SortableHeader label="Missing" sortKey="missing" state={state} onToggle={onToggle} />
        </div>

        {/* Aggregate row pinned at the top, never sorts */}
        <div style={{ display: 'grid', gridTemplateColumns: REP_COLS, gap: 10, padding: '11px 0', borderBottom: '1px solid var(--color-geg-border)', alignItems: 'center' }}>
          <span className="geg-serif" style={{ fontSize: 14, color: 'var(--color-geg-text-2)', fontStyle: 'italic', letterSpacing: '-0.002em' }}>
            All {label.toLowerCase()}
          </span>
          <Num value={aggregate.totalCalls.toString()} accent />
          <Num value={aggregate.totalOver90s.toString()} />
          <Num value={aggregate.bookings.toString()} />
          <Num value={aggregate.downsells.toString()} />
          <Num value={aggregate.followUps.toString()} />
          <Num value={aggregate.dqs.toString()} />
          <Num value={aggregate.missing.toString()} />
        </div>

        {rows.length === 0 ? (
          <div
            className="geg-serif"
            style={{ padding: '20px 0', textAlign: 'center', fontStyle: 'italic', color: 'var(--color-geg-text-3)', fontSize: 14 }}
          >
            No {label.toLowerCase()} activity in this range.
          </div>
        ) : (
          <ScrollBody maxHeight={520}>
            {sorted.map((r) => {
              const isSelected = selectedRep === r.userId
              return (
                <div key={r.userId ?? 'agg'}>
                  <RepLinkPreservingParams userId={isSelected ? null : r.userId}>
                    <div
                      style={{
                        display: 'grid',
                        gridTemplateColumns: REP_COLS,
                        gap: 10,
                        padding: '11px 12px',
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
                        style={{
                          fontSize: 14,
                          color: 'var(--color-geg-text)',
                          letterSpacing: '-0.002em',
                          fontWeight: isSelected ? 600 : 400,
                        }}
                      >
                        {isSelected ? '▼ ' : '▸ '}{r.name ?? (r.userId ? r.userId.slice(0, 13) + '…' : '—')}
                      </span>
                      <Num value={r.totalCalls.toString()} accent />
                      <Num value={r.totalOver90s.toString()} />
                      <Num value={r.bookings.toString()} />
                      <Num value={r.downsells.toString()} />
                      <Num value={r.followUps.toString()} />
                      <Num value={r.dqs.toString()} />
                      <Num value={r.missing.toString()} />
                    </div>
                  </RepLinkPreservingParams>
                  {isSelected ? (
                    <CallActivityDrillTable
                      calls={drill}
                      repName={r.name ?? (r.userId ? r.userId.slice(0, 13) + '…' : '—')}
                    />
                  ) : null}
                </div>
              )
            })}
          </ScrollBody>
        )}
      </div>
    </div>
  )
}
