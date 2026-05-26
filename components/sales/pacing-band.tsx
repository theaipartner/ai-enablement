import type { Pacing } from '@/lib/db/sales-dashboard-mocks'
import { formatMetricValue } from '@/lib/db/sales-dashboard-shared'

// Pulse · top band — MTD revenue vs target with pacing-relative status.
// The single "where are we" anchor every other block on the page is
// framed against.

export function PacingBand({ pacing }: { pacing: Pacing }) {
  const usd = (n: number) => formatMetricValue(n, 'usd')
  const paceGap = pacing.mtdActual - pacing.mtdExpected
  const onPace = paceGap >= 0
  const daysLeft = pacing.daysInMonth - pacing.dayOfMonth
  const eomGap = pacing.projectedEom - pacing.monthTarget
  const eomGapPct = Math.abs(eomGap / pacing.monthTarget) * 100
  const eomGood = eomGap >= 0
  const targetProgress = Math.min(100, (pacing.mtdActual / pacing.monthTarget) * 100)
  const expectedProgress = Math.min(100, (pacing.mtdExpected / pacing.monthTarget) * 100)

  return (
    <section
      aria-label="Month-to-date pacing"
      style={{
        marginTop: 36,
        padding: '24px 28px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr 1fr 1fr',
          gap: 32,
          alignItems: 'baseline',
        }}
      >
        <Stat
          eyebrow="MTD CASH"
          value={usd(pacing.mtdActual)}
          sub={`of ${usd(pacing.monthTarget)} target`}
          big
        />
        <Stat
          eyebrow={onPace ? 'AHEAD OF PACE' : 'BEHIND PACE'}
          value={`${onPace ? '+' : '−'}${usd(Math.abs(paceGap)).replace('$', '$')}`}
          sub={`expected ${usd(pacing.mtdExpected)}`}
          tone={onPace ? 'pos' : 'neg'}
        />
        <Stat
          eyebrow="DAILY PACE REQ"
          value={usd(pacing.dailyPaceRequired)}
          sub={`${daysLeft} days remaining`}
        />
        <Stat
          eyebrow="PROJECTED EOM"
          value={usd(pacing.projectedEom)}
          sub={`${eomGood ? '+' : '−'}${eomGapPct.toFixed(1)}% vs target`}
          tone={eomGood ? 'pos' : 'neg'}
        />
      </div>

      <ProgressTrack mtdPct={targetProgress} expectedPct={expectedProgress} onPace={onPace} />
      <Microcopy onPace={onPace} eomGood={eomGood} eomGap={eomGap} />
    </section>
  )
}

function Stat({
  eyebrow,
  value,
  sub,
  tone,
  big,
}: {
  eyebrow: string
  value: string
  sub?: string
  tone?: 'pos' | 'neg'
  big?: boolean
}) {
  const valueColor =
    tone === 'pos'
      ? 'var(--color-geg-pos)'
      : tone === 'neg'
        ? 'var(--color-geg-neg)'
        : 'var(--color-geg-text)'
  return (
    <div>
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
          marginBottom: 6,
        }}
      >
        {eyebrow}
      </div>
      <div
        className="geg-numeric-serif"
        style={{
          fontSize: big ? 44 : 28,
          lineHeight: big ? '46px' : '30px',
          letterSpacing: '-0.025em',
          color: valueColor,
        }}
      >
        {value}
      </div>
      {sub ? (
        <div
          className="geg-serif"
          style={{
            fontSize: 12,
            marginTop: 6,
            color: 'var(--color-geg-text-3)',
            letterSpacing: '-0.002em',
          }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  )
}

function ProgressTrack({
  mtdPct,
  expectedPct,
  onPace,
}: {
  mtdPct: number
  expectedPct: number
  onPace: boolean
}) {
  const fillColor = onPace ? 'var(--color-geg-pos)' : 'var(--color-geg-warn)'
  return (
    <div
      style={{
        marginTop: 22,
        position: 'relative',
        height: 10,
        borderRadius: 5,
        background: 'var(--color-geg-bg)',
        border: '1px solid var(--color-geg-border)',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: `${mtdPct}%`,
          background: fillColor,
          borderRadius: 4,
        }}
      />
      <div
        title={`Expected: ${expectedPct.toFixed(1)}%`}
        style={{
          position: 'absolute',
          top: -3,
          bottom: -3,
          left: `${expectedPct}%`,
          width: 2,
          background: 'var(--color-geg-text)',
        }}
      />
    </div>
  )
}

function Microcopy({
  onPace,
  eomGood,
  eomGap,
}: {
  onPace: boolean
  eomGood: boolean
  eomGap: number
}) {
  const usd = (n: number) => formatMetricValue(n, 'usd')
  const sentence = onPace && eomGood
    ? 'On pace to land above target.'
    : onPace && !eomGood
      ? `Ahead on pace, but trailing run-rate projects ${usd(Math.abs(eomGap))} short of target.`
      : !onPace && eomGood
        ? `Behind pace today, but recent run-rate projects ${usd(Math.abs(eomGap))} above target.`
        : `Behind pace and projected ${usd(Math.abs(eomGap))} short of target — pull a lever.`
  return (
    <div
      className="geg-serif"
      style={{
        marginTop: 14,
        fontSize: 13,
        fontStyle: 'italic',
        color: onPace && eomGood ? 'var(--color-geg-text-3)' : 'var(--color-geg-warn)',
        letterSpacing: '-0.002em',
      }}
    >
      {sentence}
    </div>
  )
}
