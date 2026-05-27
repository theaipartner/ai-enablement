import { redirect } from 'next/navigation'
import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'
import { ContentSidebar } from './sidebar'

// Two-column shell for the Content section. Admin-and-up gate;
// mirrors the (ceo) and (fulfillment) layout patterns.

export default async function ContentLayout({
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
        <ContentSidebar accessTier="creator" />
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
      <ContentSidebar accessTier={access.tier} />
      <div style={{ minWidth: 0 }}>{children}</div>
    </div>
  )
}
