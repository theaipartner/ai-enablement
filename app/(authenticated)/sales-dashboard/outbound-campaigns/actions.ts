'use server'

// Admin actions for the Outbound Campaigns manager
// (/sales-dashboard/outbound-campaigns). Create / edit / activate / delete the
// new-model outbound campaigns (a custom-field NAME + exact VALUE, matched across
// Close + GHL) and re-tag (refresh) one. The /sales-dashboard segment is
// sales-area gated by its layout; these actions re-check admin server-side.
//
// New-model campaigns are independent (no exclusivity — a lead in two campaigns
// counts in both). The two finished legacy pools (Revival, Jacob) have no
// match_field_name and are READ-ONLY here — edit/delete refuse to touch them.

import { revalidatePath } from 'next/cache'

import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'
import { createAdminClient } from '@/lib/supabase/admin'

const PATH = '/sales-dashboard/outbound-campaigns'
const OUTBOUND = '/sales-dashboard/outbound'

export type SaveResult = { ok: true; key: string } | { ok: false; error: string }
export type SimpleResult = { ok: true } | { ok: false; error: string }
export type RefreshResult = { ok: true; leadCount: number } | { ok: false; error: string }

export type CampaignInput = {
  key?: string // present = edit; absent = create
  label: string
  matchFieldName: string
  matchValue: string
  startDate: string // YYYY-MM-DD (ET)
  active: boolean
}

function clean(v: string | null | undefined): string {
  return typeof v === 'string' ? v.trim() : ''
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

// Midnight America/New_York on `dateStr` as a UTC ISO string (matches how the two
// legacy campaigns' floors were quoted, e.g. Jun 3 ET = 2026-06-03T04:00:00Z).
function etMidnightUtcIso(dateStr: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null
  const probe = new Date(`${dateStr}T12:00:00Z`)
  const tzName = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  })
    .formatToParts(probe)
    .find((p) => p.type === 'timeZoneName')?.value
  const m = tzName?.match(/GMT([+-]\d{1,2})/)
  const offH = m ? Number(m[1]) : -4
  const sign = offH <= 0 ? '-' : '+'
  const pad = String(Math.abs(offH)).padStart(2, '0')
  return `${dateStr}T00:00:00${sign}${pad}:00`
}

async function requireAdmin() {
  const access = await getCurrentUserAccessTier()
  if (!access || !tierAtLeast(access.tier, 'admin')) return null
  return access
}

// Best-effort facts refresh for one campaign (the internal psycopg2 endpoint —
// the RPC can exceed PostgREST's 8s cap on a big match). Returns the lead count.
async function refreshFacts(key: string): Promise<RefreshResult> {
  const base = process.env.NEXT_PUBLIC_APP_URL
  const secret = process.env.CRON_SECRET
  if (!base || !secret) return { ok: false, error: 'refresh_endpoint_not_configured' }
  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/api/outbound_campaign_refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ key }),
      cache: 'no-store',
    })
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>
    if (!res.ok || !data.ok) return { ok: false, error: (data.error as string) ?? `refresh ${res.status}` }
    return { ok: true, leadCount: (data.lead_count as number) ?? 0 }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : 'refresh_failed' }
  }
}

