import Link from 'next/link'
import {
  type SetterRep,
  type SetterAverages,
} from '@/lib/db/sales-dashboard-mocks'
import { Sparkline } from './sparkline'

// People · Setters leaderboard.
// Ranked by Conversation-to-Book Rate (booked rate), best first.

const COLUMN_TEMPLATE = '36px 1.4fr 90px 90px 100px 80px 90px 100px 90px 90px 88px'

export function SetterLeaderboard({
  reps,
  averages,
}: {
  reps: SetterRep[]
  averages: SetterAverages
}) {
  return (
    <section
      aria-label="Setter leaderboard"
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
        <SetterRow
          key={r.id}
          rep={r}
          rank={i + 1}
          averages={averages}
          isLast={i === reps.length - 1}
          isBottom={i === reps.length - 1}
        />
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
      <Col label="Setter" align="left" />
      <Col label="Triages" />
      <Col label="Dials" />
      <Col label="Conv → book" />
      <Col label="DQ" />
      <Col label="Downsell" />
      <Col label="Time → dial" />
      <Col label="Hand-offs" />
      <Col label="Meetings" />
      <Col label="Trend" />
    </div>
  )
}

function TeamAvgRow({ averages }: { averages: SetterAverages }) {
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
      <AvgCell value={String(Math.round(averages.triages))} />
      <AvgCell value={String(Math.round(averages.totalDials))} />
      <AvgCell value={`${Math.round(averages.bookedRate * 100)}%`} />
      <AvgCell value={`${Math.round(averages.dqRate * 100)}%`} />
      <AvgCell value={`${Math.round(averages.downsellRate * 100)}%`} />
      <AvgCell value={`${Math.round(averages.avgTimeToDial)}m`} />
      <AvgCell value={String(Math.round(averages.handOffsCompleted))} />
      <AvgCell value={String(Math.round(averages.meetingsProduced))} />
      <span />
    </div>
  )
}

function SetterRow({
  rep,
  rank,
  averages,
  isLast,
  isBottom,
}: {
  rep: SetterRep
  rank: number
  averages: SetterAverages
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
      href={`/sales-dashboard/people/setter/${rep.id}`}
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
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.06em' }}>
        #{rank}
      </span>
      <span className="geg-serif" style={{ fontSize: 15, color: 'var(--color-geg-text)', letterSpacing: '-0.005em' }}>
        {rep.name}
      </span>
      <Cell value={String(rep.triages)} delta={pctVs(rep.triages, averages.triages)} higherBetter />
      <Cell value={String(rep.totalDials)} delta={pctVs(rep.totalDials, averages.totalDials)} higherBetter />
      <Cell value={`${Math.round(rep.bookedRate * 100)}%`} delta={pctVs(rep.bookedRate, averages.bookedRate)} accent higherBetter />
      <Cell value={`${Math.round(rep.dqRate * 100)}%`} delta={pctVs(rep.dqRate, averages.dqRate)} higherBetter={false} />
      <Cell value={`${Math.round(rep.downsellRate * 100)}%`} delta={pctVs(rep.downsellRate, averages.downsellRate)} higherBetter={false} />
      <Cell value={`${rep.avgTimeToDial}m`} delta={pctVs(rep.avgTimeToDial, averages.avgTimeToDial)} higherBetter={false} />
      <Cell value={String(rep.handOffsCompleted)} delta={pctVs(rep.handOffsCompleted, averages.handOffsCompleted)} higherBetter />
      <Cell value={String(rep.meetingsProduced)} delta={pctVs(rep.meetingsProduced, averages.meetingsProduced)} higherBetter />
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
