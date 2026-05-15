'use server'

import { revalidatePath } from 'next/cache'
import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'
import { createAdminClient } from '@/lib/supabase/admin'

// Server actions for the admin-tier /cost-hub page. Every action
// self-checks admin-tier access as defense-in-depth (the sub-layout
// already gates, but server actions are reachable from any page).
// All six actions revalidatePath('/cost-hub') on success so the page
// rerenders with fresh data.
//
// Soft archive on delete — historical month totals stay accurate for
// months when the row was active. Hard delete via SQL is available
// for the rare "I never want to see this row again" case.
//
// Spec: docs/specs/cost-hub.md.

type ActionResult =
  | { success: true }
  | { success: false; error: string }

async function requireAdmin(): Promise<true | { error: string }> {
  if (process.env.NEXT_PUBLIC_DISABLE_AUTH === 'true') {
    return true
  }
  const access = await getCurrentUserAccessTier()
  if (!access || !tierAtLeast(access.tier, 'admin')) {
    return { error: 'insufficient_access' }
  }
  return true
}

// ---------------------------------------------------------------------------
// monthly_subscriptions
// ---------------------------------------------------------------------------

// effective_from validation. Defaults to today (EST) when omitted —
// defensive; the form always passes it, but a fallback prevents a
// crash if a future caller doesn't.
function resolveEffectiveFrom(
  effectiveFrom: string | undefined,
): { ok: true; value: string } | { ok: false; error: string } {
  if (effectiveFrom === undefined || effectiveFrom === '') {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/New_York',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date())
    return { ok: true, value: today }
  }
  if (!ISO_DATE_RE.test(effectiveFrom)) {
    return { ok: false, error: 'effective_from must be YYYY-MM-DD' }
  }
  return { ok: true, value: effectiveFrom }
}

export async function addMonthlySubscriptionAction(
  provider: string,
  monthlyCost: number,
  notes: string | null,
  effectiveFrom?: string,
): Promise<ActionResult> {
  const trimmedProvider = provider.trim()
  if (!trimmedProvider) {
    return { success: false, error: 'Provider cannot be empty' }
  }
  if (trimmedProvider.length > 200) {
    return { success: false, error: 'Provider name too long (200 char max)' }
  }
  if (!Number.isFinite(monthlyCost) || monthlyCost < 0) {
    return { success: false, error: 'Monthly cost must be a non-negative number' }
  }
  const trimmedNotes = (notes ?? '').trim()
  if (trimmedNotes.length > 1000) {
    return { success: false, error: 'Notes too long (1000 char max)' }
  }
  const eff = resolveEffectiveFrom(effectiveFrom)
  if (!eff.ok) {
    return { success: false, error: eff.error }
  }
  const auth = await requireAdmin()
  if (auth !== true) {
    return { success: false, error: auth.error }
  }
  const supabase = createAdminClient()
  const { error } = await supabase.from('monthly_subscriptions').insert({
    provider: trimmedProvider,
    monthly_cost_usd: monthlyCost,
    notes: trimmedNotes || null,
    effective_from: eff.value,
  })
  if (error) {
    return { success: false, error: error.message }
  }
  revalidatePath('/cost-hub')
  return { success: true }
}

export async function updateMonthlySubscriptionAction(
  id: string,
  provider: string,
  monthlyCost: number,
  notes: string | null,
  effectiveFrom?: string,
): Promise<ActionResult> {
  const trimmedProvider = provider.trim()
  if (!trimmedProvider) {
    return { success: false, error: 'Provider cannot be empty' }
  }
  if (!Number.isFinite(monthlyCost) || monthlyCost < 0) {
    return { success: false, error: 'Monthly cost must be a non-negative number' }
  }
  const trimmedNotes = (notes ?? '').trim()
  const eff = resolveEffectiveFrom(effectiveFrom)
  if (!eff.ok) {
    return { success: false, error: eff.error }
  }
  const auth = await requireAdmin()
  if (auth !== true) {
    return { success: false, error: auth.error }
  }
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('monthly_subscriptions')
    .update({
      provider: trimmedProvider,
      monthly_cost_usd: monthlyCost,
      notes: trimmedNotes || null,
      effective_from: eff.value,
    })
    .eq('id', id)
  if (error) {
    return { success: false, error: error.message }
  }
  revalidatePath('/cost-hub')
  return { success: true }
}

export async function deleteMonthlySubscriptionAction(
  id: string,
): Promise<ActionResult> {
  const auth = await requireAdmin()
  if (auth !== true) {
    return { success: false, error: auth.error }
  }
  const supabase = createAdminClient()
  // Soft archive — historical totals still see this row's monthly_cost
  // for months when it was active.
  const { error } = await supabase
    .from('monthly_subscriptions')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
    .is('archived_at', null)
  if (error) {
    return { success: false, error: error.message }
  }
  revalidatePath('/cost-hub')
  return { success: true }
}

// ---------------------------------------------------------------------------
// cost_extras
// ---------------------------------------------------------------------------

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export async function addCostExtraAction(
  incurredOn: string,
  description: string,
  costUsd: number,
): Promise<ActionResult> {
  if (!ISO_DATE_RE.test(incurredOn)) {
    return { success: false, error: 'incurred_on must be YYYY-MM-DD' }
  }
  const trimmedDesc = description.trim()
  if (!trimmedDesc) {
    return { success: false, error: 'Description cannot be empty' }
  }
  if (trimmedDesc.length > 500) {
    return { success: false, error: 'Description too long (500 char max)' }
  }
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    return { success: false, error: 'Cost must be a non-negative number' }
  }
  const auth = await requireAdmin()
  if (auth !== true) {
    return { success: false, error: auth.error }
  }
  const supabase = createAdminClient()
  const { error } = await supabase.from('cost_extras').insert({
    incurred_on: incurredOn,
    description: trimmedDesc,
    cost_usd: costUsd,
  })
  if (error) {
    return { success: false, error: error.message }
  }
  revalidatePath('/cost-hub')
  return { success: true }
}

export async function updateCostExtraAction(
  id: string,
  incurredOn: string,
  description: string,
  costUsd: number,
): Promise<ActionResult> {
  if (!ISO_DATE_RE.test(incurredOn)) {
    return { success: false, error: 'incurred_on must be YYYY-MM-DD' }
  }
  const trimmedDesc = description.trim()
  if (!trimmedDesc) {
    return { success: false, error: 'Description cannot be empty' }
  }
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    return { success: false, error: 'Cost must be a non-negative number' }
  }
  const auth = await requireAdmin()
  if (auth !== true) {
    return { success: false, error: auth.error }
  }
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('cost_extras')
    .update({
      incurred_on: incurredOn,
      description: trimmedDesc,
      cost_usd: costUsd,
    })
    .eq('id', id)
  if (error) {
    return { success: false, error: error.message }
  }
  revalidatePath('/cost-hub')
  return { success: true }
}

export async function deleteCostExtraAction(
  id: string,
): Promise<ActionResult> {
  const auth = await requireAdmin()
  if (auth !== true) {
    return { success: false, error: auth.error }
  }
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('cost_extras')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id)
    .is('archived_at', null)
  if (error) {
    return { success: false, error: error.message }
  }
  revalidatePath('/cost-hub')
  return { success: true }
}
