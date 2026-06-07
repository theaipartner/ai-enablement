import type { DcFunnel, DcPlanCounts } from '@/lib/db/funnel-dc'

// Digital College funnel — rendered under the HT funnel stack. The main funnel
// is the DC closer's (Robby/Adam): Booked → Showed → Closed, with the plan
// breakdown on the close. Below it, a downsell line for the HT closer (Aman)
// dipping into DC — split by where the downsell happened. Unique leads only,
// tag-driven. See lib/db/funnel-dc.ts.

const DC_ACCENT = '#7ea8dd'

const PLAN_COLS: { key: keyof DcPlanCounts; label: string }[] = [
  { key: 'base44Monthly', label: 'Base44 · Mo' },
  { key: 'base44Yearly', label: 'Base44 · Yr' },
  { key: 'wixMonthly', label: 'Wix · Mo' },
  { key: 'wixYearly', label: 'Wix · Yr' },
]

function planTotal(p: DcPlanCounts): number {
  return p.base44Monthly + p.base44Yearly + p.wixMonthly + p.wixYearly
}

function Stage({ label, value, dim }: { label: string; value: number; dim?: boolean }) {
  return (
    <div style={{ flex: 1, textAlign: 'center', padding: '10px 6px' }}>
      <div className="geg-numeric-serif" style={{ fontSize: 22, color: value === 0 ? 'var(--color-geg-text-faint)' : dim ? 'var(--color-geg-text-dim)' : 'var(--color-geg-text)' }}>
        {value}
      </div>
      <div className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', marginTop: 2 }}>
        {label}
      </div>
    </div>
  )
}

function Arrow() {
  return <div className="geg-mono" style={{ color: 'var(--color-geg-text-faint)', fontSize: 13, alignSelf: 'center' }}>→</div>
}

function PlanLine({ label, plans }: { label: string; plans: DcPlanCounts }) {
  const total = planTotal(plans)
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1.6fr repeat(4, 1fr)',
        alignItems: 'center',
        padding: '7px 14px',
        borderTop: '1px solid var(--color-geg-border)',
      }}
    >
      <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.04em', color: total === 0 ? 'var(--color-geg-text-faint)' : 'var(--color-geg-text-2)' }}>
        {label}
      </div>
      {PLAN_COLS.map((c) => (
        <div key={c.key} style={{ textAlign: 'center' }}>
          <div className="geg-numeric-serif" style={{ fontSize: 13, color: plans[c.key] === 0 ? 'var(--color-geg-text-faint)' : 'var(--color-geg-text-dim)' }}>
            {plans[c.key]}
          </div>
          <div className="geg-mono" style={{ fontSize: 8, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', marginTop: 1 }}>
            {c.label}
          </div>
        </div>
      ))}
    </div>
  )
}

export function DcFunnelSection({ dc }: { dc: DcFunnel }) {
  const downsellTotal = dc.downsellHtMeeting + dc.downsellConfirmation
  return (
    <div style={{ marginTop: 20, border: '1px solid var(--color-geg-border)', borderRadius: 8, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--color-geg-bg-elev)', borderBottom: '1px solid var(--color-geg-border)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: DC_ACCENT }} />
        <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text)' }}>
          Digital College
        </span>
        <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
          · DC closer
        </span>
      </div>

      {/* Main DC funnel */}
      <div style={{ display: 'flex', alignItems: 'stretch', padding: '4px 14px' }}>
        <Stage label="Booked" value={dc.booked} dim />
        <Arrow />
        <Stage label="Showed" value={dc.showed} dim />
        <Arrow />
        <Stage label="Closed" value={dc.closed} />
      </div>

      {/* Plan breakdown of the closes */}
      <PlanLine label="Plans closed" plans={dc.closedPlans} />

      {/* Downsell line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderTop: '1px solid var(--color-geg-border)', background: 'var(--color-geg-bg)' }}>
        <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}>
          HT-closer downsells
        </span>
        <span className="geg-mono" style={{ fontSize: 10, color: 'var(--color-geg-text-2)' }}>
          confirmation <b className="geg-numeric-serif" style={{ color: dc.downsellConfirmation ? 'var(--color-geg-text)' : 'var(--color-geg-text-faint)' }}>{dc.downsellConfirmation}</b>
        </span>
        <span className="geg-mono" style={{ fontSize: 10, color: 'var(--color-geg-text-2)' }}>
          · HT meeting <b className="geg-numeric-serif" style={{ color: dc.downsellHtMeeting ? 'var(--color-geg-text)' : 'var(--color-geg-text-faint)' }}>{dc.downsellHtMeeting}</b>
        </span>
        <span className="geg-mono" style={{ fontSize: 9, color: 'var(--color-geg-text-faint)', marginLeft: 'auto' }}>
          {downsellTotal} total · credited to the HT closer
        </span>
      </div>
      {downsellTotal > 0 ? <PlanLine label="Downsell plans" plans={dc.downsellPlans} /> : null}
    </div>
  )
}
