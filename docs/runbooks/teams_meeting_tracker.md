# Runbook: Teams Meeting Tracker

Operational guide for the `/teams` Meeting Tracker. Covers OAuth setup, reconnect procedure, debugging the calendar sync cron, and audit-row vocabulary.

## What it is

`/teams` is a head-CSM-and-up dashboard surface showing every CSM's current-week meetings + whether Fathom matched them. Data path:

1. **The creator-tier account OAuths once** at `/api/auth/google/connect`. The token row lands in `oauth_tokens` keyed to that account's `team_member_id`. (This account is the load-bearing calendar-sync identity — see `credentials-and-accounts.md` § calendar-sync Google account for which account it's pinned to and how to re-pin it.)
2. **The sync cron** at `/api/teams_calendar_sync_cron` fires every 30 minutes (`*/30 * * * *`). It mints a valid access token via `shared.google_oauth.get_valid_access_token`, fetches the current week's events from each CSM's primary calendar (CSMs share their calendars with that account at the Workspace level), and upserts into `calendar_events`.
3. **The `/teams` page** reads `calendar_events` + `calls` server-side and joins them in JS via case-insensitive title equality + ±30 min time window. Never calls Google directly.

Tier gating:
- **Creator**: sees `/teams`, can connect/reconnect Google.
- **Admin** (Nabeel): sees `/teams`. Reconnect requires the creator-tier session.
- **Head CSM** (Scott Wilson): sees `/teams`. Reconnect requires the creator-tier session.
- **CSM** (Lou / Nico / Zain): redirects to `/clients?error=insufficient_access`.

## OAuth setup (one-time, V1)

1. **Google Cloud Console.** Create an OAuth 2.0 Client ID under https://console.cloud.google.com/apis/credentials → "Web application". Authorized redirect URI must be exactly `{NEXT_PUBLIC_APP_URL}/api/auth/google/callback` (no trailing slash). Enable the Calendar API on the project.
2. **Env vars in Vercel Production:**
   - `GOOGLE_OAUTH_CLIENT_ID` — the Client ID from step 1.
   - `GOOGLE_OAUTH_CLIENT_SECRET` — the Client Secret from step 1.
   - `NEXT_PUBLIC_APP_URL` — `https://ai-enablement-sigma.vercel.app`.
3. **Connect.** The creator-tier login visits `/api/auth/google/connect` → redirected to Google's consent screen → approves → redirected back to `/teams?connected=google`. The `oauth_tokens` row gets written.

After this one-time flow, the sync cron runs autonomously. No per-CSM OAuth needed — each CSM shares their calendar with the creator-tier account at the Workspace level (Google Calendar UI → calendar settings → "Share with specific people or groups").

## Reconnect flow

The creator-tier user reconnects when the stored refresh token stops working. Symptoms:

- `/teams` shows a yellow "Google Calendar is not connected" banner with a Reconnect button (the creator-tier view).
- Other tiers see a muted "Calendar data is currently unavailable" line.
- Audit rows show `processing_status='failed'` + `processing_error` starting with `oauth_token_unavailable`.

Reconnect procedure: click the Reconnect button (or visit `/api/auth/google/connect` directly) from the creator-tier login. Google re-issues a fresh refresh token; the callback upserts it into the same row.

