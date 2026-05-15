# Teams meeting tracker

**Slug:** teams-meeting-tracker
**Status:** in-flight

## Context

Head CSM (Scott) and Admin (Nabeel) need visibility into whether CSMs are actually meeting with their clients each week, and whether the Fathom notetaker was present on those calls. Drake (Creator) also has access. Three other tiers (csm) are not in scope.

V1 surface: a new page at `/teams` gated to head_csm-and-up. The page lists each CSM (`team_members WHERE is_csm=true`) as a clickable row. Clicking a CSM expands or navigates to their meetings for the current calendar week (Mon–Sun, EST). Each meeting shows title + scheduled time + matched client + a checkmark when we have a corresponding Fathom call (`calls.call_category='client'`) with the same title in the time window. When the Fathom call started after the Calendar event's scheduled start, surface the delta ("started 4 min late") so Nabeel can see lateness.

Calendar data comes via Drake's Google OAuth token only. All four CSMs (Scott, Lou, Nico, Zain) have shared their calendars with Drake at the Workspace level, confirmed in Google Calendar UI 2026-05-14. No per-user OAuth required.

The spec ships the OAuth primitive AND the meeting tracker in one feature set because they're inseparable — the OAuth flow exists to power the tracker.

## Pre-flight: design-system alignment check

Before any UI code, Builder confirms the `gregory-editorial` theme + the primitives in `components/gregory/` still match production. Same check as the permissions spec — read `components/gregory/header-band.tsx`, `geg-pill.tsx`, `sentiment-pill.tsx`, `app/globals.css`, `components/top-nav.tsx`, and spot-check `app/(authenticated)/clients/page.tsx` + `app/(authenticated)/ella/runs/page.tsx`. If anything's drifted, hard-stop and surface to Drake.

If the permissions spec already shipped today (confirmed in `docs/state.md`), the design system is presumed fresh and this check is fast.

## Files Builder reads first (acclimatization)

After the design check, in order:

1. `docs/schema/calls.md` and `docs/schema/call_participants.md` — the calls primitive is load-bearing. `call_category`, `primary_client_id`, `started_at`, `title` are the join fields against calendar events.
2. `docs/schema/team_members.md` — `is_csm=true` is the filter for which team members get rendered on the page. `email` is the key for resolving the Calendar API's per-user requests.
3. `docs/schema/clients.md` — to understand the client identity surface that `calls.primary_client_id` resolves against.
4. `lib/auth/access-tier.ts` and `lib/auth/access-tier-shared.ts` — the gating primitive (just shipped). The new `/teams` route gates via the same pattern Ella uses (`app/(authenticated)/ella/layout.tsx`).
5. `api/passive_ella_cron.py` — the existing per-minute cron pattern. The new calendar-sync cron mirrors this shape (CRON_SECRET auth, structured logging, fail-soft per-CSM).
6. `app/(authenticated)/ella/runs/page.tsx` — the cleanest example of a list page in the current style. The `/teams` page mirrors its layout/structure.

## Decisions baked in (do NOT re-litigate)

- **Route:** `/teams`. Gated to `head_csm` and up via a new `app/(authenticated)/teams/layout.tsx` (mirrors the Ella layout pattern).
- **Sync model:** cron-based, 30-minute cadence. New `calendar_events` table. Page reads exclusively from Supabase, never from Google directly at render time.
- **Time zone:** EST for all display. Stored timestamps stay UTC in `calendar_events` (per Postgres standard); UI converts at render.
- **Title matching is the join:** Calendar event title (case-insensitive, trimmed) must equal `calls.title` (same normalization). Time window: Fathom `started_at` within ±30 minutes of Calendar `start_time`. Both must hold.
- **Lateness display:** when a matched Fathom call's `started_at` is more than 2 minutes after the Calendar `start_time`, render "started Nm late" inline with the checkmark. Under 2 minutes: just checkmark. Earlier than the scheduled time: no delta shown.
- **Client meeting filter:** `calls.call_category='client'` is the existing semantic. We DO NOT re-derive "is this a client meeting" from Calendar attendees — that work is already done by the Fathom classification pipeline. Calendar events without a matching Fathom call have no client to display (the row still renders, just no client + no checkmark).
- **OAuth scope:** Drake's account only in V1. New `oauth_tokens` table keyed by `team_member_id` so the primitive is reusable later. Other CSMs sharing their calendars with Drake at the Workspace level is the live mechanism for reading their data.
- **CSM unavailability:** if Google API returns a 4xx/auth error for a specific CSM's calendar (e.g., they unshared), that CSM renders with "Calendar API access denied" state. Other CSMs still load.
- **Empty state per CSM:** "(no meetings this week)" when zero events. Don't hide the CSM entirely — head_csm/admin should see the empty state explicitly.
- **No manual refresh button in V1.** Cron drives staleness. Add later if Scott or Nabeel complain.
- **OAuth-token-broken state:** if Drake's stored refresh token fails to mint a new access token (revoked, expired beyond refresh, etc.), the cron's audit row records the failure AND the `/teams` page surfaces a "Reconnect Google Calendar" banner visible to Drake. Other users see "Calendar data is currently unavailable — Drake needs to reconnect."
- **Visual style:** existing primitives, gregory-editorial theme. Use `HeaderBand` for the page header, `GegPill` for any state pills (e.g., "API denied" yellow, "Reconnect needed" warn).

