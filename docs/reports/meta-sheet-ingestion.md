# Report (PARTIAL): Meta Ad Spend Ingestion (Google Sheet)

**Slug:** meta-sheet-ingestion
**Spec:** docs/specs/meta-sheet-ingestion.md
**Status:** halted — Drake's stored Google OAuth token does NOT include a Sheets-capable scope. Spec gate fires before any code can be built.

## Files touched

**Modified:** none. The scope check is the spec's first concrete action and it failed gate before any artifact was created.

**Created:** this report only.

## What I did, in plain English

Per the spec's "first thing Builder does after acclimatization: read the stored token's `scope` for Drake's `team_member_id` and check whether it includes a Sheets-capable scope" — wrote a one-shot psycopg2 check against the production pooler URL.

**Result: FAIL.** Drake's stored OAuth token has exactly one scope:

```
https://www.googleapis.com/auth/calendar.readonly
```

None of the four Sheets-capable scopes are present:
- `https://www.googleapis.com/auth/spreadsheets.readonly` (the one we need — read-only)
- `https://www.googleapis.com/auth/spreadsheets`
- `https://www.googleapis.com/auth/drive.readonly`
- `https://www.googleapis.com/auth/drive`

Per the spec's HARD STOP rule for this case, I stopped here and did not write the migration, the `ingestion/meta/` module, the cron, the docs, or anything else.

## Verification

- **Scope check** — direct psycopg2 query against cloud Supabase, joining `team_members` (Drake's row, email `drake@theaipartner.io`, id `489eab6c-aac4-44e8-ab2a-2b5cb28d90e7`) to `oauth_tokens` where `provider='google'`. Single row returned. Single-token scope confirmed.
- **Token freshness check** — token's `access_token_expires_at` is `2026-05-24 01:00:32+00`, refreshed at `2026-05-24 00:00:33+00`. Recently refreshed, not stale; this isn't a refresh-token-revoked issue. The token simply was never granted the Sheets scope at original consent time.
- **Cross-checked the connect flow** — `lib/google/oauth.ts:26` and `app/api/auth/google/callback/route.ts:21` both hardcode `SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'` as a single-string constant. The `buildAuthUrl` function passes it as the `scope` parameter to Google's consent URL. The current code can ONLY ever obtain calendar-only tokens; adding Sheets requires both the SCOPE constant to widen AND Drake to re-consent at `/teams`.

## Surprises and judgment calls

- **Spec language is slightly ambiguous on whether Builder edits the SCOPE constant or Drake edits it.** Spec says "tell code to try if the oauth covers the sheets scope, if not I will give it" + "Do NOT attempt to add scopes programmatically or work around it; this is Drake's one-time action." My read: "add scopes programmatically" means "don't try to elevate an existing token's scope via a backdoor API call" — the constant-widening code change IS required to enable the reauth click. Both interpretations are defensible. I'm surfacing the code change as a concrete proposed edit + giving Drake the choice to land it himself or authorize me to make it. (See § What's needed to unblock below.) Either way, the reauth click itself stays Drake's action.
- **GCP project Sheets-API-enablement is a separate gate** I cannot check from here. If the Google Cloud project backing Drake's OAuth client doesn't have the Sheets API enabled in its Library, the reauth will succeed (token gets the scope) but Sheets API calls will return 403 with a "Google Sheets API has not been used in project NNN before or it is disabled" message. Drake should enable it preemptively to avoid the diagnostic round-trip.
- **No `ingestion/meta/` directory pre-seeded.** Was tempted to scaffold a stub so the next pass starts faster, but the spec is clear that schema decisions (CTR-as-derived, day-as-PK, defensive numeric parsing) tie back to the actual Sheet contents — better to write the module against a live confirmed Sheet read than against assumptions. Held off.
- **Refresh-token will silently keep the OLD scope set on next refresh** unless re-consent happens. Just-bumping the SCOPE constant in code without Drake re-consenting won't help — the next token refresh will return the same `calendar.readonly` scope it already has. The re-consent click is non-skippable; it's what re-mints the refresh-token itself with the wider scope.

## Out of scope / deferred

Held until scope is granted:

- Migration 0044 (`meta_ad_daily` table).
- `ingestion/meta/` module (sheets client + parser + pipeline).
- `api/meta_sheet_sync_cron.py` cron.
- `vercel.json` cron schedule entry.
- Tests (parser + cron auth).
- `docs/schema/meta_ad_daily.md`, `docs/runbooks/meta_sheet_ingestion.md`, CLAUDE.md folder-structure addition, state.md entry.
- Backfill of historical days currently in the Sheet.
- Resume report at `docs/reports/meta-sheet-ingestion-pt2.md` per the partial-report convention (this PARTIAL stays intact).

## Side effects

- **Supabase:** one read-only psycopg2 SELECT against `team_members` joined to `oauth_tokens`. Nothing written.
- **Google API:** zero calls. Token never minted, Sheets API never hit.
- **Slack / external services:** none.
- **Local filesystem:** none — no probe dumps, no `.env.local` edits, no code files created.
- **Vercel:** no changes, no new function, no new env var, no cron addition.

---

## What's needed to unblock

Three things, in order. Steps 2 + 3 are Drake's, step 1 has two paths:

**Step 1 — Widen the SCOPE constant in the connect flow.** Two files, identical one-line edit each:

- `lib/google/oauth.ts` line 26:
  ```diff
  -const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
  +const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly https://www.googleapis.com/auth/spreadsheets.readonly'
  ```
- `app/api/auth/google/callback/route.ts` line 21: same diff.

Google OAuth `scope` is space-separated; the consent URL `buildAuthUrl` constructs will offer Drake both scopes when he reconnects.

Two paths for landing this:
- **(a) Drake makes the edit + pushes himself** — keeps "this is Drake's one-time action" intent strictly. One-line change in 2 files.
- **(b) Drake says "go", I make + push the edit** — restart `/run` afterwards.

**My lean: (b).** It's mechanical plumbing for the reauth click; the human-judgment part is the reauth consent itself, which stays Drake's. But (a) is fine too.

**Step 2 — Pre-emptively confirm the Sheets API is enabled in the Google Cloud project** backing the OAuth client. In the Google Cloud Console: APIs & Services → Library → search "Google Sheets API" → if "Disable" button shown it's already enabled; if "Enable" button shown, click it. Without this, the reauth will succeed but the first sheet-fetch will 403. (If you don't recall which GCP project the OAuth client lives in, the `GOOGLE_OAUTH_CLIENT_ID` env var in Vercel is the client; OAuth 2.0 Client IDs page in Cloud Console shows the parent project.)

**Step 3 — Reconnect at `/teams`.** After step 1's code change deploys, the `/teams` page Connect Google button (or whatever the reconnect surface is) will route through the updated `buildAuthUrl` and Google's consent screen will show both Calendar + Sheets scopes. Click consent. The callback writes the refreshed token with the new scope; the `oauth_tokens.scope` column updates.

**Then:** restart `/run` against this spec. Builder re-runs the scope check, confirms PASS, writes migration 0044, builds the module + cron + tests + docs, hard-stops again at gate (a) for migration SQL review.

Resume report will be `docs/reports/meta-sheet-ingestion-pt2.md` per the partial-report convention; this PARTIAL stays in place as the record of why the work was held.
