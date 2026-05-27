'use client'

// Inline-editable cells for the clients list table. Per-cell wiring to
// the four Server Actions on [id]/actions.ts. Each cell wraps EditableField
// in enum variant + calls router.refresh() in startTransition after a
// successful save so the row's neighbour cells (which read the same DB
// row server-side) reflect any cascade side effects (status → cascade
// triggers, etc.) without waiting for the next navigation.
//
// Spec: docs/specs/gregory-list-editable-reorder-refresh.md
// Vocab: lib/client-vocab.ts is the single source of truth.
//
// Cells are NOT wrapped in <Link>. Click-to-navigate and click-to-edit
// are mutually exclusive on the same cell. The other five cells in the
// row (full_name, primary_csm_name, nps_standing, latest_health_score,
// meetings_this_month) handle navigation.
//
// Boolean toggles (nps_enabled / accountability_enabled) are NOT wrapped
// in EditableField — click-to-flip doesn't fit EditableField's
// click→enter-edit-mode→blur-to-save state machine. They use a small
// dedicated <PillToggle> with optimistic state + revert-on-failure.

import { useRouter } from 'next/navigation'
import { useEffect, useState, useTransition } from 'react'
import { EditableField } from '@/components/client-detail/editable-field'
import { GegPill } from '@/components/gregory/geg-pill'
import {
  changeClientPrimaryCsm,
  updateClientAccountabilityEnabledAction,
  updateClientCsmStandingAction,
  updateClientField,
  updateClientJourneyStageAction,
  updateClientNpsEnabledAction,
  updateClientStatusAction,
} from './[id]/actions'
import {
  CSM_STANDING_OPTIONS,
  JOURNEY_STAGE_OPTIONS,
  STATUS_OPTIONS,
  TRUSTPILOT_OPTIONS,
} from '@/lib/client-vocab'
import {
  CsmStandingPill,
  JourneyStagePill,
  StatusPill,
  TrustpilotPill,
} from './pills'

