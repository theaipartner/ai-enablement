'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import type { LeadRow } from '@/lib/db/leads'
import { DeleteLeadButton } from './delete-lead-button'

// Sortable per-lead roster (client). Default order is whatever the server
// returns (cohort order); clicking a column header sorts by it — desc → asc →
// back to default. Null/missing values always sort to the end.

const COLS = '1.6fr 0.8fr 1.1fr 1.2fr 1.2fr 1.2fr 0.85fr 0.7fr 0.35fr'

type SortKey =
  | 'prospect' | 'optin' | 'optInAt' | 'latestStage' | 'status' | 'speed' | 'connected' | 'intensity' | ''
type SortDir = 'asc' | 'desc' | null

const HEADERS: { label: string; key: SortKey }[] = [
  { label: 'Prospect', key: 'prospect' },
  { label: 'Opt-in', key: 'optin' },
  { label: 'Opted in (ET)', key: 'optInAt' },
  { label: 'Latest stage', key: 'latestStage' },
  { label: 'Status', key: 'status' },
  { label: 'Time to call', key: 'speed' },
  { label: 'Connected', key: 'connected' },
  { label: 'Intensity', key: 'intensity' },
  { label: '', key: '' },
]

const TYPE_RANK: Record<LeadRow['leadType'], number> = { dq: 3, reactivation: 2, direct: 1, optin: 0 }
// Stage order for sorting; the three closed labels (offer names) all rank top.
const STAGE_RANK: Record<string, number> = {
  'Opted in': 0, Connected: 1, Booked: 2, Confirmed: 3, Showed: 4,
  Closed: 5, 'High Ticket': 5, 'Digital College': 5,
}

function sortValue(r: LeadRow, key: SortKey): number | string | null {
  switch (key) {
    case 'prospect': return r.prospectName ?? ''
    case 'optin': return r.optInType
    case 'optInAt': return r.optInAt
    case 'latestStage': return STAGE_RANK[r.latestStageWord] ?? 0
    case 'status': return TYPE_RANK[r.leadType]
    case 'speed': return r.speedSec
    case 'connected': return r.totalConnectedDurationSec
    case 'intensity': return r.intensity
    default: return null
  }
}

export function LeadRoster({ rows, canDelete, backQuery }: { rows: LeadRow[]; canDelete: boolean; backQuery: string }) {
  const [key, setKey] = useState<SortKey>('')
  const [dir, setDir] = useState<SortDir>(null)

  const sorted = useMemo(() => {
    if (!key || dir === null) return rows
    const copy = rows.slice()
    copy.sort((a, b) => {
      const va = sortValue(a, key)
      const vb = sortValue(b, key)
      const aMissing = va == null || va === ''
      const bMissing = vb == null || vb === ''
      if (aMissing && bMissing) return 0
      if (aMissing) return 1 // missing always last
      if (bMissing) return -1
      if (typeof va === 'number' && typeof vb === 'number') return dir === 'asc' ? va - vb : vb - va
      const sa = String(va).toLowerCase()
      const sb = String(vb).toLowerCase()
      if (sa === sb) return 0
      return dir === 'asc' ? (sa < sb ? -1 : 1) : (sa < sb ? 1 : -1)
    })
    return copy
  }, [rows, key, dir])

  function toggle(k: SortKey) {
    if (!k) return
    if (k !== key) { setKey(k); setDir('desc'); return }
    if (dir === 'desc') { setDir('asc'); return }
    setKey(''); setDir(null) // asc → default
  }

  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '0 0 8px', borderBottom: '1px solid var(--color-geg-border)' }}>
        {HEADERS.map((h, i) => {
          if (!h.key) return <span key={`c${i}`} />
          const active = key === h.key && dir !== null
          return (
            <button
              key={h.key}
              type="button"
              onClick={() => toggle(h.key)}
              className="geg-mono"
              style={{
                background: 'none', border: 'none', padding: 0, cursor: 'pointer',
                fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase',
                color: active ? 'var(--color-geg-text-2)' : 'var(--color-geg-text-3)',
                display: 'inline-flex', gap: 5, alignItems: 'baseline', justifyContent: 'flex-start',
              }}
            >
              <span>{h.label}</span>
              {active ? <span style={{ fontSize: 8 }}>{dir === 'asc' ? '▲' : '▼'}</span> : null}
            </button>
          )
        })}
      </div>
      <div style={{ marginTop: 4 }}>
        {sorted.length === 0 ? (
          <EmptyState />
        ) : (
          sorted.map((r) => <LeadRowView key={r.leadId} r={r} canDelete={canDelete} backQuery={backQuery} />)
        )}
      </div>
    </div>
  )
}

