# Runbook: Teams Meeting Tracker

Operational guide for the `/teams` Meeting Tracker. Covers OAuth setup, reconnect procedure, debugging the calendar sync cron, and audit-row vocabulary.

## What it is

`/teams` is a head-CSM-and-up dashboard surface showing every CSM's current-week meetings + whether Fathom matched them. Data path:

1. **Drake OAuths once** at `/api/auth/google/connect`. The token row lands in `oauth_tokens` keyed to Drake's `team_member_id`.
2. **The sync cron** at `/api/teams_calendar_sync_cron` fires every 30 minutes (`*/30 * * * *`). It mints a valid access token via `shared.google_oauth.get_valid_access_token`, fetches the current week's events from each CSM's primary calendar (CSMs share their calendars with Drake at the Workspace level), and upserts into `calendar_events`.
3. **The `/teams` page** reads `calendar_events` + `calls` server-side and joins them in JS via case-insensitive title equality + ±30 min time window. Never calls Google directly.

Tier gating:
- **Creator** (Drake): sees `/teams`, can connect/reconnect Google.
- **Admin** (Nabeel): sees `/teams`. Reconnect requires Drake's session.
- **Head CSM** (Scott Wilson): sees `/teams`. Reconnect requires Drake's session.
- **CSM** (Lou / Nico / Zain): redirects to `/clients?error=insufficient_access`.

## OAuth setup (one-time, V1)

1. **Google Cloud Console.** Create an OAuth 2.0 Client ID under https://console.cloud.google.com/apis/credentials → "Web application". Authorized redirect URI must be exactly `{NEXT_PUBLIC_APP_URL}/api/auth/google/callback` (no trailing slash). Enable the Calendar API on the project.
2. **Env vars in Vercel Production** (gate (d) — Drake):
   - `GOOGLE_OAUTH_CLIENT_ID` — the Client ID from step 1.
   - `GOOGLE_OAUTH_CLIENT_SECRET` — the Client Secret from step 1.
   - `NEXT_PUBLIC_APP_URL` — `https://ai-enablement-sigma.vercel.app`.
3. **Connect.** Drake (creator-tier login) visits `/api/auth/google/connect` → redirected to Google's consent screen → approves → redirected back to `/teams?connected=google`. The `oauth_tokens` row for Drake gets written.

After this one-time flow, the sync cron runs autonomously. No per-CSM OAuth needed — each CSM shares their calendar with Drake at the Workspace level (Google Calendar UI → calendar settings → "Share with specific people or groups").

## Reconnect flow

Drake reconnects when the stored refresh token stops working. Symptoms:

- `/teams` shows a yellow "Google Calendar is not connected" banner with a Reconnect button (Drake's view).
- Other tiers see a muted "Calendar data is currently unavailable — Drake needs to reconnect" line.
- Audit rows show `processing_status='failed'` + `processing_error` starting with `oauth_token_unavailable`.

Reconnect procedure: Drake clicks the Reconnect button (or visits `/api/auth/google/connect` directly). Google re-issues a fresh refresh token; the callback upserts it into the same row.

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
- `processing_status='failed'` with `processing_error='oauth_token_unavailable: ...'` → Drake's token broke. Reconnect via `/api/auth/google/connect`.
- `processing_status='failed'` with `processing_error='drake_team_member_not_found'` → migration 0032 didn't backfill correctly, or Drake's row was archived. Investigate `team_members.access_tier`.

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

## Lateness pill

When a matched call's `started_at` is more than 2 minutes after the Calendar event's `start_time`, the page renders a `started Nm late` pill. Under 2 minutes shows just the checkmark; early starts show no delta (we don't surface "started early" as a signal).

## Empty states

- **CSM with zero events this week**: row renders with `(no meetings this week)`. Not hidden — head_csm should see the empty explicitly.
- **CSM with calendar_api_denied**: row renders an `API access denied` pill in the header. Sub-list still shows what's cached from previous successful ticks.
- **Drake's token missing**: the banner above the CSM list explains; rest of the page renders what's in `calendar_events` (possibly stale).

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

## Spec + migration

- Spec: `docs/specs/teams-meeting-tracker.md`
- Migrations: `0033_oauth_tokens.sql`, `0034_calendar_events.sql`
