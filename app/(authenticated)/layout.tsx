import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { TopNav } from '@/components/top-nav'

export default async function AuthenticatedLayout({
  children,
}: {
  children: React.ReactNode
}) {
  // Temporary env-gated bypass for preview visual verification.
  // When NEXT_PUBLIC_DISABLE_AUTH === 'true' (set in Vercel preview
  // env), skip the Supabase auth check and render with a stub user so
  // the layout still mounts. Off by default — any other value (or
  // missing env var) falls through to the real auth check unchanged.
  if (process.env.NEXT_PUBLIC_DISABLE_AUTH === 'true') {
    return (
      <div
        className="min-h-screen"
        data-theme="gregory-editorial"
        style={{
          background: 'var(--color-geg-bg)',
          color: 'var(--color-geg-text)',
        }}
      >
        <TopNav userEmail="preview@disabled" />
        <main>{children}</main>
      </div>
    )
  }

  // Auth gate: this resolves BEFORE any child Server Component starts
  // rendering, so unauthenticated requests never trigger downstream
  // data fetches. Replaces the middleware-based gate dropped in M2.3a
  // because Vercel's Edge runtime can't bundle @supabase/ssr's
  // transitive deps (`__dirname` Node-only reference).
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    redirect('/login')
  }

  return (
    <div
      className="min-h-screen"
      data-theme="gregory-editorial"
      style={{
        background: 'var(--color-geg-bg)',
        color: 'var(--color-geg-text)',
      }}
    >
      <TopNav userEmail={user.email ?? ''} />
      <main>{children}</main>
    </div>
  )
}
