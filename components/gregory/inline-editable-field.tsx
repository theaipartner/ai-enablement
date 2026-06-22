'use client'

// Gregory Redesign Part 1 — foundation primitive.
//
// Generic inline-editable cell. Implements the Decision 6 contract:
//
//   - Click (or keyboard activation) to enter edit mode.
//   - Optimistic update: the display value flips immediately on commit.
//   - Persist on blur (text) or on-change (select).
//   - Inline error tooltip on save failure — NOT a toast.
//   - Revert to last-known-good value on failure.
//   - No row-level Save button.
//   - Escape cancels; Enter commits.
//   - Tab moves focus between fields (browser default).
//
// `editable-cell.tsx` (the V1 inline-edit on the clients list table) is
// a separate, older implementation routed through
// `components/client-detail/editable-field.tsx`. It does NOT match this
// contract — it goes through a saving / saved / error state machine
// with a status badge, not an inline tooltip. The two coexist for now;
// the conventions doc names this primitive (`InlineEditableField`) as
// canonical going forward. A Part 2 spec will migrate the clients list
// to this primitive.
//
// Conventions: docs/fulfillment/gregory-conventions.md § Inline-editable contract.
// Slot owner: any glance-row or configuration-slot cell.
// Tokens consumed: --color-geg-bg-elev, --color-geg-text,
//   --color-geg-text-3, --color-geg-border-strong, --color-geg-accent,
//   --color-geg-neg.

import { useState, useRef, useEffect, type ReactNode } from 'react'

export type SaveResult = { success: true } | { success: false; error: string }

export type InlineEditableFieldOption = {
  readonly value: string
  readonly label: string
}

export type InlineEditableFieldProps = {
  // Canonical value from the parent's data layer. The primitive renders
  // this as the display value unless the user is mid-edit OR a recent
  // optimistic commit has flipped it locally.
  value: string | null
  // Async save callback. Receives the new value (or null for empty).
  // Returns { success: true } on persist OK, or { success: false, error }
  // on failure — the primitive reverts on failure and surfaces the error
  // via an inline tooltip.
  onSave: (newValue: string | null) => Promise<SaveResult>
  // Editor variant: 'text' is a single-line input; 'select' is a native
  // <select> that commits on-change; 'pill' is visually a pill-shaped
  // button that opens the same select (for status / tier / enum fields
  // that read more naturally as pills than dropdowns).
  type?: 'text' | 'select' | 'pill'
  // Required when type='select' or type='pill'. Ignored for 'text'.
  options?: ReadonlyArray<InlineEditableFieldOption>
  // Placeholder shown in display mode when value is null/empty.
  placeholder?: string
  // Disable click-to-edit + render display as static. Saves never fire.
  disabled?: boolean
  // Display-mode renderer for 'pill' type. Defaults to label-or-value.
  renderDisplay?: (value: string | null) => ReactNode
}

type ErrorState = { message: string; revertedFrom: string | null } | null

