-- OAuth token storage per (team_member, provider).
--
-- Teams Meeting Tracker spec (docs/specs/teams-meeting-tracker.md):
-- Drake's Google account is the only configured OAuth identity in V1.
-- Other CSMs share their Calendars with Drake at the Workspace level;
-- one stored token reads everyone's calendar via per-calendarId API
-- calls. The table is keyed by (team_member_id, provider) so the
-- primitive is reusable when additional providers or per-user OAuth
-- becomes useful (V2).
--
-- Access tokens expire (~1 hour for Google); refresh_token is the
-- durable secret. The cron's `getValidAccessToken` mints a fresh
-- access_token on demand and updates this row.

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
