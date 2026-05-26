import { SectionBlock } from '../section-block'
import { Sparkline } from '../sparkline'
import {
  getFulfillmentSnapshot,
  getCsms,
  type CsmRep,
} from '@/lib/db/sales-dashboard-mocks'
import { formatMetricValue, type Window } from '@/lib/db/sales-dashboard-shared'

// FULFILLMENT — decision: are we delivering, who needs attention, what
// the per-CSM picture looks like.

export function FulfillmentSection({ window }: { window: Window }) {
  const snap = getFulfillmentSnapshot(window)
  const csms = getCsms(window)
  const net = snap.newClients - snap.churnedClients

  return (
    <>
      <SectionBlock
        eyebrow="HEAD METRICS"
        title="Client base health · this period."
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
          <HeadCell label="Active clients" value={String(snap.activeClients)} accent />
          <HeadCell
            label="Net new this period"
            value={`${net >= 0 ? '+' : ''}${net}`}
            sub={`${snap.newClients} new · ${snap.churnedClients} churned`}
            tone={net >= 0 ? 'pos' : 'neg'}
          />
          <HeadCell
            label="Retention rate"
            value={`${Math.round(snap.retentionRate * 100)}%`}
            tone={snap.retentionRate >= 0.85 ? 'pos' : 'warn'}
          />
          <HeadCell
            label="NPS"
            value={String(snap.npsScore)}
            tone={snap.npsScore >= 50 ? 'pos' : snap.npsScore >= 30 ? 'warn' : 'neg'}
          />
        </div>
      </SectionBlock>

      <SectionBlock
        eyebrow="DELIVERY ACTIVITY"
        title="Calls held + avg duration."
      >
        <div style={{ display: 'flex', gap: 32, alignItems: 'center' }}>
          <Stat label="Calls held" value={String(snap.callsHeld)} />
          <Stat
            label="Avg duration"
            value={`${Math.floor(snap.avgCallDuration / 60)}m ${snap.avgCallDuration % 60}s`}
          />
          <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end' }}>
            <Sparkline data={snap.outcomesTrend} width={260} height={48} stroke="var(--color-geg-text-2)" />
          </div>
        </div>
      </SectionBlock>

      <SectionBlock
        eyebrow="PER-CSM"
        title="Retention + NPS by CSM."
      >
        <CsmTable csms={csms} />
      </SectionBlock>
    </>
  )
}

function HeadCell({
  label,
  value,
  sub,
  accent,
  tone,
}: {
  label: string
  value: string
  sub?: string
  accent?: boolean
  tone?: 'pos' | 'warn' | 'neg'
}) {
  const valColor =
    tone === 'pos' ? 'var(--color-geg-pos)'
      : tone === 'warn' ? 'var(--color-geg-warn)'
        : tone === 'neg' ? 'var(--color-geg-neg)'
          : 'var(--color-geg-text)'
  return (
    <div style={{ padding: '18px 20px 16px', background: 'var(--color-geg-bg-elev)' }}>
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
          fontSize: accent ? 36 : 30,
          lineHeight: '36px',
          letterSpacing: '-0.025em',
          color: valColor,
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

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
          marginBottom: 6,
        }}
      >
        {label}
      </div>
      <div
        className="geg-numeric-serif"
        style={{ fontSize: 30, color: 'var(--color-geg-text)', letterSpacing: '-0.02em' }}
      >
        {value}
      </div>
    </div>
  )
}

function CsmTable({ csms }: { csms: CsmRep[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '32px 1fr 1fr 1fr 1fr 100px',
          gap: 14,
          padding: '8px 0 12px',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        <Col label="#" align="left" />
        <Col label="CSM" align="left" />
        <Col label="Retention" />
        <Col label="NPS" />
        <Col label="Calls held" />
        <Col label="Trend" />
      </div>
      {csms.map((c, i) => (
        <div
          key={c.id}
          style={{
            display: 'grid',
            gridTemplateColumns: '32px 1fr 1fr 1fr 1fr 100px',
            gap: 14,
            padding: '13px 0',
            borderBottom: '1px dashed var(--color-geg-border)',
            alignItems: 'center',
            borderLeft: i === 0
              ? '3px solid var(--color-geg-pos)'
              : i === csms.length - 1
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
            {c.name}
          </span>
          <Num value={`${Math.round(c.retention * 100)}%`} accent />
          <Num value={String(c.nps)} />
          <Num value={String(c.callsHeld)} />
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

// Add a fallback function `formatMetricValue(..., 'integer')` import is fine;
// just used inside the body — keep the named import for tree-shake.
void formatMetricValue
