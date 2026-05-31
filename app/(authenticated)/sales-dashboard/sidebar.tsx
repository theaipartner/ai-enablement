'use client'

// Sales Dashboard — sales-only left sidebar.
//
// Three primary views post-2026-05-27: Pulse (the activity view —
// renamed from Funnel — with an inline sub-list of the four funnel
// stages for fast access), Revenue, and Calls.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useState } from 'react'

const TOPNAV_HEIGHT = 64

type NavItem = {
  href: string
  label: string
  children?: NavItem[]
}

const NAV: NavItem[] = [
  {
    href: '/sales-dashboard/funnel',
    label: 'Pulse',
    children: [
      { href: '/sales-dashboard/funnel/ads', label: 'Ads' },
      { href: '/sales-dashboard/funnel/landing-pages', label: 'Landing page' },
      { href: '/sales-dashboard/funnel/appointment-setting', label: 'Appointment setting' },
      { href: '/sales-dashboard/funnel/closed', label: 'Closing' },
    ],
  },
  // Leads = view-only roster of every lead opted-in in the timeframe
  // (new + re-opt-in), with qualified + booked tags. Mirror of the
  // appointment-setting dial list, read-only.
  { href: '/sales-dashboard/leads', label: 'Leads' },
  // People = per-rep views (Call Activity, per-closer scheduled, bookings,
  // cash) consolidated from the Appointment Setting + Closing pages, under
  // one date picker.
  { href: '/sales-dashboard/people', label: 'People' },
  { href: '/sales-dashboard/revenue', label: 'Revenue' },
  // Calls = setter/closer-setter call recordings transcribed via Deepgram,
  // rendered raw for V1 (AI review layer comes after golden-set selection).
  { href: '/sales-dashboard/calls', label: 'Calls' },
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

      {NAV.map((item) =>
        item.children && item.children.length > 0 ? (
          <SidebarGroup
            key={item.href}
            item={item}
            isActive={isActive}
            anyChildActive={item.children.some((c) => isActive(c.href))}
          />
        ) : (
          <SidebarLink
            key={item.href}
            href={item.href}
            label={item.label}
            active={isActive(item.href)}
            variant="overview"
          />
        ),
      )}
    </aside>
  )
}

// Parent row with chevron toggle + a collapsible list of children.
// Auto-expanded when the user is already on the parent or any child
// route; otherwise collapsed by default, toggled by clicking the
// chevron. The label itself stays a Link to the parent route.
function SidebarGroup({
  item,
  isActive,
  anyChildActive,
}: {
  item: NavItem
  isActive: (href: string) => boolean
  anyChildActive: boolean
}) {
  const parentActive = isActive(item.href)
  const autoOpen = parentActive || anyChildActive
  const [manuallyOpen, setManuallyOpen] = useState<boolean | null>(null)
  const open = manuallyOpen ?? autoOpen

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'stretch' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <SidebarLink
            href={item.href}
            label={item.label}
            active={parentActive}
            variant="overview"
          />
        </div>
        <button
          type="button"
          aria-expanded={open}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${item.label} sub-pages`}
          onClick={() => setManuallyOpen(!open)}
          style={{
            background: 'none',
            border: 'none',
            padding: '0 22px 0 8px',
            cursor: 'pointer',
            color: 'var(--color-geg-text-faint)',
            fontSize: 10,
            display: 'flex',
            alignItems: 'center',
            transition: 'transform 120ms ease, color 100ms ease',
            transform: open ? 'rotate(0deg)' : 'rotate(-90deg)',
          }}
        >
          ▾
        </button>
      </div>
      {open ? (
        <div style={{ paddingBottom: 4 }}>
          {item.children!.map((c) => (
            <SidebarLink
              key={c.href}
              href={c.href}
              label={c.label}
              active={isActive(c.href)}
              variant="child"
            />
          ))}
        </div>
      ) : null}
    </div>
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