## Implementation plan

### 1. Migrations

**`0033_oauth_tokens.sql`** — new table.

```sql
CREATE TABLE oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  provider text NOT NULL,
  access_token text NOT NULL,
  refresh_token text NOT NULL,
  access_token_expires_at timestamptz NOT NULL,
  scope text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX oauth_tokens_team_member_provider_idx
  ON oauth_tokens (team_member_id, provider);

ALTER TABLE oauth_tokens
  ADD CONSTRAINT oauth_tokens_provider_check
  CHECK (provider IN ('google'));
```

**`0034_calendar_events.sql`** — new table for cached Calendar API data.

```sql
CREATE TABLE calendar_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  google_event_id text NOT NULL,
  calendar_id text NOT NULL,  -- usually the CSM's primary calendar email
  title text,
  start_time timestamptz NOT NULL,
  end_time timestamptz NOT NULL,
  attendees jsonb NOT NULL DEFAULT '[]'::jsonb,  -- array of {email, displayName}
  meeting_link text,  -- Google Meet link if present
  raw_payload jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX calendar_events_team_event_idx
  ON calendar_events (team_member_id, google_event_id);

CREATE INDEX calendar_events_start_time_idx
  ON calendar_events (team_member_id, start_time);
```

**Hard stop before apply:** Builder reads both migrations to Drake in chat for SQL review. Two separate migrations applied in order (`0033` then `0034`). Dual-verify after each.

### 2. Schema docs

- `docs/schema/oauth_tokens.md` (new) — purpose, columns, relationships, populated-by (Google OAuth flow), read-by (calendar sync cron).
- `docs/schema/calendar_events.md` (new) — purpose, columns, the unique constraint, the index strategy, populated-by (cron), read-by (`/teams` page).

### 3. Google OAuth flow

**Two new API routes:**

`app/api/auth/google/connect/route.ts` — initiates OAuth. Builds the Google authorization URL with:
- `client_id`: from `GOOGLE_OAUTH_CLIENT_ID` env var
- `redirect_uri`: `${NEXT_PUBLIC_APP_URL}/api/auth/google/callback`
- `response_type`: `code`
- `scope`: `https://www.googleapis.com/auth/calendar.readonly`
- `access_type`: `offline` (this is what gets us a refresh token)
- `prompt`: `consent` (forces the consent screen even on re-auth, ensures we always get a fresh refresh token)
- `state`: a random nonce stored in a temporary cookie, validated on callback

Redirects the browser to the Google URL.

Requires `creator` tier — only Drake can OAuth in V1. Other tiers visiting this URL get a 403.

`app/api/auth/google/callback/route.ts` — receives Google's redirect. Validates the state cookie, exchanges the `code` for tokens via Google's token endpoint, upserts into `oauth_tokens` keyed by `(team_member_id=Drake's id, provider='google')`. Redirects to `/teams` with a success query param. Handles all the common error paths (Google returned an error, state mismatch, token exchange failed) with clear messages.

**Helper module: `lib/google/oauth.ts`** (new):
- `buildAuthUrl(state: string): string` — constructs the consent URL
- `exchangeCodeForTokens(code: string): Promise<TokenSet>` — POSTs to Google's `/token` endpoint
- `refreshAccessToken(refresh_token: string): Promise<{ access_token, expires_in }>` — used by the cron when the stored access token is expired
- `getValidAccessToken(team_member_id: string): Promise<string>` — orchestrates: read stored tokens, check expiry, refresh if needed, update the row, return the live access token

### 4. Calendar sync cron

`api/teams_calendar_sync_cron.py` — new file. Vercel cron, runs every 30 minutes (`*/30 * * * *`).

