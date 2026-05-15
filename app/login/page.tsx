import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { LoginForm } from './login-form'

// Error-code vocabulary surfaced via the ?error= query param. Kept tiny
// and explicit so the routes that redirect to /login know exactly which
// banner to expect. Unknown codes render no banner — they're silently
// dropped to avoid leaking internal state in the URL bar.
const ERROR_MESSAGES: Record<string, string> = {
  no_team_member_row:
    "Your account isn't linked to a team member record. Contact Drake to get set up.",
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  // Bounce already-authenticated users to /clients before rendering
  // the form, mirroring the middleware behavior the M2.3a spec asked
  // for. Server Component variant of the auth gate (the middleware
  // version was dropped due to Vercel Edge runtime incompatibility).
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (user) {
    redirect('/clients')
  }

  const errorRaw = Array.isArray(searchParams.error)
    ? searchParams.error[0]
    : searchParams.error
  const errorMessage = errorRaw ? ERROR_MESSAGES[errorRaw] ?? null : null

  return (
    <div
      data-theme="gregory-editorial"
      className="min-h-screen"
      style={{
        background: 'var(--color-geg-bg)',
        color: 'var(--color-geg-text)',
      }}
    >
      <LoginForm errorMessage={errorMessage} />
    </div>
  )
}
