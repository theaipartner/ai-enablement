import { Fragment } from 'react'
import Link from 'next/link'
import {
  STAGES,
  type Conversion,
  type StageId,
} from '@/lib/db/funnel-mocks'
import { compactCount, compactUsd } from '@/lib/db/sales-dashboard-shared'

// Funnel · 7-stage horizontal strip — the page's hero block.
//
// Each stage is a clickable cell linking to /funnel/<stage-id> (the
// Cash stage links straight to /revenue because the Revenue page
// already owns its full detail).
//
// Conversion % renders in the gap between stages. The worst rate is
// flagged as the bottleneck (gold/warn tone on the chevron + label).

export type FunnelStripProps = {
  headlines: Record<StageId, number>
  conversions: Conversion[]
  bottleneck: StageId | null
}

export function FunnelStrip({ headlines, conversions, bottleneck }: FunnelStripProps) {
  return (
    <section
      aria-label="Sales funnel"
      style={{
        marginTop: 36,
        padding: '24px 24px 26px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
      }}
    >
      <Eyebrow bottleneck={bottleneck} />
      <div style={{ display: 'flex', alignItems: 'stretch', gap: 0 }}>
        {STAGES.map((stage, i) => {
          const isLast = i === STAGES.length - 1
          const conv = i > 0 ? conversions[i - 1] : null
          return (
            <Fragment key={stage.id}>
              {conv && (
                <Gap
                  conversion={conv}
                  bottleneck={bottleneck}
                />
              )}
              <StageCell
                stage={stage.id}
                label={stage.label}
                headline={headlines[stage.id]}
                isCashStage={stage.id === 'cash'}
                isBottleneckTo={bottleneck === stage.id}
                isLast={isLast}
              />
            </Fragment>
          )
        })}
      </div>
    </section>
  )
}

function Eyebrow({ bottleneck }: { bottleneck: StageId | null }) {
  const bottleneckLabel = bottleneck
    ? STAGES.find((s) => s.id === bottleneck)?.label
    : null
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        marginBottom: 18,
        gap: 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-3)',
          }}
        >
          FUNNEL
        </span>
        <span
          className="geg-serif"
          style={{ fontSize: 17, color: 'var(--color-geg-text)', letterSpacing: '-0.01em' }}
        >
          Click any stage to drill in. Worst conversion is the leak.
        </span>
      </div>
      {bottleneckLabel ? (
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-warn)',
            fontWeight: 600,
          }}
        >
          BOTTLENECK · {bottleneckLabel.toUpperCase()}
        </span>
      ) : null}
    </div>
  )
}

function StageCell({
  stage,
  label,
  headline,
  isCashStage,
  isBottleneckTo,
  isLast,
}: {
  stage: StageId
  label: string
  headline: number
  isCashStage: boolean
  isBottleneckTo: boolean
  isLast: boolean
}) {
  const href = isCashStage ? '/sales-dashboard/revenue' : `/sales-dashboard/funnel/${stage}`
  // Compact-format: USD for the cash stage, count for everything else.
  // Long-form impressions/visits clip in narrow cells.
  const display = isCashStage
    ? compactUsd(headline)
    : compactCount(headline)
  return (
    <Link
      href={href}
      style={{
        flex: '1 1 0',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '6px 4px 4px',
        borderRadius: 6,
        textDecoration: 'none',
        color: 'inherit',
        transition: 'background 120ms',
        outline: isBottleneckTo ? '1px solid var(--color-geg-warn)' : 'none',
      }}
    >
      <span
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: isBottleneckTo ? 'var(--color-geg-warn)' : 'var(--color-geg-text-3)',
        }}
      >
        {label}
      </span>
      <span
        className="geg-numeric-serif"
        style={{
          fontSize: 24,
          lineHeight: '28px',
          letterSpacing: '-0.02em',
          color: 'var(--color-geg-text)',
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {display}
      </span>
      <span
        className="geg-mono"
        style={{
          fontSize: 9.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-faint)',
          marginTop: 'auto',
        }}
      >
        OPEN {isLast ? '→ REVENUE' : '→'}
      </span>
    </Link>
  )
}

function Gap({
  conversion,
  bottleneck,
}: {
  conversion: Conversion
  bottleneck: StageId | null
}) {
  const isBottleneck = bottleneck === conversion.toStage
  const color = isBottleneck ? 'var(--color-geg-warn)' : 'var(--color-geg-text-3)'
  let label: string
  if (conversion.isMonetary) {
    label = `${compactUsd(conversion.rate)}/deal`
  } else {
    const pct = conversion.rate * 100
    label = `${pct.toFixed(pct < 10 ? 1 : 0)}%`
  }
  return (
    <div
      aria-hidden
      style={{
        flex: '0 0 auto',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '0 8px',
        minWidth: 62,
      }}
    >
      <svg width="14" height="22" viewBox="0 0 14 22" aria-hidden>
        <path
          d="M2 3 L11 11 L2 19"
          stroke={color}
          strokeWidth="1.4"
          fill="none"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <span
        className="geg-mono"
        style={{
          marginTop: 6,
          fontSize: 11,
          letterSpacing: '0.04em',
          color,
          fontWeight: isBottleneck ? 600 : 400,
          whiteSpace: 'nowrap',
        }}
      >
        {label}
      </span>
    </div>
  )
}
