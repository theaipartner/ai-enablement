'use server'

import { revalidatePath } from 'next/cache'
import {
  changePrimaryCsm,
  insertNpsSubmission,
  isProfilePath,
  updateClient,
  updateClientAlternateEmails,
  updateClientCsmStandingWithHistory,
  updateClientJourneyStageWithHistory,
  updateClientProfileField,
  updateClientStatusWithHistory,
  FIELD_TYPES,
  GHL_ADOPTION_VALUES,
  type FieldType,
  type ProfilePath,
  type UpdatableField,
} from '@/lib/db/clients'
import { TRUSTPILOT_VALUES } from '@/lib/client-vocab'
import { mergeClient, type MergeResult } from '@/lib/db/merge'

// ----------------------------------------------------------------------
// updateClientField — generic inline-edit Server Action
// ----------------------------------------------------------------------
//
// Routes through updateClient with the column whitelist enforced both
// here (defense-in-depth) and in lib/db/clients.ts. The Server Action
// also narrows the raw value to the field's typed shape before passing
// through — number for birth_year, numeric for money fields, enum
// membership for trustpilot_status / ghl_adoption, three-state boolean
// for sales_group_candidate / dfy_setting, string[] for tags, etc.
//
// Status / journey_stage / csm_standing are intentionally NOT routed
// through here — they have dedicated history-writing actions below.
export async function updateClientField(
  id: string,
  field: string,
  rawValue: unknown,
): Promise<{ success: true } | { success: false; error: string }> {
  if (!(field in FIELD_TYPES)) {
    return { success: false, error: `Field not editable: ${field}` }
  }
  const fieldType: FieldType = FIELD_TYPES[field as UpdatableField]

  const narrowed = narrowValue(field, fieldType, rawValue)
  if (!narrowed.ok) {
    return { success: false, error: narrowed.error }
  }

  const partial: Partial<Record<UpdatableField, unknown>> = {}
  partial[field as UpdatableField] = narrowed.value

  const result = await updateClient(
    id,
    partial as Parameters<typeof updateClient>[1],
  )

  if (result.success) {
    revalidatePath(`/clients/${id}`)
    revalidatePath('/clients')
  }
  return result
}

type Narrowed =
  | { ok: true; value: unknown }
  | { ok: false; error: string }

