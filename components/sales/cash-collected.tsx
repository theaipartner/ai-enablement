import type { CashCollected } from '@/lib/db/funnel-cash'

function usd(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

// Cash collected — its own funnel-wide summary at the very bottom of the funnel
// page (HT upfront + DC at $300/plan + total, with ROAS). Not part of the DC
// funnel. See lib/db/funnel-cash.ts.
export function CashCollectedBar({ cash }: { cash: CashCollected }) {
  const cells: { label: string; value: string; strong?: boolean }[] = [
    { label: 'High Ticket', value: usd(cash.htUsd) },
    { label: 'Digital College', value: usd(cash.dcUsd) },
    { label: 'Total cash', value: usd(cash.totalUsd), strong: true },
    { label: 'ROAS', value: cash.roas != null ? cash.roas.toFixed(2) + '×' : '—', strong: true },
  ]
  return (
    <div style={{ marginTop: 20, border: '1px solid var(--color-geg-border)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', background: 'var(--color-geg-bg-elev)', borderBottom: '1px solid var(--color-geg-border)' }}>
        <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text)' }}>
          Cash collected
        </span>
        {cash.adspendUsd != null ? (
          <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', marginLeft: 8 }}>
            · {usd(cash.adspendUsd)} adspend
          </span>
        ) : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cells.length}, 1fr)` }}>
        {cells.map((c, i) => (
          <div key={c.label} style={{ textAlign: 'center', padding: '12px 8px', borderLeft: i === 0 ? 'none' : '1px solid var(--color-geg-border)' }}>
            <div className="geg-numeric-serif" style={{ fontSize: c.strong ? 22 : 18, color: c.value === '$0' || c.value === '—' ? 'var(--color-geg-text-faint)' : 'var(--color-geg-text)' }}>
              {c.value}
            </div>
            <div className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', marginTop: 3 }}>
              {c.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
