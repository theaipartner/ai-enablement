import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

// Lightweight lead search for the /leads page search bar. Matches Close leads
// by display name (across ALL leads, not just the current window's cohort) so
// you can jump to any lead's per-lead page. Drops creator-soft-hidden leads.

export type LeadSearchResult = {
  leadId: string
  name: string | null
  dateCreated: string | null
  qualified: 'qualified' | 'non-qualified' | 'unknown'
}

export async function searchLeads(query: string): Promise<LeadSearchResult[]> {
  const q = query.trim()
  if (q.length < 2) return []
  const safe = q.replace(/[%_\\]/g, '\\$&') // escape ilike wildcards
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('close_leads' as never)
    .select('close_id, display_name, date_created, marketing_qualified')
    .ilike('display_name', `%${safe}%`)
    .is('excluded_at', null)
    .order('date_created', { ascending: false })
    .limit(40)
  if (error) throw new Error(`lead-search failed: ${error.message}`)
  return ((data ?? []) as unknown as Array<{
    close_id: string
    display_name: string | null
    date_created: string | null
    marketing_qualified: string | null
  }>).map((r) => {
    const mq = (r.marketing_qualified ?? '').trim().toLowerCase()
    return {
      leadId: r.close_id,
      name: r.display_name,
      dateCreated: r.date_created,
      qualified: mq === 'yes' ? 'qualified' : mq === 'no' ? 'non-qualified' : 'unknown',
    }
  })
}