function narrowValue(
  field: string,
  fieldType: FieldType,
  rawValue: unknown,
): Narrowed {
  // Universal: empty string from a form input means "clear" → null.
  if (rawValue === '' || rawValue === undefined) {
    rawValue = null
  }

  switch (fieldType) {
    case 'text':
    case 'date': {
      if (rawValue === null) return { ok: true, value: null }
      if (typeof rawValue !== 'string') {
        return { ok: false, error: `${field} must be a string or null.` }
      }
      const trimmed = rawValue.trim()
      return { ok: true, value: trimmed === '' ? null : trimmed }
    }

    case 'integer': {
      if (rawValue === null) return { ok: true, value: null }
      const n =
        typeof rawValue === 'number'
          ? rawValue
          : typeof rawValue === 'string'
            ? Number.parseInt(rawValue.trim(), 10)
            : NaN
      if (!Number.isFinite(n) || !Number.isInteger(n)) {
        return { ok: false, error: `${field} must be an integer.` }
      }
      // birth_year-specific range check (mirrors migration 0017 constraint).
      if (field === 'birth_year') {
        const currentYear = new Date().getFullYear()
        if (n < 1900 || n > currentYear) {
          return {
            ok: false,
            error: `${field} must be between 1900 and ${currentYear}.`,
          }
        }
      }
      return { ok: true, value: n }
    }

    case 'numeric':
    case 'numeric_nonneg': {
      if (rawValue === null) return { ok: true, value: null }
      const cleaned =
        typeof rawValue === 'string'
          ? rawValue.replace(/[$,\s]/g, '')
          : String(rawValue)
      const n = Number.parseFloat(cleaned)
      if (!Number.isFinite(n)) {
        return { ok: false, error: `${field} must be a number.` }
      }
      if (fieldType === 'numeric_nonneg' && n < 0) {
        return { ok: false, error: `${field} cannot be negative.` }
      }
      return { ok: true, value: n }
    }

    case 'enum_trustpilot': {
      if (rawValue === null) return { ok: true, value: null }
      if (
        typeof rawValue !== 'string' ||
        !(TRUSTPILOT_VALUES as readonly string[]).includes(rawValue)
      ) {
        return {
          ok: false,
          error: `${field} must be one of ${TRUSTPILOT_VALUES.join(', ')}.`,
        }
      }
      return { ok: true, value: rawValue }
    }

    case 'enum_ghl_adoption': {
      if (rawValue === null) return { ok: true, value: null }
      if (
        typeof rawValue !== 'string' ||
        !(GHL_ADOPTION_VALUES as readonly string[]).includes(rawValue)
      ) {
        return {
          ok: false,
          error: `${field} must be one of ${GHL_ADOPTION_VALUES.join(', ')}.`,
        }
      }
      return { ok: true, value: rawValue }
    }

    case 'three_state_bool': {
      if (rawValue === null) return { ok: true, value: null }
      if (rawValue === true || rawValue === false) {
        return { ok: true, value: rawValue }
      }
      // Tolerate 'true' / 'false' string forms from form inputs.
      if (rawValue === 'true') return { ok: true, value: true }
      if (rawValue === 'false') return { ok: true, value: false }
      return {
        ok: false,
        error: `${field} must be true, false, or null.`,
      }
    }

    case 'boolean_toggle': {
      // Two-state — null is not allowed (DB columns are NOT NULL with
      // default true). Used by accountability_enabled / nps_enabled
      // (M5.6 cascade-owned toggles).
      if (rawValue === true || rawValue === false) {
        return { ok: true, value: rawValue }
      }
      if (rawValue === 'true') return { ok: true, value: true }
      if (rawValue === 'false') return { ok: true, value: false }
      return { ok: false, error: `${field} must be true or false.` }
    }

    case 'string_array': {
      if (!Array.isArray(rawValue)) {
        return { ok: false, error: 'tags must be an array of strings.' }
      }
      const cleaned: string[] = []
      const seenLower = new Set<string>()
      for (const item of rawValue) {
        if (typeof item !== 'string') {
          return { ok: false, error: 'tags must be strings.' }
        }
        const trimmed = item.trim()
        if (trimmed === '') continue
        const lower = trimmed.toLowerCase()
        if (seenLower.has(lower)) continue
        seenLower.add(lower)
        cleaned.push(trimmed)
      }
      if (cleaned.length > 30) {
        return { ok: false, error: 'tags capped at 30.' }
      }
      return { ok: true, value: cleaned }
    }
  }
}

// ----------------------------------------------------------------------
// changeClientPrimaryCsm — existing, unchanged
// ----------------------------------------------------------------------
export async function changeClientPrimaryCsm(
  client_id: string,
  new_team_member_id: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const result = await changePrimaryCsm(client_id, new_team_member_id)
  if (result.success) {
    revalidatePath(`/clients/${client_id}`)
    revalidatePath('/clients')
  }
  return result
}

// ----------------------------------------------------------------------
// History-writing edits — Section 1 (status) / Section 2 (journey/csm_standing)
// ----------------------------------------------------------------------
//
// p_changed_by is null in V1 — auth context isn't wired through the
// (authenticated) layout to Server Actions yet. Followup logged in
// docs/known-issues.md.

export async function updateClientStatusAction(
  client_id: string,
  new_status: string,
  note: string | null = null,
): Promise<{ success: true } | { success: false; error: string }> {
  const result = await updateClientStatusWithHistory(
    client_id,
    new_status,
    null,
    note,
  )
  if (result.success) {
    revalidatePath(`/clients/${client_id}`)
    revalidatePath('/clients')
  }
  return result
}

