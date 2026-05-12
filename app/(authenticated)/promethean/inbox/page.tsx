import {
  PromPage,
  PromPageHeader,
  PromCard,
  Pill,
  PromDropdownStub,
} from '@/components/promethean/primitives'
import { INBOX_NOTIFICATIONS, PERIOD_LABEL, SYNC_LABEL } from '@/lib/mock-data'

export const metadata = { title: 'Inbox — Promethean' }

const KIND_TONE: Record<string, 'pos' | 'neg' | 'warn' | 'neutral' | 'accent'> = {
  win: 'pos',
  alert: 'neg',
  risk: 'warn',
  system: 'neutral',
}

export default function PrometheanInboxPage() {
  const unread = INBOX_NOTIFICATIONS.filter((n) => !n.read).length

  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · INBOX"
        title="What needs your attention."
        meta={
          <>
            <span>{unread} unread</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
        trailing={<PromDropdownStub label="All kinds" />}
      />

      <div className="space-y-3 mt-8 max-w-[820px]">
        {INBOX_NOTIFICATIONS.map((n) => (
          <PromCard
            key={n.id}
            className="p-5"
            style={{
              borderLeft: `3px solid ${
                n.kind === 'win' ? 'var(--color-prom-accent)' :
                n.kind === 'alert' ? 'var(--color-prom-neg)' :
                n.kind === 'risk' ? 'var(--color-prom-warn)' :
                'var(--color-prom-border)'
              }`,
              opacity: n.read ? 0.65 : 1,
            } as React.CSSProperties}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <Pill tone={KIND_TONE[n.kind]}>{n.kind}</Pill>
                  {!n.read ? <span className="prom-eyebrow" style={{ color: 'var(--color-prom-accent)' }}>NEW</span> : null}
                </div>
                <div className="prom-serif" style={{ fontSize: 22, lineHeight: '26px' }}>
                  {n.title}
                </div>
                <div className="text-sm mt-2" style={{ color: 'var(--color-prom-text-2)', lineHeight: '1.55' }}>
                  {n.body}
                </div>
              </div>
              <div className="prom-eyebrow shrink-0">
                {new Date(n.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
              </div>
            </div>
          </PromCard>
        ))}
      </div>
    </PromPage>
  )
}
