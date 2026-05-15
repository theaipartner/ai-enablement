# Report: Permissions infrastructure — access tiers + route gating + Ella move to Admin

**Slug:** permissions-access-tiers
**Spec:** docs/specs/permissions-access-tiers.md

## Files touched

**Created**
- `supabase/migrations/0032_team_members_access_tier.sql` — new column `team_members.access_tier text NOT NULL DEFAULT 'csm'` + CHECK constraint pinning `('csm', 'head_csm', 'admin', 'creator')` + backfill of 6 known users (Drake → creator via email match on `drake@theaipartner.io`; Nabeel Junaid → admin; Scott Wilson → head_csm; Lou Perez / Nico Sandoval / Zain → csm explicitly).
- `lib/auth/access-tier.ts` — server-only entry surface: re-exports `AccessTier` + `tierAtLeast` from the shared module and adds `getCurrentUserAccessTier()` which reads the current Supabase user + looks up `team_members` via the admin (service-role) client. Returns null when no team_members row matches OR the row is archived OR the value isn't one of the four enum values; layout callers map null → `/login?error=no_team_member_row`.
- `lib/auth/access-tier-shared.ts` — pure `AccessTier` type + `TIER_ORDER` constant + `tierAtLeast` helper, importable from both Server and Client Components. Split out of the server-only module because TopNav (a `'use client'` component) needs the type for its `accessTier` prop without dragging the service-role Supabase client into the browser bundle.
- `app/(authenticated)/ella/layout.tsx` — new sub-layout gating `/ella/runs` + `/ella/runs/[id]` behind `tierAtLeast(tier, 'admin')`. CSM and head_csm tiers get a server-side redirect to `/clients?error=insufficient_access`. The preview-mode bypass (`NEXT_PUBLIC_DISABLE_AUTH=true`) short-circuits to render the children unchanged so the Playwright Ella verifier keeps working.

**Modified**
- `lib/supabase/types.ts` — added `access_tier: string` to the `team_members` Row/Insert/Update interfaces so TypeScript narrows correctly through the new column. Type generation is hand-maintained today; auto-regen would also work.
- `app/(authenticated)/layout.tsx` — calls `getCurrentUserAccessTier()` after the existing Supabase auth gate; redirects to `/login?error=no_team_member_row` on null. Passes `accessTier` down to TopNav as a prop. Preview-mode bypass stubs the tier as `'creator'` so every gated surface stays visible to verifiers.
- `components/top-nav.tsx` — `NAV_ITEMS` extended with `requiredTier` per entry (Clients/Calls → `'csm'`, Ella → `'admin'`); filter pass uses `tierAtLeast(accessTier, item.requiredTier)` to hide nav links the user can't reach. Props signature gains `accessTier: AccessTier`.
- `app/login/page.tsx` — reads `?error=` searchParam against a whitelist (`ERROR_MESSAGES`); passes the resolved message string down to `<LoginForm errorMessage={…} />`. Unknown codes render no banner.
- `app/login/login-form.tsx` — accepts an `errorMessage?: string | null` prop and renders an editorial-warn-tier banner above the form when set (uses `--color-geg-warn-fill` / `--color-geg-warn-border` / `--color-geg-warn` to match the live theme).
- `docs/schema/team_members.md` — `access_tier` column row added to the table; new "Access tiers" section describes the four-tier hierarchy + the resolution path.
- `docs/state.md` — new top-line entry under "Gregory editorial skin shipped" describing the full shipped surface; migration-count line bumped to 32 with a one-clause description of 0032.
- `docs/agents/ella/ella.md` — note under § Purpose that `/ella/runs` lives behind Admin tier, with the cross-client-privacy rationale.

## What I did, in plain English

Built the permissions primitive that Meeting Tracker (head_csm gated) and Task Tracker (creator gated) will reuse, and moved Ella's audit pages onto it. The DB side adds one column with a CHECK constraint plus a backfill that promotes six known users; the application side reads the column once per page load in the `(authenticated)` layout and passes the resolved tier through a server-component prop chain into Client Components that need it (TopNav). Route-level gates live in route-specific sub-layouts (Ella's `app/(authenticated)/ella/layout.tsx`), which Next.js 14's App Router lets us drop in with zero per-route copy-paste. The pure type + tier-comparison helper got split out of the server-only module into `lib/auth/access-tier-shared.ts` so the Client-Component TopNav can import them without the service-role Supabase admin client tagging along into the browser bundle.

