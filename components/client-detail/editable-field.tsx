'use client'

// Inline-edit field for the v3 client detail page (M4 Chunk B2).
//
// Display mode mirrors ReadOnlyField — label + value with cursor + hover
// highlight. Click swaps to an inline input/select/textarea; blur or
// Enter saves; Escape cancels. Save calls a per-field onSave callback
// that returns the standard { success } shape; the component handles
// transient saving / saved / error UI.
//
// Variants:
//   text             — single-line <input type="text">
//   textarea         — multi-line <textarea>; saves on blur or Cmd/Ctrl+Enter
//   integer          — <input type="number" step="1"> (e.g. birth_year)
//   numeric_money    — <input type="text">; raw entry stripped of $/, then parsed
//   enum             — <select> with options prop; "—" option for null
//   three_state_bool — <select> with Yes / No / Not assessed
//   date             — <input type="date">; ISO YYYY-MM-DD round-trip
//
// onSave is given the narrowed value (number for integer/numeric_money,
// boolean|null for three_state_bool, string|null for the rest).

import {
  useState,
  useTransition,
  useRef,
  useEffect,
  type ReactNode,
} from 'react'
import { Label } from '@/components/ui/label'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'

type FieldVariant =
  | 'text'
  | 'textarea'
  | 'integer'
  | 'numeric_money'
  | 'enum'
  | 'three_state_bool'
  | 'date'

type RawValue = string | number | boolean | null

export type EditableFieldProps = {
  label: string
  value: RawValue
  variant: FieldVariant
  onSave: (
    newValue: RawValue,
  ) => Promise<{ success: true } | { success: false; error: string }>
  options?: ReadonlyArray<{ readonly value: string; readonly label: string }>
  placeholder?: string
  mono?: boolean
  // Optional pretty-printer for display mode (e.g. format numeric_money as
  // $X,XXX.XX). Edit-mode input always shows the raw value.
  displayValue?: (value: RawValue) => ReactNode
  className?: string
  // Drop the wrapper's min-h-9 + py-1.5 so the cell sits flush against
  // plain-text sibling rows. Opt-in for surfaces where the editable cell
  // lives in a list of mostly non-editable rows (e.g. Primary CSM in the
  // Details box on /clients/[id]); not appropriate for the Standing box
  // where every row is editable and the 36px target is the rhythm.
  compact?: boolean
  // Suppress the leading {value:'', label:'—'} option in enum / three_state_bool
  // dropdowns. Opt-in for enum fields whose underlying write doesn't accept
  // null (e.g. Primary CSM — change_primary_csm RPC requires a non-null
  // team_member_id). Default behavior keeps the empty option for nullable
  // fields like Status / CSM Standing / Trustpilot / Journey Stage.
  omitEmptyOption?: boolean
}

type SaveStatus = 'idle' | 'saving' | 'saved' | 'error'
const EMPTY = '—'

