import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type {
  WistiaVideoOption,
  TypeformOption,
  TypeformFieldChoice,
  TypeformField,
  LpDiscovery,
} from './landing-pages-shared'

// Asset + discovery helpers for the admin "Add Landing Page" page.
//
// Dropdown sources are DB-first (our mirrors): Wistia videos from
// `wistia_medias`, Typeform forms + their answer choices from `typeform_forms`.
// The only external call is fetching the landing-page URL itself to auto-extract
// which Typeform + Wistia videos it embeds (best-effort — the confirm screen lets
// the admin fix anything).

export type {
  WistiaVideoOption,
  TypeformOption,
  TypeformFieldChoice,
  TypeformField,
  LpDiscovery,
}

// Wistia inventory for the VSL / confirm-video dropdowns.
export async function getWistiaInventory(): Promise<WistiaVideoOption[]> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('wistia_medias' as never)
    .select('hashed_id, name')
    .order('name', { ascending: true })
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((r) => ({
      hashedId: (r.hashed_id as string) ?? '',
      name: (r.name as string) ?? '',
    }))
    .filter((v) => v.hashedId)
}

// Typeform forms for the form dropdown (newest first).
export async function getTypeformForms(): Promise<TypeformOption[]> {
  const admin = createAdminClient()
  const { data } = await admin
    .from('typeform_forms' as never)
    .select('form_id, title, last_updated_at')
    .order('last_updated_at', { ascending: false })
  return ((data ?? []) as Array<Record<string, unknown>>)
    .map((r) => ({
      formId: (r.form_id as string) ?? '',
      title: (r.title as string) ?? '(untitled)',
    }))
    .filter((f) => f.formId)
}

// A form's fields + answer choices (for the qualification-question picker),
// from the typeform_forms.fields mirror. Only fields that have choices are
// useful as a qualification question, but we return all for flexibility.
export async function getTypeformFields(formId: string): Promise<TypeformField[]> {
  if (!formId) return []
  const admin = createAdminClient()
  const { data } = await admin
    .from('typeform_forms' as never)
    .select('fields')
    .eq('form_id', formId)
    .maybeSingle()
  const fields = ((data as Record<string, unknown> | null)?.fields ?? []) as Array<
    Record<string, unknown>
  >
  if (!Array.isArray(fields)) return []
  return fields.map((f) => {
    const props = (f.properties ?? {}) as Record<string, unknown>
    const rawChoices = (props.choices ?? []) as Array<Record<string, unknown>>
    return {
      ref: (f.ref as string) ?? '',
      title: (f.title as string) ?? '',
      type: (f.type as string) ?? '',
      choices: Array.isArray(rawChoices)
        ? rawChoices
            .map((c) => ({ label: (c.label as string) ?? '' }))
            .filter((c) => c.label)
        : [],
    }
  })
}

// Fetch the landing-page URL and extract the Typeform form_id + Wistia
// hashed_ids it embeds. Best-effort: the form id appears inconsistently (a short
// id in data-tf-popup, a ULID in data-tf-live, or injected by JS), so we collect
// candidates and resolve them against the typeform_forms mirror; the page's
// confirm screen handles anything we miss.
export async function discoverLpAssets(url: string): Promise<LpDiscovery> {
  const empty: LpDiscovery = { ok: false, vslCandidates: [], typeformGuessId: null }
  let html: string
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Gregory LP discovery)' },
      redirect: 'follow',
      cache: 'no-store',
    })
    if (!res.ok) return { ...empty, error: `fetch ${res.status}` }
    html = await res.text()
  } catch (e) {
    return { ...empty, error: e instanceof Error ? e.message : 'fetch failed' }
  }

  // Wistia: fast.wistia.com/embed/medias/<id> or /embed/<id>, or wistia_async_<id>.
  const wistiaIds = new Set<string>()
  for (const re of [
    /wistia\.(?:com|net)\/(?:embed\/)?(?:medias\/)?([a-z0-9]{8,12})/gi,
    /wistia[_-]async[_-]([a-z0-9]{8,12})/gi,
  ]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) wistiaIds.add(m[1])
  }

  // Typeform candidates: data-tf-popup / data-tf-live / data-tf-widget attrs and
  // form.typeform.com/to/<id> / admin.typeform.com/form/<id> URLs.
  const tfCandidates = new Set<string>()
  for (const re of [
    /data-tf-(?:popup|live|widget|slider|sidetab|popover)=["']([A-Za-z0-9]+)["']/gi,
    /(?:form|admin)\.typeform\.com\/(?:to|form)\/([A-Za-z0-9]+)/gi,
  ]) {
    let m: RegExpExecArray | null
    while ((m = re.exec(html)) !== null) tfCandidates.add(m[1])
  }

  // Resolve candidates against our mirrors.
  const [inventory, forms] = await Promise.all([getWistiaInventory(), getTypeformForms()])
  const invBy: Record<string, string> = {}
  for (const v of inventory) invBy[v.hashedId] = v.name
  const vslCandidates = Array.from(wistiaIds).map((hashedId) => ({
    hashedId,
    name: invBy[hashedId] ?? '(not in Wistia mirror yet)',
  }))

  const formIdSet = new Set(forms.map((f) => f.formId))
  const typeformGuessId = Array.from(tfCandidates).find((c) => formIdSet.has(c)) ?? null

  return { ok: true, vslCandidates, typeformGuessId }
}