export function EditableStatusCell({
  clientId,
  value,
}: {
  clientId: string
  value: string
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  return (
    <EditableField
      label=""
      value={value}
      variant="enum"
      options={STATUS_OPTIONS}
      displayValue={(raw) => <StatusPill status={(raw ?? 'active') as string} />}
      onSave={async (newValue) => {
        const result = await updateClientStatusAction(
          clientId,
          newValue as string,
        )
        if (result.success) {
          startTransition(() => router.refresh())
        }
        return result
      }}
    />
  )
}

export function EditableJourneyStageCell({
  clientId,
  value,
}: {
  clientId: string
  value: string | null
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  return (
    <EditableField
      label=""
      value={value}
      variant="enum"
      options={JOURNEY_STAGE_OPTIONS}
      displayValue={(raw) => <JourneyStagePill stage={(raw as string | null) ?? null} />}
      onSave={async (newValue) => {
        const result = await updateClientJourneyStageAction(
          clientId,
          newValue as string | null,
        )
        if (result.success) {
          startTransition(() => router.refresh())
        }
        return result
      }}
    />
  )
}

export function EditableCsmStandingCell({
  clientId,
  value,
}: {
  clientId: string
  value: string | null
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  return (
    <EditableField
      label=""
      value={value}
      variant="enum"
      options={CSM_STANDING_OPTIONS}
      displayValue={(raw) => <CsmStandingPill standing={(raw as string | null) ?? null} />}
      onSave={async (newValue) => {
        const result = await updateClientCsmStandingAction(
          clientId,
          newValue as 'happy' | 'content' | 'at_risk' | 'problem' | null,
        )
        if (result.success) {
          startTransition(() => router.refresh())
        }
        return result
      }}
    />
  )
}

// Shared pill-toggle base. Optimistic flip on click, revert on failure.
// Disabled while a save is in flight to swallow rapid double-clicks.
function PillToggle({
  value,
  onSave,
}: {
  value: boolean
  onSave: (
    next: boolean,
  ) => Promise<{ success: true } | { success: false; error: string }>
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const [optimistic, setOptimistic] = useState(value)
  const [saving, setSaving] = useState(false)

  // Resync to parent value after server-side revalidate completes.
  useEffect(() => {
    if (!saving) setOptimistic(value)
  }, [value, saving])

  async function handleClick() {
    if (saving) return
    const next = !optimistic
    setOptimistic(next)
    setSaving(true)
    const result = await onSave(next)
    if (result.success) {
      startTransition(() => router.refresh())
    } else {
      setOptimistic(!next)
    }
    setSaving(false)
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={saving}
      title="Click to toggle"
      className="geg-pill-toggle"
      style={{
        background: 'none',
        border: 'none',
        padding: 0,
        cursor: saving ? 'progress' : 'pointer',
        opacity: saving ? 0.6 : 1,
        font: 'inherit',
        color: 'inherit',
      }}
    >
      <GegPill
        tier={optimistic ? 'pos' : 'muted'}
        label={optimistic ? 'On' : 'Off'}
      />
    </button>
  )
}

export function EditableNpsEnabledToggle({
  clientId,
  value,
}: {
  clientId: string
  value: boolean
}) {
  return (
    <PillToggle
      value={value}
      onSave={(next) => updateClientNpsEnabledAction(clientId, next)}
    />
  )
}

export function EditableAccountabilityEnabledToggle({
  clientId,
  value,
}: {
  clientId: string
  value: boolean
}) {
  return (
    <PillToggle
      value={value}
      onSave={(next) =>
        updateClientAccountabilityEnabledAction(clientId, next)
      }
    />
  )
}

export function EditablePrimaryCsmCell({
  clientId,
  value,
  options,
  compact = false,
}: {
  clientId: string
  value: string | null
  options: ReadonlyArray<{ id: string; full_name: string }>
  // Pass true on the /clients/[id] Details box so the cell matches the
  // height + visual rhythm of its plain-text siblings (Email, Phone,
  // Country, ...). Leave default false in the /clients list table where
  // the default min-h-9 matches the neighboring editable cells.
  compact?: boolean
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  const nameById = new Map(options.map((o) => [o.id, o.full_name]))
  const enumOptions = options.map((o) => ({ value: o.id, label: o.full_name }))
  return (
    <EditableField
      label=""
      value={value}
      variant="enum"
      options={enumOptions}
      compact={compact}
      omitEmptyOption
      displayValue={(raw) => {
        if (raw === null || raw === undefined || raw === '') {
          return <span style={{ color: 'var(--color-geg-text-faint)' }}>—</span>
        }
        return nameById.get(raw as string) ?? String(raw)
      }}
      onSave={async (newValue) => {
        // change_primary_csm RPC archives the old assignment and inserts
        // a new one atomically. omitEmptyOption keeps null out of the
        // dropdown, but the type still allows it — handle defensively.
        if (newValue === null || newValue === '') {
          return {
            success: false as const,
            error: 'Clearing Primary CSM is not supported.',
          }
        }
        if (newValue === value) {
          return { success: true as const }
        }
        const result = await changeClientPrimaryCsm(
          clientId,
          newValue as string,
        )
        if (result.success) {
          startTransition(() => router.refresh())
        }
        return result
      }}
    />
  )
}

export function EditableTrustpilotCell({
  clientId,
  value,
}: {
  clientId: string
  value: string | null
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  return (
    <EditableField
      label=""
      value={value}
      variant="enum"
      options={TRUSTPILOT_OPTIONS}
      displayValue={(raw) => <TrustpilotPill status={(raw as string | null) ?? null} />}
      onSave={async (newValue) => {
        const result = await updateClientField(
          clientId,
          'trustpilot_status',
          newValue,
        )
        if (result.success) {
          startTransition(() => router.refresh())
        }
        return result
      }}
    />
  )
}
