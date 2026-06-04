import { redirect } from 'next/navigation'
import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'

// Head-CSM-and-up gate for the Fulfillment Dashboard (stats + notifications).
// "CSM team lead" maps to the head_csm tier. Mirrors the Teams Meeting
// Tracker gate (app/(authenticated)/(fulfillment)/teams/layout.tsx).
// Plain CSMs (Lou / Nico / Zain) get a redirect to /clients with an error
// query param. Creator + admin + head_csm see the dashboard.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  if (process.env.NEXT_PUBLIC_DISABLE_AUTH === 'true') {
    return <>{children}</>
  }
  const access = await getCurrentUserAccessTier()
  if (!access || !tierAtLeast(access.tier, 'head_csm')) {
    redirect('/clients?error=insufficient_access')
  }
  return <>{children}</>
}
