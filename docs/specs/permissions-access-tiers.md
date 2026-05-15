# Permissions infrastructure: access tiers + route gating + Ella move to Admin

**Slug:** permissions-access-tiers
**Status:** in-flight

## Context

Today every authenticated user sees every page in `app/(authenticated)/`. Drake (Creator), Nabeel (Admin), Scott (Head CSM), Lou / Nico / Zain (CSM) all share the same view. The Ella audit pages at `/ella/runs` and `/ella/runs/[id]` are visible to everyone with a login, which is a real privacy concern — CSMs can read every escalation, including ones on clients they don't own.

This spec builds the permissions primitive every future role-gated surface depends on. Four hierarchical access tiers, hardcoded role mapping on apply, server-side route gating, Ella moved to Admin tier. Two upcoming specs (Meeting Tracker for Head CSM, Task Tracker for Creator) reuse this primitive.

## Pre-flight: design-system alignment check

**This is a hard stop.** Before any code or migration work begins, Builder verifies that the current production site matches the `gregory-editorial` theme described in `components/gregory/` and the existing layout files. Drake recently redesigned and isn't sure the docs are up to date.

Step 1 — Read these files and confirm they match the live production design:

- `app/(authenticated)/layout.tsx` (data-theme="gregory-editorial" wrapper)
- `components/gregory/header-band.tsx`
- `components/gregory/geg-pill.tsx`
- `components/gregory/sentiment-pill.tsx`
- `components/gregory/inline-editable-field.tsx`
- `components/gregory/empty-state-aware-section.tsx`
- `components/gregory/diagnostics-collapse.tsx`
- `app/globals.css` (the `[data-theme="gregory-editorial"]` block + the `--color-geg-*` and `--font-geg-*` tokens)
- `components/top-nav.tsx`
- `docs/runbooks/design-handoff.md` if it exists

Step 2 — Spot-check one page from each of the four existing surface types against the primitives above by reading the file:

- A list page: `app/(authenticated)/clients/page.tsx` and its `clients-table.tsx`
- A detail page: `app/(authenticated)/clients/[id]/page.tsx`
- A simpler list: `app/(authenticated)/ella/runs/page.tsx`
- An auth-adjacent page: `app/login/page.tsx`

Step 3 — Confirm in 4-6 bullets in chat (BEFORE writing any code):

- Are the `--color-geg-*` tokens (gold accent, sentiment palette) still the canonical color set?
- Is `--font-geg-serif` (Newsreader) + `--font-geg-mono` (JetBrains Mono) still the typography pairing?
- Is `HeaderBand` still the page-header primitive used across Calls / Clients / Ella, or has it been superseded?
- Are the primitives in `components/gregory/` still the right reach-for set for new pages?
- Is the TopNav still the navigation surface, with editorial-dark theme + gold accent?
- Anything inconsistent or outdated that needs fixing before new pages can match cleanly?

**If everything matches: continue with the spec below.**

**If anything is out of date: HARD STOP. Surface the discrepancy to Drake. He will write a small fix-up spec to bring the design system docs / primitives back into alignment, Builder executes that, then this spec resumes.** Don't make new design decisions; don't build new pages on a stale primitive.

The reason for this gate: this spec is the first of three (Permissions → Meeting Tracker → Task Tracker), and all three lean on the existing primitives matching what's in production. If the docs and code have drifted from the live design, every downstream page will inherit the drift.

## Files Builder reads first (acclimatization)

After the design-system check above completes successfully, read these:

