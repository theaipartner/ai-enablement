import 'server-only'

import { cache } from 'react'
import { createAdminClient } from '@/lib/supabase/admin'
import type {
  LandingPageVsl,
  LandingPageForm,
  LandingPage,
} from './landing-pages-shared'

export type { LandingPageVsl, LandingPageForm, LandingPage }

// Landing-page registry — now DB-backed (tables `landing_pages` +
// `landing_page_forms`, migration 0110). Was a static array here; moved to the
// DB so landing pages can be added/edited in Gregory (the admin page) with no
// deploy. The shape returned is unchanged for existing consumers (slug, label,
// lpPath, typeformFormId, typeformLabel, vsl[], confirmVideo*) PLUS a `forms`
// array (an LP can own >1 form — editing an LP ADDS a form, keeping the old
// form's cycles counted; form_id is UNIQUE so a form belongs to one LP).
//
// All reads go through the service-role admin client (bounded 60s cache) and are
// additionally memoized per-request via React cache(). Server-only.
//
// The eligible OPT-IN form set (was HIGH_TICKET_TYPEFORM_FORM_IDS /
// OPT_IN_FORMS / FORM_IDS) is the UNION of every form_id in landing_page_forms,
// across active AND inactive LPs — deactivating an LP must never drop a form
// that still has cycles. Per-form qualification (field ref + qualifying answers)
// also lives on each form row, replacing the global INVEST_FIELD_REF rule.

type LpRow = {
  slug: string
  label: string
  lp_path: string | null
  lp_url: string | null
  typeform_label: string | null
  vsl: unknown
  confirm_video_hashed_id: string | null
  confirm_video_label: string | null
  active: boolean
  sort_order: number
}

type FormRow = {
  landing_page_slug: string
  form_id: string
  typeform_title: string | null
  qualify_field_ref: string | null
  qualify_answers: string[] | null
  is_primary: boolean
}

function toVsl(raw: unknown): LandingPageVsl[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((v) => {
      const o = (v ?? {}) as Record<string, unknown>
      const hashedId = typeof o.hashedId === 'string' ? o.hashedId : null
      if (!hashedId) return null
      return { hashedId, label: typeof o.label === 'string' ? o.label : 'VSL' }
    })
    .filter((x): x is LandingPageVsl => x !== null)
}

// Load every LP (active + inactive) with its forms, joined in memory. Memoized
// per request. `active`-filtering is the caller's job (the dropdown wants active;
// the eligible-form set wants all).
const loadAll = cache(async function loadAll(): Promise<LandingPage[]> {
  const admin = createAdminClient()
  const [lpRes, formRes] = await Promise.all([
    admin
      .from('landing_pages' as never)
      .select(
        'slug, label, lp_path, lp_url, typeform_label, vsl, confirm_video_hashed_id, confirm_video_label, active, sort_order',
      )
      .order('sort_order', { ascending: true }),
    admin
      .from('landing_page_forms' as never)
      .select(
        'landing_page_slug, form_id, typeform_title, qualify_field_ref, qualify_answers, is_primary',
      )
      .order('is_primary', { ascending: false }),
  ])

  const lps = (lpRes.data ?? []) as unknown as LpRow[]
  const forms = (formRes.data ?? []) as unknown as FormRow[]

  const formsBySlug = new Map<string, LandingPageForm[]>()
  for (const f of forms) {
    const arr = formsBySlug.get(f.landing_page_slug) ?? []
    arr.push({
      formId: f.form_id,
      typeformTitle: f.typeform_title,
      qualifyFieldRef: f.qualify_field_ref,
      qualifyAnswers: f.qualify_answers ?? [],
      isPrimary: f.is_primary,
    })
    formsBySlug.set(f.landing_page_slug, arr)
  }

  return lps.map((lp) => {
    const lpForms = formsBySlug.get(lp.slug) ?? []
    const primary = lpForms.find((f) => f.isPrimary) ?? lpForms[0]
    return {
      slug: lp.slug,
      label: lp.label,
      lpPath: lp.lp_path ?? '',
      lpUrl: lp.lp_url ?? '',
      typeformFormId: primary?.formId ?? '',
      forms: lpForms,
      typeformLabel: lp.typeform_label ?? '',
      vsl: toVsl(lp.vsl),
      confirmVideoHashedId: lp.confirm_video_hashed_id ?? '',
      confirmVideoLabel: lp.confirm_video_label ?? '',
      active: lp.active,
      sortOrder: lp.sort_order,
    }
  })
})

// Active LPs, ordered — the dropdown + LP-detail universe.
export async function getLandingPages(): Promise<LandingPage[]> {
  return (await loadAll()).filter((lp) => lp.active)
}

// ALL LPs (active + inactive), ordered — the admin registry-management page.
export async function getAllLandingPages(): Promise<LandingPage[]> {
  return loadAll()
}

// Resolve a ?lp= slug to its entry, falling back to the first active LP for an
// unknown / missing slug (stale link, hand-edited URL) — mirrors the old sync
// getLandingPage fallback. Resolves inactive LPs too (a direct slug hit wins).
export async function getLandingPage(
  slug?: string | string[] | null,
): Promise<LandingPage> {
  const s = Array.isArray(slug) ? slug[0] : slug
  const all = await loadAll()
  const active = all.filter((lp) => lp.active)
  return all.find((lp) => lp.slug === s) ?? active[0] ?? all[0]
}

// The default LP slug (first active by sort_order).
export async function getDefaultLandingPageSlug(): Promise<string> {
  return (await getLandingPages())[0]?.slug ?? 'main'
}

// The eligible OPT-IN Typeform form set — union across ALL LPs (active AND
// inactive). Replaces HIGH_TICKET_TYPEFORM_FORM_IDS / OPT_IN_FORMS / FORM_IDS on
// the TS side. Includes inactive LPs so deactivation never orphans cycles.
export async function getHighTicketFormIds(): Promise<string[]> {
  const all = await loadAll()
  const ids = new Set<string>()
  for (const lp of all) for (const f of lp.forms) ids.add(f.formId)
  return Array.from(ids)
}

// The high-ticket VSL hashed_ids — union across all LPs. Replaces
// HIGH_TICKET_VSL_HASHED_IDS.
export async function getHighTicketVslHashedIds(): Promise<string[]> {
  const all = await loadAll()
  const ids = new Set<string>()
  for (const lp of all) for (const v of lp.vsl) ids.add(v.hashedId)
  return Array.from(ids)
}

// The high-ticket confirmation-video hashed_ids — union across all LPs.
// Replaces the single HIGH_TICKET_CONFIRM_VIDEO_HASHED_ID for aggregate reads.
export async function getHighTicketConfirmVideoHashedIds(): Promise<string[]> {
  const all = await loadAll()
  const ids = new Set<string>()
  for (const lp of all) if (lp.confirmVideoHashedId) ids.add(lp.confirmVideoHashedId)
  return Array.from(ids)
}
