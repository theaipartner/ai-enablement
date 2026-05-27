'use client'

// Fulfillment — left sidebar.
//
// Mirrors the Sales sidebar (app/(authenticated)/sales-dashboard/sidebar.tsx)
// pattern: sticky 240px column, eyebrow + serif title header, vertical
// list of section links with active-state indicator on the left edge.
//
// Items: Dashboard (empty placeholder), Clients, Calls, Meeting Tracker
// (formerly the standalone /teams nav item). The route group is
// `(fulfillment)` — URLs are unchanged for the moved pages
// (/clients, /calls, /teams).

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { tierAtLeast, type AccessTier } from '@/lib/auth/access-tier-shared'

const TOPNAV_HEIGHT = 64

type NavItem = {
  href: string
  label: string
  requiredTier: AccessTier
}

const NAV: NavItem[] = [
  { href: '/dashboard', label: 'Dashboard', requiredTier: 'csm' },
  { href: '/clients', label: 'Clients', requiredTier: 'csm' },
  { href: '/calls', label: 'Calls', requiredTier: 'csm' },
  { href: '/teams', label: 'Meeting Tracker', requiredTier: 'head_csm' },
]

export function FulfillmentSidebar({ accessTier }: { accessTier: AccessTier }) {
  const pathname = usePathname() ?? ''

  function isActive(href: string): boolean {
    return pathname === href || pathname.startsWith(`${href}/`)
  }

  return (
    <aside
      style={{
        background: 'var(--color-geg-bg-elev)',
        borderRight: '1px solid var(--color-geg-border)',
        padding: '28px 0 40px',
        position: 'sticky',
        top: TOPNAV_HEIGHT,
        alignSelf: 'start',
        height: `calc(100vh - ${TOPNAV_HEIGHT}px)`,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          padding: '0 24px 24px',
          borderBottom: '1px solid var(--color-geg-border)',
          marginBottom: 18,
        }}
      >
        <div className="geg-eyebrow" style={{ color: 'var(--color-geg-accent)' }}>
          FULFILLMENT
        </div>
        <div
          className="geg-serif"
          style={{
            fontSize: 24,
            lineHeight: 1.05,
            color: 'var(--color-geg-text)',
            marginTop: 6,
            letterSpacing: '-0.015em',
          }}
        >
          The Operation.
        </div>
      </div>

      {NAV.filter((item) => tierAtLeast(accessTier, item.requiredTier)).map((item) => (
        <SidebarLink
          key={item.href}
          href={item.href}
          label={item.label}
          active={isActive(item.href)}
        />
      ))}
    </aside>
  )
}

function SidebarLink({
  href,
  label,
  active,
}: {
  href: string
  label: string
  active: boolean
}) {
  const styles: React.CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    padding: '12px 24px 12px 22px',
    color: active ? 'var(--color-geg-accent) ' : 'var(--color-geg-text)',
    borderLeft: `2px solid ${active ? 'var(--color-geg-accent)' : 'transparent'}`,
    background: active ? 'var(--color-geg-accent-fill)' : 'transparent',
    fontFamily: 'var(--font-prom-sans), Inter, system-ui, sans-serif',
    textTransform: 'uppercase',
    letterSpacing: '0.16em',
    fontSize: 11,
    fontWeight: 500,
    transition: 'background 100ms ease, color 100ms ease, border-color 100ms ease',
  }

  return (
    <Link href={href} style={styles} data-active={active ? 'true' : 'false'}>
      <span>{label}</span>
    </Link>
  )
}
