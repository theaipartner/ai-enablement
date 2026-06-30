# Runbook: Director tasks

Short operational guide for the `/tasks` task page + the underlying `director_tasks` table. Mostly for the case where dashboard access breaks and the task list needs to be inspected or recovered via SQL.

## What it is

`/tasks` is a creator-tier-only single-user task list. The creator-tier user adds personal tasks; each row has a title + a done checkbox + a delete button. No recurring tasks, no categorization, no assignment-to-others, no due dates.

Backed by `director_tasks` (one row per task, FK to `team_members`).

## Access tier

- **Creator**: sees `/tasks` in TopNav + can view + mutate their own tasks.
- **Admin / Head CSM / CSM**: do NOT see the "Tasks" nav link. Direct visit to `/tasks` redirects to `/clients?error=insufficient_access`.

Server actions (`addTaskAction`, `toggleTaskDoneAction`, `deleteTaskAction`) self-check creator-tier — even if a non-creator crafts a request, the action rejects.

## Inspect tasks via SQL

When the dashboard is down or a raw view is needed (replace the email with the creator-tier user's `team_members.email`):

```sql
SELECT id, title, done, done_at, created_at
FROM director_tasks
WHERE team_member_id = (
  SELECT id FROM team_members
  WHERE email = '<creator-email>' AND archived_at IS NULL
)
ORDER BY done ASC, created_at DESC;
```

Open tasks first (done=false), then completed.

## Recover a deleted task

`deleteTaskAction` is a hard DELETE — no soft-archive column to flip back. Recovery options:

1. **Re-add.** It's a personal list; the simplest path is just retyping the task.
2. **Postgres point-in-time recovery via Supabase backups** — only if the deletion was both important and recent. Open the Supabase dashboard → Database → Backups, restore the relevant point to a separate database, dump the table, manually re-insert into prod.

## Add a task via SQL (bypass dashboard)

```sql
INSERT INTO director_tasks (team_member_id, title)
VALUES (
  (SELECT id FROM team_members WHERE email = '<creator-email>' AND archived_at IS NULL),
  'Some task title here'
);
```

The page reflects the row on next render (no caching).

## Mark all open tasks done via SQL

```sql
UPDATE director_tasks
SET done = true, done_at = now()
WHERE team_member_id = (
  SELECT id FROM team_members WHERE email = '<creator-email>'
)
  AND done = false;
```

## Code + schema pointers

- Migration: `supabase/migrations/0036_director_tasks.sql`
- Schema doc: `docs/schema/director_tasks.md`
- Code: `app/(authenticated)/tasks/` (page, layout, actions, task-list)
- TopNav entry: `components/top-nav.tsx` (`requiredTier: 'creator'`)
