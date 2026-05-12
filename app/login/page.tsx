import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { LoginForm } from './login-form'

export default async function LoginPage() {
  // Bounce already-authenticated users to /clients before rendering
  // the form, mirroring the middleware behavior the M2.3a spec asked
  // for. Server Component variant of the auth gate (the middleware
  // version was dropped due to Vercel Edge runtime incompatibility).
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (user) {
    redirect('/clients')
  }

  return (
    <div
      data-theme="gregory-editorial"
      className="min-h-screen"
      style={{
        background: 'var(--color-geg-bg)',
        color: 'var(--color-geg-text)',
      }}
    >
      <LoginForm />
    </div>
  )
}
