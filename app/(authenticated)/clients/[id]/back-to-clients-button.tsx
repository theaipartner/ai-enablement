'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'

// When the user came from /clients (i.e. history exists in this tab),
// router.back() restores the previous URL — including filter / sort
// params. When the detail page was the first navigation (direct Slack
// share, deep link), history.length is 1 and the Link's /clients href
// fires as a clean fallback.
export function BackToClientsButton() {
  const router = useRouter()

  function handleClick(e: React.MouseEvent<HTMLAnchorElement>) {
    if (typeof window !== 'undefined' && window.history.length > 1) {
      e.preventDefault()
      router.back()
    }
  }

  return (
    <Link
      href="/clients"
      onClick={handleClick}
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
