'use client'

// Gregory Redesign Part 1 — foundation primitive.
//
// Section header that's data-aware: pages decide at composition time
// whether the section has nothing to show (hide), has nothing meaningful
// but the slot still matters (stub with an actionable placeholder), or
// has content (show). The default is to hide; the stub mode is reserved
// for sections whose absence would confuse the reader more than a
// labeled empty state.
//
// Optional collapsible behavior: when true, renders a chevron toggle on
// the section header. State is per-section (useState), not page-wide.
// Per § 1.4, collapsible sections default to expanded unless the page
// explicitly passes defaultCollapsed=true (the Diagnostics slot uses
// DiagnosticsCollapse, not this primitive, for the collapsed-by-default
// case).
//
// Conventions: docs/fulfillment/gregory-conventions.md § Empty-state rules.
// Slot owner: any section in detail/list pages.
// Tokens consumed: --color-geg-text-3 (chevron), .geg-eyebrow utility,
//   .geg-section-title utility from app/globals.css.

import { useState, type ReactNode } from 'react'

export type EmptyStateMode = 'hide' | 'stub' | 'show'

export type EmptyStateAwareSectionProps = {
  // Section header copy. Rendered with .geg-section-title styling.
  title: string
  // Composition-time decision based on data presence. Choose the mode
  // when you build the page, don't toggle defensively — see the
  // conventions doc for the exact rules.
  mode: EmptyStateMode
  // Placeholder content for mode='stub'. Required when mode='stub';
  // ignored otherwise. Typical shape: a one-line italic deck + an
  // actionable CTA ("No reviews yet. Configure NPS in settings.").
  stubContent?: ReactNode
  // Main content for mode='show'. Ignored when mode is 'hide' or 'stub'.
  children?: ReactNode
  // If true, the section header carries a chevron toggle. Default false.
  collapsible?: boolean
  // Initial open/closed state when collapsible. Default false (expanded).
  defaultCollapsed?: boolean
}

export function EmptyStateAwareSection({
  title,
  mode,
  stubContent,
  children,
  collapsible = false,
  defaultCollapsed = false,
}: EmptyStateAwareSectionProps) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed)

  // 'hide' bails before any DOM lands. No section header, no content.
  if (mode === 'hide') return null

  const showBody =
    mode === 'show' && (!collapsible || !collapsed)
  const showStub = mode === 'stub'

  return (
    <section>
      <div className="flex items-center gap-2">
        {collapsible ? (
          <button
            type="button"
            onClick={() => setCollapsed((c) => !c)}
            aria-expanded={!collapsed}
            aria-label={collapsed ? `Expand ${title}` : `Collapse ${title}`}
            className="inline-flex items-center justify-center"
            style={{
              background: 'transparent',
              border: 'none',
              padding: 0,
              cursor: 'pointer',
              color: 'var(--color-geg-text-3)',
              width: 16,
              height: 16,
            }}
          >
            <span
              style={{
                display: 'inline-block',
                transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
                transition: 'transform 150ms ease',
                fontSize: 10,
                lineHeight: 1,
              }}
            >
              ▶
            </span>
          </button>
        ) : null}
        <h2 className="geg-section-title" style={{ fontSize: 22, lineHeight: '26px' }}>
          {title}
        </h2>
      </div>

      {showStub ? (
        <div style={{ marginTop: 12 }}>{stubContent}</div>
      ) : null}

      {showBody ? (
        <div style={{ marginTop: 12 }}>{children}</div>
      ) : null}
    </section>
  )
}
