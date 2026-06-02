'use client'

// CEO — left sidebar.
//
// Same shape as the Fulfillment sidebar
// (app/(authenticated)/(fulfillment)/sidebar.tsx) which itself mirrors
// the Sales sidebar. Single item for now (Cost Hub); more land here
// as the CEO surface grows.

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
  { href: '/control-center', label: 'Control Center', requiredTier: 'admin' },
  { href: '/cost-hub', label: 'Cost Hub', requiredTier: 'admin' },
  { href: '/lead-tag-log', label: 'Tag Log', requiredTier: 'admin' },
]

export function CeoSidebar({ accessTier }: { accessTier: AccessTier }) {
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
          CEO
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
          The Backend.
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