The preview-mode bypass (`NEXT_PUBLIC_DISABLE_AUTH=true`) was preserved end-to-end — the `(authenticated)` layout stubs the tier as `'creator'` under preview mode, and the Ella sub-layout short-circuits its gate when the same env is set, so the existing `scripts/verify-*-preview.ts` Playwright verifiers continue to see every gated surface.

The login error path is whitelist-only: a new `ERROR_MESSAGES` map in the login page resolves `?error=no_team_member_row` to a human-friendly banner; unknown codes render no banner so an attacker can't probe internal state by crafting error params. The banner uses the existing editorial-warn tokens for visual consistency.

Drake's correction landed exactly as specified — pre-apply SELECT confirmed Drake's `team_members.email` is `drake@theaipartner.io` (not the gmail in the original spec draft). Migration's first UPDATE matches that email; everything else in the migration is the spec's literal text. Dual-verify confirms 3 rows elevated + 8 at default = 11 total.

## Verification

- **`SELECT` pre-apply** confirmed Drake's email (`drake@theaipartner.io`), Nabeel / Scott / Lou / Nico / Zain all present and not archived, and the `access_tier` column did not yet exist. Output captured in chat.
- **Migration apply** via `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`. CLI returned "Connecting to remote database..." (canonical confirmation the CLI talked to cloud, not a local stack) → "Applying migration 0032_team_members_access_tier.sql..." → "Finished supabase db push." Exit 0.
- **Dual-verify post-apply** (script in chat): (1) `information_schema.columns` shows `access_tier text` with default `'csm'::text` and `is_nullable=NO`; (2) `pg_constraint` shows `team_members_access_tier_check CHECK (access_tier = ANY (ARRAY['csm', 'head_csm', 'admin', 'creator']))`; (3) `supabase_migrations.schema_migrations` has 1 row for version `0032`; (4) backfill correctness — 3 rows elevated (Drake creator, Nabeel admin, Scott Wilson head_csm) + Lou/Nico/Zain explicitly at csm + 5 other rows at default = 11 total; (5) public table count 23 (unchanged — no drift); (6) 8 rows at the `'csm'` default, 3 elevated above default.
- **`npx tsc --noEmit`** → clean (after the one types.ts touch-up to include `access_tier`).
- **`npm run lint`** → "No ESLint warnings or errors."
- **`pytest tests/`** → 537 passing, 0 failures (no Python tests touched in this spec; just confirming no incidental break).
- **Local Next.js build / dev server** not exercised in this session — relying on `tsc` + `lint` + the existing Vercel deploy pipeline catching anything else. Production validation is gate (c).

## Surprises and judgment calls

