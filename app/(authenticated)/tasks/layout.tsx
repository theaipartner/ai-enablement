import { redirect } from 'next/navigation'
import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'

// Creator-tier gate for /tasks. V1 surface is single-user (Drake's
// personal task list); other tiers redirect to /clients with the
// shared insufficient-access error param. Mirrors the Ella sub-layout
// pattern. Preview-bypass branch preserves Playwright access.
//
// Spec: docs/specs/director-tasks-and-list-ux-polish.md.
export default async function TasksLayout({
  children,
}: {
  children: React.ReactNode
}) {
  if (process.env.NEXT_PUBLIC_DISABLE_AUTH === 'true') {
    return <>{children}</>
  }
  const access = await getCurrentUserAccessTier()
  if (!access || access.tier !== 'creator') {
    redirect('/clients?error=insufficient_access')
  }
  return <>{children}</>
}
