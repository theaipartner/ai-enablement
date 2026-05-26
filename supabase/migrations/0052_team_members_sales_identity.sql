-- Sales-team cross-system identity on team_members.
--
-- The appointment-setting dashboard needs to know "is this user a
-- setter or a closer?" and resolve a Close user_id to an agency
-- person + their Airtable identity. Before this migration the answer
-- was distributed across three layers:
--   - close_leads owner sets (only ~30% coverage)
--   - PRIMARY_ROLE_OVERRIDE hardcoded map in funnel-appointment-setting.ts
--   - MANUAL_SETTERS hardcoded array (added for Victoria, who has
--     zero Close calls in our mirror)
-- Adding the canonical mapping here lets the dashboard read one table.
--
-- Columns:
--   - close_user_id      Close's `user_XXX...` id. Partial-unique
--                        among non-archived rows (matches the
--                        email/slack_user_id pattern in migration 0007).
--   - airtable_user_id   Whatever per-team-member ID the sales
--                        Airtable base maintains. Currently a `rec*`
--                        record ID into an internal Team Members
--                        table (NOT Airtable's built-in `usr*` user
--                        accounts). Partial-unique.
--   - sales_role         Setter / closer / other (or NULL for the
--                        majority of team_members who aren't sales).
--                        Separate concern from the free-text `role`
--                        column (job function) and the `access_tier`
--                        column (dashboard permissions).
--
-- All three columns default NULL so existing rows are unaffected.

ALTER TABLE team_members
  ADD COLUMN close_user_id text,
  ADD COLUMN airtable_user_id text,
  ADD COLUMN sales_role text;

ALTER TABLE team_members
  ADD CONSTRAINT team_members_sales_role_check
  CHECK (sales_role IS NULL OR sales_role IN ('setter', 'closer', 'other'));

CREATE UNIQUE INDEX team_members_close_user_id_active_idx
  ON team_members (close_user_id)
  WHERE close_user_id IS NOT NULL AND archived_at IS NULL;

CREATE UNIQUE INDEX team_members_airtable_user_id_active_idx
  ON team_members (airtable_user_id)
  WHERE airtable_user_id IS NOT NULL AND archived_at IS NULL;