Per-tick behavior:
1. Validate CRON_SECRET (existing pattern from other crons).
2. Resolve Drake's `team_member_id`.
3. Get a valid access token via `getValidAccessToken` (refreshes if needed; if refresh fails, log + audit + return — no calendar sync this tick).
4. Look up all CSMs (`SELECT id, email, full_name FROM team_members WHERE is_csm=true AND archived_at IS NULL`).
5. For each CSM:
   - Call Google Calendar API's `events.list` endpoint with `calendarId={csm.email}`, `timeMin=<start of current week, EST converted to UTC>`, `timeMax=<end of current week + 1 day buffer>`, `singleEvents=true`, `orderBy=startTime`.
   - On 200: upsert each returned event into `calendar_events` keyed by `(team_member_id, google_event_id)`. Replace `raw_payload`, update `fetched_at`.
   - On 4xx auth error specifically (403, 401): log + audit under `webhook_deliveries.source='teams_calendar_sync'` with `processing_error='calendar_api_denied:{csm.email}'`. Continue to next CSM — don't crash the whole sync.
   - On other error: log + audit, continue.
6. After all CSMs processed: insert one summary audit row with totals.

Audit row contract (existing pattern):
- `source='teams_calendar_sync'`
- `processing_status='processed'` or `'failed'`
- `payload`: `{ csms_attempted: N, csms_succeeded: N, events_upserted: N, errors: [...] }`

`vercel.json` updates: add the cron schedule for `/api/teams_calendar_sync_cron`, set `maxDuration: 60`.

### 5. The `/teams` page

**`app/(authenticated)/teams/layout.tsx`** — new file. Gates the route to head_csm-and-up. Same shape as the Ella sub-layout. Pass the resolved access tier down so the page knows whether to render Drake's "Reconnect Calendar" button (only visible to creator tier).

**`app/(authenticated)/teams/page.tsx`** — the main list page.

Server-side data fetch:
- Pull all CSMs (`is_csm=true`, not archived) ordered by `full_name`.
- For each CSM, pull their `calendar_events` for the current week (Mon-Sun in EST, converted to UTC for the query).
- For each event, look up a matching `calls` row: same title (case-insensitive, trimmed), `started_at` within ±30 minutes of `start_time`, `call_category='client'`.
- For each matched call, resolve the client name via `primary_client_id` → `clients.full_name`.
- Check Drake's `oauth_tokens` row for Google — if missing or `refresh_token` is known-bad (we'd need to track this), surface the reconnect banner.

Render:
- `HeaderBand` with eyebrow "TEAM" + "Meeting tracker" title + current week range.
- If Drake is logged in and OAuth is missing/broken: a `--color-geg-warn`-styled banner with "Connect Google Calendar" or "Reconnect Google Calendar" button linking to `/api/auth/google/connect`.
- For each CSM: a clickable row (expandable inline) showing `full_name` + meeting count for the week. Clicking expands a sub-list of their meetings.
- Each meeting row: title, time (e.g., "Mon 2:00 PM"), matched client name (or "(no Fathom match)"), checkmark icon + lateness pill when applicable.
- "(no meetings this week)" empty state when a CSM has zero events.
- "API access denied" pill when the most recent audit row for this CSM shows a calendar_api_denied error.

**Reuse existing primitives:** `HeaderBand`, `GegPill` for state indicators, JetBrains Mono for times + IDs, Newsreader for headers.

### 6. TopNav update

`components/top-nav.tsx` — add a "Teams" nav item with `requiredTier: 'head_csm'`. Renders for Scott, Nabeel, Drake; hidden for the three CSMs.

### 7. Env vars

New env vars Drake adds to Vercel Production (gate (d), already done per the chat):
- `GOOGLE_OAUTH_CLIENT_ID`
- `GOOGLE_OAUTH_CLIENT_SECRET`
- `NEXT_PUBLIC_APP_URL` — the production URL, used to construct the OAuth redirect URI. Confirm Drake's value (likely `https://ai-enablement-sigma.vercel.app`).

Add all three to `.env.example` with brief comments.

### 8. Tests

Python (Builder writes):
- `tests/api/test_teams_calendar_sync_cron.py` — CRON_SECRET validation, per-CSM upsert logic (mocked Google API), failure handling per CSM, summary audit row.
- `tests/lib/google/test_oauth.py` — `getValidAccessToken` returns existing token when not expired; refreshes when expired; logs + raises when refresh fails.

TypeScript: no test infrastructure exists for TS. Verification is via Playwright on the deploy preview if Builder wants to add a `scripts/verify-teams-preview.ts` mirroring the existing `verify-*-preview.ts` pattern. Optional.

### 9. Doc updates

- `docs/state.md` — new entry. Migration count bumps to 34. Env var inventory updated. The `/teams` route added to the dashboard surface.
- `docs/schema/oauth_tokens.md` — new.
- `docs/schema/calendar_events.md` — new.
- `docs/runbooks/teams_meeting_tracker.md` (new) — operational runbook. Covers: OAuth setup steps, how to reconnect if token breaks, what each audit row means, expected cron cadence, what to look for when debugging.
- `docs/agents/ella/ella.md` — no changes; orthogonal feature.
- CLAUDE.md — no changes. Per-feature surface area lives in dedicated docs.

