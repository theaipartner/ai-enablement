# oauth_tokens

Per-team-member OAuth credentials for external providers. V1 holds a
single row for the creator-tier Google account; the table primitive is reusable
when additional providers or per-user OAuth becomes needed. That account is
documented in `docs/runbooks/credentials-and-accounts.md` § calendar-sync Google account.

## Purpose

Persistent storage for the access + refresh token pair returned by an
OAuth2 authorization-code flow. Read by background jobs (today: the
Teams Meeting Tracker's `api/teams_calendar_sync_cron.py`) that need to
mint a fresh access token on demand.

The Next.js callback at `/api/auth/google/callback` writes rows here;
both the TS helper `lib/google/oauth.ts:getValidAccessToken` and the
Python helper `shared/google_oauth.get_valid_access_token` read +
refresh.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `team_member_id` | `uuid` | Not null. FK → `team_members.id` ON DELETE CASCADE |
| `provider` | `text` | Not null. CHECK pinned to `('google')` — extend the constraint when adding providers |
| `access_token` | `text` | Not null. Short-lived (Google: ~1 hour) |
| `refresh_token` | `text` | Not null. Long-lived; the durable secret |
| `access_token_expires_at` | `timestamptz` | Not null. When the current `access_token` stops working |
| `scope` | `text` | Not null. Whitespace-separated OAuth scopes the token was minted with |
| `created_at` | `timestamptz` | Default `now()` |
| `updated_at` | `timestamptz` | Default `now()`. Stamped manually on refresh (no trigger) |

## Uniqueness

`UNIQUE (team_member_id, provider)` via the `oauth_tokens_team_member_provider_idx` index. Used as the upsert key on re-OAuth — the new row replaces the old.

## Relationships

- FK to `team_members` via `team_member_id` (cascade delete).
- Read by `api/teams_calendar_sync_cron.py` (Python — `shared/google_oauth.get_valid_access_token`).
- Read + written by `app/api/auth/google/callback/route.ts` (TS — token mint + upsert).

## Populated By

- The Google OAuth callback at `/api/auth/google/callback`, gated to creator-tier.
- Re-OAuth via the same flow overwrites the row in place. There is no automatic refresh — only the cron / TS helpers proactively call Google's `/token` endpoint when the stored `access_token_expires_at` is within 60 seconds of now.

## Security

- Service-role-only access. The Supabase admin client in `lib/supabase/admin.ts` is the sole reader/writer; the anon-key path can't see rows here.
- Tokens are stored in plaintext in the DB. Rationale: V1 simplicity. Future move to encrypted-at-rest would slot in here with no caller change.
- Never logged. The Python + TS refresh paths intentionally truncate or omit response bodies in error logs because Google's error responses can echo a client_secret on misconfiguration.

## Example Queries

Inspect the creator-tier Google token state:

```sql
select team_member_id, provider, access_token_expires_at, scope, updated_at
from oauth_tokens
where team_member_id = (select id from team_members where access_tier = 'creator');
```

Force a refresh on next cron tick (useful for testing):

```sql
update oauth_tokens
set access_token_expires_at = now() - interval '1 hour'
where team_member_id = '<creator-uuid>' and provider = 'google';
```

## Origin

Migration `0033_oauth_tokens.sql`. Operational guide at `docs/runbooks/teams_meeting_tracker.md`.
