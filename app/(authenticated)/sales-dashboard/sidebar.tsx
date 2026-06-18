'use client'

// Sales Dashboard — sales-only left sidebar.
//
// Four flat views (no sub-bars): Funnel (the stacked top-of-funnel overview;
// its stage nodes link to pre-filtered Leads, adspend → Ads, and a header link
// → Landing Pages, so Ads/LP no longer need sidebar entries), Leads, People,
// Calls. Revenue moved to the CEO tab; Appointment Setting + Closing are folded
// into People + the Funnel→Leads drill.

import Link from 'next/link'
import { usePathname } from 'next/navigation'

const TOPNAV_HEIGHT = 64

type NavItem = {
  href: string
  label: string
  children?: { href: string; label: string }[]
}

const NAV: NavItem[] = [
  // Funnel = the stacked Total/Direct/Setter/Reactivation overview. Stage nodes
  // drill into the pre-filtered Leads roster; Ads + Landing Pages are reached
  // from within the page, not the sidebar. Revival (the DC re-engagement
  // campaign) is a dedicated sub-page — revival leads are excluded from every
  // other funnel, so they get their own surface.
  {
    href: '/sales-dashboard/funnel',
    label: 'Marketing',
    children: [{ href: '/sales-dashboard/funnel/revival', label: 'Revival' }],
  },
  // Leads = the roster of every lead opted-in in the window (new + re-opt-in),
  // with type/stage filters set by the funnel drill or the filter bar.
  { href: '/sales-dashboard/leads', label: 'Leads' },
  // Talent = per-rep views (Call Activity, per-closer scheduled, bookings, cash).
  // Route stays /people; only the display name is "Talent".
  { href: '/sales-dashboard/people', label: 'Talent' },
  // The Calls list page is gone — per-call review pages are reached from the
  // per-lead Lifecycle (each call links there, and returns "Back to lead").
]

export function SalesSidebar({ includeStatesLink }: { includeStatesLink: boolean }) {
  // `includeStatesLink` is held for backward compat with the segment
  // layout — its toggle is unused under the four-item structure.
  void includeStatesLink

  const pathname = usePathname() ?? ''

  function isActive(href: string): boolean {
    if (href === '/sales-dashboard') return pathname === '/sales-dashboard'
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
          SALES · ENGINE
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
          The Engine.
        </div>
      </div>

      {NAV.map((item) => (
        <div key={item.href}>
          <SidebarLink
            href={item.href}
            label={item.label}
            active={isActive(item.href)}
            variant="overview"
          />
          {item.children?.map((child) => (
            <SidebarLink
              key={child.href}
              href={child.href}
              label={child.label}
              active={pathname === child.href}
              variant="child"
            />
          ))}
        </div>
      ))}
    </aside>
  )
}

function SidebarLink({
  href,
  label,
  count,
  active,
  variant,
}: {
  href: string
  label: string
  count?: number
  active: boolean
  variant: 'overview' | 'section' | 'child'
}) {
  const baseStyles: React.CSSProperties = {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    gap: 8,
    padding: '9px 24px 9px 22px',
    color: active ? 'var(--color-geg-text)' : 'var(--color-geg-text-2)',
    borderLeft: `2px solid ${active ? 'var(--color-geg-accent)' : 'transparent'}`,
    background: active ? 'var(--color-geg-accent-fill)' : 'transparent',
    fontFamily: 'var(--font-geg-serif), Newsreader, Georgia, serif',
    fontSize: 13.5,
    letterSpacing: '-0.005em',
    transition: 'background 100ms ease, color 100ms ease, border-color 100ms ease',
  }
  const overviewStyles: React.CSSProperties = {
    fontFamily: 'var(--font-prom-sans), Inter, system-ui, sans-serif',
    textTransform: 'uppercase',
    letterSpacing: '0.16em',
    fontSize: 11,
    fontWeight: 500,
    padding: '12px 24px 12px 22px',
    color: active ? 'var(--color-geg-accent)' : 'var(--color-geg-text)',
  }
  const childStyles: React.CSSProperties = {
    fontFamily: 'var(--font-geg-serif), Newsreader, Georgia, serif',
    fontSize: 12.5,
    letterSpacing: '-0.003em',
    padding: '6px 24px 6px 40px',
    color: active ? 'var(--color-geg-text)' : 'var(--color-geg-text-3)',
  }
  const merged =
    variant === 'overview'
      ? { ...baseStyles, ...overviewStyles }
      : variant === 'child'
        ? { ...baseStyles, ...childStyles }
        : baseStyles

  return (
    <Link href={href} style={merged} data-active={active ? 'true' : 'false'}>
      <span>{label}</span>
      {typeof count === 'number' ? (
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            color: active ? 'var(--color-geg-accent)' : 'var(--color-geg-text-faint)',
            letterSpacing: '0.06em',
          }}
        >
          {count}
        </span>
      ) : null}
    </Link>
  )
}
