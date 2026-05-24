import { redirect } from 'next/navigation'
import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'

// Admin-tier gate for /sales-dashboard. Mirrors the cost-hub layout:
// csm + head_csm tiers redirect to /clients with an error query param;
// admin + creator see the page. Preview-mode bypass passes through.
//
// Spec: docs/specs/sales-dashboard-v1.md.
export default async function SalesDashboardLayout({
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
