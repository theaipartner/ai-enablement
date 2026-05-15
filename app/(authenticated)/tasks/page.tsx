import { redirect } from 'next/navigation'
import { HeaderBand } from '@/components/gregory/header-band'
import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'
import { createAdminClient } from '@/lib/supabase/admin'
import { TaskList, type Task } from './task-list'

// /tasks — single-user personal task list for the Director (creator
// tier). Sub-layout gates the route; this page re-resolves the user
// to fetch their team_member_id and the row set.
//
// Spec: docs/specs/director-tasks-and-list-ux-polish.md.

export default async function TasksPage() {
  if (process.env.NEXT_PUBLIC_DISABLE_AUTH === 'true') {
    // Preview path: render an empty list with no DB read. The layout
    // already short-circuits, but the page would still hit the admin
    // client without this branch.
    return <TasksPageBody tasks={[]} />
  }

  const access = await getCurrentUserAccessTier()
  if (!access) {
    redirect('/login?error=no_team_member_row')
  }

  const supabase = createAdminClient()
  const { data } = await supabase
    .from('director_tasks')
    .select('id, title, done, done_at, created_at')
    .eq('team_member_id', access.team_member.id)
    .order('created_at', { ascending: false })
  const tasks: Task[] = (data ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    done: row.done,
    done_at: row.done_at,
    created_at: row.created_at,
  }))

  return <TasksPageBody tasks={tasks} />
}

function TasksPageBody({ tasks }: { tasks: Task[] }) {
  return (
    <div style={{ padding: '32px 48px 28px', maxWidth: 720 }}>
      <HeaderBand eyebrow="DIRECTOR · TASKS" title="Tasks." />
      <TaskList tasks={tasks} />
    </div>
  )
}
