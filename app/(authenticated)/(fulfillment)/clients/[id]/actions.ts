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
import { createAdminClient } from '@/lib/supabase/admin'
import type { Database } from '@/lib/supabase/types'
import { postMessage } from '@/lib/slack/post'

type ClientRow = Database['public']['Tables']['clients']['Row']

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
// Operational toggles — nps_enabled / accountability_enabled
// ----------------------------------------------------------------------
//
// Thin dedicated wrappers over updateClient for the two M5.6 boolean
// columns surfaced as click-to-flip pills on /clients/[id]. No history
// row needed (operational toggles, not customer data); cascade-owned
// for negative-status transitions but freely flippable from the
// dashboard.

export async function updateClientNpsEnabledAction(
  client_id: string,
  enabled: boolean,
): Promise<{ success: true } | { success: false; error: string }> {
  const result = await updateClient(client_id, { nps_enabled: enabled })
  if (result.success) {
    revalidatePath(`/clients/${client_id}`)
    revalidatePath('/clients')
  }
  return result
}

export async function updateClientAccountabilityEnabledAction(
  client_id: string,
  enabled: boolean,
): Promise<{ success: true } | { success: false; error: string }> {
  const result = await updateClient(client_id, {
    accountability_enabled: enabled,
  })
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
// sendActionItemsToSlackAction — post open action items to the client's
// mapped Slack channel
// ----------------------------------------------------------------------
//
// Fresh DB read on every call (per spec § Decision 3 — DB is the source
// of truth, not React state). Channel resolution mirrors getClientById:
// most recently created non-archived row in slack_channels for this
// client. Action items filtered to status='open' and scoped to calls
// where primary_client_id = clientId (matches the fixed predicate in
// the gregory-action-items-transfer-fix spec).
//
// Dry-run mode (SLACK_DRY_RUN=true) skips the chat.postMessage call but
// runs everything else — useful for verifying message shape and channel
// resolution without sending to live channels during preview testing.
//
// Observability: every invocation logs a single console.info JSON line
// regardless of dry-run vs live, with client_id / channel_id / item_count
// / message_length / dry_run / timestamp. Vercel function logs are the
// post-incident audit trail.

function formatActionItemsMessage(
  items: ReadonlyArray<{ description: string }>,
): string {
  const bullets = items.map((it) => `• ${it.description}`).join('\n')
  return `*Open action items we discussed:*\n${bullets}`
}

export async function sendActionItemsToSlackAction(
  client_id: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const supabase = createAdminClient()

  // Resolve channel — same shape as getClientById's slack_channel_id
  // derivation but isolated to this action's read.
  const { data: channelRows, error: chanErr } = await supabase
    .from('slack_channels')
    .select('slack_channel_id, is_archived, created_at')
    .eq('client_id', client_id)
  if (chanErr) {
    return { success: false, error: chanErr.message }
  }
  const channels = (channelRows ?? []) as Array<{
    slack_channel_id: string
    is_archived: boolean
    created_at: string
  }>
  const activeChannel = channels
    .filter((c) => !c.is_archived)
    .sort(
      (a, b) =>
        new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
    )[0]
  const channelId = activeChannel?.slack_channel_id ?? null
  if (!channelId) {
    return {
      success: false,
      error: 'No Slack channel mapped for this client',
    }
  }

  // Fetch open action items via the same calls!inner JOIN the detail
  // page now uses (gregory-action-items-transfer-fix). Items extracted
  // from any of the client's calls surface here regardless of who's
  // assigned as the doer.
  const { data: itemRows, error: itemErr } = await supabase
    .from('call_action_items')
    .select('description, status, calls!inner(primary_client_id)')
    .eq('calls.primary_client_id', client_id)
    .eq('status', 'open')
    .order('extracted_at', { ascending: false })
  if (itemErr) {
    return { success: false, error: itemErr.message }
  }
  const items = ((itemRows ?? []) as Array<{ description: string }>).filter(
    (it) => typeof it.description === 'string' && it.description.length > 0,
  )
  if (items.length === 0) {
    return { success: false, error: 'No open action items' }
  }

  const messageText = formatActionItemsMessage(items)
  const dryRun = process.env.SLACK_DRY_RUN === 'true'
  const logPayload = {
    event: dryRun
      ? 'send_action_items_to_slack_DRY_RUN'
      : 'send_action_items_to_slack',
    client_id,
    channel_id: channelId,
    item_count: items.length,
    message_length: messageText.length,
    dry_run: dryRun,
    timestamp: new Date().toISOString(),
  }
  console.info(JSON.stringify(logPayload))
  if (dryRun) {
    // Echo the full message body in dry-run so Vercel function logs
    // capture what would have been sent.
    console.info(
      JSON.stringify({
        event: 'send_action_items_to_slack_DRY_RUN_body',
        client_id,
        channel_id: channelId,
        message_body: messageText,
      }),
    )
    return { success: true }
  }

  const result = await postMessage(channelId, messageText)
  if (!result.ok) {
    console.error(
      JSON.stringify({
        event: 'send_action_items_to_slack_FAILED',
        client_id,
        channel_id: channelId,
        slack_error: result.slackError,
      }),
    )
    return { success: false, error: result.slackError }
  }
  return { success: true }
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

// ----------------------------------------------------------------------
// removeNeedsReviewTagAction — clears the `needs_review` tag on a single
// client + stamps an audit timestamp under metadata. Does NOT touch
// status, primary_csm_id, assignments, or any other column. The CSM
// can re-add the tag manually via inline-edit if needed (no
// destructive-confirmation flow needed for re-adding — the side
// effects of having the tag are surfacing-only).
//
// Spec: docs/specs/auto-created-client-lifecycle.md § Remove-tag button.
// ----------------------------------------------------------------------
export async function removeNeedsReviewTagAction(
  clientId: string,
): Promise<{ success: true } | { success: false; error: string }> {
  const supabase = createAdminClient()

  const { data: client, error: readErr } = await supabase
    .from('clients')
    .select('tags, metadata, full_name')
    .eq('id', clientId)
    .maybeSingle()
  if (readErr || !client) {
    return { success: false, error: readErr?.message ?? 'Client not found' }
  }

  // `tags` is the top-level text[] column on clients. Some metadata
  // breadcrumbs reference tags too (e.g., older auto-create flows
  // wrote into metadata.tags). The clients table column is the
  // authoritative location — the merge RPC and the dashboard filter
  // both query the column. Drop `needs_review` from the column only;
  // metadata.tags (if present, legacy) is left for the existing
  // metadata-merge logic to clean up on its own cadence.
  const currentTags: string[] = Array.isArray(client.tags) ? client.tags : []
  if (!currentTags.includes('needs_review')) {
    return {
      success: false,
      error: 'Client does not have the needs_review tag',
    }
  }
  const newTags = currentTags.filter((t) => t !== 'needs_review')

  const existingMetadata =
    (client.metadata as Record<string, unknown> | null) ?? {}
  // Cast through unknown — matches the existing
  // updateClientProfileField pattern. Supabase types `metadata` as
  // Json (recursive union) but we know it's an object at this point.
  const newMetadata = {
    ...existingMetadata,
    needs_review_cleared_at: new Date().toISOString(),
  } as unknown as ClientRow['metadata']

  const { error: writeErr } = await supabase
    .from('clients')
    .update({ tags: newTags, metadata: newMetadata })
    .eq('id', clientId)
  if (writeErr) {
    return { success: false, error: writeErr.message }
  }

  revalidatePath(`/clients/${clientId}`)
  revalidatePath('/clients')
  return { success: true }
}
