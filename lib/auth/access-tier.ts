import 'server-only'

import { cache } from 'react'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tierAtLeast, hasArea, type AccessTier, type Area } from '@/lib/auth/access-tier-shared'

// Server-only surface for the four-tier hierarchical access model.
// Pure type + `tierAtLeast` helper live in
// `lib/auth/access-tier-shared.ts` so Client Components (e.g. TopNav)
// can import them without dragging the server-only Supabase admin
// client into the browser bundle. Re-exported here so server-side
// callers can keep their existing single-import shape.

export type { AccessTier, Area }
export { tierAtLeast, hasArea }

export type CurrentUserAccess = {
  tier: AccessTier
  // Departments this user can access (migration 0112) — orthogonal to tier.
  areas: Area[]
  team_member: {
    id: string
    full_name: string
    email: string
  }
}

// Resolve the current Supabase user's access tier from team_members.
// Returns null when:
//   - no authenticated user is present (caller already redirected to
//     /login at the layout level, but defending here too keeps the
//     contract clean)
//   - no team_members row matches the user's email
//   - the matching row is archived
//   - the access_tier value isn't one of the four enum values
//     (shouldn't happen — DB CHECK constraint prevents it — but the
//     narrow-and-validate path keeps the type honest)
//
// Layout callers map null → redirect to /login?error=no_team_member_row.
// Production rollout assumes every operator has a matching row; ghost
// users are setup errors and should be surfaced loudly.
//
// Wrapped in React `cache()` so the per-request result is memoized:
// the authenticated layout chain is nested (e.g. (authenticated) →
// (ceo) → cost-hub), and each layout independently calls this. Without
// memoization that's 2–3 serial `auth.getUser()` round-trips + as many
// `team_members` queries before a page even starts rendering. `cache()`
// dedupes them to a single lookup per request (it does NOT persist
// across requests, so auth freshness is unchanged).
export const getCurrentUserAccessTier = cache(async function getCurrentUserAccessTier(): Promise<CurrentUserAccess | null> {
  const supabase = createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user || !user.email) return null

  const admin = createAdminClient()
  // Service-role read of team_members. Email is the auth-side identity;
  // team_members.email is partial-unique among non-archived rows per
  // migration 0007. ilike for case-insensitivity (Supabase Auth lowercases
  // emails on storage but client-side capitalization is possible on entry).
  // `as never` on the table: the generated Database types don't include the
  // `areas` column (migration 0112) until types.ts is regenerated; cast the row.
  const { data: rawData, error } = await admin
    .from('team_members' as never)
    .select('id, full_name, email, access_tier, areas')
    .ilike('email', user.email)
    .is('archived_at', null)
    .limit(1)
    .maybeSingle()
  if (error || !rawData) return null
  const data = rawData as {
    id: string
    full_name: string
    email: string
    access_tier: string
    areas: string[] | null
  }

  const tier = data.access_tier as string
  if (tier !== 'csm' && tier !== 'head_csm' && tier !== 'admin' && tier !== 'creator') {
    return null
  }

  // Narrow areas to the known values; default to fulfillment if the column is
  // null/empty (defensive — the migration backfills everyone non-null).
  const rawAreas = (data.areas as string[] | null) ?? []
  const areas = rawAreas.filter((a): a is Area => a === 'fulfillment' || a === 'sales')

  return {
    tier,
    areas: areas.length ? areas : ['fulfillment'],
    team_member: {
      id: data.id,
      full_name: data.full_name,
      email: data.email,
    },
  }
})
