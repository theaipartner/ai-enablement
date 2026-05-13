'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  commitPendingActionItemChanges,
  deleteActionItem,
} from './action-item-actions'

// Calls redesign · § 2 — Action items box (left column, bottom).
//
// Renders each open action item as an editable text line + X delete.
// "Confirm" applies pending edits + deletes server-side and redirects
// to the primary-client detail page.

export type ActionItemRow = {
  id: string
  description: string
}

type PendingEdit = {
  itemId: string
  newDescription: string
}

export function ActionItemsBox({
  callId,
  items,
}: {
  callId: string
  items: ActionItemRow[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // Pending state lives client-side until Confirm. Optimistic delete:
  // an id in `deletedIds` is hidden from the list immediately and
  // included in the server-action's deletes array on Confirm.
  const [draftById, setDraftById] = useState<Record<string, string>>({})
  const [deletedIds, setDeletedIds] = useState<Set<string>>(new Set())

  const visibleItems = items.filter((it) => !deletedIds.has(it.id))

  function onDraftChange(itemId: string, value: string) {
    setDraftById((prev) => ({ ...prev, [itemId]: value }))
  }

  async function onDelete(itemId: string) {
    setError(null)
    // Eager hide. Server delete fires on Confirm — the action-item-actions
    // also exports a standalone deleteActionItem for surfaces that want
    // immediate persistence; here we batch via Confirm.
    setDeletedIds((prev) => {
      const next = new Set(prev)
      next.add(itemId)
      return next
    })
    // Also fire the standalone delete immediately to keep the X-click
    // feel responsive even if the user never hits Confirm. The Confirm
    // re-delete is a no-op (the row is already gone). Wrapped in
    // best-effort try/catch — visual state is already updated, so a
    // race-with-server failure surfaces on the next list refresh.
    try {
      await deleteActionItem(itemId)
    } catch (err) {
      // Roll back the optimistic hide on failure so the user can retry.
      setDeletedIds((prev) => {
        const next = new Set(prev)
        next.delete(itemId)
        return next
      })
      setError(err instanceof Error ? err.message : 'Delete failed')
    }
  }

  function onConfirm() {
    setError(null)
    const edits: PendingEdit[] = []
    for (const item of items) {
      if (deletedIds.has(item.id)) continue
      const draft = draftById[item.id]
      if (draft !== undefined && draft.trim() !== item.description.trim()) {
        edits.push({ itemId: item.id, newDescription: draft })
      }
    }
    const deletes = Array.from(deletedIds)
    startTransition(async () => {
      const result = await commitPendingActionItemChanges(callId, edits, deletes)
      if (!result.success) {
        setError(result.error)
        return
      }
      router.push(result.redirectUrl)
    })
  }

  if (visibleItems.length === 0) {
    return (
      <div
        style={{
          color: 'var(--color-geg-text-2)',
          fontSize: 13,
          fontStyle: 'italic',
        }}
      >
        No action items extracted from this call.
      </div>
    )
  }

  return (
    <>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
          flex: 1,
          overflowY: 'auto',
          minHeight: 0,
        }}
      >
        {visibleItems.map((item) => {
          const draft = draftById[item.id] ?? item.description
          return (
            <li
              key={item.id}
              className="geg-action-item"
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                padding: '11px 4px 11px 0',
                borderBottom: '1px solid rgba(160, 136, 80, 0.15)',
                fontSize: 13,
                lineHeight: 1.45,
                color: 'var(--color-geg-text)',
              }}
            >
              <input
                value={draft}
                onChange={(e) => onDraftChange(item.id, e.target.value)}
                className="geg-action-item-input"
                style={{
                  flex: 1,
                  background: 'transparent',
                  border: 'none',
                  outline: 'none',
                  color: 'var(--color-geg-text)',
                  font: 'inherit',
                  padding: 0,
                }}
              />
              <button
                type="button"
                onClick={() => onDelete(item.id)}
                aria-label="Delete action item"
                className="geg-action-item-x"
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 4,
                  border: '1px solid transparent',
                  background: 'transparent',
                  color: 'var(--color-geg-text-faint)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  cursor: 'pointer',
                  fontFamily:
                    'var(--font-geg-mono, "JetBrains Mono", ui-monospace, monospace)',
                  fontSize: 13,
                  lineHeight: 1,
                  flexShrink: 0,
                }}
              >
                ×
              </button>
            </li>
          )
        })}
      </ul>
      <button
        type="button"
        onClick={onConfirm}
        disabled={isPending}
        className="geg-confirm-btn"
        style={{
          marginTop: 14,
          alignSelf: 'flex-start',
          background: 'var(--color-geg-accent)',
          color: '#0b0a09',
          fontFamily: 'var(--font-prom-sans, "Inter", system-ui, sans-serif)',
          fontSize: 12,
          fontWeight: 600,
          letterSpacing: '0.06em',
          textTransform: 'uppercase',
          padding: '9px 18px',
          border: '1px solid var(--color-geg-accent)',
          borderRadius: 6,
          cursor: isPending ? 'wait' : 'pointer',
          opacity: isPending ? 0.6 : 1,
        }}
      >
        {isPending ? 'Saving…' : 'Confirm →'}
      </button>
      {error ? (
        <p
          style={{
            marginTop: 8,
            fontSize: 12,
            color: 'var(--color-geg-neg)',
          }}
        >
          {error}
        </p>
      ) : null}
    </>
  )
}
