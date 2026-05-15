import { redirect } from 'next/navigation'
import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'

// Admin-tier gate for /cost-hub. CSM + head_csm tiers redirect back to
// /clients with an error query param. Admin + creator see the page.
// Preview-mode bypass (NEXT_PUBLIC_DISABLE_AUTH=true) short-circuits
// to render — matches the Ella sub-layout precedent.
//
// Spec: docs/specs/cost-hub.md.
export default async function CostHubLayout({
  children,
}: {
  children: React.ReactNode
}) {
  if (process.env.NEXT_PUBLIC_DISABLE_AUTH === 'true') {
    return <>{children}</>
  }
  const access = await getCurrentUserAccessTier()
  if (!access || !tierAtLeast(access.tier, 'admin')) {
    redirect('/clients?error=insufficient_access')
  }
  return <>{children}</>
}
