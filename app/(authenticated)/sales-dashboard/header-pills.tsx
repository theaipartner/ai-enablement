// Decorative actions-slot pills used in HeaderBand for the Overview
// + Section pages. v2.0 ships them as static chrome (no time-window
// picker yet — deferred to v2.1 per spec § Out of scope).

import { DASHBOARD_WINDOW_LABEL } from '@/lib/db/sales-dashboard'

export function WindowPill() {
  return (
    <span
      className="geg-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 12px',
        border: '1px solid var(--color-geg-border-strong)',
        borderRadius: 6,
        fontSize: 11,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-2)',
      }}
    >
      <span
        className="geg-pulse"
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--color-geg-pos)',
        }}
      />
      {DASHBOARD_WINDOW_LABEL.toUpperCase()}
    </span>
  )
}

export function PersonPill({ label }: { label: string }) {
  return (
    <span
      className="geg-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 10,
        padding: '6px 12px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border-strong)',
        borderRadius: 6,
        fontSize: 11,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-2)',
      }}
    >
      {label}
    </span>
  )
}

export function SectionStatusPill({
  live,
  pending,
  nc,
}: {
  live: number
  pending: number
  nc: number
}) {
  // Section-page actions slot — three-color triplet.
  return (
    <span
      className="geg-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border-strong)',
        borderRadius: 6,
        fontSize: 11,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
      }}
    >
      <span style={{ color: 'var(--color-geg-pos)' }}>{live} LIVE</span>
      <span style={{ color: 'var(--color-geg-text-faint)' }}>·</span>
      <span style={{ color: 'var(--color-geg-warn)' }}>{pending} PENDING</span>
      <span style={{ color: 'var(--color-geg-text-faint)' }}>·</span>
      <span style={{ color: 'var(--color-geg-text-faint)' }}>{nc} N/C</span>
    </span>
  )
}
