import { SectionBlock } from '../section-block'
import { Sparkline } from '../sparkline'
import {
  getSetters,
  getSetterFunnel,
  type SetterRep,
} from '@/lib/db/sales-dashboard-mocks'
import { type Window } from '@/lib/db/sales-dashboard-shared'

// APPOINTMENT SETTING — decision: which setter is dropping the ball,
// where in the triage→book flow leads die, how fast are setters
// dialing.

export function AppointmentSettingSection({ window }: { window: Window }) {
  const setters = getSetters(window)
  const funnel = getSetterFunnel(window)

  return (
    <>
      <SectionBlock
        eyebrow="TRIAGE → BOOKED"
        title="What happens to a fresh opt-in after a setter touches it."
      >
        <SetterFunnelDiagram stages={funnel} />
      </SectionBlock>

      <SectionBlock
        eyebrow="SETTER LEADERBOARD"
        title="Booked-rate ranking · 14-day trend."
      >
        <SetterTable setters={setters} />
      </SectionBlock>
    </>
  )
}

function SetterFunnelDiagram({ stages }: { stages: { id: string; label: string; count: number }[] }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 1,
        background: 'var(--color-geg-border)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {stages.map((s, i) => {
        const prior = i === 0 ? null : stages[i - 1].count
        const pct = prior && prior > 0 ? (s.count / prior) : null
        const isBottleneck = i > 0 && pct !== null && pct < 0.5
        return (
          <div key={s.id} style={{ padding: '18px 18px 14px', background: 'var(--color-geg-bg-elev)' }}>
            <div
              className="geg-mono"
              style={{
                fontSize: 10,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--color-geg-text-3)',
              }}
            >
              {s.label}
            </div>
            <div
              className="geg-numeric-serif"
              style={{
                fontSize: 30,
                lineHeight: '34px',
                letterSpacing: '-0.025em',
                color: 'var(--color-geg-text)',
                marginTop: 6,
              }}
            >
              {s.count.toLocaleString('en-US')}
            </div>
            {pct !== null ? (
              <div
                className="geg-mono"
                style={{
                  fontSize: 11,
                  color: isBottleneck ? 'var(--color-geg-warn)' : 'var(--color-geg-text-faint)',
                  letterSpacing: '0.06em',
                  marginTop: 6,
                  fontWeight: isBottleneck ? 600 : 400,
                }}
              >
                {Math.round(pct * 100)}% of prior {isBottleneck ? '· BOTTLENECK' : ''}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

function SetterTable({ setters }: { setters: SetterRep[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '32px 1fr 1fr 1fr 1fr 1fr 100px',
          gap: 14,
          padding: '8px 0 12px',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        <Col label="#" align="left" />
        <Col label="Setter" align="left" />
        <Col label="Triages" />
        <Col label="Booked rate" />
        <Col label="DQ rate" />
        <Col label="Time → dial" />
        <Col label="Trend" />
      </div>
      {setters.map((s, i) => (
        <div
          key={s.id}
          style={{
            display: 'grid',
            gridTemplateColumns: '32px 1fr 1fr 1fr 1fr 1fr 100px',
            gap: 14,
            padding: '13px 0',
            borderBottom: '1px dashed var(--color-geg-border)',
            alignItems: 'center',
            borderLeft: i === 0
              ? '3px solid var(--color-geg-pos)'
              : i === setters.length - 1
                ? '3px solid var(--color-geg-neg)'
                : '3px solid transparent',
            paddingLeft: 12,
            marginLeft: -12,
          }}
        >
          <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.06em' }}>
            #{i + 1}
          </span>
          <span className="geg-serif" style={{ fontSize: 15, color: 'var(--color-geg-text)' }}>
            {s.name}
          </span>
          <Num value={String(s.triages)} />
          <Num value={`${Math.round(s.bookedRate * 100)}%`} accent />
          <Num value={`${Math.round(s.dqRate * 100)}%`} />
          <Num value={`${s.avgTimeToDial}m`} />
          <Sparkline data={s.trend} width={86} height={18} stroke="var(--color-geg-text-3)" />
        </div>
      ))}
    </div>
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
