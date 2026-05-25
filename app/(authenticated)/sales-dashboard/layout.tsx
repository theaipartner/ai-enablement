import { redirect } from 'next/navigation'
import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'
import { SalesSidebar } from './sidebar'

// Admin-tier gate + two-column shell for /sales-dashboard/*.
// Mirrors the cost-hub auth pattern (csm/head_csm tiers redirect; admin
// + creator pass through). Preview-mode bypass passes through.
//
// v2 adds a sales-only left sidebar at 240px + flexible main. The
// sidebar lives ONLY under this segment layout — the global TopNav
// (in app/(authenticated)/layout.tsx) is untouched, and other pages
// (/clients, /calls, /cost-hub, etc.) see no sidebar.
//
// The States reference link surfaces in the sidebar only when the
// states route exists. Toggled via the includeStatesLink prop so the
// sidebar component stays decoupled from route discovery.
//
// Spec: docs/specs/sales-dashboard-v2.md § Sidebar.
const INCLUDE_STATES_LINK = true

export default async function SalesDashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  if (process.env.NEXT_PUBLIC_DISABLE_AUTH !== 'true') {
    const access = await getCurrentUserAccessTier()
    if (!access || !tierAtLeast(access.tier, 'admin')) {
      redirect('/clients?error=insufficient_access')
    }
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '240px 1fr',
        minHeight: 'calc(100vh - 64px)',
      }}
    >
      <SalesSidebar includeStatesLink={INCLUDE_STATES_LINK} />
      {/* `<div>` not `<main>` — the parent (authenticated)/layout.tsx
          already wraps every authenticated route in a `<main>` for
          a11y. Nesting another `<main>` here would violate the
          one-main-per-document landmark rule and trip Playwright's
          strict-mode role queries. */}
      <div
        style={{
          padding: '36px 56px 96px',
          maxWidth: 1480,
          width: '100%',
        }}
      >
        {children}
      </div>
    </div>
  )
}