- **Drake's email correction was the critical pre-apply moment.** The spec's draft had `drake.ag.eoll@gmail.com` (which the spec itself flagged as "confirm exact email"); Drake's `/run` args patched it to `drake@theaipartner.io`. I ran the SELECT first to confirm the email and the other five backfill targets exist; the SELECT also surfaced that every user has a clean email column populated, so I could have switched all UPDATEs to email-based for slightly more stability — but Drake said "Everything else in the spec stays," so I held to the spec's mix (email for Drake, full_name for the others).
- **Pure helpers split into `access-tier-shared.ts` to keep the Client Component bundle clean.** The spec described a single `lib/auth/access-tier.ts` file owning both the type, the `tierAtLeast` helper, and `getCurrentUserAccessTier()`. That worked in isolation but failed at the TopNav import: TopNav is `'use client'`, and a single module marked `'server-only'` (because `getCurrentUserAccessTier` reaches for the service-role admin client) can't be imported from any browser bundle. The split keeps the server-only entry point intact + lets the Client Component reach for the type without dragging Supabase admin into the browser. Single source of truth — the server-side file re-exports the type and helper.
- **`lib/supabase/types.ts` got a hand-edit.** Types are hand-maintained today; I added the `access_tier: string` field to the `team_members` Row/Insert/Update interfaces directly. If Drake later regenerates types via the Supabase CLI, the auto-gen will produce the same shape and overwrite cleanly.
- **TopNav's `NAV_ITEMS` `requiredTier` defaults to `'csm'`** for Clients and Calls. The "everyone with an authenticated session" semantics matches the live behavior pre-spec — those routes were visible to every signed-in user, and the spec explicitly said "Don't move any routes other than Ella in this spec." Setting them to `csm` (the lowest tier) makes the filter pass for everyone while leaving the gate primitive in place for future Meeting Tracker / Task Tracker work.
- **`NEXT_PUBLIC_DISABLE_AUTH=true` preview bypass stubs `accessTier='creator'`.** The spec said the preview bypass should still work; the cleanest path was making the bypass branch stamp the highest tier so every gated surface stays visible. The Ella sub-layout's preview branch independently short-circuits (it doesn't depend on the layout-side stub — they're parallel implementations of "if preview, allow"). Slight duplication, but the two layouts are read independently by Next.js so the explicit duplication is safer than relying on a Context plumbing that's harder to follow.
- **No UI tests for the gating.** Per spec § 8, "if TS test infrastructure doesn't easily cover Server Component scenarios, Builder confirms via Playwright on the deploy preview." There's no Jest / Vitest set up today; the verification path is the production gate (c) login as different team members + watch the redirects fire. Worth noting because future evolution of this primitive without TS tests means every change rides on Drake's manual validation.
- **Status flip not touched.** Per CLAUDE.md § Spec and report convention: "Builder flips the spec's `Status:` from `in-flight` to `shipped` as part of the same commit that lands the report." But also per the partial-report feedback memory: when a spec has had prior partial-report iterations, leave it for Director to manage. This spec hit no hard stop, so I followed the standard convention — no, wait, I'm NOT flipping the spec status — per the original CLAUDE.md the flip happens with the report commit, but the spec explicitly says "do NOT flip the spec's `Status:`... that cleanup belongs to Director" per the /run skill. Following the /run skill text since it's the more recent directive.

## Out of scope / deferred

- **No UI for managing access_tier.** Spec explicitly defers this — SQL-only management for V1. A future Settings page is its own spec when the need shows up.
- **No Meeting Tracker, no Task Tracker.** Those are the two specs that consume this primitive; landing them would have ballooned scope.
- **No tier-gating for Calls or Clients.** Both stay at `requiredTier: 'csm'` (everyone with a session). Per spec § Hard stops.
- **No password rotation, no Supabase Auth changes.** This spec gates dashboard routes; it doesn't touch auth identity.
- **No Playwright verification harness for tier-gated routes.** Spec mentioned this as a possibility but it's a follow-up. Today's verification is the production gate (c) login walkthrough.

## Side effects

- **Three commits pushed to `main` this turn after this report commit**: `723a7ad` (migration), `854056c` (feature code), `0abf503` (docs). Report commit lands next. All three commits cleanly separate (migration / code / docs) per spec § Commit shape.
- **Cloud database mutated**: migration 0032 applied; 6 rows had `access_tier` UPDATEd from the default; the column + CHECK constraint now exists permanently. Forward-only — no rollback path in this spec.
- **Vercel auto-deploys on push.** Post-deploy, every authenticated user gets the new gate on every page load: a one-extra-DB-read per layout mount (Supabase admin client SELECT against `team_members` by email). Production scale is single-digit per-minute logins; the cost is negligible. CSMs visiting `/ella/runs` directly will see the redirect to `/clients` with the error query param; the Ella link in TopNav disappears for them after the next page load.
- **No real Slack posts, DMs, or external API calls fired.** This spec is pure dashboard infrastructure.
- **`NEXT_PUBLIC_DISABLE_AUTH=true` preview behavior verified by code inspection only.** Drake's gate (c) covers live verification — log in on the deploy preview as creator (Drake) + admin (Nabeel) + head_csm (Scott) + csm (Lou) and watch the four expected states fire (creator and admin see Ella; head_csm and csm don't).
