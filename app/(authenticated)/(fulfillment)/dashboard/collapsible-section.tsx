'use client'

import { useState } from 'react'

// Collapsible notification-section card for the dashboard. Sections are laid
// out side by side in a responsive grid and collapsed by default — the page
// is expected to grow many sections, so the default view is a compact wall of
// headers (eyebrow + title + count) that expand on click. Children render
// only when open.
export function CollapsibleSection({
  eyebrow,
  title,
  count,
  defaultOpen = false,
  children,
}: {
  eyebrow: string
  title: string
  count: number
  defaultOpen?: boolean
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <section
      style={{
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        height: 'fit-content',
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '15px 18px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-3)',
            }}
          >
            {eyebrow}
          </div>
          <div
            className="geg-serif"
            style={{
              marginTop: 4,
              fontSize: 19,
              color: 'var(--color-geg-text)',
              letterSpacing: '-0.012em',
            }}
          >
            {title}
          </div>
        </div>
        <div
          style={{ display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0 }}
        >
          <span
            className="geg-mono"
            style={{
              fontSize: 11,
              fontVariantNumeric: 'tabular-nums',
              color:
                count > 0
                  ? 'var(--color-geg-text-2)'
                  : 'var(--color-geg-text-faint)',
            }}
          >
            {count}
          </span>
          <span
            aria-hidden
            style={{
              display: 'inline-block',
              transition: 'transform 120ms ease',
              transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
              color: 'var(--color-geg-text-3)',
              fontSize: 10,
            }}
          >
            ▶
          </span>
        </div>
      </button>
      {open ? <div style={{ padding: '0 18px 16px' }}>{children}</div> : null}
    </section>
  )
}
