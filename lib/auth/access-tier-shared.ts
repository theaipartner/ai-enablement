// Shared (server + client) access-tier types + pure helpers.
//
// The companion module `lib/auth/access-tier.ts` is marked
// `'server-only'` because it imports the service-role Supabase admin
// client. Client Components (e.g. `components/top-nav.tsx`) need the
// AccessTier type + `tierAtLeast` helper for conditional rendering but
// can't import the server-only module without breaking the build.
// Splitting the pure utilities here lets both sides reach for the same
// vocabulary.

export type AccessTier = 'csm' | 'head_csm' | 'admin' | 'creator'

// Ordered tier ranks. creator outranks admin outranks head_csm
// outranks csm. New tiers slot in here; migration 0032's CHECK
// constraint must move in lockstep.
const TIER_ORDER: Record<AccessTier, number> = {
  csm: 0,
  head_csm: 1,
  admin: 2,
  creator: 3,
}

export function tierAtLeast(actual: AccessTier, required: AccessTier): boolean {
  return TIER_ORDER[actual] >= TIER_ORDER[required]
}

// Department/area access — orthogonal to tier (migration 0112). Tier gates
// seniority WITHIN an area (admin → cost-hub/CEO, head_csm → /teams); areas gate
// WHICH departments a person sees. A person can hold one or both.
export type Area = 'fulfillment' | 'sales'

export function hasArea(areas: readonly string[] | null | undefined, area: Area): boolean {
  return !!areas && areas.includes(area)
}

// Where to send a user who lacks access to the page they hit — their own home.
// Sales-only people land on the sales dashboard; everyone else on fulfillment.
export function homePathForAreas(areas: readonly string[] | null | undefined): string {
  if (hasArea(areas, 'fulfillment')) return '/clients'
  if (hasArea(areas, 'sales')) return '/sales-dashboard'
  return '/login?error=no_area_access'
}
