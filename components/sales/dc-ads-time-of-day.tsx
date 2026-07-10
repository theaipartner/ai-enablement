import type { DcAdsHourBucket } from '@/lib/db/dc-ads'

// DC ads time-of-day — opt-ins vs dials vs connects in 2-hour ET buckets. Same
// grouped-bar SVG as the Outbound page's, with the first series being the
// OPT-IN time (form submit) instead of the SMS reply. Wall-clock: opt-in
// volume landing outside the dialing window is the coverage gap to staff for.

const C_OPTIN = '#b48ead' // purple — lead opted in
const C_DIAL = '#d08770' // coral — rep dialed
const C_CONNECT = '#a3be8c' // green — connected

const SERIES: { key: keyof Pick<DcAdsHourBucket, 'optIns' | 'dials' | 'connects'>; color: string; label: string }[] = [
  { key: 'optIns', color: C_OPTIN, label: 'Opt-ins' },
  { key: 'dials', color: C_DIAL, label: 'Dials' },
  { key: 'connects', color: C_CONNECT, label: 'Connects' },
]

export function DcAdsTimeOfDaySection({ buckets }: { buckets: DcAdsHourBucket[] }) {
  const totals = SERIES.map((s) => ({ ...s, total: buckets.reduce((a, b) => a + b[s.key], 0) }))

  const PAD_X = 30
  const PAD_TOP = 18
  const PAD_BOTTOM = 40
  const CHART_W = 720
  const CHART_H = 250
  const max = Math.max(1, ...buckets.flatMap((b) => [b.optIns, b.dials, b.connects]))
  const usableH = CHART_H - PAD_TOP - PAD_BOTTOM
  const n = buckets.length
  const groupGap = 10
  const groupW = (CHART_W - PAD_X * 2 - groupGap * (n - 1)) / n
  const barW = (groupW - 4) / 3
  const baseline = CHART_H - PAD_BOTTOM
  const h = (v: number) => usableH * (v / max)
  const gridlines = [0.25, 0.5, 0.75, 1]

  return (
    <div style={{ marginTop: 14, border: '1px solid var(--color-geg-border)', borderRadius: 8, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--color-geg-bg-elev)', borderBottom: '1px solid var(--color-geg-border)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: C_OPTIN }} />
        <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text)' }}>
          Time of day
        </span>
        <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
          · opt-ins vs dials vs connects · ET
        </span>
      </div>

      <div style={{ padding: '16px 14px' }}>
        <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} width="100%" style={{ maxWidth: CHART_W, display: 'block', margin: '0 auto' }}>
          {/* gridlines + y labels */}
          {gridlines.map((g) => {
            const yPos = PAD_TOP + usableH * (1 - g)
            return (
              <g key={g}>
                <line x1={PAD_X} x2={CHART_W - PAD_X} y1={yPos} y2={yPos} stroke="var(--color-geg-border)" strokeDasharray="2 4" strokeWidth="1" />
                <text x={PAD_X - 6} y={yPos + 3} textAnchor="end" className="geg-mono" style={{ fontSize: 9, fill: 'var(--color-geg-text-faint)' }}>
                  {Math.round(g * max)}
                </text>
              </g>
            )
          })}
          <line x1={PAD_X} x2={CHART_W - PAD_X} y1={baseline} y2={baseline} stroke="var(--color-geg-border)" strokeWidth="1" />

          {buckets.map((b, i) => {
            const gx = PAD_X + i * (groupW + groupGap)
            return (
              <g key={b.label}>
                {SERIES.map((s, si) => {
                  const v = b[s.key]
                  const x = gx + si * barW + si * 2
                  const bh = h(v)
                  return <rect key={s.key} x={x} y={baseline - bh} width={barW} height={bh} fill={s.color} rx="1.5" />
                })}
                {/* bucket label */}
                <text x={gx + groupW / 2} y={baseline + 16} textAnchor="middle" className="geg-mono" style={{ fontSize: 9.5, letterSpacing: '0.02em', fill: 'var(--color-geg-text-2)' }}>
                  {b.label}
                </text>
              </g>
            )
          })}
        </svg>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 14, marginTop: 12 }}>
          <div style={{ display: 'flex', gap: 18, alignItems: 'center' }}>
            {totals.map((s) => (
              <Swatch key={s.key} color={s.color} label={`${s.label} (${s.total})`} />
            ))}
          </div>
          <div className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)' }}>
            wall-clock ET · connects timed by the call
          </div>
        </div>
      </div>
    </div>
  )
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span style={{ width: 14, height: 14, borderRadius: 3, background: color, display: 'inline-block' }} />
      <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--color-geg-text-2)' }}>
        {label}
      </span>
    </span>
  )
}
