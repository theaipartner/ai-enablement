import { HeaderBand } from '@/components/gregory/header-band'
import { getCeoControlCenterData } from '@/lib/db/ceo-control-center'

// CEO Control Center — top-level admin metric tiles.
// New Cash / Backend Cash are placeholder values for now; Total
// Clients and Ad Spend MTD are real.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Placeholder cash numbers — replaced when revenue source wires up.
const PLACEHOLDER_NEW_CASH = 185_400
const PLACEHOLDER_BACKEND_CASH = 312_750

const USD_FMT = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0,
})

export default async function CeoControlCenterPage() {
  const data = await getCeoControlCenterData()

  return (
    <div style={{ padding: '32px 48px 64px', maxWidth: 1480, width: '100%' }}>
      <HeaderBand eyebrow="CEO" title="Control center." />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: 18,
          marginTop: 28,
        }}
      >
        <MetricTile
          eyebrow="NEW CASH"
          caption="MTD · new deals"
          value={USD_FMT.format(PLACEHOLDER_NEW_CASH)}
          placeholder
        />
        <MetricTile
          eyebrow="BACKEND CASH"
          caption="MTD · renewals + upsell"
          value={USD_FMT.format(PLACEHOLDER_BACKEND_CASH)}
          placeholder
        />
        <MetricTile
          eyebrow="TOTAL CLIENTS"
          caption="active · status='active'"
          value={String(data.total_active_clients)}
        />
        <MetricTile
          eyebrow="AD SPEND"
          caption={data.ad_spend_period_label.toLowerCase()}
          value={USD_FMT.format(data.ad_spend_mtd)}
        />
      </div>
    </div>
  )
}

function MetricTile({
  eyebrow,
  caption,
  value,
  placeholder,
}: {
  eyebrow: string
  caption: string
  value: string
  placeholder?: boolean
}) {
  return (
    <div
      style={{
        position: 'relative',
        padding: '22px 24px 24px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        minHeight: 168,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 8,
        }}
      >
        <div
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-3)',
          }}
        >
          {eyebrow}
        </div>
        {placeholder ? (
          <span
            className="geg-mono"
            style={{
              fontSize: 9,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-warn)',
              border: '1px solid var(--color-geg-warn-border)',
              background: 'var(--color-geg-warn-fill)',
              padding: '2px 6px',
              borderRadius: 3,
            }}
          >
            placeholder
          </span>
        ) : null}
      </div>
      <div
        className="geg-numeric-serif"
        style={{
          fontSize: 40,
          lineHeight: 1.05,
          letterSpacing: '-0.025em',
          color: 'var(--color-geg-text)',
          marginTop: 16,
        }}
      >
        {value}
      </div>
      <div
        className="geg-mono"
        style={{
          marginTop: 'auto',
          paddingTop: 12,
          fontSize: 10,
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-faint)',
        }}
      >
        {caption}
      </div>
    </div>
  )
}
