'use client'

// Gregory Redesign Part 1 — foundation primitive.
//
// Collapsed-by-default container for raw / dev-facing content at the
// bottom of detail pages: JSON metadata, internal IDs, raw payload
// dumps, anything a CSM normally doesn't want above the fold. State is
// per-section (useState); no role-based default per Decision 5 — Drake
// gets the same click as everyone else.
//
// Intended placement is the bottom of every detail page. The component
// doesn't enforce placement (no positional checks); the conventions doc
// is the source of truth for "where this goes." Misuse is caught in
// code review.
//
// Visual treatment is deliberately muted (top hairline rule, small-caps
// "DIAGNOSTICS" eyebrow, no card chrome) so it reads as a footer
// affordance rather than primary content.
//
// Conventions: docs/gregory-conventions.md § Diagnostics-collapse rule.
// Slot owner: detail-page footer ("Diagnostics" slot).
// Tokens consumed: --color-geg-border, --color-geg-text-3, .geg-eyebrow.

import { useState, type ReactNode } from 'react'

export type DiagnosticsCollapseProps = {
  // Diagnostic content (JSON dump, raw IDs, etc.). Rendered only when
  // expanded — never present in the initial DOM, so it can't accidentally
  // dominate the page's scroll height.
  children: ReactNode
}

export function DiagnosticsCollapse({ children }: DiagnosticsCollapseProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <section
      style={{
        marginTop: 48,
        paddingTop: 24,
        borderTop: '1px solid var(--color-geg-border)',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        aria-controls="gregory-diagnostics-body"
        className="geg-eyebrow inline-flex items-center gap-2"
        style={{
          background: 'transparent',
          border: 'none',
          padding: 0,
          cursor: 'pointer',
          color: 'var(--color-geg-text-3)',
        }}
      >
        <span
          style={{
            display: 'inline-block',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 150ms ease',
            fontSize: 10,
            lineHeight: 1,
            width: 10,
          }}
        >
          ▶
        </span>
        DIAGNOSTICS
      </button>
      {expanded ? (
        <div
          id="gregory-diagnostics-body"
          style={{ marginTop: 16 }}
        >
          {children}
        </div>
      ) : null}
    </section>
  )
}
