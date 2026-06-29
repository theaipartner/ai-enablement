import { redirect } from 'next/navigation'
import { getCurrentUserAccessTier, hasArea } from '@/lib/auth/access-tier'
import { homePathForAreas } from '@/lib/auth/access-tier-shared'
import { FulfillmentSidebar } from './sidebar'

// Two-column shell for the Fulfillment section. Wraps /clients, /calls,
// /teams (Meeting Tracker), and /dashboard. Mirrors the
// /sales-dashboard segment layout: 240px sticky sidebar + flexible main
// column. The global TopNav (in app/(authenticated)/layout.tsx) is
// untouched.
//
// Access tier: csm-and-up (i.e., any authenticated team member). The
// sidebar itself hides Meeting Tracker for sub-head_csm users, and the
// /teams/layout.tsx child layout still enforces its head_csm gate.

export default async function FulfillmentLayout({
  children,
}: {
  children: React.ReactNode
}) {
  if (process.env.NEXT_PUBLIC_DISABLE_AUTH === 'true') {
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '240px 1fr',
          minHeight: 'calc(100vh - 64px)',
        }}
      >
        <FulfillmentSidebar accessTier="creator" />
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
    )
  }

  const access = await getCurrentUserAccessTier()
  if (!access) {
    redirect('/login?error=no_team_member_row')
  }
  // Department gate (migration 0112): fulfillment area required. A sales-only
  // rep is sent to their own home (the sales dashboard) instead of seeing CSM data.
  if (!hasArea(access.areas, 'fulfillment')) {
    redirect(homePathForAreas(access.areas))
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '240px 1fr',
        minHeight: 'calc(100vh - 64px)',
      }}
    >
      <FulfillmentSidebar accessTier={access.tier} />
      {/* `<div>` not `<main>` — the parent (authenticated)/layout.tsx
          already wraps every authenticated route in a `<main>`. */}
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  )
}
