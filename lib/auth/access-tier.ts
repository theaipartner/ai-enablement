import 'server-only'

import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tierAtLeast, type AccessTier } from '@/lib/auth/access-tier-shared'

// Server-only surface for the four-tier hierarchical access model.
// Pure type + `tierAtLeast` helper live in
// `lib/auth/access-tier-shared.ts` so Client Components (e.g. TopNav)
// can import them without dragging the server-only Supabase admin
// client into the browser bundle. Re-exported here so server-side
// callers can keep their existing single-import shape.

export type { AccessTier }
export { tierAtLeast }

export type CurrentUserAccess = {
  tier: AccessTier
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
export async function getCurrentUserAccessTier(): Promise<CurrentUserAccess | null> {
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
  const { data, error } = await admin
    .from('team_members')
    .select('id, full_name, email, access_tier')
    .ilike('email', user.email)
    .is('archived_at', null)
    .limit(1)
    .maybeSingle()
  if (error || !data) return null

  const tier = data.access_tier as string
  if (tier !== 'csm' && tier !== 'head_csm' && tier !== 'admin' && tier !== 'creator') {
    return null
  }

  return {
    tier,
    team_member: {
      id: data.id,
      full_name: data.full_name,
      email: data.email,
    },
  }
}
