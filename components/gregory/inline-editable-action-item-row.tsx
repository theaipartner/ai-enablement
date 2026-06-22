'use client'

// Gregory Redesign Part 1 — foundation primitive.
//
// Composes `InlineEditableField` for the three editable cells of an
// action-item row: description (text), owner (select), status (pill).
// The completed-at timestamp is a computed field and renders read-only.
//
// The row owns no save logic of its own — onSave is fired with the
// partial-update payload (just the changed field) and the parent
// decides whether to merge / overwrite / route through its own
// persistence layer. Same primitive contract (optimistic + revert on
// failure) applies per-cell via InlineEditableField.
//
// Conventions: docs/fulfillment/gregory-conventions.md § Inline-editable contract.
// Slot owner: Workflow content slot on /clients/[id] action-items list.
// Tokens consumed: --color-geg-text-3, --color-geg-border,
//   --color-geg-accent.

import type { SaveResult } from './inline-editable-field'
import { InlineEditableField } from './inline-editable-field'

export type ActionItemStatus = 'open' | 'done' | 'cancelled'

export type ActionItem = {
  id: string
  description: string
  owner: string | null
  status: ActionItemStatus
  // Optional completed timestamp; read-only by contract.
  completed_at?: string | null
}

export type ActionItemOwnerOption = {
  readonly value: string
  readonly label: string
}

export type InlineEditableActionItemRowProps = {
  actionItem: ActionItem
  // Available owners for the owner select. Pass the resolved list from
  // the parent (team_members table or whatever the page source-of-truth
  // is). The primitive doesn't fetch.
  owners: ReadonlyArray<ActionItemOwnerOption>
  // Save callback receives the changed-field payload only — the parent
  // decides how to merge it into the canonical record + persist. Same
  // SaveResult shape as InlineEditableField.
  onSave: (
    changes: Partial<Pick<ActionItem, 'description' | 'owner' | 'status'>>,
  ) => Promise<SaveResult>
  // Optional row-level delete affordance. Renders a "Delete" link when
  // provided; the conventions doc says delete is a discrete affordance
  // (not folded into an edit mode).
  onDelete?: () => Promise<SaveResult>
}

const STATUS_OPTIONS: ReadonlyArray<ActionItemOwnerOption> = [
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
] as const

const STATUS_PILL_STYLES: Record<ActionItemStatus, { bg: string; fg: string; label: string }> = {
  open: {
    bg: 'rgba(0, 102, 255, 0.16)',
    fg: '#5ea4ff',
    label: 'Open',
  },
  done: {
    bg: 'rgba(245, 244, 239, 0.10)',
    fg: 'rgba(245, 244, 239, 0.60)',
    label: 'Done',
  },
  cancelled: {
    bg: 'rgba(255, 107, 71, 0.16)',
    fg: '#ff6b47',
    label: 'Cancelled',
  },
}

export function InlineEditableActionItemRow({
  actionItem,
  owners,
  onSave,
  onDelete,
}: InlineEditableActionItemRowProps) {
  return (
    <div
      className="flex items-center gap-4"
      style={{
        paddingTop: 12,
        paddingBottom: 12,
        borderBottom: '1px solid var(--color-geg-border)',
      }}
    >
      {/* Description — text input, expands to fill the row. */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <InlineEditableField
          value={actionItem.description}
          onSave={(next) => onSave({ description: next ?? '' })}
          type="text"
          placeholder="Untitled action item"
        />
      </div>

      {/* Owner — select with the parent-resolved owner list. */}
      <div style={{ width: 180, flexShrink: 0 }}>
        <InlineEditableField
          value={actionItem.owner}
          onSave={(next) => onSave({ owner: next })}
          type="select"
          options={owners}
          placeholder="Unassigned"
        />
      </div>

      {/* Status — pill-rendered select. Display mode shows the colored
          pill; edit mode shows the same <select> with the same options. */}
      <div style={{ width: 130, flexShrink: 0 }}>
        <InlineEditableField
          value={actionItem.status}
          onSave={(next) =>
            onSave({ status: (next ?? 'open') as ActionItemStatus })
          }
          type="pill"
          options={STATUS_OPTIONS}
          renderDisplay={(raw) => {
            const status = (raw ?? 'open') as ActionItemStatus
            const s = STATUS_PILL_STYLES[status] ?? STATUS_PILL_STYLES.open
            return (
              <span
                role="status"
                aria-label={`Status: ${s.label}`}
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium"
                style={{ background: s.bg, color: s.fg }}
              >
                {s.label}
              </span>
            )
          }}
        />
      </div>

      {/* Computed completed-at — read-only by contract. */}
      <div
        style={{
          width: 110,
          flexShrink: 0,
          color: 'var(--color-geg-text-3)',
          fontSize: 12,
        }}
      >
        {actionItem.completed_at ? (
          <time dateTime={actionItem.completed_at}>
            {new Date(actionItem.completed_at).toLocaleDateString('en-US', {
              month: 'short',
              day: 'numeric',
            })}
          </time>
        ) : (
          <span aria-hidden>—</span>
        )}
      </div>

      {/* Discrete delete affordance — never folded into the edit mode. */}
      {onDelete ? (
        <button
          type="button"
          onClick={() => void onDelete()}
          className="text-xs hover:underline"
          style={{
            color: 'var(--color-geg-text-3)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
          }}
        >
          Delete
        </button>
      ) : null}
    </div>
  )
}
