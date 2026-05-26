import { SectionBlock } from '../section-block'
import {
  getFunnels,
  type FunnelDef,
} from '@/lib/db/sales-dashboard-mocks'
import { type Window } from '@/lib/db/sales-dashboard-shared'

// FUNNELS — decision: where leads die on the way from page-view to
// booking. Per-funnel drop-off + stage-by-stage rates per funnel.

export function FunnelsSection({ window }: { window: Window }) {
  const funnels = getFunnels(window)

  return (
    <>
      {funnels.map((f) => (
        <SectionBlock
          key={f.id}
          eyebrow="FUNNEL"
          title={f.name}
          aside={<FunnelHealthBadge funnel={f} />}
        >
          <FunnelStages funnel={f} />
        </SectionBlock>
      ))}
    </>
  )
}

function FunnelHealthBadge({ funnel }: { funnel: FunnelDef }) {
  const visitToBook = funnel.visits > 0 ? funnel.booked / funnel.visits : 0
  // KPI: ~1% visit→book is healthy for a coaching VSL funnel.
  const tone = visitToBook >= 0.01 ? 'pos' : 'warn'
  const color = tone === 'pos' ? 'var(--color-geg-pos)' : 'var(--color-geg-warn)'
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 10,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color,
        fontWeight: 500,
      }}
    >
      {(visitToBook * 100).toFixed(2)}% VISIT → BOOK
    </span>
  )
}

function FunnelStages({ funnel }: { funnel: FunnelDef }) {
  const stages: { id: string; label: string; count: number }[] = []
  stages.push({ id: 'visits', label: 'Landing visits', count: funnel.visits })
  if (funnel.vslWatched > 0) stages.push({ id: 'vsl', label: 'VSL watched', count: funnel.vslWatched })
  stages.push({ id: 'submits', label: 'Opt-ins', count: funnel.submits })
  stages.push({ id: 'booked', label: 'Booked call', count: funnel.booked })

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${stages.length}, 1fr)`,
        gap: 1,
        background: 'var(--color-geg-border)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 8,
        overflow: 'hidden',
      }}
    >
      {stages.map((s, i) => {
        const prior = i === 0 ? null : stages[i - 1].count
        const pct = prior && prior > 0 ? s.count / prior : null
        // Bottleneck = step with the smallest conversion (relative to
        // a typical funnel step). Highlight if < 10% or the worst
        // non-first step in this funnel.
        const isBottleneck = pct !== null && pct < 0.1
        return (
          <div key={s.id} style={{ padding: '18px 18px 14px', background: 'var(--color-geg-bg-elev)' }}>
            <div
              className="geg-mono"
              style={{
                fontSize: 10,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: 'var(--color-geg-text-3)',
              }}
            >
              {s.label}
            </div>
            <div
              className="geg-numeric-serif"
              style={{
                fontSize: 28,
                lineHeight: '32px',
                letterSpacing: '-0.025em',
                color: 'var(--color-geg-text)',
                marginTop: 6,
              }}
            >
              {s.count.toLocaleString('en-US')}
            </div>
            {pct !== null ? (
              <div
                className="geg-mono"
                style={{
                  fontSize: 11,
                  color: isBottleneck ? 'var(--color-geg-warn)' : 'var(--color-geg-text-faint)',
                  letterSpacing: '0.06em',
                  marginTop: 6,
                  fontWeight: isBottleneck ? 600 : 400,
                }}
              >
                {(pct * 100).toFixed(pct < 0.1 ? 1 : 0)}% of prior
                {isBottleneck ? ' · BOTTLENECK' : ''}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
