import {
  PromPage,
  PromPageHeader,
  PromCard,
  PromSection,
  KpiCard,
  Pill,
  PreviewBadge,
  money,
} from '@/components/promethean/primitives'
import { leadById, setterById, closerById, DIALS } from '@/lib/mock-data'
import { notFound } from 'next/navigation'
import Link from 'next/link'

export default function PrometheanContactDetailPage({ params }: { params: { id: string } }) {
  const lead = leadById(params.id)
  if (!lead) return notFound()
  const setter = setterById(lead.setter_id)
  const closer = closerById(lead.closer_id)
  const dials = DIALS.filter((d) => d.lead_id === lead.id)

  return (
    <PromPage>
      <Link
        href="/promethean/contacts"
        className="prom-eyebrow hover:underline inline-block mb-4"
        style={{ color: 'var(--color-prom-text-3)' }}
      >
        ← BACK TO CONTACTS
      </Link>
      <PromPageHeader
        eyebrow={`HELIOS · CONTACT · ${lead.country}`}
        title={lead.name}
        meta={
          <>
            <span>{lead.email}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span className="prom-numeric">{lead.phone}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>{lead.source}</span>
          </>
        }
      />

      <PromSection eyebrow="DEAL SHAPE" headline="Where this one sits.">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          <KpiCard label="STATUS" value={lead.status} size="sm" />
          <KpiCard label="CONTRACT" value={lead.contract_value ? money(lead.contract_value) : '—'} size="sm" />
          <KpiCard label="CASH" value={lead.cash_collected ? money(lead.cash_collected) : '—'} size="sm" />
          <KpiCard
            label="DIALS · TALK"
            value={`${dials.length} · ${Math.round(dials.reduce((s, d) => s + d.talk_time_seconds, 0) / 60)}m`}
            size="sm"
          />
        </div>
      </PromSection>

      <PromSection eyebrow="RELATIONSHIPS">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <PromCard className="p-6">
            <div className="prom-eyebrow">SETTER</div>
            <div className="mt-2 text-lg">{setter?.name ?? '—'}</div>
          </PromCard>
          <PromCard className="p-6">
            <div className="prom-eyebrow">CLOSER</div>
            <div className="mt-2 text-lg">{closer?.name ?? '—'}</div>
          </PromCard>
        </div>
      </PromSection>

      <PromSection eyebrow="QUALITY" trailing={<PreviewBadge />}>
        <PromCard className="p-6">
          <div className="flex items-center gap-3">
            <Pill tone={lead.lead_quality === 'ready_to_buy' ? 'pos' : lead.lead_quality === 'poor' ? 'neg' : 'warn'}>
              {lead.lead_quality ?? 'unscored'}
            </Pill>
            <Pill tone={lead.sentiment === 'green' ? 'pos' : lead.sentiment === 'red' ? 'neg' : 'warn'}>
              sentiment · {lead.sentiment ?? 'untagged'}
            </Pill>
            {lead.payment_plan ? <Pill tone="warn">payment plan</Pill> : null}
          </div>
          {lead.notes ? (
            <div
              className="mt-4 text-sm rounded-lg p-4"
              style={{
                background: 'var(--color-prom-bg-elev-2)',
                border: '1px solid var(--color-prom-border)',
                lineHeight: '1.55',
              }}
            >
              {lead.notes}
            </div>
          ) : null}
        </PromCard>
      </PromSection>

      <PromSection eyebrow="RECORDING" trailing={<PreviewBadge />}>
        <PromCard className="p-6 flex items-center justify-between">
          <div>
            <div className="prom-serif" style={{ fontSize: 20 }}>
              Discovery → pitch · 38m 14s
            </div>
            <div className="text-xs mt-1" style={{ color: 'var(--color-prom-text-2)' }}>
              Recorded {new Date(lead.showed_at ?? lead.created_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
            </div>
          </div>
          <button
            className="text-xs prom-eyebrow px-4 py-2 rounded-full"
            style={{
              background: 'var(--color-prom-bg-elev-2)',
              color: 'var(--color-prom-text)',
              border: '1px solid var(--color-prom-border)',
            }}
          >
            ▶ PLAY
          </button>
        </PromCard>
      </PromSection>
    </PromPage>
  )
}
