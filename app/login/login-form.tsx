'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

export function LoginForm({ errorMessage = null }: { errorMessage?: string | null }) {
  const router = useRouter()
  const supabase = createClient()

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    setError(null)
    setSubmitting(true)
    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password,
    })
    if (signInError) {
      setError(signInError.message)
      setSubmitting(false)
      return
    }
    router.push('/clients')
    router.refresh()
  }

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-[420px]">
        {/* Wordmark + LIVE pulse */}
        <div className="flex items-center gap-2.5 mb-10">
          <span
            className="inline-block rounded-full geg-pulse"
            style={{
              width: 7,
              height: 7,
              background: 'var(--color-geg-accent)',
              boxShadow: '0 0 8px var(--color-geg-accent-dim)',
            }}
          />
          <span
            className="geg-eyebrow"
            style={{ color: 'var(--color-geg-text-2)' }}
          >
            GREGORY · LIVE
          </span>
        </div>

        <h1
          className="geg-display"
          style={{ fontSize: 64, lineHeight: '64px', marginBottom: 12 }}
        >
          Sign in.
        </h1>
        <p
          className="geg-deck"
          style={{ fontSize: 17, marginBottom: 36 }}
        >
          The CSM brain for The AI Partner.
        </p>

        {errorMessage ? (
          <div
            role="alert"
            className="text-sm"
            style={{
              background: 'var(--color-geg-warn-fill)',
              border: '1px solid var(--color-geg-warn-border)',
              borderRadius: 6,
              color: 'var(--color-geg-warn)',
              padding: '10px 14px',
              marginBottom: 16,
            }}
          >
            {errorMessage}
          </div>
        ) : null}

        <form
          onSubmit={onSubmit}
          className="space-y-5"
          style={{
            background: 'var(--color-geg-bg-elev)',
            border: '1px solid var(--color-geg-border-strong)',
            borderRadius: 8,
            padding: '28px 28px 24px',
          }}
        >
          <div className="space-y-2">
            <Label
              htmlFor="email"
              className="geg-eyebrow"
              style={{ color: 'var(--color-geg-text-3)' }}
            >
              EMAIL
            </Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              style={{
                background: 'var(--color-geg-bg)',
                color: 'var(--color-geg-text)',
                borderColor: 'var(--color-geg-border-strong)',
              }}
            />
          </div>

          <div className="space-y-2">
            <Label
              htmlFor="password"
              className="geg-eyebrow"
              style={{ color: 'var(--color-geg-text-3)' }}
            >
              PASSWORD
            </Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              style={{
                background: 'var(--color-geg-bg)',
                color: 'var(--color-geg-text)',
                borderColor: 'var(--color-geg-border-strong)',
              }}
            />
          </div>

          {error ? (
            <p
              className="text-sm"
              role="alert"
              style={{ color: 'var(--color-geg-neg)' }}
            >
              {error}
            </p>
          ) : null}

          <Button
            type="submit"
            className="w-full"
            disabled={submitting}
            style={{
              background: 'var(--color-geg-accent)',
              color: '#ffffff',
              borderColor: 'transparent',
              fontWeight: 500,
            }}
          >
            {submitting ? 'Signing in…' : 'Sign in'}
          </Button>
        </form>
      </div>
    </div>
  )
}
