import type { DailyFunnelRow } from '@/lib/db/funnel-daily'

// Marketing page — the rolling last-5-days daily cohort table. Pinned to the
// bottom of the page, independent of the date picker. Each row is the cohort
// that opted in that day and how far it has since progressed. See
// lib/db/funnel-daily.ts for the cohort-vs-activity rationale.

const COLS = '1.1fr 1fr 0.8fr 0.9fr 0.8fr 0.8fr 0.8fr 1fr 0.9fr 0.8fr'

function fmtUsd(value: number | null): string {
  if (value == null) return '—'
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function fmtCount(value: number): string {
  return value.toLocaleString('en-US')
}

// Speed-to-lead seconds → "2h 56m" / "47m" / "38s". Mirrors the Leads-page read.
function fmtSpeed(sec: number | null): string {
  if (sec == null) return '—'
  const s = Math.round(sec)
  if (s < 60) return `${s}s`
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

// ET date string → "Wed, Jun 18".
function fmtDay(etDate: string): string {
  const [y, m, d] = etDate.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(dt)
}

export function DailyFunnelTable({ rows }: { rows: DailyFunnelRow[] }) {
  return (
    <div style={{ marginTop: 24 }}>
      <div
        className="geg-mono"
        style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 4 }}
      >
        Last 5 days · by opt-in day
      </div>
      <div
        className="geg-mono"
        style={{ fontSize: 9, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)', marginBottom: 12 }}
      >
        Each row is the cohort that opted in that day. Recent days show fewer Showed / Closed — those leads
        haven&apos;t finished their sales cycle yet.
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: COLS,
          gap: 10,
          padding: '6px 4px 12px',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        <ColH label="Day" align="left" />
        <ColH label="Spend" />
        <ColH label="Leads" />
        <ColH label="Connects" />
        <ColH label="Booked" />
        <ColH label="Showed" />
        <ColH label="Closed" />
        <ColH label="Cash" />
        <ColH label="Sp2L" />
        <ColH label="Dials" />
      </div>

      {rows.map((r) => (
        <div
          key={r.etDate}
          style={{
            display: 'grid',
            gridTemplateColumns: COLS,
            gap: 10,
            padding: '13px 4px',
            borderBottom: '1px dashed var(--color-geg-border)',
            alignItems: 'center',
          }}
        >
          <span className="geg-serif" style={{ fontSize: 14, color: 'var(--color-geg-text)', letterSpacing: '-0.002em' }}>
            {fmtDay(r.etDate)}
          </span>
          <Num value={fmtUsd(r.spendUsd)} />
          <Num value={fmtCount(r.leads)} accent />
          <Num value={fmtCount(r.connected)} />
          <Num value={fmtCount(r.booked)} />
          <Num value={fmtCount(r.showed)} />
          <Num value={fmtCount(r.closed)} />
          <Num value={fmtUsd(r.cashUsd)} />
          <Num value={fmtSpeed(r.speedToLeadSec)} />
          <Num value={fmtCount(r.dials)} />
        </div>
      ))}
    </div>
  )
}

function ColH({ label, align }: { label: string; align?: 'left' | 'right' }) {
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 10,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-faint)',
        textAlign: align ?? 'right',
      }}
    >
      {label}
    </span>
  )
}

function Num({ value, accent }: { value: string; accent?: boolean }) {
  return (
    <span
      className="geg-numeric-serif"
      style={{
        fontSize: 14,
        color: accent ? 'var(--color-geg-accent)' : 'var(--color-geg-text-2)',
        letterSpacing: '-0.01em',
        textAlign: 'right',
      }}
    >
      {value}
    </span>
  )
}
