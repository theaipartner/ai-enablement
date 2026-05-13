import Link from 'next/link'

// Plain Link to /clients — always returns to the list page, never the
// previous browser history entry. Filter / sort state on /clients
// persists via URL params, so a CSM coming back to the list still sees
// their last filter view.
export function BackToClientsButton() {
  return (
    <Link
      href="/clients"
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
