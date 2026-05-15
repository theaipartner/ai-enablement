-- Director personal task list. V1 is single-user (Drake / creator
-- tier only) but the primitive is keyed by `team_member_id` so future
-- per-user task pages slot in without a schema migration.
--
-- Hard-delete on DELETE — personal task lists don't need soft-archive
-- per spec § Decisions ("It's a personal task list; soft-archive is
-- overkill."). FK cascades on team_member archival so an archived
-- team_member's tasks disappear cleanly with them.
--
-- Index pairs (team_member_id, created_at DESC) for the page query
-- which fetches one user's tasks ordered newest first.
--
-- Spec: docs/specs/director-tasks-and-list-ux-polish.md.

CREATE TABLE director_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id uuid NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  title text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX director_tasks_team_member_created_idx
  ON director_tasks (team_member_id, created_at DESC);
