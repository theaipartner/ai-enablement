'use client'

import { usePathname } from 'next/navigation'
import { TopNav } from '@/components/top-nav'
import { PrometheanShell } from '@/components/promethean/shell'

export function AuthenticatedShell({
  userEmail,
  children,
}: {
  userEmail: string
  children: React.ReactNode
}) {
  const pathname = usePathname() ?? ''
  if (pathname.startsWith('/promethean')) {
    return <PrometheanShell userEmail={userEmail}>{children}</PrometheanShell>
  }
  return (
    <>
      <TopNav userEmail={userEmail} />
      <main>{children}</main>
    </>
  )
}
