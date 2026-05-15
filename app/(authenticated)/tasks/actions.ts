'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'
import { createAdminClient } from '@/lib/supabase/admin'

// Server actions for the Director task page. Every action self-checks
// creator-tier access (defense in depth — the (authenticated)/tasks
// layout already gates, but server actions are reachable from any
// page and should validate independently).
//
// All three actions revalidate /tasks so the page rerenders with the
// fresh state after each mutation. No optimistic UI on the server
// side; the Client Component handles the perceived snappiness.
//
// Spec: docs/specs/director-tasks-and-list-ux-polish.md.

type ActionResult =
  | { success: true }
  | { success: false; error: string }

async function requireCreator(): Promise<
  { id: string } | { error: string }
> {
  const access = await getCurrentUserAccessTier()
  if (!access || access.tier !== 'creator') {
    return { error: 'insufficient_access' }
  }
  return { id: access.team_member.id }
}

export async function addTaskAction(
  title: string,
): Promise<ActionResult> {
  const trimmed = title.trim()
  if (!trimmed) {
    return { success: false, error: 'Title cannot be empty' }
  }
  if (trimmed.length > 500) {
    return { success: false, error: 'Title is too long (500 char max)' }
  }
  const auth = await requireCreator()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }
  const supabase = createAdminClient()
  const { error } = await supabase.from('director_tasks').insert({
    team_member_id: auth.id,
    title: trimmed,
  })
  if (error) {
    return { success: false, error: error.message }
  }
  revalidatePath('/tasks')
  return { success: true }
}

export async function toggleTaskDoneAction(
  taskId: string,
): Promise<ActionResult> {
  const auth = await requireCreator()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }
  const supabase = createAdminClient()
  // Read current state; we need it to know which way to flip and
  // whether to stamp / clear done_at.
  const { data: task, error: readErr } = await supabase
    .from('director_tasks')
    .select('done, team_member_id')
    .eq('id', taskId)
    .maybeSingle()
  if (readErr || !task) {
    return { success: false, error: readErr?.message ?? 'Task not found' }
  }
  if (task.team_member_id !== auth.id) {
    // Defense in depth — the page only renders the current user's
    // tasks, but a forged client-side request shouldn't be able to
    // toggle another team_member's tasks.
    return { success: false, error: 'Not your task' }
  }
  const nextDone = !task.done
  const { error: writeErr } = await supabase
    .from('director_tasks')
    .update({
      done: nextDone,
      done_at: nextDone ? new Date().toISOString() : null,
    })
    .eq('id', taskId)
  if (writeErr) {
    return { success: false, error: writeErr.message }
  }
  revalidatePath('/tasks')
  return { success: true }
}

export async function deleteTaskAction(
  taskId: string,
): Promise<ActionResult> {
  const auth = await requireCreator()
  if ('error' in auth) {
    return { success: false, error: auth.error }
  }
  const supabase = createAdminClient()
  // Ownership check before delete, same rationale as toggle.
  const { data: task, error: readErr } = await supabase
    .from('director_tasks')
    .select('team_member_id')
    .eq('id', taskId)
    .maybeSingle()
  if (readErr || !task) {
    return { success: false, error: readErr?.message ?? 'Task not found' }
  }
  if (task.team_member_id !== auth.id) {
    return { success: false, error: 'Not your task' }
  }
  const { error: deleteErr } = await supabase
    .from('director_tasks')
    .delete()
    .eq('id', taskId)
  if (deleteErr) {
    return { success: false, error: deleteErr.message }
  }
  revalidatePath('/tasks')
  return { success: true }
}