export async function saveCampaign(input: CampaignInput): Promise<SaveResult> {
  if (!(await requireAdmin())) return { ok: false, error: 'forbidden' }

  const label = clean(input.label)
  const field = clean(input.matchFieldName)
  const value = clean(input.matchValue)
  if (!label) return { ok: false, error: 'name_required' }
  if (!field) return { ok: false, error: 'match_field_required' }
  if (!value) return { ok: false, error: 'match_value_required' }
  const floorAt = etMidnightUtcIso(clean(input.startDate))
  if (!floorAt) return { ok: false, error: 'invalid_start_date' }

  const admin = createAdminClient()
  const isEdit = !!clean(input.key)
  const key = clean(input.key) || slugify(label)
  if (!key) return { ok: false, error: 'could_not_derive_key' }

  if (isEdit) {
    // Guard: never edit a legacy (close_cf_id) campaign through here.
    const { data: existing } = await admin
      .from('outbound_campaigns' as never)
      .select('match_field_name')
      .eq('key', key)
      .maybeSingle()
    const row = existing as { match_field_name: string | null } | null
    if (!row) return { ok: false, error: 'campaign_not_found' }
    if (!row.match_field_name) return { ok: false, error: 'legacy_campaign_read_only' }

    const { error } = await admin
      .from('outbound_campaigns' as never)
      .update({
        label,
        match_field_name: field,
        match_value: value,
        floor_at: floorAt,
        is_active: input.active !== false,
      } as never)
      .eq('key', key)
    if (error) return { ok: false, error: error.message }
  } else {
    // New: sort_order = max+1 (switcher ordering; never affects legacy exclusivity).
    const { data: maxRow } = await admin
      .from('outbound_campaigns' as never)
      .select('sort_order')
      .order('sort_order', { ascending: false })
      .limit(1)
      .maybeSingle()
    const sortOrder = (((maxRow as { sort_order: number } | null)?.sort_order ?? -1) as number) + 1

    const { error } = await admin.from('outbound_campaigns' as never).insert({
      key,
      label,
      match_field_name: field,
      match_value: value,
      floor_at: floorAt,
      is_active: input.active !== false,
      sort_order: sortOrder,
    } as never)
    if (error) {
      if (error.code === '23505') return { ok: false, error: 'key_already_exists' }
      return { ok: false, error: error.message }
    }
  }

  // Populate the funnel immediately so the new/edited campaign isn't empty until
  // the next cron tick. Best-effort — the */15 cron is the backstop.
  await refreshFacts(key)
  revalidatePath(PATH)
  revalidatePath(OUTBOUND)
  return { ok: true, key }
}

export async function setCampaignActive(key: string, active: boolean): Promise<SimpleResult> {
  if (!(await requireAdmin())) return { ok: false, error: 'forbidden' }
  const k = clean(key)
  if (!k) return { ok: false, error: 'invalid_key' }
  const admin = createAdminClient()
  const { error } = await admin
    .from('outbound_campaigns' as never)
    .update({ is_active: active } as never)
    .eq('key', k)
  if (error) return { ok: false, error: error.message }
  revalidatePath(PATH)
  revalidatePath(OUTBOUND)
  return { ok: true }
}

// Delete a new-model campaign (and its materialized facts so it can't linger in
// the "All" aggregate). Legacy campaigns are refused.
export async function deleteCampaign(key: string): Promise<SimpleResult> {
  if (!(await requireAdmin())) return { ok: false, error: 'forbidden' }
  const k = clean(key)
  if (!k) return { ok: false, error: 'invalid_key' }
  const admin = createAdminClient()

  const { data: existing } = await admin
    .from('outbound_campaigns' as never)
    .select('match_field_name')
    .eq('key', k)
    .maybeSingle()
  const row = existing as { match_field_name: string | null } | null
  if (!row) return { ok: false, error: 'campaign_not_found' }
  if (!row.match_field_name) return { ok: false, error: 'legacy_campaign_read_only' }

  await admin.from('outbound_lead_facts' as never).delete().eq('campaign_key', k)
  const { error } = await admin.from('outbound_campaigns' as never).delete().eq('key', k)
  if (error) return { ok: false, error: error.message }
  revalidatePath(PATH)
  revalidatePath(OUTBOUND)
  return { ok: true }
}

// "Re-tag / Refresh now" — re-run the match so a changed custom field/value (or a
// fresh sync) re-applies. Same as the cron, scoped to one campaign.
export async function refreshCampaign(key: string): Promise<RefreshResult> {
  if (!(await requireAdmin())) return { ok: false, error: 'forbidden' }
  const k = clean(key)
  if (!k) return { ok: false, error: 'invalid_key' }
  const res = await refreshFacts(k)
  revalidatePath(PATH)
  revalidatePath(OUTBOUND)
  return res
}
