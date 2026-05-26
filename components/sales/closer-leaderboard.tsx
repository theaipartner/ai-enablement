import Link from 'next/link'
import {
  type CloserRep,
  type CloserAverages,
} from '@/lib/db/sales-dashboard-mocks'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import { Sparkline } from './sparkline'

// People · Closers leaderboard.
//
// Ranked by Cash per Call (default), best first. Pinned TEAM AVG row
// at the top so every other row reads "vs the average." Each cell
// shows the value + a small per-cell delta-vs-avg pill.

const COLUMN_TEMPLATE = '36px 1.4fr 80px 80px 80px 100px 90px 90px 80px 80px 88px'

export function CloserLeaderboard({
  reps,
  averages,
}: {
  reps: CloserRep[]
  averages: CloserAverages
}) {
  return (
    <section
      aria-label="Closer leaderboard"
      style={{
        marginTop: 24,
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <HeaderRow />
      <TeamAvgRow averages={averages} />
      {reps.map((r, i) => (
        <CloserRow key={r.id} rep={r} rank={i + 1} averages={averages} isLast={i === reps.length - 1} isBottom={i === reps.length - 1} />
      ))}
    </section>
  )
}

function HeaderRow() {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: COLUMN_TEMPLATE,
        gap: 12,
        padding: '12px 22px',
        background: 'var(--color-geg-bg)',
        borderBottom: '1px solid var(--color-geg-border)',
      }}
    >
      <Col label="" />
      <Col label="Closer" align="left" />
      <Col label="Showed" />
      <Col label="Close" />
      <Col label="1-call" />
      <Col label="Total cash" />
      <Col label="$ / call" />
      <Col label="AOV" />
      <Col label="Deposits" />
      <Col label="Closed" />
      <Col label="Cash trend" />
    </div>
  )
}

function TeamAvgRow({ averages }: { averages: CloserAverages }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: COLUMN_TEMPLATE,
        gap: 12,
        padding: '12px 22px',
        borderBottom: '1px solid var(--color-geg-border)',
        background: 'var(--color-geg-bg-elev)',
        alignItems: 'center',
      }}
    >
      <span
        className="geg-mono"
        style={{ fontSize: 9.5, color: 'var(--color-geg-text-faint)', letterSpacing: '0.14em' }}
      >
        AVG
      </span>
      <span
        className="geg-mono"
        style={{
          fontSize: 11,
          color: 'var(--color-geg-text-2)',
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          fontWeight: 500,
        }}
      >
        Team average
      </span>
      <AvgCell value={String(Math.round(averages.showedCalls))} />
      <AvgCell value={`${Math.round(averages.closeRate * 100)}%`} />
      <AvgCell value={`${Math.round(averages.oneCallCloseRate * 100)}%`} />
      <AvgCell value={compactUsd(averages.cashTotal)} />
      <AvgCell value={compactUsd(averages.cashPerCall)} />
      <AvgCell value={compactUsd(averages.aov)} />
      <AvgCell value={String(Math.round(averages.deposits))} />
      <AvgCell value={String(Math.round(averages.totalClosedDeals))} />
      <span />
    </div>
  )
}

function CloserRow({
  rep,
  rank,
  averages,
  isLast,
  isBottom,
}: {
  rep: CloserRep
  rank: number
  averages: CloserAverages
  isLast: boolean
  isBottom: boolean
}) {
  const borderColor =
    rank === 1
      ? 'var(--color-geg-pos)'
      : isBottom
        ? 'var(--color-geg-neg)'
        : 'transparent'
  return (
    <Link
      href={`/sales-dashboard/people/closer/${rep.id}`}
      style={{
        display: 'grid',
        gridTemplateColumns: COLUMN_TEMPLATE,
        gap: 12,
        padding: '14px 22px',
        borderBottom: isLast ? 'none' : '1px dashed var(--color-geg-border)',
        borderLeft: `3px solid ${borderColor}`,
        paddingLeft: 19,
        alignItems: 'center',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <span
        className="geg-mono"
        style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.06em' }}
      >
        #{rank}
      </span>
      <span
        className="geg-serif"
        style={{ fontSize: 15, color: 'var(--color-geg-text)', letterSpacing: '-0.005em' }}
      >
        {rep.name}
      </span>
      <Cell value={String(rep.showedCalls)} delta={pctVs(rep.showedCalls, averages.showedCalls)} higherBetter />
      <Cell value={`${Math.round(rep.closeRate * 100)}%`} delta={pctVs(rep.closeRate, averages.closeRate)} higherBetter />
      <Cell value={`${Math.round(rep.oneCallCloseRate * 100)}%`} delta={pctVs(rep.oneCallCloseRate, averages.oneCallCloseRate)} higherBetter />
      <Cell value={compactUsd(rep.cashTotal)} delta={pctVs(rep.cashTotal, averages.cashTotal)} higherBetter />
      <Cell value={compactUsd(rep.cashPerCall)} delta={pctVs(rep.cashPerCall, averages.cashPerCall)} accent higherBetter />
      <Cell value={compactUsd(rep.aov)} delta={pctVs(rep.aov, averages.aov)} higherBetter />
      <Cell value={String(rep.deposits)} delta={pctVs(rep.deposits, averages.deposits)} higherBetter />
      <Cell value={String(rep.totalClosedDeals)} delta={pctVs(rep.totalClosedDeals, averages.totalClosedDeals)} higherBetter />
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Sparkline data={rep.trend} width={72} height={20} stroke="var(--color-geg-text-3)" />
      </div>
    </Link>
  )
}

function pctVs(value: number, avg: number): number {
  if (avg === 0) return 0
  return (value - avg) / avg
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

function AvgCell({ value }: { value: string }) {
  return (
    <span
      className="geg-numeric-serif"
      style={{
        fontSize: 14,
        color: 'var(--color-geg-text-2)',
        letterSpacing: '-0.01em',
        textAlign: 'right',
        fontStyle: 'italic',
      }}
    >
      {value}
    </span>
  )
}

function Cell({
  value,
  delta,
  accent,
  higherBetter,
}: {
  value: string
  delta: number
  accent?: boolean
  higherBetter?: boolean
}) {
  const isPositive = delta >= 0
  const isGood = (higherBetter ?? true) ? isPositive : !isPositive
  const color =
    delta === 0
      ? 'var(--color-geg-text-faint)'
      : isGood
        ? 'var(--color-geg-pos)'
        : 'var(--color-geg-neg)'
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 }}>
      <span
        className="geg-numeric-serif"
        style={{
          fontSize: 15,
          color: accent ? 'var(--color-geg-text)' : 'var(--color-geg-text-2)',
          letterSpacing: '-0.01em',
        }}
      >
        {value}
      </span>
      <span
        className="geg-mono"
        style={{
          fontSize: 9.5,
          color,
          letterSpacing: '0.04em',
          fontWeight: 500,
        }}
      >
        {delta === 0 ? '·' : isPositive ? '▲' : '▼'} {Math.abs(delta * 100).toFixed(0)}%
      </span>
    </div>
  )
}
