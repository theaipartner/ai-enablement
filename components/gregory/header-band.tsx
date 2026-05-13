// Gregory Redesign Part 1 — foundation primitive.
//
// Renders the eyebrow + serif title + optional pills + optional right-aligned
// actions + optional backlink header pattern that every Gregory list and
// detail page currently hand-rolls. The visual contract is calibrated to
// `app/(authenticated)/clients/page.tsx`'s existing header so a Part 2
// migration of that file is a pure refactor with zero visible diff.
//
// Conventions: docs/gregory-conventions.md § Header pattern.
// Slot owner: detail/list § HeaderBand slot.
// Tokens consumed: --color-geg-border-strong, --color-geg-text-3,
//   plus the .geg-eyebrow + .geg-display utility classes from
//   app/globals.css.

import Link from 'next/link'
import type { ReactNode } from 'react'

export type HeaderBandProps = {
  // Small-caps eyebrow label rendered above the serif title.
  // Use the eyebrow taxonomy in docs/gregory-conventions.md (CSM · CLIENTS,
  // CLIENT · DETAIL, etc.) — copy is the page's call, not the primitive's.
  eyebrow: string
  // Serif title content. String is rendered directly; ReactNode supports
  // inline italics, line breaks, or composed elements (e.g. a name with
  // an inline status indicator). Renders as <h1> for a11y per § 1.9.
  title: string | ReactNode
  // Optional state pills slot (status, journey stage, needs-review, etc.).
  // Rendered as a flex-wrap row directly below the title with 12px spacing.
  pills?: ReactNode
  // Optional right-aligned slot — list-page counts ("188 CLIENTS"),
  // primary actions, dropdowns. Wrapped in a flex baseline so it aligns
  // with the bottom edge of the title row.
  actions?: ReactNode
  // Optional upward navigation link for detail pages. Renders as a tiny
  // small-caps link above the eyebrow ("← BACK TO CLIENTS").
  backlink?: { href: string; label: string }
}

export function HeaderBand({
  eyebrow,
  title,
  pills,
  actions,
  backlink,
}: HeaderBandProps) {
  return (
    <header
      className="flex items-end justify-between gap-6"
      style={{
        paddingBottom: 24,
        borderBottom: '1px solid var(--color-geg-border-strong)',
      }}
    >
      <div>
        {backlink ? (
          <Link
            href={backlink.href}
            className="geg-eyebrow hover:underline inline-block"
            style={{
              color: 'var(--color-geg-text-3)',
              marginBottom: 12,
            }}
          >
            ← {backlink.label.toUpperCase()}
          </Link>
        ) : null}
        <div className="geg-eyebrow">{eyebrow}</div>
        <h1
          className="geg-display"
          style={{ fontSize: 52, lineHeight: '54px', marginTop: 8 }}
        >
          {title}
        </h1>
        {pills ? (
          <div
            className="flex flex-wrap gap-2 items-center"
            style={{ marginTop: 12 }}
          >
            {pills}
          </div>
        ) : null}
      </div>
      {actions ? (
        <div style={{ paddingBottom: 6 }}>{actions}</div>
      ) : null}
    </header>
  )
}
