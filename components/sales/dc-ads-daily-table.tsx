import type { DcAdsDailyRow } from '@/lib/db/dc-ads'

// DC ads page — the rolling last-5-days daily cohort table, borrowed from the
// Advertising Hub's DailyFunnelTable but shaped to the DC funnel: Spend →
// Opt-ins → Called → Connected → Closed → Cash → Dials. No speed-to-lead and
// no bookings columns (not part of the DC funnel's read). Pinned to the bottom
// of the page, independent of the date picker; scoped to the ad cascade.

const COLS = '1.1fr 1fr 0.9fr 0.9fr 1fr 0.8fr 1fr 0.8fr'

function fmtUsd(value: number | null): string {
  if (value == null) return '—'
  return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 0, maximumFractionDigits: 0 })
}

function fmtCount(value: number): string {
  return value.toLocaleString('en-US')
}

// ET date string → "Wed, Jul 9".
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

export function DcAdsDailyTable({ rows }: { rows: DcAdsDailyRow[] }) {
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
        Each row is the cohort that opted in that ET day and how far it has since progressed. Recent days
        show fewer Connected / Closed — those leads haven&apos;t finished their cycle yet. Follows the ad
        chooser above.
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
        <ColH label="Opt-ins" />
        <ColH label="Called" />
        <ColH label="Connected" />
        <ColH label="Closed" />
        <ColH label="Cash" />
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
          <Num value={fmtCount(r.optIns)} accent />
          <Num value={fmtCount(r.called)} />
          <Num value={fmtCount(r.connected)} />
          <Num value={fmtCount(r.closed)} />
          <Num value={fmtUsd(r.cashUsd)} />
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