## What success looks like

1. **Migrations 0033 + 0034 apply + dual-verify cleanly.**
2. **Drake visits `/api/auth/google/connect`** — redirected to Google consent screen → approves → redirected back to `/teams` with a success banner. `oauth_tokens` table has one row for Drake + provider='google'.
3. **Cron tick fires every 30 minutes**, pulls Calendar API for each CSM, upserts to `calendar_events`. Audit rows visible in `webhook_deliveries`.
4. **Drake (creator) visits `/teams`** — sees all four CSMs (Scott, Lou, Nico, Zain). Clicks each, sees their week's meetings. Matched client meetings show client name + checkmark. Late-started Fathom calls show "started Nm late". Unmatched events show no client + no checkmark.
5. **Nabeel (admin) and Scott (head_csm) visit `/teams`** — see the same view as Drake, minus the "Reconnect Calendar" surface (only Creator can act on it).
6. **CSMs (Lou, Nico, Zain) visit `/teams`** — redirected to `/clients?error=insufficient_access`. Nav link for Teams not visible.
7. **A CSM with zero meetings this week** renders with the empty state, not hidden.
8. **Simulated calendar-API denial** (Builder can mock this in a test, or you can manually unshare one calendar momentarily to validate): renders the "API access denied" state without breaking the rest of the page.
9. **All tests pass.** `pytest tests/` green.

## Hard stops

- **Pre-flight design check** — same as last spec.
- **SQL review before each migration apply.** Two migrations, two SQL-review hard stops.
- **Don't OAuth as anyone other than Drake.** The connect route is gated to creator tier; if Builder thinks "should other CSMs OAuth too?" — no, that's V2.
- **Don't write secrets to logs.** Access tokens, refresh tokens, client secret — never logged, never printed, never returned in API responses except in the OAuth callback (where the response IS the redirect to `/teams`, not a token leak).
- **Don't re-classify client meetings from Calendar data.** Use `calls.call_category='client'` only. Calendar events without a matched call render as "no Fathom match" — that's information, not a bug.
- **Don't add a manual refresh button.** Cron only in V1.

## What could go wrong

- **Drake's Google account isn't actually a Workspace admin / the Calendar API rejects per-user calendar reads via shared access.** Mitigation: Builder confirms with a one-off test call against one CSM's calendar early in the flow. If denied, surface to Drake before sinking more effort.
- **The Workspace's default sharing setting changes** and CSMs' calendars stop being readable. Mitigation: each CSM renders with the "API access denied" state, audit logs show which one. Drake or Nabeel coordinates re-sharing.
- **A Calendar event has no title.** Skip it for matching (title is the join key); it still upserts and renders with title="(untitled)" so head_csm sees "yes there was a calendar block but Fathom couldn't have matched it." Worth surfacing rather than hiding.
- **A CSM has a recurring weekly meeting** like "1:1 with Drake" that creates an event every week with the same title. The matching is per-week (time window is ±30 min of `start_time`); only the matching week's Fathom call matches. No cross-week false matches.
- **The cron's per-CSM Calendar API calls fail in sequence** (rate-limited, network blip). One CSM's failure doesn't crash the rest; each is wrapped in try/except + audit row. Mitigation already specced.
- **Time zone math is hard.** EST is UTC-5 in winter, UTC-4 in summer (DST). Use Python's `zoneinfo` (stdlib in 3.9+) with `ZoneInfo('America/New_York')` for the week boundary calculations — NOT a fixed UTC offset. Builder verifies with a test crossing a DST boundary.
- **Stale `oauth_tokens` row when Drake re-OAuths.** Upsert on `(team_member_id, provider)` — the existing row gets updated, no duplicates. Spec already covers this with the unique index.

## Mandatory doc-update list

- `supabase/migrations/0033_oauth_tokens.sql`
- `supabase/migrations/0034_calendar_events.sql`
- `docs/schema/oauth_tokens.md`
- `docs/schema/calendar_events.md`
- `docs/runbooks/teams_meeting_tracker.md`
- `docs/state.md`
- New: `lib/google/oauth.ts`, `app/(authenticated)/teams/layout.tsx`, `app/(authenticated)/teams/page.tsx`, `app/api/auth/google/connect/route.ts`, `app/api/auth/google/callback/route.ts`, `api/teams_calendar_sync_cron.py`
- Modified: `components/top-nav.tsx`, `vercel.json`, `.env.example`, `lib/supabase/types.ts`

## Commit shape

One migration commit per migration (two total). One feature commit for OAuth + cron + page. One docs commit. One report commit. Push at end.
