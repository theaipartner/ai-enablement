import type { CashCollected } from '@/lib/db/funnel-cash'

function usd(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}
function roasStr(r: number | null): string {
  return r != null ? r.toFixed(2) + '×' : '—'
}

const GRID = '0.9fr 1fr 1fr 1fr 0.9fr'

function HeadCell({ label, right }: { label: string; right?: boolean }) {
  return (
    <div className="geg-mono" style={{ textAlign: right ? 'center' : 'left', fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
      {label}
    </div>
  )
}

function Num({ value, strong }: { value: string; strong?: boolean }) {
  const zero = value === '$0' || value === '—'
  return (
    <div className="geg-numeric-serif" style={{ textAlign: 'center', fontSize: strong ? 18 : 16, color: zero ? 'var(--color-geg-text-faint)' : strong ? 'var(--color-geg-text)' : 'var(--color-geg-text-dim)' }}>
      {value}
    </div>
  )
}

function Row({ label, ht, dc, total, roas }: { label: string; ht: number; dc: number; total: number; roas: number | null }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', padding: '11px 14px', borderTop: '1px solid var(--color-geg-border)' }}>
      <div className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--color-geg-text-2)' }}>{label}</div>
      <Num value={usd(ht)} />
      <Num value={usd(dc)} />
      <Num value={usd(total)} strong />
      <Num value={roasStr(roas)} strong />
    </div>
  )
}

// Cash collected — its own funnel-wide summary at the bottom of the funnel page.
// Upfront (amount paid today) and full contract value, each split HT / DC /
// total with ROAS. Not part of the DC funnel. See lib/db/funnel-cash.ts.
export function CashCollectedBar({ cash }: { cash: CashCollected }) {
  return (
    <div style={{ marginTop: 20, border: '1px solid var(--color-geg-border)', borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '10px 14px', background: 'var(--color-geg-bg-elev)' }}>
        <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text)' }}>
          Cash collected
        </span>
        {cash.adspendUsd != null ? (
          <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', marginLeft: 8 }}>
            · {usd(cash.adspendUsd)} adspend
          </span>
        ) : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: GRID, alignItems: 'center', padding: '6px 14px 4px', borderTop: '1px solid var(--color-geg-border)' }}>
        <HeadCell label="" />
        <HeadCell label="High Ticket" right />
        <HeadCell label="Digital College" right />
        <HeadCell label="Total" right />
        <HeadCell label="ROAS" right />
      </div>
      <Row label="Upfront" ht={cash.htUpfrontUsd} dc={cash.dcUsd} total={cash.upfrontTotalUsd} roas={cash.upfrontRoas} />
      <Row label="Contract" ht={cash.htContractUsd} dc={cash.dcUsd} total={cash.contractTotalUsd} roas={cash.contractRoas} />
    </div>
  )
}
