import type { ReactNode } from 'react'

// Standard chrome for a section-page block: eyebrow + title + body.
// Used by every section's primary/secondary block so the surface
// reads consistently.

export function SectionBlock({
  eyebrow,
  title,
  aside,
  children,
  marginTop = 24,
  noBg = false,
}: {
  eyebrow: string
  title: string
  aside?: ReactNode
  children: ReactNode
  marginTop?: number
  noBg?: boolean
}) {
  return (
    <section
      style={{
        marginTop,
        padding: '22px 26px 24px',
        background: noBg ? 'transparent' : 'var(--color-geg-bg-elev)',
        border: noBg ? 'none' : '1px solid var(--color-geg-border)',
        borderRadius: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 18,
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
            {eyebrow}
          </span>
          <span
            className="geg-serif"
            style={{ fontSize: 17, color: 'var(--color-geg-text)', letterSpacing: '-0.01em' }}
          >
            {title}
          </span>
        </div>
        {aside ? <div>{aside}</div> : null}
      </div>
      {children}
    </section>
  )
}
