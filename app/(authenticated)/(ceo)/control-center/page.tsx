import { HeaderBand } from '@/components/gregory/header-band'
import { getCeoControlCenterData } from '@/lib/db/ceo-control-center'
import { getMissingFormFlags, type MissingFormFlag } from '@/lib/db/ceo-missing-forms'

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

function formatEtTime(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso))
}

export default async function CeoControlCenterPage() {
  const [data, missing] = await Promise.all([getCeoControlCenterData(), getMissingFormFlags()])

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

      <MissingFormsPanel setter={missing.setter} closer={missing.closer} />
    </div>
  )
}

// Today's overdue forms — connected setter calls with no triage form 15 min on,
// and closer meetings with no EOC form 1.5 h after start. Clears itself once the
// forms land. Hidden entirely when nothing is overdue.
function MissingFormsPanel({ setter, closer }: { setter: MissingFormFlag[]; closer: MissingFormFlag[] }) {
  const total = setter.length + closer.length
  if (total === 0) return null
  return (
    <div
      style={{
        marginTop: 28,
        padding: '20px 24px 22px',
        background: 'color-mix(in srgb, var(--color-geg-warn) 7%, transparent)',
        border: '1px solid var(--color-geg-warn-border)',
        borderRadius: 10,
      }}
    >
      <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-geg-warn)', marginBottom: 14 }}>
        ⚠ Forms not filled · today · {total}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 24 }}>
        <FlagColumn title="Setter · connected call, no triage form (15 min)" flags={setter} />
        <FlagColumn title="Closer · meeting started, no EOC form (1.5 h)" flags={closer} />
      </div>
    </div>
  )
}

function FlagColumn({ title, flags }: { title: string; flags: MissingFormFlag[] }) {
  return (
    <div>
      <div className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 8 }}>
        {title}
      </div>
      {flags.length === 0 ? (
        <div className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)' }}>All filled ✓</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {flags.map((f, i) => (
            <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 12 }}>
              <span className="geg-serif" style={{ color: 'var(--color-geg-text)' }}>{f.leadName}</span>
              <span className="geg-mono" style={{ fontSize: 10, color: 'var(--color-geg-text-3)' }}>· {f.talentName}</span>
              <span className="geg-mono" style={{ fontSize: 10, color: 'var(--color-geg-text-faint)', marginLeft: 'auto' }}>{formatEtTime(f.atIso)}</span>
            </div>
          ))}
        </div>
      )}
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
