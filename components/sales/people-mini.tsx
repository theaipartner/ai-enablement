import Link from 'next/link'
import type { CloserRep } from '@/lib/db/sales-dashboard-mocks'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import { Sparkline } from './sparkline'

// Pulse · people mini — top 3 closers ranked by cash per call.
// Single header row at the top, then one row per closer. Each row is a
// link to /sales-dashboard/closing#closer-{id} so a click jumps you to
// that closer in the full leaderboard.

const COLUMN_TEMPLATE = '28px 1.2fr 90px 100px 70px 70px 70px 88px'

export function PeopleMini({ closers }: { closers: CloserRep[] }) {
  const top = closers.slice(0, 3)
  return (
    <section
      aria-label="Top closers this period"
      style={{
        marginTop: 18,
        padding: '20px 24px 22px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 14,
          gap: 12,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
          <span
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-3)',
            }}
          >
            PEOPLE
          </span>
          <span
            className="geg-serif"
            style={{ fontSize: 17, color: 'var(--color-geg-text)', letterSpacing: '-0.01em' }}
          >
            Top closers · cash per call.
          </span>
        </div>
        <Link
          href="/sales-dashboard/people"
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-accent)',
            textDecoration: 'none',
          }}
        >
          SEE ALL →
        </Link>
      </div>
      <HeaderRow />
      <div>
        {top.map((c, i) => (
          <CloserRow key={c.id} rep={c} rank={i + 1} />
        ))}
      </div>
    </section>
  )
}

function HeaderRow() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: COLUMN_TEMPLATE,
        gap: 14,
        padding: '6px 0 10px',
        borderBottom: '1px solid var(--color-geg-border)',
        alignItems: 'baseline',
      }}
    >
      <Col label="" />
      <Col label="Closer" align="left" />
      <Col label="$ / call" />
      <Col label="Total cash" />
      <Col label="Calls" />
      <Col label="Show" />
      <Col label="Close" />
      <Col label="Trend" />
    </div>
  )
}

function CloserRow({ rep, rank }: { rep: CloserRep; rank: number }) {
  return (
    <Link
      href={`/sales-dashboard/closing#closer-${rep.id}`}
      style={{
        display: 'grid',
        gridTemplateColumns: COLUMN_TEMPLATE,
        gap: 14,
        padding: '12px 0',
        borderBottom: '1px dashed var(--color-geg-border)',
        alignItems: 'center',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <span
        className="geg-mono"
        style={{
          fontSize: 11,
          color: 'var(--color-geg-text-faint)',
          letterSpacing: '0.06em',
        }}
      >
        #{rank}
      </span>
      <span
        className="geg-serif"
        style={{ fontSize: 15, color: 'var(--color-geg-text)', letterSpacing: '-0.005em' }}
      >
        {rep.name}
      </span>
      <Num value={compactUsd(rep.cashPerCall)} accent />
      <Num value={compactUsd(rep.cashTotal)} />
      <Num value={String(rep.callsHandled)} />
      <Num value={`${Math.round(rep.showRate * 100)}%`} />
      <Num value={`${Math.round(rep.closeRate * 100)}%`} />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Sparkline data={rep.trend} width={72} height={20} stroke="var(--color-geg-text-3)" />
      </div>
    </Link>
  )
}

function Col({ label, align }: { label: string; align?: 'left' | 'right' }) {
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 10,
        letterSpacing: '0.14em',
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
        fontSize: 15,
        color: accent ? 'var(--color-geg-text)' : 'var(--color-geg-text-2)',
        letterSpacing: '-0.01em',
        textAlign: 'right',
      }}
    >
      {value}
    </span>
  )
}
