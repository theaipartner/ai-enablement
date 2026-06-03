import type { DcSalesTally, DcPlanCounts } from '@/lib/db/funnel-dc-sales'

// Digital College sales tally — rendered under the funnel stack. Two
// breakdowns of the same deduped DC sales: by funnel path (Direct / Setter /
// Reactivation) and by origin (where they became a DC lead). Each shows the
// sale-type composition (Base44 / Wix × Monthly / Yearly) + a sale count.
// Reads both the current closer EOC and the retired dedicated DC form.

const COLS: { key: keyof Omit<DcPlanCounts, 'sales'>; label: string }[] = [
  { key: 'base44Monthly', label: 'Base44 · Mo' },
  { key: 'base44Yearly', label: 'Base44 · Yr' },
  { key: 'wixMonthly', label: 'Wix · Mo' },
  { key: 'wixYearly', label: 'Wix · Yr' },
]

const GRID = '1.7fr repeat(4, 1fr) 0.9fr'

// Accent dots — funnel-path rows match the funnel-stack box colours; origin
// rows get a neutral accent.
const DOT: Record<string, string> = {
  Direct: 'var(--color-geg-pos)',
  Setter: 'var(--color-geg-warn)',
  Reactivation: '#7ea8dd',
  Total: 'var(--color-geg-text-2)',
}

function Cell({ value, strong }: { value: number; strong?: boolean }) {
  return (
    <div
      className="geg-numeric-serif"
      style={{
        textAlign: 'center',
        fontSize: strong ? 16 : 15,
        color: value === 0 ? 'var(--color-geg-text-faint)' : strong ? 'var(--color-geg-text)' : 'var(--color-geg-text-dim)',
      }}
    >
      {value}
    </div>
  )
}

function Row({ label, counts, isTotal }: { label: string; counts: DcPlanCounts; isTotal?: boolean }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: GRID,
        alignItems: 'center',
        padding: '10px 14px',
        borderTop: '1px solid var(--color-geg-border)',
        background: isTotal ? 'var(--color-geg-bg-elev)' : 'transparent',
      }}
    >
      <div className="geg-mono" style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, letterSpacing: '0.04em', color: isTotal ? 'var(--color-geg-text)' : 'var(--color-geg-text-2)' }}>
        <span style={{ width: 7, height: 7, borderRadius: '50%', background: DOT[label] ?? 'var(--color-geg-text-faint)', flexShrink: 0 }} />
        {label}
      </div>
      {COLS.map((c) => (
        <Cell key={c.key} value={counts[c.key]} strong={isTotal} />
      ))}
      <Cell value={counts.sales} strong />
    </div>
  )
}

function SectionHeader({ title }: { title: string }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: GRID,
        alignItems: 'center',
        padding: '8px 14px 4px',
        borderTop: '1px solid var(--color-geg-border)',
        background: 'var(--color-geg-bg-elev)',
      }}
    >
      <div className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}>
        {title}
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
          Digital College sales
        </div>
        <div className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)', marginTop: 3 }}>
          Closes in this window · deduped per lead · both forms (closer EOC + retired DC form)
        </div>
      </div>

      {hasSales ? (
        <>
          <SectionHeader title="By funnel" />
          <Row label="Direct" counts={tally.byPath.direct} />
          <Row label="Setter" counts={tally.byPath.setter} />
          <Row label="Reactivation" counts={tally.byPath.reactivation} />

          <SectionHeader title="By origin" />
          <Row label="Confirmed DC booking" counts={tally.byOrigin.confirmed_booking} />
          <Row label="Downsell (confirmation)" counts={tally.byOrigin.downsell} />
          <Row label="HT-meeting close" counts={tally.byOrigin.ht_meeting} />
          <Row label="Robby direct" counts={tally.byOrigin.robby_direct} />

          <div
            className="geg-mono"
            style={{ padding: '8px 14px', borderTop: '1px solid var(--color-geg-border)', fontSize: 9, letterSpacing: '0.04em', lineHeight: 1.6, color: 'var(--color-geg-text-faint)' }}
          >
            ↳ Confirmed DC bookings route straight to Robby — both Confirmed DC booking and Robby direct are Robby&rsquo;s closes. Only HT-meeting close is a non-Robby (Aman) downsell.
          </div>

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
