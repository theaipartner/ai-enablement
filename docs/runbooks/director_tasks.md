# Runbook: Director tasks

Short operational guide for the `/tasks` Director task page + the underlying `director_tasks` table. Mostly for the case where dashboard access breaks and Drake needs to inspect or recover his task list via SQL.

## What it is

`/tasks` is a creator-tier-only single-user task list. Drake adds personal tasks; each row has a title + a done checkbox + a delete button. No recurring tasks, no categorization, no assignment-to-others, no due dates — those defer to future specs.

Backed by `director_tasks` (one row per task, FK to `team_members`).

## Access tier

- **Creator** (Drake): sees `/tasks` in TopNav + can view + mutate his own tasks.
- **Admin / Head CSM / CSM**: do NOT see the "Tasks" nav link. Direct visit to `/tasks` redirects to `/clients?error=insufficient_access`.

Server actions (`addTaskAction`, `toggleTaskDoneAction`, `deleteTaskAction`) self-check creator-tier — even if a non-creator crafts a request, the action rejects.

## Inspect Drake's tasks via SQL

When the dashboard is down or Drake wants a raw view:

```sql
SELECT id, title, done, done_at, created_at
FROM director_tasks
WHERE team_member_id = (
  SELECT id FROM team_members
  WHERE email = 'drake@theaipartner.io' AND archived_at IS NULL
)
ORDER BY done ASC, created_at DESC;
```

Open tasks first (done=false), then completed.

## Recover a deleted task

`deleteTaskAction` is a hard DELETE — no soft-archive column to flip back. Recovery options:

1. **Memory / re-add.** It's a personal list; the simplest path is just retyping the task.
2. **Postgres point-in-time recovery via Supabase backups** — only if the deletion was both important and recent. Open the Supabase dashboard → Database → Backups, restore the relevant point to a separate database, dump the table, manually re-insert into prod.

## Add a task via SQL (bypass dashboard)

```sql
INSERT INTO director_tasks (team_member_id, title)
VALUES (
  (SELECT id FROM team_members WHERE email = 'drake@theaipartner.io' AND archived_at IS NULL),
  'Some task title here'
);
```

The page reflects the row on next render (no caching).

## Mark all open tasks done via SQL

Rare but useful for end-of-day batch cleanup:

```sql
UPDATE director_tasks
SET done = true, done_at = now()
WHERE team_member_id = (
  SELECT id FROM team_members WHERE email = 'drake@theaipartner.io'
)
  AND done = false;
```

## Future spec backlog

The current shape is V1 minimum. Surface area that doesn't ship today but might later:

- **Edit task title in place.** Today: delete + re-add. Add an inline editor when titles drift more than expected.
- **Recurring tasks** (daily / weekly). Probably a separate `task_recurrences` table referencing this one.
- **Due dates + overdue indicators.** Light addition; nullable `due_date` column + a "overdue" filter.
- **Per-user pages** for other tiers. The team_member_id keying is already there; gating the page to all tiers + filtering each user to their own row set is straightforward.
- **Categorization / projects.** Tag column or a separate task_lists table for grouping.

## Spec + code pointers

- Spec: `docs/specs/director-tasks-and-list-ux-polish.md`
- Migration: `supabase/migrations/0036_director_tasks.sql`
- Schema doc: `docs/schema/director_tasks.md`
- Code: `app/(authenticated)/tasks/` (page, layout, actions, task-list)
- TopNav entry: `components/top-nav.tsx` (`requiredTier: 'creator'`)
