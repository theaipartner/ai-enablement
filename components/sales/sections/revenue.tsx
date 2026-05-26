import { SectionBlock } from '../section-block'
import { BreakdownBar } from '../breakdown-bar'
import {
  getRevenueComposition,
  getCashByOffer,
  type RevenueSlice,
} from '@/lib/db/sales-dashboard-mocks'
import { formatMetricValue, type Window } from '@/lib/db/sales-dashboard-shared'

// SALES DATA / BACK END REV — decision: where the money's actually
// coming from. Composition, by-offer, AR-vs-new-cash split, LTV.
// One component drives both section pages with a `view` switch.

export function RevenueSection({
  window,
  view,
}: {
  window: Window
  view: 'sales' | 'backend'
}) {
  const composition = getRevenueComposition(window)
  const offers = getCashByOffer(window)

  const newCash = composition.find((s) => s.id === 'new')?.cash ?? 0
  const ar = composition.find((s) => s.id === 'ar')?.cash ?? 0
  const upsells = composition.find((s) => s.id === 'upsell')?.cash ?? 0
  const renewals = composition.find((s) => s.id === 'renewals')?.cash ?? 0
  const mastermind = composition.find((s) => s.id === 'mastermind')?.cash ?? 0
  const refunds = Math.abs(composition.find((s) => s.id === 'refunds')?.cash ?? 0)
  const gross = newCash + ar + upsells + renewals + mastermind
  const net = gross - refunds
  const backendShare = (ar + upsells + renewals) / (gross || 1)

  const heads = view === 'sales'
    ? [
        { label: 'Gross inflow', value: formatMetricValue(gross, 'usd'), accent: true },
        { label: 'New cash', value: formatMetricValue(newCash, 'usd') },
        { label: 'Refunds', value: formatMetricValue(refunds, 'usd'), tone: 'warn' as const },
        { label: 'Net revenue', value: formatMetricValue(net, 'usd'), accent: true },
      ]
    : [
        { label: 'Backend revenue', value: formatMetricValue(ar + upsells + renewals, 'usd'), accent: true },
        { label: 'AR collected', value: formatMetricValue(ar, 'usd') },
        { label: 'Upsells', value: formatMetricValue(upsells, 'usd') },
        { label: 'Backend % of gross', value: `${Math.round(backendShare * 100)}%`, tone: 'pos' as const },
      ]

  // For Sales view, show full composition. For Backend view, filter to backend-only slices.
  const compRows = view === 'sales' ? composition : composition.filter((s) => ['ar', 'upsell', 'renewals', 'mastermind'].includes(s.id))

  return (
    <>
      <SectionBlock
        eyebrow="HEAD METRICS"
        title={view === 'sales' ? 'Top-line revenue mix · this period.' : 'Backend / recurring revenue.'}
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
          {heads.map((h) => (
            <HeadCell key={h.label} {...h} />
          ))}
        </div>
      </SectionBlock>

      <SectionBlock
        eyebrow="COMPOSITION"
        title={view === 'sales' ? 'What makes up the inflow.' : 'Backend revenue split by source.'}
      >
        <BreakdownBar
          rows={compRows.map((s: RevenueSlice) => ({
            id: s.id,
            label: s.label,
            value: s.cash,
          }))}
          format="usd"
          labelWidth={260}
        />
      </SectionBlock>

      {view === 'sales' && (
        <SectionBlock
          eyebrow="BY OFFER"
          title="Cash, units sold, AOV, LTV — by program."
        >
          <OfferTable offers={offers} />
        </SectionBlock>
      )}
    </>
  )
}

function HeadCell({
  label,
  value,
  accent,
  tone,
}: {
  label: string
  value: string
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
          fontSize: accent ? 34 : 28,
          lineHeight: '34px',
          letterSpacing: '-0.025em',
          color: valColor,
          marginTop: 6,
        }}
      >
        {value}
      </div>
    </div>
  )
}

function OfferTable({ offers }: { offers: ReturnType<typeof getCashByOffer> }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
          gap: 14,
          padding: '8px 0 12px',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        <Col label="Offer" align="left" />
        <Col label="Cash" />
        <Col label="Units" />
        <Col label="AOV" />
        <Col label="LTV" />
      </div>
      {offers.map((o) => (
        <div
          key={o.id}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 1fr 1fr 1fr 1fr',
            gap: 14,
            padding: '13px 0',
            borderBottom: '1px dashed var(--color-geg-border)',
            alignItems: 'center',
          }}
        >
          <span
            className="geg-serif"
            style={{ fontSize: 14.5, color: 'var(--color-geg-text)', letterSpacing: '-0.005em' }}
          >
            {o.label}
          </span>
          <Num value={formatMetricValue(o.cash, 'usd')} accent />
          <Num value={String(o.units)} />
          <Num value={formatMetricValue(o.aov, 'usd')} />
          <Num value={formatMetricValue(o.ltv, 'usd')} />
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
