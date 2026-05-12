import {
  PromPage,
  PromPageHeader,
  PromCard,
  Pill,
  PreviewBadge,
} from '@/components/promethean/primitives'
import { SETTERS, CLOSERS, PERIOD_LABEL, SYNC_LABEL } from '@/lib/mock-data'

export const metadata = { title: 'Setter EOD — Promethean' }

export default function PrometheanSetterEodPage() {
  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · END OF DAY"
        title="Log today's leads."
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
        trailing={<PreviewBadge />}
      />

      <div className="mt-8 grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 space-y-5">
          <PromCard className="p-7">
            <div className="prom-eyebrow">LEAD DETAILS</div>
            <h3
              className="prom-serif mt-2"
              style={{ fontSize: 26, color: 'var(--color-prom-text-2)' }}
            >
              Marcus Carter
            </h3>
            <div className="prom-eyebrow mt-1">USA · META · COLD TRAFFIC</div>

            <div className="grid grid-cols-2 gap-5 mt-7">
              <Field label="Country" value="USA" />
              <Field label="Setter">
                <PromSelectStub options={SETTERS.map((s) => s.name)} selected={SETTERS[0].name} />
              </Field>
              <Field label="Call outcome">
                <PromSelectStub options={['Pitched', 'Won', 'Lost', 'No show', 'DQ']} selected="Pitched" />
              </Field>
              <Field label="Cash collected">
                <PromInputStub value="$12,500" />
              </Field>
              <Field label="Payment plan">
                <div className="flex gap-2 mt-2">
                  <Pill tone="accent">Yes</Pill>
                  <Pill tone="neutral">No</Pill>
                </div>
              </Field>
              <Field label="Lead quality">
                <PromSelectStub options={['Ready to buy', 'Good', 'Average', 'Poor']} selected="Good" />
              </Field>
              <Field label="Closer">
                <PromSelectStub options={CLOSERS.map((c) => c.name)} selected={CLOSERS[0].name} />
              </Field>
              <Field label="Sentiment">
                <div className="flex gap-2 mt-2">
                  <Pill tone="pos">Green</Pill>
                  <Pill tone="warn">Yellow</Pill>
                  <Pill tone="neg">Red</Pill>
                </div>
              </Field>
            </div>

            <div className="mt-7">
              <div className="prom-eyebrow mb-2">NOTES</div>
              <textarea
                placeholder="What happened on the call?"
                rows={4}
                className="w-full rounded-lg px-3 py-2.5 text-sm"
                style={{
                  background: 'var(--color-prom-bg-elev-2)',
                  color: 'var(--color-prom-text)',
                  border: '1px solid var(--color-prom-border)',
                }}
                defaultValue="Looking to close before end of quarter. Husband on the fence. Wants to pitch June start."
              />
            </div>

            <div className="mt-6 flex justify-end gap-2">
              <button
                className="text-xs prom-eyebrow px-4 py-2 rounded-full"
                style={{ color: 'var(--color-prom-text-2)' }}
              >
                SAVE DRAFT
              </button>
              <button
                className="text-xs prom-eyebrow px-4 py-2 rounded-full font-semibold"
                style={{
                  background: 'var(--color-prom-accent)',
                  color: 'var(--color-prom-bg)',
                }}
              >
                SUBMIT LEAD
              </button>
            </div>
          </PromCard>
        </div>

        <div className="space-y-5">
          <PromCard className="p-6">
            <div className="prom-eyebrow">TODAY&apos;S QUEUE</div>
            <div className="prom-serif mt-2" style={{ fontSize: 30 }}>
              7 to log
            </div>
            <div className="text-xs mt-1" style={{ color: 'var(--color-prom-text-2)' }}>
              Auto-pulled from CRM at 4:00 PM local.
            </div>
            <div className="mt-5 space-y-2">
              {['Marcus Carter', 'Olivia Hayes', 'Noah Bennett', 'Ava Walsh', 'Liam Russo', 'Sophia Mendez', 'Ethan Khan'].map((name, i) => (
                <div
                  key={name}
                  className="flex items-center justify-between text-sm px-3 py-2 rounded-md"
                  style={{
                    background: i === 0 ? 'rgba(212, 225, 87, 0.08)' : 'transparent',
                    border: i === 0 ? '1px solid var(--color-prom-accent-dim)' : '1px solid transparent',
                    color: i === 0 ? 'var(--color-prom-text)' : 'var(--color-prom-text-2)',
                  }}
                >
                  <span>{name}</span>
                  {i === 0 ? <Pill tone="accent">active</Pill> : <span style={{ color: 'var(--color-prom-text-3)' }}>•</span>}
                </div>
              ))}
            </div>
          </PromCard>
        </div>
      </div>
    </PromPage>
  )
}

function Field({ label, value, children }: { label: string; value?: string; children?: React.ReactNode }) {
  return (
    <div>
      <div className="prom-eyebrow">{label.toUpperCase()}</div>
      {value ? (
        <div className="mt-2 prom-numeric" style={{ color: 'var(--color-prom-text)' }}>
          {value}
        </div>
      ) : (
        children
      )}
    </div>
  )
}

function PromSelectStub({ selected }: { options: string[]; selected: string }) {
  return (
    <button
      className="mt-2 w-full text-left text-sm inline-flex items-center justify-between rounded-md px-3 py-2"
      style={{
        background: 'var(--color-prom-bg-elev-2)',
        color: 'var(--color-prom-text)',
        border: '1px solid var(--color-prom-border)',
      }}
    >
      <span>{selected}</span>
      <span style={{ color: 'var(--color-prom-text-3)', fontSize: 9 }}>▾</span>
    </button>
  )
}

function PromInputStub({ value }: { value: string }) {
  return (
    <input
      defaultValue={value}
      className="mt-2 w-full text-sm rounded-md px-3 py-2 prom-numeric"
      style={{
        background: 'var(--color-prom-bg-elev-2)',
        color: 'var(--color-prom-text)',
        border: '1px solid var(--color-prom-border)',
      }}
    />
  )
}
