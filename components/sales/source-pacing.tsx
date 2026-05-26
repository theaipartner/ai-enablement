import type { Pacing, SourcePace } from '@/lib/db/sales-dashboard-mocks'
import { formatMetricValue } from '@/lib/db/sales-dashboard-shared'

// Trajectory · per-source pacing table. Shows each revenue source's
// MTD actual against its target slice + pace progress.

export function SourcePacing({
  pacing,
  rows,
}: {
  pacing: Pacing
  rows: SourcePace[]
}) {
  return (
    <section
      aria-label="Per-source pacing"
      style={{
        marginTop: 24,
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '20px 24px 14px' }}>
        <div
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-3)',
          }}
        >
          PER-SOURCE PACING
        </div>
        <div
          className="geg-serif"
          style={{
            fontSize: 17,
            color: 'var(--color-geg-text)',
            letterSpacing: '-0.01em',
            marginTop: 4,
          }}
        >
          Each source vs its slice of the month target.
        </div>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.4fr 1fr 1fr 1.5fr 80px',
          gap: 14,
          padding: '10px 24px',
          background: 'var(--color-geg-bg)',
          borderTop: '1px solid var(--color-geg-border)',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        <ColH text="Source" align="left" />
        <ColH text="Target slice" />
        <ColH text="MTD actual" />
        <ColH text="Pace" />
        <ColH text="% to target" />
      </div>
      {rows.map((r) => {
        const targetSlice = pacing.monthTarget * r.targetShare
        const pct = (r.mtdActual / targetSlice) * 100
        // Pace = expected so far on this source's slice given dayOfMonth.
        const expected = targetSlice * (pacing.dayOfMonth / pacing.daysInMonth)
        const onPace = r.mtdActual >= expected
        const pctColor = onPace ? 'var(--color-geg-pos)' : 'var(--color-geg-warn)'
        return (
          <div
            key={r.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1.4fr 1fr 1fr 1.5fr 80px',
              gap: 14,
              padding: '14px 24px',
              alignItems: 'center',
              borderBottom: '1px dashed var(--color-geg-border)',
            }}
          >
            <span
              className="geg-serif"
              style={{ fontSize: 14, color: 'var(--color-geg-text)', letterSpacing: '-0.005em' }}
            >
              {r.label}
            </span>
            <Num value={formatMetricValue(targetSlice, 'usd')} />
            <Num value={formatMetricValue(r.mtdActual, 'usd')} accent />
            <PaceBar mtd={r.mtdActual} target={targetSlice} expected={expected} />
            <span
              className="geg-mono"
              style={{
                fontSize: 13,
                color: pctColor,
                letterSpacing: '0.04em',
                fontWeight: 500,
                textAlign: 'right',
              }}
            >
              {Math.round(pct)}%
            </span>
          </div>
        )
      })}
    </section>
  )
}

function ColH({ text, align }: { text: string; align?: 'left' | 'right' }) {
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
      {text}
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

function PaceBar({
  mtd,
  target,
  expected,
}: {
  mtd: number
  target: number
  expected: number
}) {
  const mtdPct = Math.min(100, (mtd / target) * 100)
  const expectedPct = Math.min(100, (expected / target) * 100)
  const onPace = mtd >= expected
  return (
    <div
      style={{
        height: 10,
        borderRadius: 5,
        background: 'var(--color-geg-bg)',
        border: '1px solid var(--color-geg-border)',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          bottom: 0,
          width: `${mtdPct}%`,
          background: onPace ? 'var(--color-geg-pos)' : 'var(--color-geg-warn)',
          opacity: 0.75,
        }}
      />
      <div
        style={{
          position: 'absolute',
          top: -3,
          bottom: -3,
          left: `${expectedPct}%`,
          width: 2,
          background: 'var(--color-geg-text-2)',
        }}
      />
    </div>
  )
}
