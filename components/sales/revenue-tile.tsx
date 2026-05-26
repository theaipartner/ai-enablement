import Link from 'next/link'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'

// Revenue main-page tile. Hero variant (Profit + New Cash) — large
// value, prominent. Support variant (Future / Refunds / Expenses) —
// smaller, supporting. Every tile is a doorway — wraps a Link to the
// drill-down sub-route. Backed by inline-flex so the entire tile is
// the click target.

export type RevenueTileTone = 'hero' | 'support' | 'negative-support'

export type RevenueTileProps = {
  href: string
  eyebrow: string
  label: string
  value: number
  delta?: number
  sub?: string
  variant: 'hero' | 'support'
  tone?: 'pos' | 'neg' | 'muted'
}

export function RevenueTile({
  href,
  eyebrow,
  label,
  value,
  delta,
  sub,
  variant,
  tone = 'muted',
}: RevenueTileProps) {
  const isHero = variant === 'hero'
  const valueSize = isHero ? 56 : 30
  const valueLine = isHero ? '60px' : '34px'
  const valueColor =
    tone === 'pos'
      ? 'var(--color-geg-pos)'
      : tone === 'neg'
        ? 'var(--color-geg-text)'
        : 'var(--color-geg-text)'
  return (
    <Link
      href={href}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: isHero ? '24px 28px 26px' : '18px 20px 18px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        textDecoration: 'none',
        color: 'inherit',
        transition: 'border-color 120ms, transform 120ms',
        minHeight: isHero ? 168 : 112,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 10,
        }}
      >
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-3)',
          }}
        >
          {eyebrow}
        </span>
        <span
          className="geg-mono"
          style={{
            fontSize: 9.5,
            letterSpacing: '0.14em',
            color: 'var(--color-geg-text-faint)',
          }}
        >
          OPEN →
        </span>
      </div>
      <span
        className="geg-serif"
        style={{
          fontSize: isHero ? 16 : 14,
          color: 'var(--color-geg-text-2)',
          letterSpacing: '-0.005em',
        }}
      >
        {label}
      </span>
      <span
        className="geg-numeric-serif"
        style={{
          fontSize: valueSize,
          lineHeight: valueLine,
          letterSpacing: '-0.025em',
          color: valueColor,
          marginTop: isHero ? 6 : 2,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {tone === 'neg' && value > 0 ? '−' : ''}
        {compactUsd(Math.abs(value))}
      </span>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          marginTop: 'auto',
        }}
      >
        {typeof delta === 'number' ? <DeltaPill pct={delta} /> : <span />}
        {sub ? (
          <span
            className="geg-serif"
            style={{
              fontSize: 12,
              color: 'var(--color-geg-text-3)',
              fontStyle: 'italic',
              letterSpacing: '-0.002em',
            }}
          >
            {sub}
          </span>
        ) : null}
      </div>
    </Link>
  )
}

function DeltaPill({ pct }: { pct: number }) {
  if (pct === 0) return <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)' }}>·</span>
  const pos = pct >= 0
  const color = pos ? 'var(--color-geg-pos)' : 'var(--color-geg-neg)'
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 11,
        color,
        letterSpacing: '0.04em',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {pos ? '▲' : '▼'} {Math.abs(pct * 100).toFixed(1)}%
    </span>
  )
}
