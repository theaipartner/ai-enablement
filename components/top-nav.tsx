'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'

export function TopNav({ userEmail }: { userEmail: string }) {
  const router = useRouter()
  const supabase = createClient()

  async function onLogout() {
    await supabase.auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <nav className="flex items-center justify-between border-b px-6 py-3">
      <div className="flex items-center gap-6">
        <Link
          href="/clients"
          className="text-sm font-medium hover:underline underline-offset-4"
        >
          Clients
        </Link>
        <Link
          href="/calls"
          className="text-sm font-medium hover:underline underline-offset-4"
        >
          Calls
        </Link>
        <Link
          href="/ella/runs"
          className="text-sm font-medium hover:underline underline-offset-4"
        >
          Ella
        </Link>
      </div>
      <div className="flex items-center gap-3">
        <span className="text-sm text-muted-foreground">{userEmail}</span>
        <Button variant="outline" size="sm" onClick={onLogout}>
          Logout
        </Button>
      </div>
    </nav>
  )
}
