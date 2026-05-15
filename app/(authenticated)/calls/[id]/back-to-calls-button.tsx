'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

// Back-to-list button for /calls. Mirrors BackToClientsButton: reads
// the `from` query param the list-page row links wrote, validates it
// starts with `/calls`, falls back to bare `/calls` for anything
// else (defense against open-redirect via crafted URLs).
//
// Spec: docs/specs/director-tasks-and-list-ux-polish.md § Piece 3.
export function BackToCallsButton() {
  const searchParams = useSearchParams()
  const from = searchParams.get('from')
  const safeFrom =
    from && from.startsWith('/calls') && !from.startsWith('//')
      ? from
      : '/calls'

  return (
    <Link
      href={safeFrom}
      className="geg-mono"
      style={{
        color: 'var(--color-geg-accent)',
        textDecoration: 'none',
        fontSize: 11,
        fontWeight: 500,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
      }}
    >
      ← BACK TO CALLS
    </Link>
  )
}
