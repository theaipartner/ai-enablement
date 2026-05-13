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

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { EditableField } from '@/components/client-detail/editable-field'
import {
  updateClientCsmStandingAction,
  updateClientField,
  updateClientJourneyStageAction,
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