export function EditableField({
  label,
  value,
  variant,
  onSave,
  options,
  placeholder,
  mono = false,
  displayValue,
  className,
  compact = false,
  omitEmptyOption = false,
}: EditableFieldProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<string>(rawToDraft(value, variant))
  const [committed, setCommitted] = useState<RawValue>(value)
  const [status, setStatus] = useState<SaveStatus>('idle')
  const [error, setError] = useState<string | undefined>()
  const [isPending, startTransition] = useTransition()
  const savedTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null)

  // Keep local committed state in sync if the parent re-renders with a
  // new value (e.g. server-side revalidation completed).
  useEffect(() => {
    setCommitted(value)
    if (!editing) {
      setDraft(rawToDraft(value, variant))
    }
  }, [value, variant, editing])

  // Auto-focus the input when entering edit mode.
  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus()
      if ('select' in inputRef.current && typeof inputRef.current.select === 'function') {
        inputRef.current.select()
      }
    }
  }, [editing])

  function enter() {
    if (status === 'saving' || isPending) return
    setDraft(rawToDraft(committed, variant))
    setStatus('idle')
    setError(undefined)
    setEditing(true)
  }

  function cancel() {
    setEditing(false)
    setDraft(rawToDraft(committed, variant))
    setStatus('idle')
    setError(undefined)
  }

  // commit accepts an optional draftOverride to fix a stale-closure bug
  // on the enum / three_state_bool select onChange path. Background:
  // those paths used to call setTimeout(commit, 0) right after
  // setDraft(e.target.value). The setTimeout queues a macrotask that
  // captures the THIS-render commit closure — but `draft` in that
  // closure is still the OLD value. By the time the macrotask fires,
  // React has re-rendered with the new draft, but the queued commit is
  // a stale reference that reads the OLD draft via closure, computes
  // parsed.value === committed, hits the "no change — exit cleanly"
  // branch, and exits without calling onSave. The select-change appears
  // to do nothing.
  //
  // Fix: callers that already know the new draft (the select onChange)
  // pass it as draftOverride; commit reads it directly instead of from
  // the closure-captured state. Callers that genuinely come from a
  // stale-state-irrelevant context (e.g. text input onBlur, fired in a
  // separate event handler after typing has settled) call commit() with
  // no arg and fall back to the closure-captured draft, which is fine
  // by then.
  //
  // Bug pre-existed M5.6 (since M4 commit 19f4e50, when EditableField
  // was introduced); surfaced 2026-05-04 by the visual smoke that the
  // M5.6 deploy triggered. Affected fields: status (Section 1),
  // csm_standing (Section 2), trustpilot_status / ghl_adoption (Section
  // 6), sales_group_candidate / dfy_setting (Section 6 three-state
  // booleans). Drake confirmed status + csm_standing + trustpilot
  // broken; the others were probably broken too but went untested.
  function commit(draftOverride?: string) {
    const effectiveDraft = draftOverride !== undefined ? draftOverride : draft
    const parsed = draftToRaw(effectiveDraft, variant)
    if (!parsed.ok) {
      setStatus('error')
      setError(parsed.error)
      return
    }
    if (rawEquals(parsed.value, committed)) {
      // No change — exit cleanly.
      setEditing(false)
      setStatus('idle')
      return
    }
    setStatus('saving')
    setError(undefined)
    startTransition(async () => {
      const result = await onSave(parsed.value)
      if (result.success) {
        setCommitted(parsed.value)
        setStatus('saved')
        setEditing(false)
        if (savedTimer.current) clearTimeout(savedTimer.current)
        savedTimer.current = setTimeout(() => setStatus('idle'), 1500)
      } else {
        setStatus('error')
        setError(result.error)
        // Keep editing mode open so the user can correct or cancel.
      }
    })
  }

  // ----- DISPLAY MODE -----
  if (!editing) {
    const isEmpty =
      committed === null || committed === undefined || committed === ''
    const display: ReactNode = displayValue
      ? displayValue(committed)
      : isEmpty
        ? EMPTY
        : variant === 'three_state_bool'
          ? committed === true
            ? 'Yes'
            : 'No'
          : String(committed)

    // When label is empty AND compact is set, hide the label-row entirely.
    // Otherwise the empty Label still occupies vertical space and the
    // space-y-1.5 gap adds another sliver — both compound on the
    // /clients/[id] Details box Primary CSM row, blowing it past sibling
    // height. Standalone uses with a real label string keep the
    // label-row regardless.
    const hideLabelRow = compact && label === ''
    return (
      <div className={cn(hideLabelRow ? null : 'space-y-1.5', className)}>
        {hideLabelRow ? null : (
          <div className="flex items-center justify-between">
            <Label>{label}</Label>
            <StatusBadge status={status} error={error} />
          </div>
        )}
        <div
          role="button"
          tabIndex={0}
          onClick={enter}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              enter()
            }
          }}
          className={cn(
            // The .geg-editable-display class hooks into the theme-scoped
            // focus-visible-only outline rules in app/globals.css so a
            // mouse-click into a cell doesn't leave a persistent browser
            // focus ring on the display-mode div after the select unmounts.
            // Keyboard navigation (Tab) still gets a visible focus ring
            // via :focus-visible.
            'geg-editable-display rounded-md px-2 text-sm cursor-pointer hover:bg-muted/50 border border-transparent hover:border-input transition-colors',
            compact ? 'min-h-0 py-0.5' : 'min-h-9 py-1.5',
            mono && 'font-mono',
            isEmpty && 'text-muted-foreground',
            variant === 'textarea' && 'whitespace-pre-wrap',
          )}
          title="Click to edit"
        >
          {display}
        </div>
      </div>
    )
  }

  // ----- EDIT MODE -----
  const hideLabelRowEdit = compact && label === ''
  return (
    <div className={cn(hideLabelRowEdit ? null : 'space-y-1.5', className)}>
      {hideLabelRowEdit ? null : (
        <div className="flex items-center justify-between">
          <Label>{label}</Label>
          <StatusBadge status={status} error={error} />
        </div>
      )}
      {renderEditor({
        variant,
        draft,
        setDraft,
        commit,
        cancel,
        options,
        placeholder,
        mono,
        disabled: isPending,
        inputRef,
        omitEmptyOption,
      })}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Editor primitive selection
// ---------------------------------------------------------------------------

function renderEditor({
  variant,
  draft,
  setDraft,
  commit,
  cancel,
  options,
  placeholder,
  mono,
  disabled,
  inputRef,
  omitEmptyOption,
}: {
  variant: FieldVariant
  draft: string
  setDraft: (s: string) => void
  commit: (draftOverride?: string) => void
  cancel: () => void
  options?: ReadonlyArray<{ readonly value: string; readonly label: string }>
  placeholder?: string
  mono: boolean
  disabled: boolean
  inputRef: React.MutableRefObject<
    HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null
  >
  omitEmptyOption: boolean
}) {
  if (variant === 'textarea') {
    return (
      <Textarea
        ref={inputRef as React.RefObject<HTMLTextAreaElement>}
        value={draft}
        placeholder={placeholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => commit()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault()
            ;(e.target as HTMLTextAreaElement).blur()
          }
        }}
        disabled={disabled}
        rows={5}
        className={cn(mono && 'font-mono', 'text-sm whitespace-pre-wrap')}
      />
    )
  }

  if (variant === 'enum' || variant === 'three_state_bool') {
    const opts =
      variant === 'three_state_bool'
        ? [
            { value: '', label: 'Not assessed' },
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]
        : omitEmptyOption
          ? [...(options ?? [])]
          : [{ value: '', label: '—' }, ...(options ?? [])]
    return (
      <select
        ref={inputRef as React.RefObject<HTMLSelectElement>}
        value={draft}
        onChange={(e) => {
          // Save immediately on select-change; no blur dance for a
          // dropdown — there's nothing to "abandon" when the choice
          // itself is the input. Pass the new value to commit directly
          // rather than going through `draft` state — that read would
          // hit a stale closure (see commit's own comment for the full
          // story).
          const next = e.target.value
          setDraft(next)
          commit(next)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault()
            cancel()
          }
        }}
        disabled={disabled}
        // The .geg-select class hooks into the theme-scoped CSS in
        // app/globals.css that disables the native user-agent appearance,
        // paints the editorial-dark surface, injects a custom chevron via
        // a background-image SVG, locks the height to prevent the
        // open-state cell-expansion bug, and uses focus-visible-only for
        // the focus ring so click-to-blur leaves a clean cell.
        className="geg-select h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
      >
        {opts.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    )
  }

  // text / integer / numeric_money / date
  const inputType =
    variant === 'integer'
      ? 'number'
      : variant === 'date'
        ? 'date'
        : 'text'
  const step = variant === 'integer' ? 1 : undefined
  return (
    <Input
      ref={inputRef as React.RefObject<HTMLInputElement>}
      type={inputType}
      step={step}
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => commit()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          ;(e.target as HTMLInputElement).blur()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          cancel()
        }
      }}
      disabled={disabled}
      className={cn(mono && 'font-mono')}
    />
  )
}

