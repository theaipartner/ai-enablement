import { SectionBlock } from '../section-block'
import { BreakdownBar } from '../breakdown-bar'
import { Sparkline } from '../sparkline'
import {
  getAdCreatives,
  type AdCreative,
} from '@/lib/db/sales-dashboard-mocks'
import { formatMetricValue, type Window } from '@/lib/db/sales-dashboard-shared'

// ADVERTISING — decision: which creatives to scale, which are fatiguing,
// where to cut spend.

export function AdvertisingSection({ window }: { window: Window }) {
  const creatives = getAdCreatives(window)

  const totalSpend = creatives.reduce((s, c) => s + c.spend, 0)
  const totalBookings = creatives.reduce((s, c) => s + c.bookings, 0)
  const avgCpb = totalBookings > 0 ? totalSpend / totalBookings : 0

  const spendByCreative = creatives.map((c) => ({
    id: c.id,
    label: c.name,
    value: c.spend,
  }))

  return (
    <>
      <SectionBlock
        eyebrow="HEAD METRICS"
        title="Spend, bookings, cost-per-booking · this period."
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 1,
            background: 'var(--color-geg-border)',
            border: '1px solid var(--color-geg-border)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          <HeadCell label="Total spend" value={formatMetricValue(totalSpend, 'usd')} accent />
          <HeadCell label="Total bookings" value={String(totalBookings)} />
          <HeadCell
            label="Cost per booking"
            value={formatMetricValue(avgCpb, 'usd')}
            sub={avgCpb <= 150 ? 'within KPI ($150)' : 'over KPI ($150)'}
            tone={avgCpb <= 150 ? 'pos' : 'warn'}
          />
        </div>
      </SectionBlock>

      <SectionBlock
        eyebrow="CREATIVE LEADERBOARD"
        title="Ranked by cost-per-booking · scale the green, kill the red."
      >
        <CreativeTable creatives={creatives} />
      </SectionBlock>

      <SectionBlock
        eyebrow="SPEND DISTRIBUTION"
        title="Where the dollars are going."
      >
        <BreakdownBar
          rows={spendByCreative}
          format="usd"
          labelWidth={260}
        />
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
  const subColor =
    tone === 'pos' ? 'var(--color-geg-pos)'
      : tone === 'warn' ? 'var(--color-geg-warn)'
        : tone === 'neg' ? 'var(--color-geg-neg)'
          : 'var(--color-geg-text-faint)'
  return (
    <div style={{ padding: '20px 22px 18px', background: 'var(--color-geg-bg-elev)' }}>
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
          fontSize: accent ? 38 : 30,
          lineHeight: '40px',
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
            color: subColor,
            letterSpacing: '0.06em',
            marginTop: 6,
            fontWeight: 500,
          }}
        >
          {sub.toUpperCase()}
        </div>
      ) : null}
    </div>
  )
}

function CreativeTable({ creatives }: { creatives: AdCreative[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '2fr 100px 1fr 1fr 1fr 1fr 100px 100px',
          gap: 12,
          padding: '8px 0 12px',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        <Col label="Creative" align="left" />
        <Col label="Status" />
        <Col label="Spend" />
        <Col label="CTR" />
        <Col label="CPC" />
        <Col label="Bookings" />
        <Col label="$ / booking" />
        <Col label="Trend" />
      </div>
      {creatives.map((c) => (
        <div
          key={c.id}
          style={{
            display: 'grid',
            gridTemplateColumns: '2fr 100px 1fr 1fr 1fr 1fr 100px 100px',
            gap: 12,
            padding: '13px 0',
            borderBottom: '1px dashed var(--color-geg-border)',
            alignItems: 'center',
          }}
        >
          <span
            className="geg-serif"
            style={{
              fontSize: 14,
              color: 'var(--color-geg-text)',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {c.name}
          </span>
          <StatusPill status={c.status} />
          <Num value={formatMetricValue(c.spend, 'usd')} />
          <Num value={`${(c.ctr * 100).toFixed(2)}%`} />
          <Num value={formatMetricValue(c.cpc, 'usd')} />
          <Num value={String(c.bookings)} />
          <Num value={formatMetricValue(c.costPerBooking, 'usd')} accent />
          <Sparkline data={c.trend} width={86} height={18} stroke="var(--color-geg-text-3)" />
        </div>
      ))}
    </div>
  )
}

function StatusPill({ status }: { status: AdCreative['status'] }) {
  const config: Record<AdCreative['status'], { label: string; color: string; bg: string }> = {
    scaling: { label: 'SCALING', color: 'var(--color-geg-pos)', bg: 'transparent' },
    stable: { label: 'STABLE', color: 'var(--color-geg-text-2)', bg: 'transparent' },
    fatiguing: { label: 'FATIGUING', color: 'var(--color-geg-warn)', bg: 'transparent' },
    paused: { label: 'PAUSED', color: 'var(--color-geg-text-faint)', bg: 'transparent' },
  }
  const c = config[status]
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 9.5,
        letterSpacing: '0.16em',
        color: c.color,
        background: c.bg,
        padding: '4px 8px',
        border: `1px solid ${c.color}`,
        borderRadius: 4,
        textAlign: 'center',
        justifySelf: 'end',
      }}
    >
      {c.label}
    </span>
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
        fontSize: 14,
        color: accent ? 'var(--color-geg-text)' : 'var(--color-geg-text-2)',
        letterSpacing: '-0.01em',
        textAlign: 'right',
      }}
    >
      {value}
    </span>
  )
}
