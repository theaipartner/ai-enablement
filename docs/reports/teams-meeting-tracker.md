# Report: Teams Meeting Tracker

**Slug:** teams-meeting-tracker
**Spec:** docs/specs/teams-meeting-tracker.md

## Files touched

**Created**
- `supabase/migrations/0033_oauth_tokens.sql` — per-team-member OAuth credential storage. Provider CHECK pinned to `'google'`; unique index on `(team_member_id, provider)` as the upsert key; FK with `ON DELETE CASCADE`.
- `supabase/migrations/0034_calendar_events.sql` — cached Google Calendar events. Unique index on `(team_member_id, google_event_id)` as the upsert key; secondary index on `(team_member_id, start_time)` for the per-week page query. JSONB `attendees` + `raw_payload`.
- `lib/google/oauth.ts` — server-only TS surface for the OAuth flow. `buildAuthUrl`, `exchangeCodeForTokens`, `refreshAccessToken`, `getValidAccessToken`. No SDK dependency — two `fetch()` calls + the existing admin Supabase client.
- `shared/google_oauth.py` — Python parallel for the cron's use. `get_valid_access_token` + `_refresh_access_token`. Same `oauth_tokens` row the TS callback writes is read here.
- `app/api/auth/google/connect/route.ts` — creator-gated; generates state nonce, sets httpOnly cookie, redirects to Google consent.
- `app/api/auth/google/callback/route.ts` — creator-gated; validates state cookie, exchanges code for tokens, upserts via the unique `(team_member_id, provider)` index, redirects to `/teams` with success/error query param.
- `api/teams_calendar_sync_cron.py` — Vercel cron `*/30 * * * *`. Per tick: CRON_SECRET auth → resolve Drake → mint token → loop CSMs (sentinels excluded) → fetch `events.list` with a Mon-Sun EST week window via `zoneinfo.ZoneInfo('America/New_York')` (DST-safe) → upsert into `calendar_events`. Cancelled / all-day events filtered out at upsert time. Per-CSM 4xx auth failures caught + audited as `calendar_api_denied`; other CSMs continue. Single summary audit row per tick.
- `lib/db/teams.ts` — server-side data layer for `/teams`. `getTeamsThisWeek` pulls CSMs + calendar_events + candidate `calls` rows + bulk client names in three queries, then JS-joins via case-insensitive trim title equality + ±30 min tolerance (closest-in-time wins). `getDrakeOAuthState` surfaces token presence + most-recent sync audit error for the reconnect banner.
- `app/(authenticated)/teams/layout.tsx` — head_csm-and-up gate (mirrors the Ella sub-layout pattern). `NEXT_PUBLIC_DISABLE_AUTH=true` preview-bypass branch short-circuits to children.
- `app/(authenticated)/teams/page.tsx` — page composition. `HeaderBand` + week range + OAuth banner (creator gets the Reconnect button; others see a muted "Drake needs to reconnect" line) + per-CSM expandable cards. Success / error banners from OAuth callback redirect query params.
- `app/(authenticated)/teams/csm-block.tsx` — Client Component for the expandable per-CSM card. Inline meeting table with When / Title / Client / Fathom columns. `GegPill` for the `started Nm late` pill (≥2 min) and the `API access denied` state. `(no meetings this week)` empty state. `(no Fathom match)` per-row state when title-and-time join misses.
- `docs/schema/oauth_tokens.md` — schema doc covering purpose, columns, indexes, relationships, security posture, example queries.
- `docs/schema/calendar_events.md` — schema doc covering the cached sync layer + the title-and-time join the page does + the no-pruning V1 posture.
- `docs/runbooks/teams_meeting_tracker.md` — operational runbook covering OAuth setup, reconnect procedure, audit-row vocabulary, force-manual-sync curl, common pitfalls (time-zone math, resource calendars, missing Fathom matches), env vars.
- `tests/api/test_teams_calendar_sync_cron.py` — 6 tests: Drake-not-found short-circuit, OAuth refresh failure, happy-path 2 CSMs both succeed, partial failure with one CSM denied, cancelled+all-day event filter at upsert, sentinel exclusion from CSM loop.
- `tests/shared/test_google_oauth.py` — 5 tests: returns stored token when not expired, refreshes when expired, no-row raises, http-error raises, proactive refresh within 60s buffer.

