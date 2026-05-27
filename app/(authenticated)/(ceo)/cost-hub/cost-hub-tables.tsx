'use client'

import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import {
  addCostExtraAction,
  addMonthlySubscriptionAction,
  cancelMonthlySubscriptionAction,
  removeCostExtraAction,
  removeMonthlySubscriptionAction,
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
  effective_from: string // YYYY-MM-DD
  // True for rows that have been Cancelled (soft-archived) but are
  // still counted in the current month (archived_at >= monthStart).
  // Renders with a "cancelled" badge + non-editable; the × menu offers
  // only Remove (Cancel already happened). Part 2 of spec
  // `cost-hub-total-cancel-remove-and-add` (2026-05-24): the visible
  // subscriptions list = active + cancelled-this-month so its visible
  // costs sum to the subscriptions portion of the running total.
  is_cancelled: boolean
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
  const [draftEffectiveFrom, setDraftEffectiveFrom] = useState(todayIsoDate())

  function submitAdd(event: React.FormEvent) {
    event.preventDefault()
    const provider = draftProvider.trim()
    const cost = Number.parseFloat(draftCost)
    if (!provider || !Number.isFinite(cost) || !draftEffectiveFrom) return
    setError(null)
    startTransition(async () => {
      const result = await addMonthlySubscriptionAction(
        provider,
        cost,
        draftNotes.trim() || null,
        draftEffectiveFrom,
      )
      if (result.success) {
        setDraftProvider('')
        setDraftCost('')
        setDraftNotes('')
        setDraftEffectiveFrom(todayIsoDate())
        router.refresh()
      } else {
        setError(result.error)
      }
    })
  }

  function onSaveEdit(
    id: string,
    provider: string,
    cost: number,
    notes: string | null,
    effectiveFrom: string,
  ) {
    setError(null)
    startTransition(async () => {
      const result = await updateMonthlySubscriptionAction(
        id,
        provider,
        cost,
        notes,
        effectiveFrom,
      )
      if (result.success) {
        setEditingId(null)
        router.refresh()
      } else {
        setError(result.error)
      }
    })
  }

  // CANCEL — soft-archive. Sub stops counting next month; stays in
  // this month's total + visible-with-badge until month rollover.
  // The use case: "we cancelled the sub but already paid this month."
  function onCancel(id: string, provider: string) {
    if (
      !confirm(
        `Cancel subscription "${provider}"?\n\n` +
          `It will stop counting NEXT month but stays counted in THIS ` +
          `month's total (and shows in the list with a "cancelled" badge) ` +
          `because you already paid for it this month.`,
      )
    ) {
      return
    }
    setError(null)
    startTransition(async () => {
      const result = await cancelMonthlySubscriptionAction(id)
      if (!result.success) {
        setError(result.error)
      }
      router.refresh()
    })
  }

  // REMOVE — hard DELETE. Gone from totals + history. Irreversible.
  // The use case: "I added this by mistake."
  function onRemove(id: string, provider: string) {
    if (
      !confirm(
        `REMOVE subscription "${provider}" permanently?\n\n` +
          `This DELETES the row entirely:\n` +
          `  • Gone from this month's running total\n` +
          `  • Gone from all historical month totals\n` +
          `  • Cannot be undone\n\n` +
          `Use this for mistakes only. To stop a sub going forward while ` +
          `keeping this month's cost, use Cancel instead.`,
      )
    ) {
      return
    }
    setError(null)
    startTransition(async () => {
      const result = await removeMonthlySubscriptionAction(id)
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
          gridTemplateColumns: '2fr 1fr 3fr 1fr auto',
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
        <input
          type="date"
          value={draftEffectiveFrom}
          onChange={(e) => setDraftEffectiveFrom(e.target.value)}
          aria-label="Effective from"
          title="Effective from — which month this sub starts counting"
          className="geg-filter-input"
          disabled={isPending}
        />
        <button
          type="submit"
          disabled={isPending || !draftProvider.trim() || !draftCost || !draftEffectiveFrom}
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
              onSave={(provider, cost, notes, effectiveFrom) =>
                onSaveEdit(row.id, provider, cost, notes, effectiveFrom)
              }
              onCancel={() => onCancel(row.id, row.provider)}
              onRemove={() => onRemove(row.id, row.provider)}
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
  onCancel,
  onRemove,
  disabled,
}: {
  row: SubscriptionRow
  isEditing: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: (
    provider: string,
    cost: number,
    notes: string | null,
    effectiveFrom: string,
  ) => void
  // Soft-archive — stops next month, keeps this month.
  onCancel: () => void
  // Hard DELETE — gone from everything. Destructive.
  onRemove: () => void
  disabled: boolean
}) {
  const [provider, setProvider] = useState(row.provider)
  const [cost, setCost] = useState(String(row.monthly_cost_usd))
  const [notes, setNotes] = useState(row.notes ?? '')
  const [effectiveFrom, setEffectiveFrom] = useState(row.effective_from)

  if (isEditing) {
    return (
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 3fr 1fr auto auto',
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
        <input
          type="date"
          value={effectiveFrom}
          onChange={(e) => setEffectiveFrom(e.target.value)}
          aria-label="Effective from"
          className="geg-filter-input"
        />
        <button
          onClick={() => {
            const parsedCost = Number.parseFloat(cost)
            if (provider.trim() && Number.isFinite(parsedCost) && effectiveFrom) {
              onSave(provider.trim(), parsedCost, notes.trim() || null, effectiveFrom)
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
        // 3 action slots after the data columns: Edit (or cancelled badge),
        // Cancel button (or empty for already-cancelled rows), Remove button.
        gridTemplateColumns: '2fr 1fr 3fr 1fr auto auto auto',
        gap: 8,
        alignItems: 'center',
        padding: '10px 0',
        borderBottom: '1px solid var(--color-geg-border)',
        // Subtle visual de-emphasis for cancelled rows so they don't
        // read as "active" at a glance. Still rendered so the visible
        // costs sum to the running total.
        opacity: row.is_cancelled ? 0.65 : 1,
      }}
    >
      <span
        style={{
          fontSize: 14,
          color: 'var(--color-geg-text)',
          // Strike-through the provider name on cancelled rows for an
          // extra visual cue beyond the badge.
          textDecoration: row.is_cancelled ? 'line-through' : 'none',
        }}
      >
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
      <span
        className="geg-mono"
        style={{ fontSize: 12, color: 'var(--color-geg-text-3)' }}
        title="Effective from"
      >
        {row.effective_from}
      </span>
      {/*
        Action slots — three columns, but cancelled rows skip Edit
        (no point editing a cancelled sub) and Cancel (already done).
        Cancelled rows show: badge / empty / Remove.
        Active rows show: Edit / Cancel / Remove.
      */}
      {row.is_cancelled ? (
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            color: 'var(--color-geg-warn)',
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
            border: '1px solid var(--color-geg-warn)',
            borderRadius: 4,
            padding: '3px 8px',
            textAlign: 'center',
            whiteSpace: 'nowrap',
          }}
          aria-label="Cancelled this month"
          title="Cancelled — still counted in this month's total. Drops out next month."
        >
          Cancelled
        </span>
      ) : (
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
      )}
      {row.is_cancelled ? (
        <span />
      ) : (
        <button
          onClick={onCancel}
          disabled={disabled}
          style={{
            padding: '4px 10px',
            fontSize: 12,
            background: 'transparent',
            border: '1px solid var(--color-geg-border)',
            color: 'var(--color-geg-text-2)',
            borderRadius: 4,
            cursor: 'pointer',
            whiteSpace: 'nowrap',
          }}
          title="Cancel — stops next month, stays counted this month"
        >
          Cancel
        </button>
      )}
      <button
        onClick={onRemove}
        disabled={disabled}
        className="geg-action-item-x"
        style={{
          padding: '4px 10px',
          fontSize: 14,
          background: 'transparent',
          // Subtle red border to signal destructive action distinct from Cancel.
          border: '1px solid var(--color-geg-warn)',
          color: 'var(--color-geg-warn)',
          borderRadius: 4,
          cursor: 'pointer',
        }}
        aria-label={`Remove ${row.provider} permanently`}
        title="Remove — hard delete, gone from all totals + history"
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

  // REMOVE — hard DELETE. Extras don't have a Cancel option (no "next
  // month" semantic for one-offs); the only destructive op is Remove.
  // Spec `cost-hub-total-cancel-remove-and-add` Part 4: "for extras
  // 'cancel' doesn't really mean anything; extras likely just need
  // 'remove' (hard delete)."
  function onRemove(id: string, description: string) {
    if (
      !confirm(
        `REMOVE extra "${description}" permanently?\n\n` +
          `This DELETES the row entirely:\n` +
          `  • Gone from this month's running total\n` +
          `  • Gone from all historical month totals\n` +
          `  • Cannot be undone`,
      )
    ) {
      return
    }
    setError(null)
    startTransition(async () => {
      const result = await removeCostExtraAction(id)
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
              onRemove={() => onRemove(row.id, row.description)}
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
  onRemove,
  disabled,
}: {
  row: CostExtraRow
  isEditing: boolean
  onStartEdit: () => void
  onCancelEdit: () => void
  onSave: (date: string, desc: string, cost: number) => void
  // Hard DELETE — extras have no Cancel option. Destructive.
  onRemove: () => void
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
        onClick={onRemove}
        disabled={disabled}
        className="geg-action-item-x"
        style={{
          padding: '4px 10px',
          fontSize: 14,
          background: 'transparent',
          // Subtle red border to signal destructive action — same shape as subs Remove.
          border: '1px solid var(--color-geg-warn)',
          color: 'var(--color-geg-warn)',
          borderRadius: 4,
          cursor: 'pointer',
        }}
        aria-label={`Remove ${row.description} permanently`}
        title="Remove — hard delete, gone from all totals + history"
      >
        ×
      </button>
    </div>
  )
}
