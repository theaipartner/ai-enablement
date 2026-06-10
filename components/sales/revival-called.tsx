import type { RevivalCalled } from '@/lib/db/funnel-revival'

// Revival "Called" section — sits under the main revival funnel. It splits the
// "Responded" stage by what the SETTER actually did: responded → called →
// connected, plus a speed-to-dial distribution (reply → first dial). All
// event-based (no reply-text classification), see lib/db/funnel-revival.ts.

const ACCENT = '#d08770' // coral — matches the revival funnel
const SLOW = 'var(--color-geg-text-3)' // muted — the "dialed late" tail

function pct(n: number, d: number): string {
  if (d === 0) return '—'
  return Math.round((n / d) * 100) + '%'
}

function Stage({ label, value, accent }: { label: string; value: number; accent?: boolean }) {
  return (
    <div style={{ flex: 1, textAlign: 'center', padding: '14px 6px' }}>
      <div
        className="geg-numeric-serif"
        style={{ fontSize: 26, lineHeight: 1, color: value === 0 ? 'var(--color-geg-text-faint)' : accent ? ACCENT : 'var(--color-geg-text)' }}
      >
        {value.toLocaleString('en-US')}
      </div>
      <div className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', marginTop: 5 }}>
        {label}
      </div>
    </div>
  )
}

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

function fmtMedian(min: number | null): string {
  if (min == null) return '—'
  if (min < 60) return `${min}m`
  const h = min / 60
  return h < 10 ? `${h.toFixed(1)}h` : `${Math.round(h)}h`
}

// Speed-to-dial distribution — pure SVG count bars, one per time bucket. Fast
// buckets (dialed within 30m) read in accent; the slower tail fades to muted so
// "where they land" is legible at a glance.
function SpeedChart({ speed, speedN, median }: { speed: RevivalCalled['speed']; speedN: number; median: number | null }) {
  const PAD_X = 30
  const PAD_TOP = 24
  const PAD_BOTTOM = 44
  const CHART_W = 720
  const CHART_H = 230
  const max = Math.max(1, ...speed.map((b) => b.count))
  const usableH = CHART_H - PAD_TOP - PAD_BOTTOM
  const n = speed.length
  const gap = 16
  const barW = (CHART_W - PAD_X * 2 - gap * (n - 1)) / n
  // The first three buckets are "<30m" — the fast-follow-up window.
  const FAST_CUTOFF = 3

  return (
    <div>
      <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width="100%" style={{ maxWidth: CHART_W, display: 'block', margin: '0 auto' }}>
        {/* Baseline */}
        <line x1={PAD_X} x2={CHART_W - PAD_X} y1={CHART_H - PAD_BOTTOM} y2={CHART_H - PAD_BOTTOM} stroke="var(--color-geg-border)" strokeWidth="1" />
        {speed.map((b, i) => {
          const x = PAD_X + i * (barW + gap)
          const barH = usableH * (b.count / max)
          const yTop = CHART_H - PAD_BOTTOM - barH
          const color = i < FAST_CUTOFF ? ACCENT : SLOW
          return (
            <g key={b.label}>
              <rect x={x} y={yTop} width={barW} height={barH} fill={color} opacity={i < FAST_CUTOFF ? 1 : 0.6} rx="2" />
              {/* count label */}
              <text x={x + barW / 2} y={yTop - 6} textAnchor="middle" className="geg-numeric-serif" style={{ fontSize: 13, fill: b.count === 0 ? 'var(--color-geg-text-faint)' : 'var(--color-geg-text)' }}>
                {b.count}
              </text>
              {/* bucket label */}
              <text x={x + barW / 2} y={CHART_H - PAD_BOTTOM + 18} textAnchor="middle" className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.04em', fill: 'var(--color-geg-text-2)' }}>
                {b.label}
              </text>
              {/* share-of-called */}
              <text x={x + barW / 2} y={CHART_H - PAD_BOTTOM + 31} textAnchor="middle" className="geg-mono" style={{ fontSize: 8.5, fill: 'var(--color-geg-text-faint)' }}>
                {speedN > 0 ? `${Math.round((b.count / speedN) * 100)}%` : '—'}
              </text>
            </g>
          )
        })}
      </svg>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, marginTop: 12 }}>
        <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
          <Swatch color={ACCENT} label="Dialed within 30m" />
          <Swatch color={SLOW} label="Dialed later" opacity={0.6} />
        </div>
        <div className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)' }}>
          {speedN} dialed · median {fmtMedian(median)} reply → first dial
        </div>
      </div>
    </div>
  )
}

function Swatch({ color, label, opacity = 1 }: { color: string; label: string; opacity?: number }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 14, height: 14, borderRadius: 3, background: color, opacity, display: 'inline-block' }} />
      <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--color-geg-text-2)' }}>
        {label}
      </span>
    </span>
  )
}

export function RevivalCalledSection({ called }: { called: RevivalCalled }) {
  const c = called
  return (
    <div style={{ marginTop: 14, border: '1px solid var(--color-geg-border)', borderRadius: 8, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--color-geg-bg-elev)', borderBottom: '1px solid var(--color-geg-border)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: ACCENT }} />
        <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text)' }}>
          Called
        </span>
        <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
          · setter follow-up on replies
        </span>
        {c.notCalled > 0 ? (
          <span className="geg-mono" style={{ fontSize: 9.5, letterSpacing: '0.04em', color: 'var(--color-geg-text-3)', marginLeft: 'auto' }}>
            {c.notCalled} replied, never dialed back
          </span>
        ) : null}
      </div>

      {/* responded → called → connected */}
      <div style={{ display: 'flex', alignItems: 'stretch', padding: '4px 10px' }}>
        <Stage label="Responded" value={c.responded} />
        <Conv from={c.responded} to={c.called} />
        <Stage label="Called" value={c.called} accent />
        <Conv from={c.called} to={c.connected} />
        <Stage label="Connected" value={c.connected} />
      </div>

      {/* speed-to-dial distribution */}
      <div style={{ padding: '14px 14px 16px', borderTop: '1px solid var(--color-geg-border)', background: 'var(--color-geg-bg)' }}>
        <div className="geg-mono" style={{ fontSize: 9.5, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 12 }}>
          Speed to dial · reply → first call
        </div>
        <SpeedChart speed={c.speed} speedN={c.speedN} median={c.speedMedianMin} />
      </div>
    </div>
  )
}
