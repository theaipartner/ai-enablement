import { createAdminClient } from '@/lib/supabase/admin'

// Ad-set id → name, from cortana_adset_daily (groupBy=medium mirror; see
// migration 0089). The cascade's Ad Set dropdown reads this to show "Broad"
// instead of the bare numeric Meta ad-set id. Latest day's name wins per id.
//
// Scoped to the ids actually in the funnel's hierarchy so the read stays small.
// Any id with no Cortana row (e.g. a junk {{adset.id}} macro, or a brand-new
// ad set not yet pulled) just isn't in the map; the UI falls back to the id.
export async function getAdsetNameMap(adsetIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  const ids = Array.from(new Set(adsetIds.filter((id) => /^\d+$/.test(id))))
  if (ids.length === 0) return map
  try {
    const sb = createAdminClient()
    // cortana_* tables aren't in the generated Database type → cast like
    // leads-funnel.ts does for cortana_ad_daily.
    const { data, error } = await sb
      .from('cortana_adset_daily' as never)
      .select('platform_entity_id, entity_name, day')
      .in('platform_entity_id', ids)
      .order('day', { ascending: false })
    if (error) throw new Error(error.message)
    const rows = (data ?? []) as unknown as Array<{ platform_entity_id: string | null; entity_name: string | null }>
    for (const r of rows) {
      const id = r.platform_entity_id
      // First row per id is the latest day (ordered desc) — keep it.
      if (id && r.entity_name && !map.has(id)) map.set(id, r.entity_name)
    }
  } catch {
    // No names is fine — the cascade falls back to showing the id.
  }
  return map
}
