'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  addCostExtraAction,
  addMonthlySubscriptionAction,
  deleteCostExtraAction,
  deleteMonthlySubscriptionAction,
  updateCostExtraAction,
  updateMonthlySubscriptionAction,
} from './actions'

// Client Component for the cost-hub editable tables. Two surfaces:
// monthly_subscriptions + cost_extras. Both follow the same pattern:
// add-row inline form, per-row edit toggle (display → input mode),
// delete with confirm(), optimistic via useTransition + router.refresh().
//
// Mirrors the TaskList component shape but with multi-field inputs
// per row (provider/cost/notes for subs; date/desc/cost for extras).

export type SubscriptionRow = {
  id: string
  provider: string
  monthly_cost_usd: number
  notes: string | null
}

export type CostExtraRow = {
  id: string
  incurred_on: string // YYYY-MM-DD
  description: string
  cost_usd: number
}

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

// ---------------------------------------------------------------------------
// Monthly subscriptions table
// ---------------------------------------------------------------------------

export function MonthlySubscriptionsTable({
  rows,
}: {
  rows: SubscriptionRow[]
}) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftProvider, setDraftProvider] = useState('')
  const [draftCost, setDraftCost] = useState('')
  const [draftNotes, setDraftNotes] = useState('')

  function submitAdd(event: React.FormEvent) {
    event.preventDefault()
    const provider = draftProvider.trim()
    const cost = Number.parseFloat(draftCost)
    if (!provider || !Number.isFinite(cost)) return
    setError(null)
    startTransition(async () => {
      const result = await addMonthlySubscriptionAction(
        provider,
        cost,
        draftNotes.trim() || null,
      )
      if (result.success) {
        setDraftProvider('')
        setDraftCost('')
        setDraftNotes('')
        router.refresh()
      } else {
        setError(result.error)
      }
    })
  }

  function onSaveEdit(id: string, provider: string, cost: number, notes: string | null) {
    setError(null)
    startTransition(async () => {
      const result = await updateMonthlySubscriptionAction(id, provider, cost, notes)
      if (result.success) {
        setEditingId(null)
        router.refresh()
      } else {
        setError(result.error)
      }
    })
  }

  function onDelete(id: string, provider: string) {
    if (!confirm(`Delete subscription "${provider}"? It will be soft-archived (recoverable via SQL).`)) {
      return
    }
    setError(null)
    startTransition(async () => {
      const result = await deleteMonthlySubscriptionAction(id)
      if (!result.success) {
        setError(result.error)
      }
      router.refresh()
    })
  }

  const total = rows.reduce((sum, r) => sum + r.monthly_cost_usd, 0)

  return (
    <div>
      <form
        onSubmit={submitAdd}
        style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 3fr auto',
          gap: 8,
          marginBottom: 16,
        }}
      >
        <input
          type="text"
          value={draftProvider}
          onChange={(e) => setDraftProvider(e.target.value)}
          placeholder="Provider"
          maxLength={200}
          className="geg-filter-input"
          disabled={isPending}
        />
        <input
          type="number"
          step="0.01"
          min="0"
          value={draftCost}
          onChange={(e) => setDraftCost(e.target.value)}
          placeholder="Monthly cost USD"
          className="geg-filter-input"
          disabled={isPending}
        />
        <input
          type="text"
          value={draftNotes}
          onChange={(e) => setDraftNotes(e.target.value)}
          placeholder="Notes (optional)"
          maxLength={1000}
          className="geg-filter-input"
          disabled={isPending}
        />
        <button
          type="submit"
          disabled={isPending || !draftProvider.trim() || !draftCost}
          style={{
            padding: '6px 14px',
            fontSize: 13,
            background: 'var(--color-geg-accent-fill)',
            border: '1px solid var(--color-geg-accent-border)',
            color: 'var(--color-geg-text)',
            borderRadius: 4,
            cursor: isPending ? 'wait' : 'pointer',
          }}
        >
          Add
        </button>
      </form>
      {error ? (
        <p
          role="alert"
          style={{ color: 'var(--color-geg-warn)', fontSize: 12, marginBottom: 8 }}
        >
          {error}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p
          className="geg-mono"
          style={{
            fontSize: 12,
            color: 'var(--color-geg-text-3)',
            fontStyle: 'italic',
            padding: '12px 0',
          }}
        >
          No subscriptions yet.
        </p>
      ) : (
        <div>
          {rows.map((row) => (
            <SubscriptionRowCmp
              key={row.id}
              row={row}
              isEditing={editingId === row.id}
              onStartEdit={() => setEditingId(row.id)}
              onCancelEdit={() => setEditingId(null)}
              onSave={(provider, cost, notes) =>
                onSaveEdit(row.id, provider, cost, notes)
              }
              onDelete={() => onDelete(row.id, row.provider)}
              disabled={isPending}
            />
          ))}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '12px 0 4px',
              borderTop: '1px solid var(--color-geg-accent-border)',
              marginTop: 8,
            }}
          >
            <span
              className="geg-mono"
              style={{
                fontSize: 11,
                color: 'var(--color-geg-text-2)',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
              }}
            >
              Total / month
            </span>
            <span
              className="geg-mono"
              style={{ fontSize: 14, color: 'var(--color-geg-text)' }}
            >
              {formatUsd(total)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function SubscriptionRowCmp({
  row,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSave,
  onDelete,
  disabled,
}: {
  row: SubscriptionRow
  isEditing: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: (provider: string, cost: number, notes: string | null) => void
  onDelete: () => void
  disabled: boolean
}) {
  const [provider, setProvider] = useState(row.provider)
  const [cost, setCost] = useState(String(row.monthly_cost_usd))
  const [notes, setNotes] = useState(row.notes ?? '')

  if (isEditing) {
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 3fr auto auto',
          gap: 8,
          alignItems: 'center',
          padding: '8px 0',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        <input
          type="text"
          value={provider}
          onChange={(e) => setProvider(e.target.value)}
          maxLength={200}
          className="geg-filter-input"
        />
        <input
          type="number"
          step="0.01"
          min="0"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          className="geg-filter-input"
        />
        <input
          type="text"
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          maxLength={1000}
          className="geg-filter-input"
        />
        <button
          onClick={() => {
            const parsedCost = Number.parseFloat(cost)
            if (provider.trim() && Number.isFinite(parsedCost)) {
              onSave(provider.trim(), parsedCost, notes.trim() || null)
            }
          }}
          disabled={disabled}
          style={{
            padding: '4px 10px',
            fontSize: 12,
            background: 'var(--color-geg-accent-fill)',
            border: '1px solid var(--color-geg-accent-border)',
            color: 'var(--color-geg-text)',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Save
        </button>
        <button
          onClick={onCancelEdit}
          disabled={disabled}
          style={{
            padding: '4px 10px',
            fontSize: 12,
            background: 'transparent',
            border: '1px solid var(--color-geg-border)',
            color: 'var(--color-geg-text-3)',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '2fr 1fr 3fr auto auto',
        gap: 8,
        alignItems: 'center',
        padding: '10px 0',
        borderBottom: '1px solid var(--color-geg-border)',
      }}
    >
      <span style={{ fontSize: 14, color: 'var(--color-geg-text)' }}>
        {row.provider}
      </span>
      <span
        className="geg-mono"
        style={{ fontSize: 13, color: 'var(--color-geg-text)' }}
      >
        {formatUsd(row.monthly_cost_usd)}
      </span>
      <span
        style={{
          fontSize: 13,
          color: 'var(--color-geg-text-3)',
          fontStyle: row.notes ? 'normal' : 'italic',
        }}
      >
        {row.notes ?? '(no notes)'}
      </span>
      <button
        onClick={onStartEdit}
        disabled={disabled}
        style={{
          padding: '4px 10px',
          fontSize: 12,
          background: 'transparent',
          border: '1px solid var(--color-geg-border)',
          color: 'var(--color-geg-text-2)',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        Edit
      </button>
      <button
        onClick={onDelete}
        disabled={disabled}
        className="geg-action-item-x"
        style={{
          padding: '4px 10px',
          fontSize: 14,
          background: 'transparent',
          border: '1px solid var(--color-geg-border)',
          color: 'var(--color-geg-text-3)',
          borderRadius: 4,
          cursor: 'pointer',
        }}
        aria-label={`Delete ${row.provider}`}
      >
        ×
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Cost extras table — same shape, different input columns
// ---------------------------------------------------------------------------

function todayIsoDate(): string {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(now)
}

export function CostExtrasTable({ rows }: { rows: CostExtraRow[] }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const [editingId, setEditingId] = useState<string | null>(null)
  const [draftDate, setDraftDate] = useState(todayIsoDate())
  const [draftDesc, setDraftDesc] = useState('')
  const [draftCost, setDraftCost] = useState('')

  function submitAdd(event: React.FormEvent) {
    event.preventDefault()
    const desc = draftDesc.trim()
    const cost = Number.parseFloat(draftCost)
    if (!desc || !Number.isFinite(cost) || !draftDate) return
    setError(null)
    startTransition(async () => {
      const result = await addCostExtraAction(draftDate, desc, cost)
      if (result.success) {
        setDraftDate(todayIsoDate())
        setDraftDesc('')
        setDraftCost('')
        router.refresh()
      } else {
        setError(result.error)
      }
    })
  }

  function onSaveEdit(id: string, date: string, desc: string, cost: number) {
    setError(null)
    startTransition(async () => {
      const result = await updateCostExtraAction(id, date, desc, cost)
      if (result.success) {
        setEditingId(null)
        router.refresh()
      } else {
        setError(result.error)
      }
    })
  }

  function onDelete(id: string, description: string) {
    if (!confirm(`Delete extra "${description}"? It will be soft-archived (recoverable via SQL).`)) {
      return
    }
    setError(null)
    startTransition(async () => {
      const result = await deleteCostExtraAction(id)
      if (!result.success) {
        setError(result.error)
      }
      router.refresh()
    })
  }

  const total = rows.reduce((sum, r) => sum + r.cost_usd, 0)

  return (
    <div>
      <form
        onSubmit={submitAdd}
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 3fr 1fr auto',
          gap: 8,
          marginBottom: 16,
        }}
      >
        <input
          type="date"
          value={draftDate}
          onChange={(e) => setDraftDate(e.target.value)}
          className="geg-filter-input"
          disabled={isPending}
        />
        <input
          type="text"
          value={draftDesc}
          onChange={(e) => setDraftDesc(e.target.value)}
          placeholder="Description"
          maxLength={500}
          className="geg-filter-input"
          disabled={isPending}
        />
        <input
          type="number"
          step="0.01"
          min="0"
          value={draftCost}
          onChange={(e) => setDraftCost(e.target.value)}
          placeholder="Cost USD"
          className="geg-filter-input"
          disabled={isPending}
        />
        <button
          type="submit"
          disabled={isPending || !draftDesc.trim() || !draftCost || !draftDate}
          style={{
            padding: '6px 14px',
            fontSize: 13,
            background: 'var(--color-geg-accent-fill)',
            border: '1px solid var(--color-geg-accent-border)',
            color: 'var(--color-geg-text)',
            borderRadius: 4,
            cursor: isPending ? 'wait' : 'pointer',
          }}
        >
          Add
        </button>
      </form>
      {error ? (
        <p
          role="alert"
          style={{ color: 'var(--color-geg-warn)', fontSize: 12, marginBottom: 8 }}
        >
          {error}
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p
          className="geg-mono"
          style={{
            fontSize: 12,
            color: 'var(--color-geg-text-3)',
            fontStyle: 'italic',
            padding: '12px 0',
          }}
        >
          No extras this month yet.
        </p>
      ) : (
        <div>
          {rows.map((row) => (
            <ExtraRowCmp
              key={row.id}
              row={row}
              isEditing={editingId === row.id}
              onStartEdit={() => setEditingId(row.id)}
              onCancelEdit={() => setEditingId(null)}
              onSave={(date, desc, cost) =>
                onSaveEdit(row.id, date, desc, cost)
              }
              onDelete={() => onDelete(row.id, row.description)}
              disabled={isPending}
            />
          ))}
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '12px 0 4px',
              borderTop: '1px solid var(--color-geg-accent-border)',
              marginTop: 8,
            }}
          >
            <span
              className="geg-mono"
              style={{
                fontSize: 11,
                color: 'var(--color-geg-text-2)',
                textTransform: 'uppercase',
                letterSpacing: '0.12em',
              }}
            >
              Total this month
            </span>
            <span
              className="geg-mono"
              style={{ fontSize: 14, color: 'var(--color-geg-text)' }}
            >
              {formatUsd(total)}
            </span>
          </div>
        </div>
      )}
    </div>
  )
}

function ExtraRowCmp({
  row,
  isEditing,
  onStartEdit,
  onCancelEdit,
  onSave,
  onDelete,
  disabled,
}: {
  row: CostExtraRow
  isEditing: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: (date: string, desc: string, cost: number) => void
  onDelete: () => void
  disabled: boolean
}) {
  const [date, setDate] = useState(row.incurred_on)
  const [desc, setDesc] = useState(row.description)
  const [cost, setCost] = useState(String(row.cost_usd))

  if (isEditing) {
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 3fr 1fr auto auto',
          gap: 8,
          alignItems: 'center',
          padding: '8px 0',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="geg-filter-input"
        />
        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          maxLength={500}
          className="geg-filter-input"
        />
        <input
          type="number"
          step="0.01"
          min="0"
          value={cost}
          onChange={(e) => setCost(e.target.value)}
          className="geg-filter-input"
        />
        <button
          onClick={() => {
            const parsedCost = Number.parseFloat(cost)
            if (date && desc.trim() && Number.isFinite(parsedCost)) {
              onSave(date, desc.trim(), parsedCost)
            }
          }}
          disabled={disabled}
          style={{
            padding: '4px 10px',
            fontSize: 12,
            background: 'var(--color-geg-accent-fill)',
            border: '1px solid var(--color-geg-accent-border)',
            color: 'var(--color-geg-text)',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Save
        </button>
        <button
          onClick={onCancelEdit}
          disabled={disabled}
          style={{
            padding: '4px 10px',
            fontSize: 12,
            background: 'transparent',
            border: '1px solid var(--color-geg-border)',
            color: 'var(--color-geg-text-3)',
            borderRadius: 4,
            cursor: 'pointer',
          }}
        >
          Cancel
        </button>
      </div>
    )
  }

  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1fr 3fr 1fr auto auto',
        gap: 8,
        alignItems: 'center',
        padding: '10px 0',
        borderBottom: '1px solid var(--color-geg-border)',
      }}
    >
      <span
        className="geg-mono"
        style={{ fontSize: 13, color: 'var(--color-geg-text-2)' }}
      >
        {row.incurred_on}
      </span>
      <span style={{ fontSize: 14, color: 'var(--color-geg-text)' }}>
        {row.description}
      </span>
      <span
        className="geg-mono"
        style={{ fontSize: 13, color: 'var(--color-geg-text)' }}
      >
        {formatUsd(row.cost_usd)}
      </span>
      <button
        onClick={onStartEdit}
        disabled={disabled}
        style={{
          padding: '4px 10px',
          fontSize: 12,
          background: 'transparent',
          border: '1px solid var(--color-geg-border)',
          color: 'var(--color-geg-text-2)',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        Edit
      </button>
      <button
        onClick={onDelete}
        disabled={disabled}
        className="geg-action-item-x"
        style={{
          padding: '4px 10px',
          fontSize: 14,
          background: 'transparent',
          border: '1px solid var(--color-geg-border)',
          color: 'var(--color-geg-text-3)',
          borderRadius: 4,
          cursor: 'pointer',
        }}
        aria-label={`Delete ${row.description}`}
      >
        ×
      </button>
    </div>
  )
}
