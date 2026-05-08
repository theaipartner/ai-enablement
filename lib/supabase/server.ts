import { createServerClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { Database } from './types'

export function createClient() {
  const cookieStore = cookies()

  return createServerClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options),
            )
          } catch {
            // Server Components may not set cookies. Safe to ignore:
            // the auth gate in app/(authenticated)/layout.tsx calls
            // getUser() on every render, which does its own session
            // freshness check. (Middleware was dropped in M2.3a due to
            // Vercel Edge incompat — see known-issues.md.)
          }
        },
      },
    },
  )
}
