import type { QueueItem, EmergencyTrigger } from '@/lib/db/sales-dashboard-mocks'

// Pulse · needs attention — two-column block. Left: daily review queue
// (items the system flagged as needing a human decision). Right:
// emergency triggers (KPIs against thresholds with action buttons).
// The video's "daily review queue" + emergency booking protocols.

export function NeedsAttention({
  queue,
  triggers,
}: {
  queue: QueueItem[]
  triggers: EmergencyTrigger[]
}) {
  return (
    <section
      aria-label="Needs attention"
      style={{
        marginTop: 24,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 18,
      }}
    >
      <ReviewQueueBlock items={queue} />
      <TriggersBlock triggers={triggers} />
    </section>
  )
}

function ReviewQueueBlock({ items }: { items: QueueItem[] }) {
  return (
    <div
      style={{
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        padding: '18px 20px 14px',
      }}
    >
      <Eyebrow label="DAILY REVIEW QUEUE" subLabel="Things the system can't decide alone." />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {items.length === 0 ? (
          <Empty text="Queue clear. Nothing to triage." />
        ) : (
          items.map((it) => <QueueRow key={it.id} item={it} />)
        )}
      </div>
    </div>
  )
}

function QueueRow({ item }: { item: QueueItem }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr auto',
        gap: 14,
        alignItems: 'center',
        padding: '10px 0',
        borderBottom: '1px dashed var(--color-geg-border)',
      }}
    >
      <div>
        <div
          className="geg-serif"
          style={{ fontSize: 14, color: 'var(--color-geg-text)', letterSpacing: '-0.002em' }}
        >
          {item.label}
        </div>
        <div
          className="geg-mono"
          style={{
            fontSize: 10.5,
            letterSpacing: '0.06em',
            color: 'var(--color-geg-text-faint)',
            marginTop: 3,
          }}
        >
          {item.detail}
        </div>
      </div>
      <button
        type="button"
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          padding: '5px 10px',
          background: 'transparent',
          border: '1px solid var(--color-geg-border-strong)',
          borderRadius: 4,
          color: 'var(--color-geg-text-2)',
          cursor: 'pointer',
        }}
      >
        {item.action} →
      </button>
    </div>
  )
}

function TriggersBlock({ triggers }: { triggers: EmergencyTrigger[] }) {
  return (
    <div
      style={{
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        padding: '18px 20px 14px',
      }}
    >
      <Eyebrow label="EMERGENCY TRIGGERS" subLabel="KPIs vs threshold — pull a lever when crit." />
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {triggers.map((t) => <TriggerRow key={t.id} trigger={t} />)}
      </div>
    </div>
  )
}

function TriggerRow({ trigger }: { trigger: EmergencyTrigger }) {
  const dotColor =
    trigger.status === 'crit'
      ? 'var(--color-geg-neg)'
      : trigger.status === 'warn'
        ? 'var(--color-geg-warn)'
        : 'var(--color-geg-pos)'
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '14px 1fr auto auto',
        gap: 14,
        alignItems: 'center',
        padding: '10px 0',
        borderBottom: '1px dashed var(--color-geg-border)',
      }}
    >
      <span
        style={{ width: 8, height: 8, borderRadius: '50%', background: dotColor, justifySelf: 'center' }}
      />
      <div>
        <div
          className="geg-serif"
          style={{ fontSize: 14, color: 'var(--color-geg-text)', letterSpacing: '-0.002em' }}
        >
          {trigger.label}
        </div>
        <div
          className="geg-mono"
          style={{
            fontSize: 10.5,
            letterSpacing: '0.06em',
            color: 'var(--color-geg-text-faint)',
            marginTop: 3,
          }}
        >
          {trigger.value} · threshold {trigger.threshold}
        </div>
      </div>
      {trigger.action ? (
        <button
          type="button"
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            padding: '5px 10px',
            background: trigger.status === 'crit' ? 'var(--color-geg-neg)' : 'transparent',
            color: trigger.status === 'crit' ? 'var(--color-geg-bg)' : 'var(--color-geg-text-2)',
            border: `1px solid ${trigger.status === 'crit' ? 'var(--color-geg-neg)' : 'var(--color-geg-border-strong)'}`,
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          {trigger.action} →
        </button>
      ) : <span />}
    </div>
  )
}

function Eyebrow({ label, subLabel }: { label: string; subLabel: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
        }}
      >
        {label}
      </div>
      <div
        className="geg-serif"
        style={{
          fontSize: 14,
          color: 'var(--color-geg-text-2)',
          fontStyle: 'italic',
          letterSpacing: '-0.002em',
          marginTop: 4,
        }}
      >
        {subLabel}
      </div>
    </div>
  )
}

function Empty({ text }: { text: string }) {
  return (
    <div
      className="geg-serif"
      style={{
        padding: '14px 0',
        color: 'var(--color-geg-text-3)',
        fontStyle: 'italic',
        fontSize: 13,
      }}
    >
      {text}
    </div>
  )
}
