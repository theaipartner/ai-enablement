import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AuthenticatedShell } from '@/components/authenticated-shell'

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Auth gate resolves BEFORE any child Server Component starts
  // rendering, so unauthenticated requests never trigger downstream
  // data fetches. Shell picks Gregory's TopNav or Promethean's dark
  // sidebar based on the active route — see AuthenticatedShell.
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <div className="min-h-screen">
      <AuthenticatedShell userEmail={user.email ?? ''}>
        {children}
      </AuthenticatedShell>
    </div>
  )
}