// ---------------------------------------------------------------------------
// Value <-> draft conversion
// ---------------------------------------------------------------------------

function rawToDraft(value: RawValue, variant: FieldVariant): string {
  if (value === null || value === undefined) {
    return ''
  }
  if (variant === 'three_state_bool') {
    return value === true ? 'true' : value === false ? 'false' : ''
  }
  return String(value)
}

function draftToRaw(
  draft: string,
  variant: FieldVariant,
): { ok: true; value: RawValue } | { ok: false; error: string } {
  const trimmed = draft.trim()
  if (trimmed === '') {
    return { ok: true, value: null }
  }
  switch (variant) {
    case 'text':
    case 'textarea':
    case 'date':
    case 'enum':
      return { ok: true, value: trimmed }
    case 'integer': {
      const n = Number.parseInt(trimmed, 10)
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return { ok: false, error: 'Must be an integer.' }
      }
      return { ok: true, value: n }
    }
    case 'numeric_money': {
      const cleaned = trimmed.replace(/[$,\s]/g, '')
      const n = Number.parseFloat(cleaned)
      if (!Number.isFinite(n)) {
        return { ok: false, error: 'Must be a number.' }
      }
      return { ok: true, value: n }
    }
    case 'three_state_bool':
      if (trimmed === 'true') return { ok: true, value: true }
      if (trimmed === 'false') return { ok: true, value: false }
      return { ok: false, error: 'Must be Yes, No, or Not assessed.' }
  }
}

function rawEquals(a: RawValue, b: RawValue): boolean {
  if (a === null && b === null) return true
  if (a === null || b === null) return false
  return a === b
}

// ---------------------------------------------------------------------------
// Save status badge
// ---------------------------------------------------------------------------

function StatusBadge({
  status,
  error,
}: {
  status: SaveStatus
  error?: string
}) {
  if (status === 'idle') return null
  if (status === 'saving') {
    return <span className="text-xs text-muted-foreground">Saving…</span>
  }
  if (status === 'saved') {
    return <span className="text-xs text-emerald-700">Saved</span>
  }
  return (
    <span className="text-xs text-rose-700" title={error}>
      Error: {error ?? 'failed'}
    </span>
  )
}
