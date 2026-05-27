'use client'

import Link from 'next/link'
import { useSearchParams } from 'next/navigation'

// Back-to-list button that preserves the URL query string the user
// came from. List page row links append `?from=<encoded path+query>`;
// this component reads the param + validates it starts with `/clients`
// to prevent open-redirect via crafted URLs. Anything else falls back
// to bare `/clients`.
//
// Spec: docs/specs/director-tasks-and-list-ux-polish.md § Piece 3.
export function BackToClientsButton() {
  const searchParams = useSearchParams()
  const from = searchParams.get('from')
  const safeFrom =
    from && from.startsWith('/clients') && !from.startsWith('//')
      ? from
      : '/clients'

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
      ← BACK TO CLIENTS
    </Link>
  )
}
