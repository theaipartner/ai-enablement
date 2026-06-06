import type { RevivalFunnel } from '@/lib/db/funnel-revival'

// Revival funnel — the DC re-engagement campaign, on its own sub-page under
// Funnel. all revival leads → responded → connected → booked → showed → closed,
// plus a cash row ($300 per DC plan unit). Monotonic (each stage ⊆ the prior),
// so the conversion % between stages is always 0–100. See lib/db/funnel-revival.ts.

const ACCENT = '#d08770' // coral — distinct from Direct green / setter yellow / DC blue

function usd(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

function pct(n: number, d: number): string {
  if (d === 0) return '—'
  return Math.round((n / d) * 100) + '%'
}

function Stage({ label, value, bracket, accent }: { label: string; value: number; bracket?: string; accent?: boolean }) {
  return (
    <div style={{ flex: 1, textAlign: 'center', padding: '14px 6px' }}>
      <div
        className="geg-numeric-serif"
        style={{ fontSize: 26, lineHeight: 1, color: value === 0 ? 'var(--color-geg-text-faint)' : accent ? ACCENT : 'var(--color-geg-text)' }}
      >
        {value.toLocaleString('en-US')}
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

export function RevivalFunnelSection({ funnel }: { funnel: RevivalFunnel }) {
  const f = funnel
  const bookedBracket =
    f.booked > 0 ? `${f.bookedDc} DC${f.bookedHt > 0 ? ` / ${f.bookedHt} HT` : ''}` : undefined

  return (
    <div style={{ marginTop: 14, border: '1px solid var(--color-geg-border)', borderRadius: 8, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--color-geg-bg-elev)', borderBottom: '1px solid var(--color-geg-border)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: ACCENT }} />
        <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text)' }}>
          Revival
        </span>
        <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
          · DC re-engagement · all-time
        </span>
      </div>

      {/* The funnel */}
      <div style={{ display: 'flex', alignItems: 'stretch', padding: '4px 10px' }}>
        <Stage label="Revival leads" value={f.leads} accent />
        <Conv from={f.leads} to={f.responded} />
        <Stage label="Responded" value={f.responded} />
        <Conv from={f.responded} to={f.connected} />
        <Stage label="Connected" value={f.connected} />
        <Conv from={f.connected} to={f.booked} />
        <Stage label="Booked" value={f.booked} bracket={bookedBracket} />
        <Conv from={f.booked} to={f.showed} />
        <Stage label="Showed" value={f.showed} />
        <Conv from={f.showed} to={f.closed} />
        <Stage label="Closed" value={f.closed} accent />
      </div>

      {/* Cash line */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '11px 14px', borderTop: '1px solid var(--color-geg-border)', background: 'var(--color-geg-bg)' }}>
        <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)' }}>
          Cash collected
        </span>
        <span className="geg-numeric-serif" style={{ fontSize: 18, color: f.cashUsd > 0 ? 'var(--color-geg-text)' : 'var(--color-geg-text-faint)' }}>
          {usd(f.cashUsd)}
        </span>
        <span className="geg-mono" style={{ fontSize: 9, color: 'var(--color-geg-text-faint)' }}>
          · $300 per DC plan unit · closes need an explicit plan
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
