# director_tasks

Personal task list for the creator-tier user. V1 surfaces a single-user list at `/tasks`; the table primitive is keyed by `team_member_id` so future per-user task pages slot in without a migration.

## Purpose

A single-user task bucket for the creator-tier user. The V1 ask is intentionally minimal — title field, done checkbox, delete. Recurring tasks, categorization, due dates, reminders, and assignment-to-others all defer to future specs once usage patterns emerge.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK, default `gen_random_uuid()` |
| `team_member_id` | `uuid` | Not null. FK → `team_members.id` ON DELETE CASCADE. Filters rows to the current user on the page query |
| `title` | `text` | Not null. 1-500 char range enforced at the server-action level (not in the schema, since the column's natural ceiling is `text`'s ~1 GB) |
| `done` | `boolean` | Default `false`. Flipped via the toggle action; pairs with `done_at` |
| `done_at` | `timestamptz` | Nullable. Stamped when `done` transitions `false → true`; cleared when `done → false` |
| `created_at` | `timestamptz` | Default `now()`. Primary sort column for the open-task list |

## Indexes

- `director_tasks_team_member_created_idx` — `(team_member_id, created_at DESC)`. Powers the per-user page query (one user's tasks, newest first).

## Relationships

- FK to `team_members` via `team_member_id` (cascade delete). Archiving a team_member via `archived_at` does NOT cascade — that's intentional (archived members' tasks become orphaned but recoverable if the soft-archive ever flips back).

## Populated By

- `app/(authenticated)/tasks/actions.ts:addTaskAction` — server action invoked by the `/tasks` page's add-task input. Validates creator-tier access + non-empty trimmed title + ≤500 chars; inserts a row for the current user.

## Read By

- `app/(authenticated)/tasks/page.tsx` — single per-user query (`WHERE team_member_id = <creator's id>`, ordered by `created_at DESC`). Page renders open-first / done-second; JS-side sorts because the row count is tiny (a single user's personal task list).

## Mutation paths

- `toggleTaskDoneAction(taskId)` — reads current row, flips `done`, stamps or clears `done_at` accordingly. Validates the task belongs to the current user before writing.
- `deleteTaskAction(taskId)` — hard delete. No soft-archive; this is a personal task list and recovery isn't load-bearing. Validates ownership before deleting.

## Access tier

Surfaces only at `/tasks`, which is gated to **creator-tier** via `app/(authenticated)/tasks/layout.tsx`. The TopNav "Tasks" link is hidden for every other tier. Every server action self-checks `getCurrentUserAccessTier().tier === 'creator'` as defense-in-depth.

## Manual SQL — inspecting tasks if dashboard access breaks

```sql
SELECT id, title, done, done_at, created_at
FROM director_tasks
WHERE team_member_id = (
  SELECT id FROM team_members
  WHERE email = '<creator-email>' AND archived_at IS NULL
)
ORDER BY done ASC, created_at DESC;
```

## Origin

Migration `0036_director_tasks.sql`. Operational guide at `docs/runbooks/director_tasks.md`.
