'use server'

// Admin actions for the Landing Pages manager (/sales-dashboard/landing-pages).
// Create / edit / delete landing pages in the DB-backed registry (landing_pages
// + landing_page_forms, migration 0110). The whole /sales-dashboard segment is
// admin-gated by its layout; actions re-check admin server-side.
//
// "Editing the form" ADDS a form to the LP (an LP owns a SET of forms) — old
// forms keep their cycles counted. A form belongs to one LP (form_id UNIQUE).

import { revalidatePath } from 'next/cache'

import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  discoverLpAssets,
  getTypeformFields,
  type LpDiscovery,
  type TypeformField,
} from '@/lib/db/landing-page-assets'

const PATH = '/sales-dashboard/landing-pages'

export type SaveResult = { ok: true; slug: string } | { ok: false; error: string }
export type SimpleResult = { ok: true } | { ok: false; error: string }

export type LpFormInput = {
  formId: string
  typeformTitle: string | null
  qualifyFieldRef: string | null
  qualifyAnswers: string[]
}

export type LpInput = {
  slug?: string // present = edit; absent = create
  label: string
  lpUrl: string | null
  lpPath: string | null
  typeformLabel: string | null
  vsl: { hashedId: string; label: string }[]
  confirmVideoHashedId: string | null
  confirmVideoLabel: string | null
  active: boolean
  form: LpFormInput // the form to register/add (required — the attribution key)
}

function clean(v: string | null | undefined): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length ? t : null
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

async function requireAdmin() {
  const access = await getCurrentUserAccessTier()
  if (!access || !tierAtLeast(access.tier, 'admin')) return null
  return access
}

// Auto-discover the Typeform + Wistia videos a landing-page URL embeds.
export async function discoverFromUrl(url: string): Promise<LpDiscovery> {
  const access = await requireAdmin()
  if (!access) return { ok: false, error: 'forbidden', vslCandidates: [], typeformGuessId: null }
  const u = clean(url)
  if (!u) return { ok: false, error: 'invalid_url', vslCandidates: [], typeformGuessId: null }
  return discoverLpAssets(u)
}

// A form's fields + answer choices for the qualification-question picker.
export async function loadTypeformFields(formId: string): Promise<TypeformField[]> {
  const access = await requireAdmin()
  if (!access) return []
  return getTypeformFields(clean(formId) ?? '')
}

// Create or update a landing page (+ register/add its form). Editing the form
// ADDS it (form_id UNIQUE → reject if it belongs to a different LP).
export async function saveLandingPage(input: LpInput): Promise<SaveResult> {
  const access = await requireAdmin()
  if (!access) return { ok: false, error: 'forbidden' }

  const label = clean(input.label)
  if (!label) return { ok: false, error: 'label_required' }
  const formId = clean(input.form?.formId)
  if (!formId) return { ok: false, error: 'typeform_required' }

  const isEdit = !!clean(input.slug)
  const slug = clean(input.slug) ?? slugify(label)
  if (!slug) return { ok: false, error: 'could_not_derive_slug' }

  const admin = createAdminClient()

  // Guard: the form must not already belong to a DIFFERENT landing page.
  const { data: existingForm } = await admin
    .from('landing_page_forms' as never)
    .select('landing_page_slug')
    .eq('form_id', formId)
    .maybeSingle()
  const ownerSlug = (existingForm as Record<string, unknown> | null)?.landing_page_slug as
    | string
    | undefined
  if (ownerSlug && ownerSlug !== slug) {
    return { ok: false, error: `typeform_already_used_by:${ownerSlug}` }
  }

  // sort_order: keep existing on edit; max+1 on create.
  let sortOrder = 0
  if (!isEdit) {
    const { data: maxRow } = await admin
      .from('landing_pages' as never)
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle()
    sortOrder = (((maxRow as Record<string, unknown> | null)?.sort_order as number) ?? -1) + 1
  }

  const lpRow: Record<string, unknown> = {
    slug,
    label,
    lp_url: clean(input.lpUrl),
    lp_path: clean(input.lpPath),
    typeform_label: clean(input.typeformLabel),
    vsl: input.vsl
      .map((v) => ({ hashedId: clean(v.hashedId), label: clean(v.label) ?? 'VSL' }))
      .filter((v) => v.hashedId),
    confirm_video_hashed_id: clean(input.confirmVideoHashedId),
    confirm_video_label: clean(input.confirmVideoLabel),
    active: input.active !== false,
  }
  if (!isEdit) lpRow.sort_order = sortOrder

  const { error: lpErr } = await admin
    .from('landing_pages' as never)
    .upsert(lpRow as never, { onConflict: 'slug' } as never)
  if (lpErr) return { ok: false, error: lpErr.message }

  // Register / update the form (upsert by form_id). is_primary stays true for the
  // form being saved; other forms on this LP are demoted only if this is new.
  const formRow: Record<string, unknown> = {
    landing_page_slug: slug,
    form_id: formId,
    typeform_title: clean(input.form.typeformTitle),
    qualify_field_ref: clean(input.form.qualifyFieldRef),
    qualify_answers: input.form.qualifyAnswers ?? [],
    is_primary: true,
  }
  const { error: formErr } = await admin
    .from('landing_page_forms' as never)
    .upsert(formRow as never, { onConflict: 'form_id' } as never)
  if (formErr) return { ok: false, error: formErr.message }

  revalidatePath(PATH)
  revalidatePath('/sales-dashboard/funnel')
  return { ok: true, slug }
}

