import 'server-only'

import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { Database } from './types'

// Service-role client for server-side data reads/writes from the
// dashboard. Bypasses Row-Level Security — required because Gregory V1
// ships with RLS enabled but no policies on data tables, which makes
// every anon-key query return an empty result set (deny-default). See
// docs/archive/historical/known-issues.md § "RLS revisit trigger for Gregory dashboard" for
// the V2 plan that re-enables per-CSM scoping.
//
// Hard rules:
// - This module imports 'server-only' so a Client Component import
//   throws at build time. The service-role key must never reach the
//   browser.
// - Lives at lib/supabase/admin.ts (not lib/supabase/server.ts). The
//   per-request auth-gate client in server.ts uses the anon key + the
//   user's session cookies, and is correct as-is for verifying who
//   the request belongs to. This client is for everything *after*
//   that check — pulling rows, writing updates, calling RPCs.
// - No cookies wired up: this client isn't session-aware. Auth
//   identity is enforced one layer up (the (authenticated) route
//   group's layout calls getUser() and redirects unauthenticated
//   users before any data layer call runs).
export function createAdminClient() {
  return createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    {
      auth: {
        // Don't persist session, don't auto-refresh — there's no user
        // session here to manage. This is a pure data-access client.
        persistSession: false,
        autoRefreshToken: false,
      },
    },
  )
}