export function InlineEditableField({
  value,
  onSave,
  type = 'text',
  options,
  placeholder,
  disabled = false,
  renderDisplay,
}: InlineEditableFieldProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>(value ?? '')
  // committed mirrors `value` but allows optimistic flips to land
  // before the parent re-renders. Synced from props on mount and on
  // every parent re-render (useEffect below).
  const [committed, setCommitted] = useState<string | null>(value)
  // Pre-edit value, captured at edit-enter, so revert-on-failure
  // restores exactly what the user saw before clicking.
  const lastGoodRef = useRef<string | null>(value)
  // Active error from the most recent failed save. Rendered as an
  // inline tooltip on the display element. Cleared on next successful
  // commit or on cancel.
  const [errorState, setErrorState] = useState<ErrorState>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const selectRef = useRef<HTMLSelectElement | null>(null)

  // Keep `committed` in sync with the canonical prop value on every
  // parent re-render. Only overwrites the local optimistic state when
  // the parent's value changed — preserves an in-flight edit.
  useEffect(() => {
    setCommitted(value)
    if (!editing) {
      setDraft(value ?? '')
    }
    lastGoodRef.current = value
  }, [value, editing])

  // Auto-focus when entering edit mode.
  useEffect(() => {
    if (!editing) return
    if (type === 'text' && inputRef.current) {
      inputRef.current.focus()
      inputRef.current.select()
    } else if ((type === 'select' || type === 'pill') && selectRef.current) {
      selectRef.current.focus()
    }
  }, [editing, type])

  function enter() {
    if (disabled) return
    lastGoodRef.current = committed
    setDraft(committed ?? '')
    setErrorState(null)
    setEditing(true)
  }

  function cancel() {
    setDraft(committed ?? '')
    setEditing(false)
    setErrorState(null)
  }

  async function commit(next: string) {
    const normalized = next.trim() === '' ? null : next
    const wasCommitted = lastGoodRef.current
    // No-change shortcut: no save call, no error reset.
    if (normalized === wasCommitted) {
      setEditing(false)
      return
    }
    // Optimistic flip.
    setCommitted(normalized)
    setEditing(false)
    setErrorState(null)
    const result = await onSave(normalized)
    if (!result.success) {
      // Revert to pre-edit value + surface the error inline.
      setCommitted(wasCommitted)
      setErrorState({ message: result.error, revertedFrom: normalized })
    }
  }

  // ----- DISPLAY MODE -----
  if (!editing) {
    const displayValue = renderDisplay
      ? renderDisplay(committed)
      : committed ??
        (placeholder ? (
          <span style={{ color: 'var(--color-geg-text-3)' }}>{placeholder}</span>
        ) : (
          <span style={{ color: 'var(--color-geg-text-3)' }}>—</span>
        ))

    // The inline error tooltip is a `title` attribute on the display
    // button + a small red triangle next to the value. Native title
    // tooltips are accessible enough for this case (the error is also
    // visible via the aria-describedby below); a richer tooltip is a
    // Part 2 polish concern.
    return (
      <button
        type="button"
        onClick={enter}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            enter()
          }
        }}
        disabled={disabled}
        title={errorState ? `Save failed: ${errorState.message}` : 'Click to edit'}
        aria-describedby={errorState ? 'inline-editable-error' : undefined}
        className="inline-flex items-center gap-1.5 rounded-md text-left text-sm cursor-pointer"
        style={{
          background: 'transparent',
          border: 'none',
          padding: '4px 6px',
          color: 'var(--color-geg-text)',
          minHeight: 28,
        }}
      >
        <span>{displayValue}</span>
        {errorState ? (
          <span
            id="inline-editable-error"
            role="img"
            aria-label={`Save failed: ${errorState.message}`}
            style={{
              color: 'var(--color-geg-neg)',
              fontSize: 11,
              lineHeight: 1,
            }}
          >
            ▲
          </span>
        ) : null}
      </button>
    )
  }

  // ----- EDIT MODE: SELECT / PILL -----
  if (type === 'select' || type === 'pill') {
    return (
      <select
        ref={selectRef}
        value={draft}
        onChange={(e) => {
          const next = e.target.value
          setDraft(next)
          void commit(next)
        }}
        onBlur={() => {
          // If the select lost focus without an onChange (rare; usually
          // user opens then clicks away), just exit edit mode without
          // saving. Draft equals committed at this point.
          if (draft === (committed ?? '')) {
            cancel()
          }
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
        className="geg-select h-9 rounded-md px-3 text-sm"
        style={{
          background: 'var(--color-geg-bg-elev)',
          color: 'var(--color-geg-text)',
          border: '1px solid var(--color-geg-border-strong)',
        }}
      >
        {options?.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }

  // ----- EDIT MODE: TEXT -----
  return (
    <input
      ref={inputRef}
      type="text"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit(draft)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(e.target as HTMLInputElement).blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
      placeholder={placeholder}
      className="h-9 rounded-md px-3 text-sm"
      style={{
        background: 'var(--color-geg-bg-elev)',
        color: 'var(--color-geg-text)',
        border: '1px solid var(--color-geg-border-strong)',
        outline: 'none',
      }}
    />
  )
}