// Activate / deactivate (hide from the dropdown without dropping its forms from
// the eligible set — cycles stay counted).
export async function setLandingPageActive(
  slug: string,
  active: boolean,
): Promise<SimpleResult> {
  const access = await requireAdmin()
  if (!access) return { ok: false, error: 'forbidden' }
  const s = clean(slug)
  if (!s) return { ok: false, error: 'invalid_slug' }
  const admin = createAdminClient()
  const { error } = await admin
    .from('landing_pages' as never)
    .update({ active } as never)
    .eq('slug', s)
  if (error) return { ok: false, error: error.message }
  revalidatePath(PATH)
  revalidatePath('/sales-dashboard/funnel')
  return { ok: true }
}

// Hard-delete a landing page (test/junk). Refused if any of its forms already
// has lead_cycles — deleting would drop those forms from the eligible set and a
// later full retag would wipe their cycles. Deactivate those instead.
export async function deleteLandingPage(slug: string): Promise<SimpleResult> {
  const access = await requireAdmin()
  if (!access) return { ok: false, error: 'forbidden' }
  const s = clean(slug)
  if (!s) return { ok: false, error: 'invalid_slug' }
  const admin = createAdminClient()

  const { data: forms } = await admin
    .from('landing_page_forms' as never)
    .select('form_id')
    .eq('landing_page_slug', s)
  const formIds = ((forms ?? []) as Array<Record<string, unknown>>).map(
    (f) => f.form_id as string,
  )
  if (formIds.length) {
    const { count } = await admin
      .from('lead_cycles' as never)
      .select('close_id', { count: 'exact', head: true })
      .in('source_form_id', formIds)
    if ((count ?? 0) > 0) {
      return { ok: false, error: 'has_cycles_deactivate_instead' }
    }
  }

  // No cycles → safe to delete (landing_page_forms cascades via FK).
  const { error } = await admin.from('landing_pages' as never).delete().eq('slug', s)
  if (error) return { ok: false, error: error.message }
  revalidatePath(PATH)
  revalidatePath('/sales-dashboard/funnel')
  return { ok: true }
}

// "Retag now" — backfill cycles for leads that opted in through this LP's forms
// BEFORE it was registered (going-forward leads attribute automatically). The
// tagger is Python, so this calls the internal api/landing_page_retag endpoint.
export type RetagResult = { ok: true; leadCount: number } | { ok: false; error: string }

export async function retagLandingPage(slug: string): Promise<RetagResult> {
  const access = await requireAdmin()
  if (!access) return { ok: false, error: 'forbidden' }
  const s = clean(slug)
  if (!s) return { ok: false, error: 'invalid_slug' }

  const base = process.env.NEXT_PUBLIC_APP_URL
  const secret = process.env.CRON_SECRET
  if (!base || !secret) return { ok: false, error: 'retag_endpoint_not_configured' }

  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/landing_page_retag`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ slug: s }),
      cache: 'no-store',
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || !data.ok) {
      return { ok: false, error: (data.error as string) ?? `retag ${res.status}` }
    }
    revalidatePath(PATH)
    revalidatePath('/sales-dashboard/funnel')
    return { ok: true, leadCount: (data.lead_count as number) ?? 0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'retag_failed' }
  }
}
