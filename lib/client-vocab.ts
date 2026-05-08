// Single source of truth for the value→label mappings of clients table
// vocabularies surfaced in the dashboard UI. Used by:
//   - filter dropdowns on /clients (M5.5)
//   - inline-edit dropdowns on the client detail page (csm_standing in
//     lifecycle-section, trustpilot_status in adoption-section)
//   - NpsStandingPill display
//   - Server Action validation (TRUSTPILOT_VALUES → actions.ts)
//
// DB-side CHECK constraints are the ultimate authority on allowed values;
// this module mirrors them. When a migration changes vocab (e.g. 0019
// added 'leave' to status, 0020 renamed trustpilot, 0021 added
// nps_standing), update this file in the same commit.
//
// Color treatments stay co-located with their pill components (see
// app/(authenticated)/clients/pills.tsx STATUS_CLASSES,
// components/client-detail/nps-standing-pill.tsx NPS_STANDING_CLASSES).
// Vocab is shared; visual treatment is a per-component concern.

export type VocabOption<T extends string = string> = {
  value: T
  label: string
}

// ---------------------------------------------------------------------------
// status — clients.status (CHECK constraint, migration 0019)
// ---------------------------------------------------------------------------
export const STATUS_OPTIONS = [
  { value: 'active', label: 'Active' },
  { value: 'paused', label: 'Paused' },
  { value: 'ghost', label: 'Ghost' },
  { value: 'leave', label: 'Leave' },
  { value: 'churned', label: 'Churned' },
] as const satisfies readonly VocabOption[]

export type StatusValue = (typeof STATUS_OPTIONS)[number]['value']
export const STATUS_VALUES: readonly StatusValue[] = STATUS_OPTIONS.map(
  (o) => o.value,
)

// ---------------------------------------------------------------------------
// csm_standing — clients.csm_standing (RPC 0018; values pinned in
// update_client_csm_standing_with_history's allowlist)
// ---------------------------------------------------------------------------
export const CSM_STANDING_OPTIONS = [
  { value: 'happy', label: 'Happy' },
  { value: 'content', label: 'Content' },
  { value: 'at_risk', label: 'At risk' },
  { value: 'problem', label: 'Problem' },
] as const satisfies readonly VocabOption[]

export type CsmStandingValue = (typeof CSM_STANDING_OPTIONS)[number]['value']
export const CSM_STANDING_VALUES: readonly CsmStandingValue[] =
  CSM_STANDING_OPTIONS.map((o) => o.value)

// ---------------------------------------------------------------------------
// nps_standing — clients.nps_standing (CHECK constraint, migration 0021)
// ---------------------------------------------------------------------------
export const NPS_STANDING_OPTIONS = [
  { value: 'promoter', label: 'Promoter' },
  { value: 'neutral', label: 'Neutral' },
  { value: 'at_risk', label: 'At Risk' },
] as const satisfies readonly VocabOption[]

export type NpsStandingValue = (typeof NPS_STANDING_OPTIONS)[number]['value']
export const NPS_STANDING_VALUES: readonly NpsStandingValue[] =
  NPS_STANDING_OPTIONS.map((o) => o.value)
export const NPS_STANDING_LABEL: Record<string, string> = Object.fromEntries(
  NPS_STANDING_OPTIONS.map((o) => [o.value, o.label]),
)

// ---------------------------------------------------------------------------
// trustpilot_status — clients.trustpilot_status (CHECK constraint,
// migration 0020). Short labels match the inline-edit dropdown in
// components/client-detail/adoption-section.tsx — that dropdown is
// the source of truth (Drake's call 2026-05-08 after a brief
// "Given"/"Declined" detour was reverted). End state: edit dropdown,
// filter dropdown, and list-table pill all render "Yes/No/Ask/Asked"
// for the same underlying values.
// ---------------------------------------------------------------------------
export const TRUSTPILOT_OPTIONS = [
  { value: 'yes', label: 'Yes' },
  { value: 'no', label: 'No' },
  { value: 'ask', label: 'Ask' },
  { value: 'asked', label: 'Asked' },
] as const satisfies readonly VocabOption[]

export type TrustpilotValue = (typeof TRUSTPILOT_OPTIONS)[number]['value']
export const TRUSTPILOT_VALUES: readonly TrustpilotValue[] =
  TRUSTPILOT_OPTIONS.map((o) => o.value)