Common refresh-failure causes:
- Refresh token explicitly revoked at https://myaccount.google.com/permissions.
- Refresh token unused for 6 months (Google's expiry policy for non-published apps).
- Client secret rotated in Google Cloud Console without redeploy.
- Workspace policy changed to require domain admin re-consent.

## Verify the sync is flowing

### Most-recent cron tick

```sql
select received_at, processing_status, processing_error,
       payload->'counts' as counts,
       jsonb_array_length(payload->'errors') as error_count
from webhook_deliveries
where source = 'teams_calendar_sync'
order by received_at desc
limit 10;
```

A healthy tick:
- `processing_status='processed'`.
- `payload.counts.csms_attempted` = N (typically 4: Scott, Lou, Nico, Zain).
- `payload.counts.csms_succeeded` = N.
- `error_count` = 0.

A degraded tick:
- `processing_status='processed'` with `error_count > 0` → one or more CSMs failed; the rest succeeded. Look at `payload.errors[]` for which.
- `processing_status='failed'` with `processing_error='oauth_token_unavailable: ...'` → the creator-tier token broke. Reconnect via `/api/auth/google/connect`.
- `processing_status='failed'` with `processing_error='drake_team_member_not_found'` (literal code string) → migration 0032 didn't backfill correctly, or the creator-tier row was archived. Investigate `team_members.access_tier`.

### Per-CSM event counts

```sql
select tm.full_name, count(*) as events_cached, max(ce.fetched_at) as last_sync
from calendar_events ce
join team_members tm on tm.id = ce.team_member_id
where ce.start_time >= now() - interval '7 days'
group by tm.full_name
order by tm.full_name;
```

If a specific CSM hasn't synced recently, check the audit `payload.errors[]` for a `calendar_api_denied` entry on that `team_member_id`. They likely unshared their calendar.

### Force a manual sync

```bash
curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \
     https://ai-enablement-sigma.vercel.app/api/teams_calendar_sync_cron
```

Useful for debugging without waiting 30 min. Response body has the same `counts` + `errors` shape as the audit row.

## Filter behavior

The sync cron only stores events with **at least one attendee outside the `@theaipartner.io` domain**. Applied at fetch time inside `_upsert_events` (helper: `_has_external_attendee`) before any row writes. Calibrated to keep client-facing meetings + drop everything else.

**Kept:**
- Client meetings (any external email — client@gmail.com, client@theirbusiness.com, etc.).
- Meetings with vendors, prospects, accountants, contractors — anyone outside the AIP Workspace.
- Mixed meetings (AIP team + external attendees).

**Dropped:**
- Events with zero attendees (OOO blocks, work blocks, focus time).
- Events where every attendee is `@theaipartner.io` (internal 1:1s, team syncs, leadership meetings).
- Events where AIP attendees + resource calendars (conference rooms, equipment) are the only entries — resource calendars don't count as external attendees.

**Edge cases worth knowing:**
- Domain match is case-insensitive (Google sometimes echoes user-typed casing).
- Attendees without an `email` field are skipped (treated as neither AIP nor external).
- A trialed-future-team-member client with an `@theaipartner.io` alias would be incorrectly filtered out. Vanishingly rare — if it happens, the symptom is "this client meeting isn't showing up on /teams" and the fix is to remove the alias or surface a follow-up spec.

**Why this exists**: pre-filter, the page showed every CSM's full calendar including OOO / focus time / internal meetings. Noise vs signal was unmanageable. Filter shipped 2026-05-15 alongside the original Meeting Tracker.

### Personal-email exclusion (2026-05-15)

A teammate joining an internal meeting from a personal account (e.g. Huzaifa attending CSM Sync from `huzaifasaeed460@gmail.com`) would slip past the AIP-domain check unless we explicitly recognize their personal address as internal. `team_members.metadata.personal_emails` is the list; the cron's `_fetch_personal_emails` loads them per tick into a lowercased set that `_has_external_attendee` consults alongside the `@theaipartner.io` check.

Current entries:
- Huzaifa → `huzaifasaeed460@gmail.com`

When a new leak pattern surfaces, add to the list via SQL — no code deploy needed. See `docs/schema/team_members.md` § Personal emails for the exact UPDATE shape. The next cron tick picks it up.

If you add a personal email and existing rows in `calendar_events` should be dropped, run a one-time cleanup DELETE for the affected `calendar_events` rows.

### Ignored booking links (2026-06-19)

Independent of the attendee filter, the cron drops a small ignore list of
booking links that must never surface as meetings — dropped at the same point
as cancelled events. Helper: `_is_ignored_event` (constants
`_IGNORED_EVENT_TITLES` / `_IGNORED_EVENT_URLS`).

- **Digital College Implementation Call with Nico** (Scott). A separate program
  booked on Nico's calendar via an external booking link
  (`api.leadconnectorhq.com`). Matched by exact title (case-insensitive,
  trimmed) **and** by the booking-link URL anywhere in the payload. The genuine
  "Coaching Call with Nico" is untouched. Mirrored in `client_meetings_sync_cron.py`
  (the pay-driving sync — see `docs/runbooks/client_meetings_sync.md`).

**Debugging "why doesn't meeting X show up on /teams":**
1. Check that the meeting has at least one external attendee on the actual Google Calendar entry. CSMs sometimes invite themselves only ("hold this slot") — that won't show.
2. Check `calendar_events` directly: if the row is missing, the filter dropped it. If the row is present but the page doesn't render it, look at the title-and-time match (next section).
3. If the row is missing AND the filter SHOULD have kept it, look at the cron's audit row for the most recent tick — was there a transport error?

## Title-and-time match logic

The `/teams` page joins `calendar_events` to `calls` in JS:

- **Title**: `lower(trim(calendar_events.title)) == lower(trim(calls.title))`.
- **Time**: `abs(calls.started_at - calendar_events.start_time) <= 30 minutes`.
- **Category**: `calls.call_category = 'client'` (we never re-classify from Calendar attendees — the Fathom classification pipeline owns that).

When multiple candidate `calls` rows match a single calendar event, the closest-in-time wins.

If a meeting renders as "(no Fathom match)" but you expected one:
1. Check `calls.title` — does it differ from the calendar event title? (Common: Google Meet adds " (Recording)" suffixes; Fathom's `title` follows Fathom's naming.)
2. Check `calls.call_category` — is it `'client'`? If `'unclassified'` or `'internal'`, the join skips.
3. Check `calls.started_at` — outside the ±30 min window?

V2 fixes (out of scope today): use Google Meet link → Fathom's `meeting_link` as a more stable join, or migrate to a Fathom-side ID Calendar can reference.

## Missed-recording flagger (cs-call-summaries)

`api/cs_missed_recording_cron.py` (Vercel cron, `*/15 * * * *`) reuses this same title-and-time match against `calendar_events` to catch meetings that should have produced a Fathom recording but didn't. A row qualifies when `end_time + 30min` has passed (grace elapsed), it's within the trailing 7-day backstop, no client `calls` row matches (normalized title + ±30min of start), and `missing_recording_posted_at IS NULL`. It posts `[title] - recording not available` to the cs-call-summaries channel (`SLACK_CS_CALL_SUMMARIES_CHANNEL_ID`) and stamps `calendar_events.missing_recording_posted_at` so each missed call posts once. Matched events are left unstamped and simply age out of the backstop window. This is the time-based complement to `agents/gregory/cs_call_summary_post.py`, which fires when a recording *does* arrive. Schema: `missing_recording_posted_at` added by migration `0056`; the 30-min teams sync upsert does not write that column, so the stamp survives re-syncs.

## Lateness pill

When a matched call's `started_at` is more than 2 minutes after the Calendar event's `start_time`, the page renders a `started Nm late` pill. Under 2 minutes shows just the checkmark; early starts show no delta (we don't surface "started early" as a signal).

## Empty states

- **CSM with zero events this week**: row renders with `(no meetings this week)`. Not hidden — head_csm should see the empty explicitly.
- **CSM with calendar_api_denied**: row renders an `API access denied` pill in the header. Sub-list still shows what's cached from previous successful ticks.
- **Creator-tier token missing**: the banner above the CSM list explains; rest of the page renders what's in `calendar_events` (possibly stale).

## Common pitfalls

- **Time zone math is DST-sensitive.** The Python cron + the TS data layer both use `America/New_York` ZoneInfo. Don't hardcode UTC offsets — DST flips the offset twice a year.
- **`maxResults=250` is Google's per-page cap.** A CSM with >250 events in a week (essentially impossible in our usage) would lose the tail. Future: paginate via `nextPageToken`.
- **Resource calendars** (conference rooms, equipment) get filtered out of the attendees list at upsert time. They show up in `raw_payload` if you need them.

## Env vars (Vercel Production)

| Var | Purpose | Default |
|-----|---------|---------|
| `GOOGLE_OAUTH_CLIENT_ID` | OAuth client from Google Cloud Console | (set in Vercel) |
| `GOOGLE_OAUTH_CLIENT_SECRET` | OAuth client secret | (set in Vercel) |
| `NEXT_PUBLIC_APP_URL` | Base URL for OAuth redirect | `https://ai-enablement-sigma.vercel.app` |
| `CRON_SECRET` | Bearer auth for the cron, shared across all crons | (set in Vercel) |

## Origin

- Migrations: `0033_oauth_tokens.sql`, `0034_calendar_events.sql`
- Schema docs: `docs/schema/oauth_tokens.md`, `docs/schema/calendar_events.md`