1. `app/(authenticated)/layout.tsx` — the current auth gate. Note: `NEXT_PUBLIC_DISABLE_AUTH=true` Preview-bypass branch is preserved; the new permission gate slots in AFTER the existing Supabase auth check.
2. `lib/supabase/server.ts` and `lib/supabase/admin.ts` — Supabase client patterns. The permission lookup uses the admin client (service-role) because we're reading `team_members` server-side at layout-mount time.
3. `docs/schema/team_members.md` — confirm the existing `role` column is free-text job-function (csm / leadership / engineering / ops / sales / system_bot). The new `access_tier` column is separate; this spec does NOT touch `role`.
4. `app/(authenticated)/ella/runs/page.tsx` and `app/(authenticated)/ella/runs/[id]/page.tsx` — the two routes being moved to Admin-tier.
5. `components/top-nav.tsx` — nav items rendered per page. The Ella link needs to render conditionally based on access tier.

## Decisions baked in (do NOT re-litigate)

- **Column name: `team_members.access_tier`.** Separate from the existing `role` column. CHECK constraint pinning the four values: `'csm'`, `'head_csm'`, `'admin'`, `'creator'`. Default `'csm'` for any new row.
- **Hierarchical access.** Tiers are an ordered list, not arbitrary roles. `creator > admin > head_csm > csm`. Helper function returns true if the user's tier is at-or-above the required tier.
- **Backfill on apply.** Migration hardcodes the four-tier mapping for the 6 known users by email or full_name:
  - `creator`: Drake (drake.ag.eoll@gmail.com — confirm exact email)
  - `admin`: Nabeel Junaid
  - `head_csm`: Scott Wilson
  - `csm`: Lou Perez, Nico Sandoval, Zain
  All other `team_members` rows stay at the `'csm'` default. The `Gregory Bot` and `Scott Chasing` sentinels are excluded (they're not users — `metadata.sentinel = true`).
- **No matching team_members row → reject.** When a user logs in via Supabase Auth, the layout looks up `team_members.email == user.email`. No row → redirect back to login with an error query param. Ghost users are setup errors, surfaced loudly.
- **The `access_tier` lookup runs server-side at layout time.** Every page load in `(authenticated)/` resolves the user's tier before rendering. Don't cache per-request; the layout already runs server-side. Per-session caching can come later if it matters.
- **Route gating via the `(authenticated)/` layout for whole-route gating; conditional rendering for in-page elements.** Ella routes get moved to a sub-layout (`(authenticated)/ella/layout.tsx`) that checks for `admin` or higher. TopNav uses a conditional render for the Ella link based on the same tier check.
- **No UI for managing access_tier in V1.** Changes happen via SQL or future migration. The Settings page that would let Drake change someone's tier is out of scope; would be a separate spec when needed.
- **Visual style: existing primitives, gregory-editorial theme.** Any UI added in this spec (error message on the rejected-user redirect, the "you don't have access" page if relevant) uses `HeaderBand`, the `--color-geg-*` tokens, and the editorial dark theme. No new visual patterns.

## Implementation plan

### 1. Migration: `0032_team_members_access_tier.sql`

```sql
-- Add access_tier column with CHECK constraint
ALTER TABLE team_members
  ADD COLUMN access_tier text NOT NULL DEFAULT 'csm';

ALTER TABLE team_members
  ADD CONSTRAINT team_members_access_tier_check
  CHECK (access_tier IN ('csm', 'head_csm', 'admin', 'creator'));

-- Backfill the 6 known users. Use email lookups where possible
-- (more stable than full_name), full_name as fallback.
UPDATE team_members SET access_tier = 'creator'
  WHERE email = 'drake.ag.eoll@gmail.com';  -- confirm with Drake

UPDATE team_members SET access_tier = 'admin'
  WHERE full_name = 'Nabeel Junaid';

UPDATE team_members SET access_tier = 'head_csm'
  WHERE full_name = 'Scott Wilson';

UPDATE team_members SET access_tier = 'csm'
  WHERE full_name IN ('Lou Perez', 'Nico Sandoval', 'Zain');
```

**Verify post-apply (Builder runs both):**

```sql
-- Schema reality
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_name = 'team_members' AND column_name = 'access_tier';

-- Ledger registration
SELECT name, executed_at FROM supabase_migrations.schema_migrations
WHERE name LIKE '%access_tier%' ORDER BY executed_at DESC LIMIT 1;

-- Backfill correctness — should return 6 rows
SELECT full_name, email, access_tier FROM team_members
WHERE access_tier != 'csm'
   OR full_name IN ('Lou Perez', 'Nico Sandoval', 'Zain')
ORDER BY access_tier DESC, full_name;
```

**Hard stop before apply:** Builder reads the migration to Drake in chat for SQL review. Standard migration gate (a).

### 2. Schema doc update: `docs/schema/team_members.md`

Add `access_tier` to the columns table. Add a section "Access tiers" describing the four-value hierarchy and what each tier sees. Reference this spec.

### 3. New TypeScript primitive: `lib/auth/access-tier.ts` (new file)

```typescript
export type AccessTier = 'csm' | 'head_csm' | 'admin' | 'creator'

const TIER_ORDER: Record<AccessTier, number> = {
  csm: 0,
  head_csm: 1,
  admin: 2,
  creator: 3,
}

export function tierAtLeast(actual: AccessTier, required: AccessTier): boolean {
  return TIER_ORDER[actual] >= TIER_ORDER[required]
}

export async function getCurrentUserAccessTier(): Promise<{
  tier: AccessTier
  team_member: { id: string; full_name: string; email: string }
} | null> {
  // Read current Supabase user, look up team_members by email,
  // return access_tier + identity. Returns null if no team_members
  // row matches — layout caller redirects to login.
  // Uses createAdminClient() server-side.
}
```

### 4. `app/(authenticated)/layout.tsx` — slot in the tier lookup

After the existing Supabase auth check + before the page renders:

```typescript
const accessInfo = await getCurrentUserAccessTier()
if (!accessInfo) {
  redirect('/login?error=no_team_member_row')
}
```

Pass `accessInfo.tier` down via a Context or a Server Component prop chain so child layouts can read it without re-fetching. Cleanest: a `<AccessTierProvider tier={accessInfo.tier}>` React Context that wraps `{children}`, paired with a `useAccessTier()` hook for client components and a `getAccessTierFromContext()` for server components. Builder picks the cleanest pattern given Next.js 14's App Router conventions.

### 5. `app/(authenticated)/ella/layout.tsx` (new file) — gate Ella routes

```typescript
import { redirect } from 'next/navigation'
import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'

export default async function EllaLayout({ children }: { children: React.ReactNode }) {
  const accessInfo = await getCurrentUserAccessTier()
  if (!accessInfo || !tierAtLeast(accessInfo.tier, 'admin')) {
    redirect('/clients?error=insufficient_access')
  }
  return <>{children}</>
}
```

CSM and Head CSM accessing `/ella/runs` get redirected to `/clients` (the default landing) with an error query param. The redirect happens server-side before any Ella data loads.

### 6. `components/top-nav.tsx` — conditional Ella link

Read the access tier (via context or by passing as a prop from the layout above) and render the "Ella" nav item only when `tierAtLeast(tier, 'admin')`. Use the existing nav styling — no visual changes, just conditional rendering of the link.

### 7. `app/login/page.tsx` — handle the error query param

When `?error=no_team_member_row` is present, render an error band above the login form: "Your account isn't linked to a team member record. Contact Drake to get set up." Use the existing editorial form chrome — small `<div>` with `--color-geg-warn` background or similar, fitting the theme.

When `?error=insufficient_access` is present (though this case redirects to `/clients`, not login — so this is just for completeness if any other route uses this pattern), render: "You don't have access to that page."

### 8. Tests

- `tests/lib/auth/test-access-tier.ts` (new file, if test infrastructure for TS exists; else skip Builder tests and test manually):
  - `tierAtLeast('creator', 'csm')` → true
  - `tierAtLeast('csm', 'admin')` → false
  - `tierAtLeast('admin', 'admin')` → true
  - `getCurrentUserAccessTier()` returns expected shape for a logged-in user with a `team_members` row
  - `getCurrentUserAccessTier()` returns null when no `team_members` row matches

If the TS test infrastructure doesn't easily cover Server Component scenarios, Builder confirms via Playwright on the deploy preview that the gating actually fires (logged-in CSM → `/ella/runs` redirects to `/clients`).

### 9. Doc updates

- `docs/schema/team_members.md` — `access_tier` column added (per § 2 above).
- `docs/state.md` — new entry describing the permissions infrastructure, what's gated where, the 4-tier hierarchy.
- `docs/agents/ella/ella.md` — note that `/ella/runs` is now Admin-tier gated.

## What success looks like

1. **Migration applied + dual-verified.** Schema shows the column; ledger has the entry; 6 users backfilled.
2. **Drake (creator) logs in → sees all routes.** Clients, Calls, Ella all visible in TopNav, all clickable.
3. **Nabeel (admin) logs in → sees all routes.** Same as Drake for V1.
4. **Scott (head_csm) logs in → sees Clients + Calls.** Ella nav link hidden; manually navigating to `/ella/runs` redirects to `/clients` with error param.
5. **Lou / Nico / Zain (csm) logs in → sees Clients + Calls.** Same gating as Scott.
6. **A logged-in user with no `team_members` row → redirected to login with error banner.**
7. **Preview-mode bypass (`NEXT_PUBLIC_DISABLE_AUTH=true`) still works** — the bypass branch in the layout falls through without the tier check, mounting the stub user. Builder confirms by setting the env var on a Preview deployment and visiting all routes.

## Hard stops

- **Pre-flight design-system check (top of spec).** Builder does NOT touch any UI code until the design-system alignment check is complete. If primitives or theme tokens have drifted, surface and stop.
- **SQL review before migration apply.** Standard gate (a). Builder reads the migration to Drake in chat first.
- **Don't touch the existing `role` column on `team_members`.** It's free-text job function, used by other parts of the system. The new `access_tier` is separate.
- **Don't add a UI for managing tiers in V1.** Out of scope. SQL-only management for now.
- **Don't move any routes other than Ella in this spec.** Calls, Clients stay open to all authenticated users (csm tier and up). Meeting Tracker and Task Tracker move into their tier-gated layouts in their own specs.
- **Don't break the existing `NEXT_PUBLIC_DISABLE_AUTH=true` Preview bypass.** Visual verification harnesses depend on it.

## What could go wrong

- **Drake's email in `team_members` doesn't match what the backfill expects.** Mitigation: Builder confirms Drake's actual email in `team_members` via a SELECT before writing the UPDATE, adjusts the literal accordingly.
- **A user's email in Supabase Auth differs from their `team_members.email` (Google login vs work email).** Mitigation: surfaces as "no_team_member_row" error on login, Drake fixes by updating either side. Worth documenting in the schema doc.
- **The TopNav conditional render flickers on first paint.** If access tier is read server-side and passed down, no flicker. If it's read client-side via a hook, there may be a moment where Ella is visible before being hidden. Use the server-side path.
- **Existing test suites break because routes that were public-to-auth are now gated.** Mitigation: tests that hit Ella routes need to mock a user with `admin` or `creator` tier. Builder updates accordingly.

## Mandatory doc-update list

- `supabase/migrations/0032_team_members_access_tier.sql` — new migration.
- `docs/schema/team_members.md` — `access_tier` column added, "Access tiers" section added.
- `docs/state.md` — new entry.
- `docs/agents/ella/ella.md` — note the new gating.
- New: `lib/auth/access-tier.ts`.
- New: `app/(authenticated)/ella/layout.tsx`.
- Modified: `app/(authenticated)/layout.tsx`, `components/top-nav.tsx`, `app/login/page.tsx`.

## Commit shape

One migration commit ("feat: add access_tier column + backfill"), one feature commit ("feat: tier-gated routing, Ella moved to admin"), one docs commit, one report commit. Push at end.
