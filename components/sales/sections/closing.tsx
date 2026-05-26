import { SectionBlock } from '../section-block'
import { BreakdownBar } from '../breakdown-bar'
import { Sparkline } from '../sparkline'
import {
  getClosers,
  getObjectionMix,
  getCashByCallType,
  type CloserRep,
} from '@/lib/db/sales-dashboard-mocks'
import { formatMetricValue, type Window } from '@/lib/db/sales-dashboard-shared'

// CLOSING — decision: who's choking margin, where's leakage in the
// show→close funnel, what objection is killing deals.

export function ClosingSection({ window }: { window: Window }) {
  const closers = getClosers(window)
  const objections = getObjectionMix(window)
  const cashByType = getCashByCallType(window)

  // Show→Close funnel — aggregate across closers for the section view.
  const totalCalls = closers.reduce((s, c) => s + c.callsHandled, 0)
  const totalShowed = closers.reduce((s, c) => s + Math.round(c.callsHandled * c.showRate), 0)
  const totalClosed = closers.reduce((s, c) => s + Math.round(c.callsHandled * c.showRate * c.closeRate), 0)
  const showRate = totalCalls > 0 ? totalShowed / totalCalls : 0
  const closeRate = totalShowed > 0 ? totalClosed / totalShowed : 0
  const oneCallRate = closeRate * 0.72 // ~72% of closes are one-call (mock-tuned)

  return (
    <>
      <SectionBlock
        eyebrow="SHOW → CLOSE"
        title="Where the cash leaks between booked and paid."
      >
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
          <FunnelCell label="Calls booked" value={String(totalCalls)} accent />
          <FunnelCell label="Showed" value={String(totalShowed)} sub={`${Math.round(showRate * 100)}% show`} />
          <FunnelCell label="Closed" value={String(totalClosed)} sub={`${Math.round(closeRate * 100)}% close`} />
          <FunnelCell label="One-call closes" value={String(Math.round(totalClosed * 0.72))} sub={`${Math.round(oneCallRate * 100)}% of booked`} />
        </div>
      </SectionBlock>

      <SectionBlock
        eyebrow="CLOSER LEADERBOARD"
        title="Cash per call by closer."
      >
        <CloserMiniTable closers={closers} />
      </SectionBlock>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 18, marginTop: 24 }}>
        <SectionBlock
          marginTop={0}
          eyebrow="OBJECTIONS"
          title="What's killing deals."
        >
          <BreakdownBar
            rows={objections.map((o) => ({ id: o.id, label: o.label, value: o.count, share: o.share }))}
            showShare
            labelWidth={170}
          />
        </SectionBlock>

        <SectionBlock
          marginTop={0}
          eyebrow="CASH BY CALL TYPE"
          title="Which call type drives revenue."
        >
          <BreakdownBar
            rows={cashByType.map((c) => ({ id: c.id, label: c.label, value: c.cash }))}
            format="usd"
            labelWidth={160}
          />
        </SectionBlock>
      </div>
    </>
  )
}

function FunnelCell({ label, value, sub, accent }: { label: string; value: string; sub?: string; accent?: boolean }) {
  return (
    <div style={{ padding: '18px 18px 16px', background: 'var(--color-geg-bg-elev)' }}>
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
        }}
      >
        {label}
      </div>
      <div
        className="geg-numeric-serif"
        style={{
          fontSize: accent ? 34 : 30,
          lineHeight: '36px',
          letterSpacing: '-0.025em',
          color: 'var(--color-geg-text)',
          marginTop: 6,
        }}
      >
        {value}
      </div>
      {sub ? (
        <div
          className="geg-mono"
          style={{
            fontSize: 11,
            color: 'var(--color-geg-text-faint)',
            letterSpacing: '0.06em',
            marginTop: 4,
          }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  )
}

function CloserMiniTable({ closers }: { closers: CloserRep[] }) {
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
        <Col label="Closer" align="left" />
        <Col label="Calls" />
        <Col label="Show" />
        <Col label="Close" />
        <Col label="$ / call" />
        <Col label="Trend" />
      </div>
      {closers.map((c, i) => (
        <div
          key={c.id}
          id={`closer-${c.id}`}
          style={{
            display: 'grid',
            gridTemplateColumns: '32px 1fr 1fr 1fr 1fr 1fr 100px',
            gap: 14,
            padding: '13px 0',
            borderBottom: '1px dashed var(--color-geg-border)',
            alignItems: 'center',
            borderLeft: i === 0 ? '3px solid var(--color-geg-pos)' : i === closers.length - 1 ? '3px solid var(--color-geg-neg)' : '3px solid transparent',
            paddingLeft: 12,
            marginLeft: -12,
            scrollMarginTop: 96,
          }}
        >
          <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.06em' }}>
            #{i + 1}
          </span>
          <span className="geg-serif" style={{ fontSize: 15, color: 'var(--color-geg-text)' }}>
            {c.name}
          </span>
          <Num value={String(c.callsHandled)} />
          <Num value={`${Math.round(c.showRate * 100)}%`} />
          <Num value={`${Math.round(c.closeRate * 100)}%`} />
          <Num value={formatMetricValue(c.cashPerCall, 'usd')} accent />
          <Sparkline data={c.trend} width={86} height={18} stroke="var(--color-geg-text-3)" />
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
