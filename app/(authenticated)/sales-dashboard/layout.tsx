import { redirect } from 'next/navigation'
import { getCurrentUserAccessTier, hasArea, tierAtLeast } from '@/lib/auth/access-tier'
import { homePathForAreas } from '@/lib/auth/access-tier-shared'
import { SalesSidebar } from './sidebar'

// Sales-AREA gate + two-column shell for /sales-dashboard/* (migration 0112).
// Was an admin-TIER gate — which meant sales reps (csm tier) couldn't see their
// own dashboard. Now gated on the 'sales' department instead, so any tier with
// the sales area gets in; non-sales users are sent to their own home.
// Preview-mode bypass passes through.
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
  const preview = process.env.NEXT_PUBLIC_DISABLE_AUTH === 'true'
  let isAdmin = true // preview defaults to creator → admin tools visible
  if (!preview) {
    const access = await getCurrentUserAccessTier()
    if (!access) {
      redirect('/login?error=no_team_member_row')
    }
    if (!hasArea(access.areas, 'sales')) {
      redirect(homePathForAreas(access.areas))
    }
    // Admin tools inside Sales (Verify Reps, Landing Pages) stay admin-tier —
    // sales reps (csm + sales area) see the data pages, not the admin tools.
    isAdmin = tierAtLeast(access.tier, 'admin')
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '240px 1fr',
        minHeight: 'calc(100vh - 64px)',
      }}
    >
      <SalesSidebar includeStatesLink={INCLUDE_STATES_LINK} isAdmin={isAdmin} />
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
          // CSS grid + 1fr: without min-width:0 the child column won't
          // shrink below its content's intrinsic min-content size,
          // which causes the whole page to overflow when a child block
          // has wide internal min-content (the funnel chevron stack
          // was the trigger).
          minWidth: 0,
        }}
      >
        {children}
      </div>
    </div>
  )
}
