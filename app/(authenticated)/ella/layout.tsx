import { redirect } from 'next/navigation'
import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'

// Admin-tier gate for /ella/runs and /ella/runs/[id]. CSM + head_csm
// tiers see a redirect back to /clients with an error query param.
// Creator + admin see Ella as before. Preview-mode bypass
// (NEXT_PUBLIC_DISABLE_AUTH=true) skips this gate via the parent
// (authenticated) layout that stubs the tier as 'creator'; this layout
// re-reads tier via getCurrentUserAccessTier(), and in preview mode
// there's no Supabase user so that returns null — fall through to the
// same preview-mode handling.
//
// Spec: docs/specs/permissions-access-tiers.md.
export default async function EllaLayout({
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
