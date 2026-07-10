import type { DcAdsFunnel } from '@/lib/db/dc-ads'
import type { DcPlanCounts } from '@/lib/db/funnel-dc'

const PLAN_COLS: { key: keyof DcPlanCounts; label: string }[] = [
  { key: 'base44Monthly', label: 'Base44·Mo' },
  { key: 'base44Yearly', label: 'Base44·Yr' },
  { key: 'wixMonthly', label: 'Wix·Mo' },
  { key: 'wixYearly', label: 'Wix·Yr' },
]

function PlanChip({ label, count }: { label: string; count: number }) {
  const zero = count === 0
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 4 }}>
      <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.04em', color: zero ? 'var(--color-geg-text-faint)' : 'var(--color-geg-text-3)' }}>
        {label}
      </span>
      <span className="geg-numeric-serif" style={{ fontSize: 13, color: zero ? 'var(--color-geg-text-faint)' : 'var(--color-geg-text)' }}>
        {count}
      </span>
    </span>
  )
}

// DC ads funnel — the Digital College paid-ads funnel, with AD SPEND as the
// leading node: adspend → opt-ins → called → connected → closed, plus a
// cash + ROAS row. Booked/Showed are computed but hidden, matching the
// Outbound funnel's Connected → Closed model (Drake 2026-06-24). Monotonic
// from opt-ins on (each stage ⊆ the prior). See lib/db/dc-ads.ts.

const ACCENT = '#b48ead' // purple — distinct from Direct green / setter yellow / reactivation blue / outbound coral

function usd(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

function pct(n: number, d: number): string {
  if (d === 0) return '—'
  return Math.round((n / d) * 100) + '%'
}

function Stage({ label, value, display, bracket, accent }: { label: string; value: number; display?: string; bracket?: string; accent?: boolean }) {
  return (
    <div style={{ flex: 1, textAlign: 'center', padding: '14px 6px' }}>
      <div
        className="geg-numeric-serif"
        style={{ fontSize: 26, lineHeight: 1, color: value === 0 ? 'var(--color-geg-text-faint)' : accent ? ACCENT : 'var(--color-geg-text)' }}
      >
        {display ?? value.toLocaleString('en-US')}
      </div>
      {bracket ? (
        <div className="geg-mono" style={{ fontSize: 9, color: 'var(--color-geg-text-2)', marginTop: 3 }}>
          {bracket}
        </div>
      ) : null}
      <div className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', marginTop: 5 }}>
        {label}
      </div>
    </div>
  )
}

// The conversion % from the previous stage, shown on the connecting arrow.
function Conv({ from, to }: { from: number; to: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minWidth: 44 }}>
      <div className="geg-mono" style={{ color: 'var(--color-geg-text-faint)', fontSize: 13 }}>→</div>
      <div className="geg-mono" style={{ fontSize: 9.5, color: 'var(--color-geg-text)', marginTop: 2 }}>
        {pct(to, from)}
      </div>
    </div>
  )
}

// Adspend → opt-ins junction: cost per opt-in instead of a conversion %.
function CostPer({ spendUsd, optIns }: { spendUsd: number; optIns: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minWidth: 52 }}>
      <div className="geg-mono" style={{ color: 'var(--color-geg-text-faint)', fontSize: 13 }}>→</div>
      <div className="geg-mono" style={{ fontSize: 9.5, color: 'var(--color-geg-text)', marginTop: 2 }}>
        {optIns > 0 ? `${usd(spendUsd / optIns)}/opt-in` : '—'}
      </div>
    </div>
  )
}

export function DcAdsFunnelSection({ funnel, spendUsd }: { funnel: DcAdsFunnel; spendUsd: number }) {
  const f = funnel
  const roas = spendUsd > 0 ? f.cashUsd / spendUsd : null

  return (
    <div style={{ marginTop: 14, border: '1px solid var(--color-geg-border)', borderRadius: 8, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--color-geg-bg-elev)', borderBottom: '1px solid var(--color-geg-border)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: ACCENT }} />
        <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text)' }}>
          DC Ads
        </span>
        <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
          · Meta lead-form funnel · selected dates
        </span>
      </div>

      {/* The funnel — ad spend leads it */}
      <div style={{ display: 'flex', alignItems: 'stretch', padding: '4px 10px' }}>
        <Stage label="Adspend" value={spendUsd} display={usd(spendUsd)} accent />
        <CostPer spendUsd={spendUsd} optIns={f.optIns} />
        <Stage label="Opt-ins" value={f.optIns} accent />
        <Conv from={f.optIns} to={f.called} />
        <Stage label="Called" value={f.called} />
        <Conv from={f.called} to={f.connected} />
        <Stage label="Connected" value={f.connected} />
        <Conv from={f.connected} to={f.closed} />
        <Stage label="Closed" value={f.closed} accent />
      </div>

      {/* Cash + ROAS line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderTop: '1px solid var(--color-geg-border)', background: 'var(--color-geg-bg)' }}>
        <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}>
          Cash collected
        </span>
        <span className="geg-numeric-serif" style={{ fontSize: 18, color: f.cashUsd > 0 ? 'var(--color-geg-text)' : 'var(--color-geg-text-faint)' }}>
          {usd(f.cashUsd)}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 6, paddingLeft: 10, borderLeft: '1px solid var(--color-geg-border)' }}>
          <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}>
            ROAS
          </span>
          <span className="geg-numeric-serif" style={{ fontSize: 16, color: roas && roas > 0 ? 'var(--color-geg-text)' : 'var(--color-geg-text-faint)' }}>
            {roas === null ? '—' : roas.toFixed(2)}
          </span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 14, paddingLeft: 10, borderLeft: '1px solid var(--color-geg-border)' }}>
          {PLAN_COLS.map((c) => (
            <PlanChip key={c.key} label={c.label} count={f.closedPlans[c.key]} />
          ))}
        </span>
        <span className="geg-mono" style={{ fontSize: 9, color: 'var(--color-geg-text-faint)' }}>
          · $300 per DC plan unit
        </span>
        {f.markedNoPlan > 0 ? (
          <span className="geg-mono" style={{ fontSize: 9, color: 'var(--color-geg-text-faint)', marginLeft: 'auto' }}>
            {f.markedNoPlan} marked “DC Closed” w/o a plan → counted as showed, not closed
          </span>
        ) : null}
      </div>
    </div>
  )
}
