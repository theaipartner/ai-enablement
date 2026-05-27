import { redirect } from 'next/navigation'
import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'
import { CeoSidebar } from './sidebar'

// Two-column shell for the CEO section. Wraps /cost-hub (and future
// CEO surfaces). Admin-and-up gate (the only thing inside today is
// admin-only). Mirrors the (fulfillment) layout pattern.

export default async function CeoLayout({
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
        <CeoSidebar accessTier="creator" />
        <div style={{ minWidth: 0 }}>{children}</div>
      </div>
    )
  }

  const access = await getCurrentUserAccessTier()
  if (!access || !tierAtLeast(access.tier, 'admin')) {
    redirect('/clients?error=insufficient_access')
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '240px 1fr',
        minHeight: 'calc(100vh - 64px)',
      }}
    >
      <CeoSidebar accessTier={access.tier} />
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  )
}