function LeadRowView({ r, canDelete, backQuery }: { r: LeadRow; canDelete: boolean; backQuery: string }) {
  const href = `/sales-dashboard/leads/${encodeURIComponent(r.leadId)}${backQuery ? `?ret=${encodeURIComponent(backQuery)}` : ''}`
  return (
    <Link href={href} style={{ display: 'grid', gridTemplateColumns: COLS, gap: 10, padding: '8px 0', borderBottom: '1px dashed var(--color-geg-border)', alignItems: 'center', textDecoration: 'none', color: 'inherit', cursor: 'pointer' }}>
      <span className="geg-serif" style={{ fontSize: 13, color: 'var(--color-geg-text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.leadId}>
        {r.prospectName ?? <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>(no name)</span>}
      </span>
      <span><OptInBadge type={r.optInType} /></span>
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>{formatEt(r.optInAt)}</span>
      <span><LatestStageCell word={r.latestStageWord} /></span>
      <span><StatusCell r={r} /></span>
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>
        {r.speedSec !== null ? (
          <>
            {formatDuration(r.speedSec)}
            <span style={{ color: 'var(--color-geg-text-faint)', marginLeft: 4 }}>({r.firstTwoDialsConnected ? 'yes' : 'no'})</span>
          </>
        ) : (
          <span style={{ fontStyle: 'italic', color: 'var(--color-geg-text-faint)' }}>not yet called</span>
        )}
      </span>
      <span
        className="geg-mono"
        style={{ fontSize: 11, letterSpacing: '0.04em', display: 'inline-flex', alignItems: 'center', gap: 6 }}
        title="Yes when we reached the lead — a ≥90s call, a setter triage form, a confirmation that reached them, a setter/reactive booking, or a show/close. A pure self-booked direct call does NOT count. Bracket = total ≥90s talk time (omitted when reached only via a form/booking); ×N = how many calls connected."
      >
        <span style={{ color: r.connectedEffective ? 'var(--color-geg-pos)' : r.firstCallAt ? 'var(--color-geg-neg)' : 'var(--color-geg-text-faint)' }}>
          {r.connectedEffective ? 'Yes' : r.firstCallAt ? 'No' : '—'}
        </span>
        {r.totalConnectedDurationSec > 0 ? (
          <span style={{ color: 'var(--color-geg-text-faint)' }}>({formatDuration(r.totalConnectedDurationSec)})</span>
        ) : null}
        {r.connectedCallCount >= 2 ? <MultiCallTag count={r.connectedCallCount} /> : null}
      </span>
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.04em' }}>{r.intensity}</span>
      <span style={{ display: 'flex', justifyContent: 'flex-end' }}>
        {canDelete ? <DeleteLeadButton closeId={r.leadId} /> : null}
      </span>
    </Link>
  )
}

function MultiCallTag({ count }: { count: number }) {
  return (
    <span
      className="geg-mono"
      title={`${count} separate calls to this lead connected (≥90s). The bracketed duration is their combined talk time.`}
      style={{ flexShrink: 0, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', padding: '1px 5px', borderRadius: 4, border: '1px solid var(--color-geg-border)', color: 'var(--color-geg-text-faint)', background: 'var(--color-geg-bg)' }}
    >
      ×{count}
    </span>
  )
}

function OptInBadge({ type }: { type: LeadRow['optInType'] }) {
  const reoptin = type === 'reoptin'
  const color = reoptin ? 'var(--color-geg-text-dim)' : 'var(--color-geg-text-3)'
  return (
    <span className="geg-mono" style={{ fontSize: 8.5, letterSpacing: '0.08em', textTransform: 'uppercase', color, border: '1px solid var(--color-geg-border)', borderRadius: 4, padding: '1px 5px' }}>
      {reoptin ? 're-opt-in' : 'new'}
    </span>
  )
}

// Latest journey stage — the furthest funnel stage the lead ever reached
// (Total-funnel ladder), independent of the phase-scoped Status. Closed reads
// the offer (High Ticket / Digital College).
const STAGE_COLOR: Record<string, string> = {
  'Opted in': 'var(--color-geg-text-faint)',
  Connected: 'var(--color-geg-text-3)',
  Booked: 'var(--color-geg-text-2)',
  Confirmed: 'var(--color-geg-accent)',
  Showed: 'var(--color-geg-text)',
  Closed: 'var(--color-geg-pos)',
  'High Ticket': 'var(--color-geg-pos)',
  'Digital College': 'var(--color-geg-pos)',
}

function LatestStageCell({ word }: { word: string }) {
  const color = STAGE_COLOR[word] ?? 'var(--color-geg-text-2)'
  return (
    <span
      className="geg-mono"
      style={{ fontSize: 8.5, letterSpacing: '0.08em', textTransform: 'uppercase', color, border: `1px solid ${color}`, borderRadius: 4, padding: '1px 5px' }}
      title="Furthest funnel stage reached (any phase) — independent of current status"
    >
      {word}
    </span>
  )
}

const STATUS_COLOR: Record<LeadRow['leadType'], string> = {
  direct: 'var(--color-geg-pos)',
  optin: 'var(--color-geg-warn)',
  reactivation: '#7ea8dd',
  dq: 'var(--color-geg-neg)',
}

function StatusCell({ r }: { r: LeadRow }) {
  const color = STATUS_COLOR[r.leadType]
  if (r.statusWord === '—') {
    return <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)' }}>—</span>
  }
  return (
    <span
      className="geg-mono"
      style={{ fontSize: 8.5, letterSpacing: '0.08em', textTransform: 'uppercase', color, border: `1px solid ${color}`, borderRadius: 4, padding: '1px 5px' }}
      title={`${r.leadType} lead`}
    >
      {r.statusWord}
    </span>
  )
}

function EmptyState() {
  return (
    <div className="geg-mono" style={{ padding: '40px 0', textAlign: 'center', fontSize: 11, letterSpacing: '0.12em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
      No leads opted in for this range.
    </div>
  )
}

function formatEt(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `${m}m ${Math.round(sec % 60)}s`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  const d = Math.floor(h / 24)
  return `${d}d ${h % 24}h`
}
