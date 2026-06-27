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
// How long dashboard reads stay cached (Next Data Cache TTL). Short enough that
// staleness is invisible on a sales dashboard, long enough to restore the speed
// the cache gave us. Bounded TTL = self-healing, so stale data can't persist.
const ADMIN_READ_TTL_SEC = 60

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
      global: {
        // BOUNDED, self-healing cache for dashboard reads. Next.js wraps the
        // runtime `fetch` with its Data Cache; supabase-js calls aren't reliably
        // opted out by a page's `export const dynamic = 'force-dynamic'`. The
        // original failure mode wasn't caching itself — it was that the default
        // cache never expired (it PERSISTS ACROSS DEPLOYMENTS), so the dashboard
        // froze on stale data (Outbound stuck at 24k revival, HT funnel frozen
        // at an old date). We pin an explicit short TTL instead: every read is
        // cached for `revalidate` seconds, so repeated loads are fast, but data
        // is never more than that stale and the cache SELF-HEALS — the
        // "frozen forever" failure can't recur. Strip any caller `cache` option
        // first (Next forbids `cache` + `next.revalidate` together).
        fetch: (input, init) => {
          const { cache: _ignored, ...rest } = (init ?? {}) as RequestInit
          return fetch(input, { ...rest, next: { revalidate: ADMIN_READ_TTL_SEC } })
        },
      },
    },
  )
}
