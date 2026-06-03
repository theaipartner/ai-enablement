import type { DcSalesTally, DcPlanCounts } from '@/lib/db/funnel-dc-sales'

// Digital College sales tally — rendered under the funnel stack. Shows the
// sale-type composition (Base44 / Wix × Monthly / Yearly) split by which funnel
// the sale came from (Direct / Setter / Reactivation). Deduped per lead; reads
// both the current closer EOC and the retired dedicated DC form.

const COLS: { key: keyof Omit<DcPlanCounts, 'sales'>; label: string }[] = [
  { key: 'base44Monthly', label: 'Base44 · Mo' },
  { key: 'base44Yearly', label: 'Base44 · Yr' },
  { key: 'wixMonthly', label: 'Wix · Mo' },
  { key: 'wixYearly', label: 'Wix · Yr' },
]

// Path-row accent dots, matching the funnel-stack box colours.
const PATH_COLOR: Record<string, string> = {
  Direct: 'var(--color-geg-pos)',
  Setter: 'var(--color-geg-warn)',
  Reactivation: '#7ea8dd',
  Total: 'var(--color-geg-text-2)',
}

function Cell({ value, strong }: { value: number; strong?: boolean }) {
  const zero = value === 0
  return (
    <div
      className="geg-numeric-serif"
      style={{
        textAlign: 'center',
        fontSize: strong ? 16 : 15,
        color: zero ? 'var(--color-geg-text-faint)' : strong ? 'var(--color-geg-text)' : 'var(--color-geg-text-dim)',
      }}
    >
      {value}
    </div>
  )
}

function Row({
  label,
  counts,
  isTotal,
}: {
  label: string
  counts: DcPlanCounts
  isTotal?: boolean
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1.4fr repeat(4, 1fr) 0.9fr',
        alignItems: 'center',
        padding: '10px 14px',
        borderTop: '1px solid var(--color-geg-border)',
        background: isTotal ? 'var(--color-geg-bg-elev)' : 'transparent',
      }}
    >
      <div className="geg-mono" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, letterSpacing: '0.04em', color: isTotal ? 'var(--color-geg-text)' : 'var(--color-geg-text-2)' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: PATH_COLOR[label] ?? 'var(--color-geg-text-faint)', flexShrink: 0 }} />
        {label}
      </div>
      {COLS.map((c) => (
        <Cell key={c.key} value={counts[c.key]} strong={isTotal} />
      ))}
      <Cell value={counts.sales} strong />
    </div>
  )
}

export function DcSalesTally({ tally }: { tally: DcSalesTally }) {
  const hasSales = tally.total.sales > 0

  return (
    <div
      style={{
        marginTop: 22,
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        background: 'var(--color-geg-bg)',
        overflow: 'hidden',
      }}
    >
      <div style={{ padding: '12px 14px 10px' }}>
        <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}>
          Digital College sales · by funnel
        </div>
        <div className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)', marginTop: 3 }}>
          Closes in this window · deduped per lead · both forms (closer EOC + retired DC form)
        </div>
      </div>

      {hasSales ? (
        <>
          {/* Column header */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1.4fr repeat(4, 1fr) 0.9fr',
              alignItems: 'center',
              padding: '6px 14px',
              borderTop: '1px solid var(--color-geg-border)',
            }}
          >
            <div className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
              Funnel
            </div>
            {COLS.map((c) => (
              <div key={c.key} className="geg-mono" style={{ textAlign: 'center', fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
                {c.label}
              </div>
            ))}
            <div className="geg-mono" style={{ textAlign: 'center', fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
              Sales
            </div>
          </div>

          <Row label="Direct" counts={tally.direct} />
          <Row label="Setter" counts={tally.setter} />
          <Row label="Reactivation" counts={tally.reactivation} />
          <Row label="Total" counts={tally.total} isTotal />
        </>
      ) : (
        <div className="geg-mono" style={{ padding: '14px', borderTop: '1px solid var(--color-geg-border)', fontSize: 11, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)' }}>
          No Digital College sales in this window.
        </div>
      )}
    </div>
  )
}
