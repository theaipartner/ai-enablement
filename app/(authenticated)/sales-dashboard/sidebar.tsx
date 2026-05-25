'use client'

// Sales Dashboard v2 — sales-only left sidebar.
//
// Renders inside the `/sales-dashboard/*` segment layout only (not in
// the global app shell). Client component because it consumes
// usePathname() for active-state highlighting; the rest of the page
// tree stays server-rendered.
//
// Spec: docs/specs/sales-dashboard-v2.md § Sidebar.

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import {
  METRICS,
  SECTION_ORDER,
  SECTION_SIDEBAR_LABEL,
  SLUG_BY_SECTION,
} from '@/lib/db/sales-dashboard-shared'

const TOPNAV_HEIGHT = 64

export function SalesSidebar({ includeStatesLink }: { includeStatesLink: boolean }) {
  const pathname = usePathname() ?? ''

  // Per-section counts derive from METRICS — never hardcode the mock's
  // 7/16/21/47/30/8/9/6/4. The instant a catalog row lands, the
  // sidebar tracks.
  const countBySection: Record<string, number> = {}
  for (const m of METRICS) {
    countBySection[m.section] = (countBySection[m.section] ?? 0) + 1
  }

  const isOverviewActive = pathname === '/sales-dashboard'
  const isStatesActive = pathname === '/sales-dashboard/states'

  function isSectionActive(slug: string): boolean {
    return pathname === `/sales-dashboard/${slug}`
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
      {/* Brand block */}
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

      {/* Overview */}
      <SidebarLink
        href="/sales-dashboard"
        label="Overview"
        active={isOverviewActive}
        variant="overview"
      />

      <GroupLabel>9 Engine sections</GroupLabel>

      {SECTION_ORDER.map((section) => {
        const slug = SLUG_BY_SECTION[section]
        return (
          <SidebarLink
            key={section}
            href={`/sales-dashboard/${slug}`}
            label={SECTION_SIDEBAR_LABEL[section]}
            count={countBySection[section]}
            active={isSectionActive(slug)}
            variant="section"
          />
        )
      })}

      {includeStatesLink ? (
        <>
          <GroupLabel>Reference</GroupLabel>
          <SidebarLink
            href="/sales-dashboard/states"
            label="Three states"
            active={isStatesActive}
            variant="section"
          />
        </>
      ) : null}
    </aside>
  )
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="geg-mono"
      style={{
        padding: '18px 24px 8px',
        fontSize: 9.5,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-faint)',
      }}
    >
      {children}
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
  variant: 'overview' | 'section'
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
  const merged = variant === 'overview' ? { ...baseStyles, ...overviewStyles } : baseStyles

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
