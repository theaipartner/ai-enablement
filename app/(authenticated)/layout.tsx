import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { AuthenticatedShell } from '@/components/authenticated-shell'

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // TEMP: bypass auth on promethean-shell preview for Claude Design access.
  // Removed when Promethean V0 visual iteration is complete OR when this
  // branch is ready to merge to main (whichever comes first). The env var
  // is scoped in Vercel to Preview environment + promethean-shell branch
  // only — production and main-branch previews keep the auth gate.
  // See docs/known-issues.md § "Temporary work in progress" for the
  // removal procedure.
  if (process.env.PROMETHEAN_PUBLIC_PREVIEW === 'true') {
    return (
      <div className="min-h-screen">
        <AuthenticatedShell userEmail="">
          {children}
        </AuthenticatedShell>
      </div>
    )
  }

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