**Modified**
- `components/top-nav.tsx` — `NAV_ITEMS` extended with `{ href: '/teams', label: 'Teams', requiredTier: 'head_csm' }`. `isActive` prefix-matches `/teams` / `/teams/`.
- `vercel.json` — `api/teams_calendar_sync_cron.py` added to functions (`maxDuration: 60`) + `*/30 * * * *` cron schedule.
- `lib/supabase/types.ts` — new `oauth_tokens` + `calendar_events` Row/Insert/Update interfaces inserted between `pending_ella_responses` and `slack_channels` alphabetically. Both include the FK Relationship entries.
- `.env.example` — three new vars under a `--- Google OAuth (Teams Meeting Tracker) ---` block: `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `NEXT_PUBLIC_APP_URL`. Inline comments cover where to create them in Google Cloud Console + the exact redirect URI shape.
- `docs/state.md` — new top-line entry under "Gregory editorial skin shipped" describing what shipped; migration count line bumped 32 → 34; env-var inventory + Vercel cron list + Python function count all extended to cover the new pieces.

## What I did, in plain English

Shipped the full OAuth + 30-min sync cron + `/teams` page surface as one feature. The migration side adds two tables; the TS side has the OAuth flow + the page's data layer + the page itself; the Python side has the parallel OAuth helper + the cron that owns the Google API round trip. The page reads from Supabase, never from Google directly — soft-fails on Google API outages by rendering stale-but-correct data with the `fetched_at` timestamp on each row.

Drake's correction from the prior spec stays relevant: the cron resolves Drake by his work email `drake@theaipartner.io` (canonical now per migration 0032's `access_tier='creator'` backfill). The four CSMs (Scott, Lou, Nico, Zain) share their calendars with Drake at the Workspace level — confirmed in chat — so Drake's one stored token reads everyone's events via per-`calendarId` API calls. The cron treats each CSM independently; one denial doesn't crash the rest.

The title-and-time join against `calls` lives in JS at the page's data layer, not Postgres. Reason: the dataset is small (4 CSMs × ~30 events/week) and the JS pass lets us implement "closest-in-time wins" cheaply with a Math.abs distance check. Future move to a more stable join (Meet link → Fathom's `meeting_link`) is a one-file change in `lib/db/teams.ts` if title drift becomes a problem.

The OAuth side has two implementations (TS for the connect/callback routes; Python for the cron's refresh logic), both reading the same `oauth_tokens` row. The duplication is small and contained — both modules are ~120 lines, both follow the same proactive-refresh-within-60s-buffer pattern. Either side could be the source of truth; today the TS side mints rows + the Python side reads them, with both able to refresh.

The /teams page renders four CSM rows (or however many `is_csm=true` non-sentinel rows exist). Each is a clickable expand/collapse card; the V1 default is collapsed. The empty state per CSM (`(no meetings this week)`) is explicit rather than hidden — head_csm should see that information clearly. The lateness pill only fires for ≥2 minutes late (under 2 min is just a green checkmark; earlier than scheduled shows no delta — we don't surface "started early" as a signal).

## Verification

- **Migrations dual-verified post-apply.** Schema reality: both tables present, columns + nullability per spec, CHECK constraints in place (`oauth_tokens_provider_check` pinned to `'google'`), all four indexes present (2 primary keys + 2 unique + 1 secondary). Ledger registration: rows for `0033` + `0034`. Drift check: public table count 23 → 25 as expected.
- **`pytest tests/`** → 548 passed, 0 failed (was 537 pre-spec; +11 from 6 cron tests + 5 OAuth helper tests).
- **`npx tsc --noEmit`** → clean.
- **`npm run lint`** → clean.
- **No Google API call made from this session.** Tests stub `_fetch_calendar_events` + `_refresh_access_token` at the boundary; the OAuth flow itself isn't exercised end-to-end until Drake completes the production gate (d) env var setup + the gate (c) walkthrough.
- **No production data written.** The cron has not run from a live deploy — Vercel deploys on push, but the cron is gated on `CRON_SECRET` + the new env vars. Drake's first manual `curl` against the deployed cron is what will fire the first real sync.

## Surprises and judgment calls

- **Two OAuth helper modules (TS + Python), not one.** The cron is Python; the connect/callback routes are Next.js (TS). I considered routing the cron through a TS endpoint for token refresh (single source of truth) but it added an extra round trip + a new endpoint surface for no obvious win. Two parallel modules with ~120 lines each, sharing the same DB row, was cleaner. Both proactively refresh inside a 60s buffer; both update `oauth_tokens` on refresh. Flag-worthy because future Google providers (Gmail, Drive) might want to consolidate.
- **`provider` CHECK pinned to `'google'` deliberately tight.** A future provider extension is a one-line ALTER. Pinning narrow today catches typos / drift; if/when Microsoft Graph or similar lands, that spec widens it.
- **Title-and-time join in JS, not SQL.** Rationale above. The cost is one extra round trip per page render but the dataset is tiny and the closest-in-time pick is cheaper in JS than in a Postgres correlated subquery.
- **Drake identified by email, not access_tier, in the cron.** The cron has `_DRAKE_EMAIL = "drake@theaipartner.io"` hardcoded. Alternative was `WHERE access_tier='creator'`, which has the same cardinality today (1 row) but feels marginally less direct + would tie the cron to the access-tier primitive's lifecycle. Email lookup is also what the OAuth callback uses to identify Drake — keeps the two surfaces aligned. If `access_tier='creator'` ever has >1 row, the cron picks the first email match, which is acceptable.
- **Sentinel CSMs (Scott Chasing) get filtered out by metadata, not by hardcoded UUID.** I considered hardcoding the sentinel UUIDs but `metadata.sentinel = true` is the documented signal per `docs/schema/team_members.md` and is more durable.
- **No `updated_at` trigger on either new table.** The callers stamp the field explicitly (cron sets `fetched_at` on every upsert; OAuth callback sets `updated_at` on refresh). A future trigger would be redundant. Matches the pre-existing pattern on `oauth_tokens.created_at` defaults.
- **Cron's `_DRAKE_EMAIL` constant rather than env var.** Could have used `TEAMS_CALENDAR_OWNER_EMAIL` or similar, but it's a single-user feature in V1 and Drake's email is already the canonical creator identity. If the production rollout reveals a need to swap owners, the constant becomes an env var in a follow-up.
- **`_CalendarApiError` not exported.** Used only internally for the per-CSM failure pattern. Tests reach into it via `cron._CalendarApiError`, which is acceptable in test code but worth noting for anyone tempted to import it from outside.
- **Page renders four CSM cards default-collapsed.** Spec said "clickable row (expandable inline)" but didn't pin the default state. Collapsed-first feels cleaner — head_csm scans the four CSM names + meeting counts first, expands what's interesting. If Drake wants default-expanded, single-line change in `csm-block.tsx`.
- **Recovery audit pattern uses `processing_status='processed'` even when errors are present.** The audit row carries `payload.errors[]` array; status flips to `'failed'` only on hard-stop (Drake missing, OAuth unavailable). Per-CSM denials are partial outcomes, not full failures. The runbook's troubleshooting queries reflect this distinction.

## Out of scope / deferred

- **Per-CSM OAuth.** V1 uses Drake's token only. Per-CSM OAuth (each CSM authorizes their own calendar separately) is V2 work; the `oauth_tokens` table primitive already supports it via the `(team_member_id, provider)` key.
- **Manual refresh button on `/teams`.** Spec said no. Cron drives staleness; Drake can `curl` the cron endpoint for an immediate sync. If Scott or Nabeel complain about stale data, V1.5.
- **Calendar event pruning.** Spec said no. Rows accumulate at ~6k/year; trivial. Add a pruning cron when it's worth it.
- **More stable Fathom join.** Title equality is the V1 working join. A future move to Google Meet link → Fathom's meeting link (or a Fathom-side ID Calendar can reference) is a one-file change in `lib/db/teams.ts`.
- **`scripts/verify-teams-preview.ts` Playwright harness.** Spec listed this as optional. Not landed; gate (c) walkthrough is the production verification path today.
- **`NEXT_PUBLIC_APP_URL` doesn't exist in `.env.example` outside this spec.** Added it under the new Google OAuth block. If other future surfaces need it (e.g., for canonical URL construction), it's already there.

## Side effects

- **Three commits pushed to `main` this turn** plus the report commit after this writes: `4c6c829` (migrations), `65736a8` (feature code + tests), `b30b040` (docs).
- **Cloud database mutated**: migrations 0033 + 0034 applied; two new tables now exist permanently. Forward-only — no rollback path in this spec.
- **No real Google API calls.** No `oauth_tokens` row exists yet because Drake hasn't run the OAuth flow against the deployed callback (gate (c)). The first real Google API call will happen on the first cron tick after Drake connects.
- **No real Slack posts, no DMs.** Pure dashboard + cron infrastructure.
- **Vercel auto-deploys on push.** Post-deploy, the new cron will fire every 30 minutes BUT will return `{"error": "drake_team_member_not_found"}` (impossible — migration 0032 wrote Drake) or `{"error": "oauth_token_unavailable", "detail": "no oauth_tokens row..."}` until Drake completes the OAuth flow. Each failed tick writes an audit row; that audit traffic is benign but worth knowing about.
- **The `/teams` page is now in production for head_csm + admin + creator.** Until OAuth + cron tick land real data, it renders the "Google Calendar is not connected" banner (Drake's view) or the "Drake needs to reconnect" line (Scott / Nabeel) + an empty CSM list.

## What's needed for production rollout (gate (c) + (d))

1. **Drake confirms three env vars** (gate (d)): `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `NEXT_PUBLIC_APP_URL=https://ai-enablement-sigma.vercel.app` set in Vercel Production. The spec mentioned these were already added; this verifies.
2. **Google Cloud Console redirect URI** registered exactly as `https://ai-enablement-sigma.vercel.app/api/auth/google/callback`. Calendar API enabled on the project.
3. **Drake visits `/api/auth/google/connect`** in production (creator tier required) and completes the consent flow. The callback writes the token row.
4. **Watch the next cron tick** (within 30 min, or `curl` to force) — audit row should show `processing_status='processed'` + `csms_attempted=4` + `csms_succeeded=4` + `events_upserted>0`.
5. **Visit `/teams`** as creator/admin/head_csm — see each CSM's week + the Fathom matches. As csm — redirected to `/clients?error=insufficient_access`.
6. **Verify lateness pill** by finding a meeting where Fathom started >2 min after the calendar event.