export async function updateClientJourneyStageAction(
  client_id: string,
  new_journey_stage: string | null,
  note: string | null = null,
): Promise<{ success: true } | { success: false; error: string }> {
  const result = await updateClientJourneyStageWithHistory(
    client_id,
    new_journey_stage,
    null,
    note,
  )
  if (result.success) {
    revalidatePath(`/clients/${client_id}`)
    revalidatePath('/clients')
  }
  return result
}

export async function updateClientCsmStandingAction(
  client_id: string,
  new_csm_standing: 'happy' | 'content' | 'at_risk' | 'problem' | null,
  note: string | null = null,
): Promise<{ success: true } | { success: false; error: string }> {
  const result = await updateClientCsmStandingWithHistory(
    client_id,
    new_csm_standing,
    null,
    note,
  )
  if (result.success) {
    revalidatePath(`/clients/${client_id}`)
    revalidatePath('/clients')
  }
  return result
}

// ----------------------------------------------------------------------
// addNpsScoreAction — Section 2 "Add NPS score" inline form
// ----------------------------------------------------------------------
export async function addNpsScoreAction(
  client_id: string,
  score: number,
  feedback: string | null = null,
): Promise<{ success: true } | { success: false; error: string }> {
  if (!Number.isInteger(score) || score < 0 || score > 10) {
    return { success: false, error: 'Score must be an integer 0-10.' }
  }
  const result = await insertNpsSubmission(
    client_id,
    score,
    feedback?.trim() === '' ? null : feedback,
    null,
  )
  if (result.success) {
    revalidatePath(`/clients/${client_id}`)
  }
  return result
}

// ----------------------------------------------------------------------
// updateClientProfileFieldAction — Section 5 (metadata.profile.*)
// ----------------------------------------------------------------------
export async function updateClientProfileFieldAction(
  client_id: string,
  profilePath: string,
  value: string | null,
): Promise<{ success: true } | { success: false; error: string }> {
  if (!isProfilePath(profilePath)) {
    return {
      success: false,
      error: `Profile path not editable: ${profilePath}`,
    }
  }
  const cleaned = value === null ? null : value.trim() === '' ? null : value
  const result = await updateClientProfileField(
    client_id,
    profilePath as ProfilePath,
    cleaned,
  )
  if (result.success) {
    revalidatePath(`/clients/${client_id}`)
  }
  return result
}

// ----------------------------------------------------------------------
// updateClientAlternateEmailsAction — Section 1 metadata.alternate_emails
// ----------------------------------------------------------------------
//
// Comma-separated input → string[]. Split on commas, trim each piece,
// drop empties. No dedup, no email validation, no collision check by
// design (Drake's call) — matches the editability pattern of every
// other inline-edit field on the page. Empty/null raw writes [].
// Risk of typo'd alt-emails affecting Fathom resolver matches is
// accepted; recoverable by editing the call's primary_client_id.
export async function updateClientAlternateEmailsAction(
  client_id: string,
  raw: string | null,
): Promise<{ success: true } | { success: false; error: string }> {
  const text = raw ?? ''
  const emails = text
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
  const result = await updateClientAlternateEmails(client_id, emails)
  if (result.success) {
    revalidatePath(`/clients/${client_id}`)
  }
  return result
}

// ----------------------------------------------------------------------
// mergeClientAction — existing, unchanged
// ----------------------------------------------------------------------
export async function mergeClientAction(
  source_client_id: string,
  target_client_id: string,
): Promise<
  | { success: true; result: MergeResult }
  | { success: false; error: string }
> {
  const result = await mergeClient(source_client_id, target_client_id)
  if (result.success) {
    revalidatePath(`/clients/${target_client_id}`)
    revalidatePath(`/clients/${source_client_id}`)
    revalidatePath('/clients')
  }
  return result
}
