import { redirect } from 'next/navigation'
import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'

// Head-CSM-and-up gate for the Teams Meeting Tracker. Mirrors the
// Ella sub-layout pattern (app/(authenticated)/ella/layout.tsx).
// CSMs (Lou / Nico / Zain) get a redirect to /clients with an error
// query param. Creator + admin + head_csm see the full surface.
//
// Spec: docs/specs/teams-meeting-tracker.md § 5.
export default async function TeamsLayout({
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
