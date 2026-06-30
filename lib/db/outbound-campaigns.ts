import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

// Admin reads for the Outbound Campaigns manager (/sales-dashboard/outbound-campaigns).
// The funnel-facing loader (getOutboundCampaigns) lives in funnel-revival.ts; this
// file is the admin registry view (all campaigns incl. inactive + the match config).
//
// A campaign is "legacy" when it has no match_field_name (it's one of the two
// finished Close pools, Revival/Jacob, defined by close_cf_id + 0103 exclusivity).
// Legacy campaigns are shown read-only — they're done and must not be edited.

export type AdminOutboundCampaign = {
  key: string
  label: string
  matchFieldName: string | null
  matchValue: string | null
  floorAt: string | null
  isActive: boolean
  sortOrder: number
  isLegacy: boolean
  leadCount: number
}

type Row = {
  key: string
  label: string
  close_cf_id: string | null
  match_field_name: string | null
  match_value: string | null
  floor_at: string | null
  is_active: boolean
  sort_order: number
}

export async function getAllOutboundCampaigns(): Promise<AdminOutboundCampaign[]> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('outbound_campaigns' as never)
    .select('key, label, close_cf_id, match_field_name, match_value, floor_at, is_active, sort_order')
    .order('sort_order')
  if (error) throw new Error(`getAllOutboundCampaigns failed: ${error.message}`)
  const rows = (data ?? []) as Row[]

  // Per-campaign materialized lead count (head + exact). Few campaigns → cheap.
  const counts = await Promise.all(
    rows.map(async (r) => {
      const { count } = await sb
        .from('outbound_lead_facts' as never)
        .select('close_id', { count: 'exact', head: true })
        .eq('campaign_key', r.key)
      return [r.key, count ?? 0] as const
    }),
  )
  const countByKey = new Map(counts)

  return rows.map((r) => ({
    key: r.key,
    label: r.label,
    matchFieldName: r.match_field_name,
    matchValue: r.match_value,
    floorAt: r.floor_at,
    isActive: r.is_active,
    sortOrder: r.sort_order,
    isLegacy: !r.match_field_name,
    leadCount: countByKey.get(r.key) ?? 0,
  }))
}

// Known custom-field NAMES across both mirrors (Close + GHL), for the add-form's
// field-name suggestions. The union — a campaign can match either system.
export async function getMatchFieldSuggestions(): Promise<string[]> {
  const sb = createAdminClient()
  const [close, ghl] = await Promise.all([
    sb.from('close_custom_field_definitions' as never).select('name'),
    sb.from('ghl_custom_field_definitions' as never).select('name'),
  ])
  const names = new Set<string>()
  for (const r of (close.data ?? []) as Array<{ name: string | null }>) {
    if (r.name) names.add(r.name)
  }
  for (const r of (ghl.data ?? []) as Array<{ name: string | null }>) {
    if (r.name) names.add(r.name)
  }
  return Array.from(names).sort((a, b) => a.localeCompare(b))
}
