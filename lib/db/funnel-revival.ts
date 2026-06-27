import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DcPlanCounts } from './funnel-dc'

// Outbound funnel — SQL aggregation (migrations 0093 + 0094). One
// `outbound_funnel(p_campaign_key)` RPC returns the whole page: funnel + called
// + timeOfDay. Replaces the old all-time JS loaders (3 × full close_leads scan
// for anchors + ~58 chunk-queries each across 4 signal tables, ~600 round trips
// per load).
//
// Connected = a >=90s call ONLY (either direction) — the form-reach branch is
// gone (Drake 2026-06-24), matching the rest of the app. Parameterized by
// CAMPAIGN via the outbound_campaigns registry, so future outbound campaigns
// (other lead tags) are a registry row + a dropdown option — see the function.
//
// Verified cell-by-cell against the prior JS before cut-over. The only deltas
// were the reply/dial counts (responded, dials, speed buckets, time-of-day
// replies/dials): the SQL counts them correctly, where the JS undercounted via
// supabase's 1000-row page cap (one 200-lead chunk held 1068 inbound SMS). The
// funnel stages (connected/booked/showed/closed/cash) are identical.

export type RevivalFunnel = {
  leads: number
  responded: number
  called: number
  connected: number
  booked: number
  bookedDc: number
  bookedHt: number
  showed: number
  closed: number
  closedPlans: DcPlanCounts
  cashUsd: number
  markedNoPlan: number
}

export type RevivalSpeedBucket = { label: string; count: number; connected: number }

export type RevivalCalled = {
  responded: number
  called: number
  connected: number
  notCalled: number
  speed: RevivalSpeedBucket[]
  speedN: number
  speedMedianMin: number | null
}

export type RevivalHourBucket = { label: string; replies: number; dials: number; connects: number }

// One row of the per-rep breakdown (Dials / Connections / Closes / Cash).
export type OutboundRepRow = {
  rep: string
  dials: number
  connections: number
  closes: number
  cash: number
}

// Activity-window totals for the per-rep header: total closes + the unit mix
// actually sold (same plan classification as the funnel's closedPlans).
export type OutboundRepTotals = {
  closes: number
  base44Monthly: number
  base44Yearly: number
  wixMonthly: number
  wixYearly: number
}

export type OutboundByRep = { reps: OutboundRepRow[]; totals: OutboundRepTotals }

// The SQL returns the 12 two-hour ET buckets in order; their labels live here.
const TOD_LABELS = ['12a', '2a', '4a', '6a', '8a', '10a', '12p', '2p', '4p', '6p', '8p', '10p']

// Raw shape of the outbound_funnel() jsonb (called.buckets -> .speed; timeOfDay
// rows get labels applied by index below).
type RawOutbound = {
  funnel: RevivalFunnel
  called: Omit<RevivalCalled, 'speed'> & { buckets: RevivalSpeedBucket[] }
  timeOfDay: { replies: number; dials: number; connects: number }[]
  activeFrom: string | null
  activeTo: string | null
}

// Active outbound campaigns for the page's switcher (Revival, Jacob, …), in
// sort order. Each is a registry row in outbound_campaigns (migration 0093+).
export async function getOutboundCampaigns(): Promise<Array<{ key: string; label: string }>> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('outbound_campaigns' as never)
    .select('key, label, sort_order, is_active')
    .eq('is_active', true)
    .order('sort_order')
  if (error) throw new Error(`getOutboundCampaigns failed: ${error.message}`)
  return ((data ?? []) as Array<{ key: string; label: string }>).map((c) => ({ key: c.key, label: c.label }))
}

// `range` (optional) scopes the funnel by each lead's anchor (when it entered
// the campaign = greatest(date_created, floor)) — a fast in-memory filter over
// the materialized facts (migration 0102). Omitted → all-time. activeFrom/
// activeTo are the campaign's full anchor span (independent of range), for the
// "active dates" label.
export async function getOutboundFunnel(
  campaignKey = 'revival',
  range?: { startUtcIso: string; endUtcIso: string },
): Promise<{
  funnel: RevivalFunnel
  called: RevivalCalled
  timeOfDay: { buckets: RevivalHourBucket[] }
  activeFrom: string | null
  activeTo: string | null
}> {
  const sb = createAdminClient()
  // 'all' → null = aggregate every campaign (the page's "All" view, migration 0108).
  const args: Record<string, unknown> = { p_campaign_key: campaignKey === 'all' ? null : campaignKey }
  if (range) {
    args.p_start = range.startUtcIso
    args.p_end = range.endUtcIso
  }
  const { data, error } = await sb.rpc('outbound_funnel' as never, args as never)
  if (error) throw new Error(`outbound_funnel RPC failed: ${error.message}`)
  const r = data as unknown as RawOutbound

  return {
    funnel: r.funnel,
    called: {
      responded: r.called.responded,
      called: r.called.called,
      connected: r.called.connected,
      notCalled: r.called.notCalled,
      speed: r.called.buckets,
      speedN: r.called.speedN,
      speedMedianMin: r.called.speedMedianMin,
    },
    timeOfDay: {
      buckets: r.timeOfDay.map((b, i) => ({
        label: TOD_LABELS[i] ?? '',
        replies: b.replies,
        dials: b.dials,
        connects: b.connects,
      })),
    },
    activeFrom: r.activeFrom ?? null,
    activeTo: r.activeTo ?? null,
  }
}

// Per-rep Outbound breakdown (migration 0104). ACTIVITY-scoped — unlike the
// cohort funnel, this counts what each rep DID in [start, end): calls by their
// activity_at, closes by their form date, regardless of when the lead entered.
// Only reps who actually closed are returned (sorted by closes, then cash). The
// range is required; the page always passes its calendar range.
export async function getOutboundByRep(
  campaignKey: string,
  range: { startUtcIso: string; endUtcIso: string },
): Promise<OutboundByRep> {
  const sb = createAdminClient()
  const { data, error } = await sb.rpc('outbound_funnel_by_rep' as never, {
    p_campaign_key: campaignKey === 'all' ? null : campaignKey, // 'all' = every campaign
    p_start: range.startUtcIso,
    p_end: range.endUtcIso,
  } as never)
  if (error) throw new Error(`outbound_funnel_by_rep RPC failed: ${error.message}`)
  const d = data as unknown as OutboundByRep | null
  return {
    reps: d?.reps ?? [],
    totals: d?.totals ?? { closes: 0, base44Monthly: 0, base44Yearly: 0, wixMonthly: 0, wixYearly: 0 },
  }
}
