import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { SetterCallReviewFull } from './setter-calls'

// Per-lead detail (the /sales-dashboard/leads/[close_id] page). Pulls one
// Close lead's identity + opt-in facts, its FULL call history (both
// directions), and each call's setter-call review when one exists. The
// page renders the calls collapsed-by-default, expanding to the review.
//
// Reviews + transcripts only exist for transcribed setter calls (>=90s,
// since the 2026-05-24 horizon) — older / sub-90s / closer calls show as
// rows with no review. That's inherent to the upstream data, not a gap
// here. Closing-call info is a future addition (stubbed on the page).

export type Qualification = 'qualified' | 'non-qualified' | 'unknown'

export type LeadCallEntry = {
  closeCallId: string
  activityAt: string             // ISO UTC
  durationSec: number
  direction: string | null       // 'inbound' | 'outbound' | null
  connected: boolean             // duration >= 90s
  setterName: string | null
  // True when a transcript landed for this call → the per-call detail
  // page (/sales-dashboard/calls/[id]) has audio/transcript to show.
  hasTranscript: boolean
  // The Sonnet review, when it has run. null = no review (not transcribed
  // yet, or sub-90s / closer call that never gets one).
  review: SetterCallReviewFull | null
}

export type LeadDetail = {
  leadId: string
  prospectName: string | null
  dateCreated: string | null
  dateFirstOptedIn: string | null
  latestOptInDate: string | null
  numberOfOptIns: number | null
  qualified: Qualification
  // Aggregates over the lead's connected (>=90s) calls — matches the
  // "Connected" semantics on the lead list it was opened from.
  totalCalls: number
  connectedCount: number
  totalConnectedDurationSec: number
  primaryCallerName: string | null
  calls: LeadCallEntry[]
}

function qualFromMarketingQualified(mq: string | null): Qualification {
  const v = (mq ?? '').trim().toLowerCase()
  if (v === 'yes') return 'qualified'
  if (v === 'no') return 'non-qualified'
  return 'unknown'
}

const CONNECTED_SEC = 90

export async function getLeadDetail(closeId: string): Promise<LeadDetail | null> {
  const sb = createAdminClient()

  // 1. Lead identity + opt-in facts.
  const { data: leadData, error: leadErr } = await sb
    .from('close_leads' as never)
    .select(
      'close_id, display_name, date_created, date_first_opted_in, ' +
        'latest_opt_in_date, number_of_opt_ins, marketing_qualified',
    )
    .eq('close_id' as never, closeId)
    .maybeSingle()
  if (leadErr) throw new Error(`lead-detail: close_leads read failed: ${leadErr.message}`)
  if (!leadData) return null
  const lead = leadData as unknown as {
    close_id: string
    display_name: string | null
    date_created: string | null
    date_first_opted_in: string | null
    latest_opt_in_date: string | null
    number_of_opt_ins: number | null
    marketing_qualified: string | null
  }

  // 2. Full call history for this lead (both directions), newest first.
  type CallRaw = {
    close_id: string
    activity_at: string
    duration: number | null
    direction: string | null
    user_id: string | null
    raw_payload: { user_name?: string } | null
  }
  const callRows: CallRaw[] = []
  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('close_calls' as never)
      .select('close_id, activity_at, duration, direction, user_id, raw_payload')
      .eq('lead_id' as never, closeId)
      .order('activity_at', { ascending: false })
      .range(from, from + 999)
    if (error) throw new Error(`lead-detail: close_calls read failed: ${error.message}`)
    const rows = (data ?? []) as unknown as CallRaw[]
    if (rows.length === 0) break
    callRows.push(...rows)
    if (rows.length < 1000) break
    from += 1000
  }

  const callIds = callRows.map((c) => c.close_id)

  // 3. Which calls have a transcript, and their reviews.
  const transcriptSet = new Set<string>()
  const reviewByCall = new Map<string, SetterCallReviewFull>()
  for (let i = 0; i < callIds.length; i += 100) {
    const chunk = callIds.slice(i, i + 100)
    const [{ data: trx, error: trxErr }, { data: rev, error: revErr }] = await Promise.all([
      sb
        .from('setter_call_transcripts' as never)
        .select('close_call_id')
        .in('close_call_id' as never, chunk),
      sb
        .from('setter_call_reviews' as never)
        .select(
          'close_call_id, sentiment, lead_score, lead_score_reason, should_be_dqd, ' +
            'dq_reason, booked, no_book_reason, setter_strengths, setter_weaknesses, ' +
            'lead_attributes, setter_words, prospect_words, talk_ratio_setter, ' +
            'model, prompt_version, reviewed_at',
        )
        .in('close_call_id' as never, chunk),
    ])
    if (trxErr) throw new Error(`lead-detail: transcripts read failed: ${trxErr.message}`)
    if (revErr) throw new Error(`lead-detail: reviews read failed: ${revErr.message}`)
    for (const t of (trx ?? []) as unknown as Array<{ close_call_id: string }>) {
      transcriptSet.add(t.close_call_id)
    }
    for (const r of (rev ?? []) as unknown as Array<{ close_call_id: string } & SetterCallReviewFull>) {
      const { close_call_id, ...review } = r
      reviewByCall.set(close_call_id, review)
    }
  }

  // 4. Setter names — team_members by close_user_id, falling back to the
  //    call's raw_payload.user_name when the user isn't a known member.
  const userIds = Array.from(
    new Set(callRows.map((c) => c.user_id).filter((u): u is string => !!u)),
  )
  const nameByUser = new Map<string, string>()
  for (let i = 0; i < userIds.length; i += 100) {
    const chunk = userIds.slice(i, i + 100)
    const { data, error } = await sb
      .from('team_members' as never)
      .select('close_user_id, full_name')
      .in('close_user_id' as never, chunk)
    if (error) throw new Error(`lead-detail: team_members read failed: ${error.message}`)
    for (const m of (data ?? []) as unknown as Array<{ close_user_id: string; full_name: string }>) {
      nameByUser.set(m.close_user_id, m.full_name)
    }
  }
  const resolveSetter = (c: CallRaw): string | null => {
    if (c.user_id && nameByUser.has(c.user_id)) return nameByUser.get(c.user_id) ?? null
    return c.raw_payload?.user_name ?? null
  }

  // 5. Assemble call entries + aggregates.
  const calls: LeadCallEntry[] = callRows.map((c) => ({
    closeCallId: c.close_id,
    activityAt: c.activity_at,
    durationSec: c.duration ?? 0,
    direction: c.direction,
    connected: (c.duration ?? 0) >= CONNECTED_SEC,
    setterName: resolveSetter(c),
    hasTranscript: transcriptSet.has(c.close_id),
    review: reviewByCall.get(c.close_id) ?? null,
  }))

  const connected = calls.filter((c) => c.connected)
  const totalConnectedDurationSec = connected.reduce((sum, c) => sum + c.durationSec, 0)
  // Primary caller = setter on the most recent connected call (else the
  // most recent call overall).
  const primaryCallerName =
    connected.find((c) => c.setterName)?.setterName ??
    calls.find((c) => c.setterName)?.setterName ??
    null

  return {
    leadId: lead.close_id,
    prospectName: lead.display_name,
    dateCreated: lead.date_created,
    dateFirstOptedIn: lead.date_first_opted_in,
    latestOptInDate: lead.latest_opt_in_date,
    numberOfOptIns: lead.number_of_opt_ins,
    qualified: qualFromMarketingQualified(lead.marketing_qualified),
    totalCalls: calls.length,
    connectedCount: connected.length,
    totalConnectedDurationSec,
    primaryCallerName,
    calls,
  }
}
