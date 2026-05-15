'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  addTaskAction,
  deleteTaskAction,
  toggleTaskDoneAction,
} from './actions'

// Client component for the Director task page. Server fetches the
// task list + passes it as a prop; this component owns the add input
// state, optimistic toggles, and the per-row delete buttons.
//
// Optimistic UI: each action sets a transient state immediately, then
// router.refresh() pulls the canonical server state on completion.
// If the action fails, the displayed error overrides the optimistic
// state and the next refresh corrects.

export type Task = {
  id: string
  title: string
  done: boolean
  done_at: string | null
  created_at: string
}

export function TaskList({ tasks }: { tasks: Task[] }) {
  const router = useRouter()
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const value = draft.trim()
    if (!value) return
    setError(null)
    startTransition(async () => {
      const result = await addTaskAction(value)
      if (result.success) {
        setDraft('')
        router.refresh()
      } else {
        setError(result.error)
      }
    })
  }

  function onToggle(taskId: string) {
    setError(null)
    startTransition(async () => {
      const result = await toggleTaskDoneAction(taskId)
      if (!result.success) {
        setError(result.error)
      }
      router.refresh()
    })
  }

  function onDelete(taskId: string) {
    setError(null)
    startTransition(async () => {
      const result = await deleteTaskAction(taskId)
      if (!result.success) {
        setError(result.error)
      }
      router.refresh()
    })
  }

  // Open tasks first (created_at desc — newest at top), then done
  // tasks (done_at desc — most-recently-completed first). Done block
  // visually dims + strikes through to keep open tasks the focus.
  const openTasks = tasks
    .filter((t) => !t.done)
    .sort((a, b) =>
      a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0,
    )
  const doneTasks = tasks
    .filter((t) => t.done)
    .sort((a, b) => {
      const ad = a.done_at ?? ''
      const bd = b.done_at ?? ''
      return ad < bd ? 1 : ad > bd ? -1 : 0
    })

  return (
    <div style={{ marginTop: 24 }}>
      <form onSubmit={submit} style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Add a task and press Enter…"
          maxLength={500}
          className="geg-filter-input"
          style={{ flex: 1 }}
          disabled={isPending}
        />
      </form>

      {error ? (
        <p
          role="alert"
          className="text-sm"
          style={{
            color: 'var(--color-geg-warn)',
            marginTop: 8,
          }}
        >
          {error}
        </p>
      ) : null}

      <div style={{ marginTop: 24 }}>
        {openTasks.length === 0 && doneTasks.length === 0 ? (
          <p
            className="geg-mono"
            style={{
              fontSize: 12,
              color: 'var(--color-geg-text-3)',
              fontStyle: 'italic',
              padding: '24px 0',
            }}
          >
            No tasks yet. Add one above.
          </p>
        ) : null}

        {openTasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onToggle={() => onToggle(task.id)}
            onDelete={() => onDelete(task.id)}
          />
        ))}

        {doneTasks.length > 0 ? (
          <div
            className="geg-eyebrow"
            style={{
              marginTop: 24,
              marginBottom: 8,
              color: 'var(--color-geg-text-3)',
            }}
          >
            DONE · {doneTasks.length}
          </div>
        ) : null}
        {doneTasks.map((task) => (
          <TaskRow
            key={task.id}
            task={task}
            onToggle={() => onToggle(task.id)}
            onDelete={() => onDelete(task.id)}
          />
        ))}
      </div>
    </div>
  )
}

function TaskRow({
  task,
  onToggle,
  onDelete,
}: {
  task: Task
  onToggle: () => void
  onDelete: () => void
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 0',
        borderBottom: '1px solid var(--color-geg-border)',
        opacity: task.done ? 0.6 : 1,
      }}
    >
      <input
        type="checkbox"
        checked={task.done}
        onChange={onToggle}
        aria-label={
          task.done ? `Mark ${task.title} undone` : `Mark ${task.title} done`
        }
        style={{
          width: 16,
          height: 16,
          accentColor: 'var(--color-geg-accent)',
          cursor: 'pointer',
        }}
      />
      <span
        style={{
          flex: 1,
          fontSize: 14,
          color: 'var(--color-geg-text)',
          textDecoration: task.done ? 'line-through' : 'none',
          fontFamily: task.done
            ? 'var(--font-geg-mono, "JetBrains Mono", monospace)'
            : undefined,
        }}
      >
        {task.title}
      </span>
      <button
        onClick={onDelete}
        aria-label={`Delete ${task.title}`}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--color-geg-text-3)',
          fontSize: 16,
          cursor: 'pointer',
          padding: '4px 8px',
        }}
      >
        ×
      </button>
    </div>
  )
}
