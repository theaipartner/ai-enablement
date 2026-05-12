import {
  PromPage,
  PromPageHeader,
  PromCard,
  PromTable,
  PromTHead,
  PromTH,
  PromTR,
  PromTD,
  Pill,
  PreviewBadge,
  setterDisplay,
} from '@/components/promethean/primitives-extra'
import {
  PromSection,
  PromDropdownStub,
} from '@/components/promethean/primitives'
import {
  LEADS,
  setterById,
  PERIOD_LABEL,
  SYNC_LABEL,
} from '@/lib/mock-data'

export const metadata = { title: 'Triage Inbox — Promethean' }

const TRIAGE_TONE: Record<string, 'pos' | 'neg' | 'warn' | 'neutral' | 'accent'> = {
  untriaged: 'warn',
  confirmed: 'pos',
  dq: 'neg',
  follow_up: 'neutral',
  no_show: 'neg',
}

export default function PrometheanTriageInboxPage() {
  const triageRows = LEADS.filter((l) => l.triage_status !== null).slice(0, 18)

  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · TRIAGE"
        title="Direct bookings, in the queue."
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
        trailing={
          <div className="flex items-center gap-2">
            <PromDropdownStub label="All setters" />
            <PromDropdownStub label="All status" />
          </div>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mt-8">
        <div className="lg:col-span-2">
          <PromSection eyebrow="QUEUE" headline="What's coming in.">
            <PromTable>
              <PromTHead>
                <tr>
                  <PromTH>Lead</PromTH>
                  <PromTH>Booked at</PromTH>
                  <PromTH>Setter</PromTH>
                  <PromTH>Status</PromTH>
                  <PromTH align="right">Action</PromTH>
                </tr>
              </PromTHead>
              <tbody>
                {triageRows.map((l) => {
                  const setter = setterById(l.setter_id)
                  return (
                    <PromTR key={l.id}>
                      <PromTD>
                        <div className="font-medium">{l.name}</div>
                        <div className="text-xs" style={{ color: 'var(--color-prom-text-3)' }}>
                          {l.email}
                        </div>
                      </PromTD>
                      <PromTD>
                        <span className="prom-numeric text-xs" style={{ color: 'var(--color-prom-text-2)' }}>
                          {new Date(l.booked_at ?? l.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                        </span>
                      </PromTD>
                      <PromTD>{setter ? setterDisplay(setter) : '—'}</PromTD>
                      <PromTD>
                        <Pill tone={TRIAGE_TONE[l.triage_status ?? 'untriaged']}>
                          {(l.triage_status ?? 'untriaged').replace('_', ' ')}
                        </Pill>
                      </PromTD>
                      <PromTD align="right">
                        <button
                          className="text-[11px] prom-eyebrow px-3 py-1 rounded-full"
                          style={{
                            color: 'var(--color-prom-text)',
                            background: 'var(--color-prom-bg-elev-2)',
                            border: '1px solid var(--color-prom-border)',
                          }}
                        >
                          UPDATE
                        </button>
                      </PromTD>
                    </PromTR>
                  )
                })}
              </tbody>
            </PromTable>
          </PromSection>
        </div>

        <div className="space-y-5">
          <PromCard className="p-6 sticky top-6">
            <div className="flex items-center justify-between">
              <div className="prom-eyebrow">AI MODE</div>
              <PreviewBadge />
            </div>
            <h3
              className="prom-serif mt-3"
              style={{ fontSize: 22, lineHeight: '26px' }}
            >
              Ask anything about the sales data.
            </h3>
            <div
              className="mt-4 rounded-lg p-3 text-sm"
              style={{
                background: 'var(--color-prom-bg-elev-2)',
                border: '1px solid var(--color-prom-border)',
                color: 'var(--color-prom-text-2)',
              }}
            >
              What&apos;s going to move the needle this week? Why are we losing deals?
            </div>
            <div className="mt-3">
              <textarea
                placeholder="Ask about pipeline, performance, anything..."
                rows={4}
                className="w-full rounded-lg px-3 py-2.5 text-sm"
                style={{
                  background: 'var(--color-prom-bg)',
                  color: 'var(--color-prom-text)',
                  border: '1px solid var(--color-prom-border)',
                }}
              />
            </div>
            <button
              className="mt-3 w-full text-xs prom-eyebrow py-2.5 rounded-full font-semibold"
              style={{
                background: 'var(--color-prom-accent)',
                color: 'var(--color-prom-bg)',
              }}
            >
              ✦ ASK PROMETHEAN
            </button>
            <div className="mt-3 text-[11px]" style={{ color: 'var(--color-prom-text-3)' }}>
              Demo-only. Live AI features land in V1.
            </div>
          </PromCard>
        </div>
      </div>
    </PromPage>
  )
}
