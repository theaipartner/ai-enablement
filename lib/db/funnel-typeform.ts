import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { Window } from './sales-dashboard-shared'
import { getDateRangeFromWindow, type DateRange } from './funnel-window'
import { HIGH_TICKET_TYPEFORM_FORM_ID, HIGH_TICKET_TYPEFORM_FORM_IDS } from './funnel-assets'

// Funnel · Typeform metrics — used by the consolidated LP detail page.
//
// Headline metrics:
//   - submits (row count from typeform_responses)
//   - qualified vs non-qualified split (parsed from the budget question)
//   - avg time to complete (submitted_at - landed_at)
//
// Sourced entirely from typeform_responses.answers. Form views / starts
// / completion rate are NOT here — those require Typeform's Insights
// API which we don't mirror.

// The high-ticket coaching-application forms. Reads default to ALL of them
// (aggregate across landing pages); per-LP callers pass a single form_id.
// Qualification parsing relies on the budget question's field ref, which is the
// SAME across these forms (5138f17b). Other forms in the mirror are ignored —
// they belong to other funnels. Sourced from the asset lock.
const HT_FORM_IDS = HIGH_TICKET_TYPEFORM_FORM_IDS as unknown as string[]
// Primary form — used for Typeform Insights snapshots, which exist only for it.
const PRIMARY_FORM_ID = HIGH_TICKET_TYPEFORM_FORM_ID

// Normalize a one-or-many form arg to an id array.
function formIds(formId: string | string[]): string[] {
  return Array.isArray(formId) ? formId : [formId]
}

// Field ref of the qualification question — the budget question
// ("Imagine... 6 months from today... how much are you willing to invest
// into starting your successful online business...?"). The SAME ref is
// used on every high-ticket form (SFedWelr + Os4c0q6V), so qualification
// parsing is uniform across landing pages.
//
// Qualifying answers: any choice that does NOT start with "Under"
// (i.e. the budget is $2,000 or above). The label set Drake's team
// has today:
//   - "Under $2,000"           → non-qualified
//   - "$2,000 and $5,000"      → qualified
//   - "$5,000 and $8,000"      → qualified
//   - "$8,000+"                → qualified
//
// If the choice is absent (the respondent skipped the question), the
// response is counted as 'unknown' and surfaced separately so neither
// the qualified nor non-qualified count gets inflated.
const QUALIFICATION_FIELD_REF = '5138f17b-eb31-4d36-bacb-88a8c83326ed'

function resolveRange(arg: Window | DateRange): DateRange {
  if (typeof arg === 'string') return getDateRangeFromWindow(arg)
  return arg
}

function etDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d)
}

function addDaysToEtDateStr(etDate: string, days: number): string {
  const [y, m, d] = etDate.split('-').map((n) => parseInt(n, 10))
  const dt = new Date(Date.UTC(y, m - 1, d))
  dt.setUTCDate(dt.getUTCDate() + days)
  return dt.toISOString().slice(0, 10)
}

type TfRow = {
  response_id: string
  form_id: string
  landed_at: string | null
  submitted_at: string
  answers: unknown
}

type TfAnswer = {
  field?: { ref?: string; id?: string; type?: string; title?: string }
  type?: string
  choice?: { label?: string; id?: string }
  choices?: { labels?: string[]; ids?: string[] }
}

function answerForRef(row: TfRow, ref: string): TfAnswer | null {
  if (!Array.isArray(row.answers)) return null
  for (const a of row.answers as TfAnswer[]) {
    if (a?.field?.ref === ref) return a
  }
  return null
}

// Returns 'qualified' | 'non-qualified' | 'unknown' for a single
// response. The predicate: if the qualification answer's label
// starts with "Under" (case-insensitive), non-qualified. Otherwise,
// if there IS a label, qualified. If the field is missing entirely
// or has no label, unknown.
export function classifyResponse(row: TfRow): 'qualified' | 'non-qualified' | 'unknown' {
  const ans = answerForRef(row, QUALIFICATION_FIELD_REF)
  if (!ans) return 'unknown'
  const label = ans.choice?.label?.trim() ?? ''
  if (!label) return 'unknown'
  if (/^under\s/i.test(label)) return 'non-qualified'
  return 'qualified'
}

async function loadResponses(range: DateRange, formId: string | string[]): Promise<TfRow[]> {
  const sb = createAdminClient()
  // submitted_at is timestamptz (UTC) — filter against the UTC ISO
  // boundaries derived from the ET calendar range.
  const { data, error } = await sb
    .from('typeform_responses' as never)
    .select('response_id, form_id, landed_at, submitted_at, answers')
    .in('form_id', formIds(formId))
    .gte('submitted_at', range.startUtcIso)
    .lt('submitted_at', range.endUtcIso)
  if (error) throw new Error(`typeform_responses read failed: ${error.message}`)
  return (data ?? []) as unknown as TfRow[]
}

export type TypeformMetrics = {
  submits: number
  qualified: number
  nonQualified: number
  unknownQualification: number
  avgTimeToCompleteSec: number | null
  // Starts within the selected range, derived from
  // typeform_form_insights_snapshots. `null` when we don't have
  // bracketing snapshots (e.g. days before the cron started).
  starts: number | null
  // completion rate = submits / starts within the same range.
  completionRate: number | null
  // Indicates the starts figure is bracketed by a partial first
  // snapshot (e.g. on the day we first started capturing). True
  // means "starts since first snapshot of the range," not "starts
  // for the entire range." Renders a small note on the page.
  startsPartial: boolean
  // ISO timestamp of the earliest snapshot anchoring the starts
  // delta (null when no anchor available).
  startsAnchorIso: string | null
  // 14-day daily series (most recent on the right) for submits/qualified/nonqualified
  trendSubmits: number[]
  trendQualified: number[]
  trendNonQualified: number[]
}

// Derive starts within an ET-anchored date range from the
// append-only snapshots table. Lifetime totals come back from
// Typeform's /insights endpoint; the delta between two snapshots is
// the new starts in that window.
//
// Logic:
//   1. anchor = latest snapshot whose snapshot_at < range.startUtcIso.
//      If no such snapshot exists, anchor = earliest snapshot inside
//      the range, and result is flagged as partial.
//   2. end-cap = latest snapshot whose snapshot_at <= range.endUtcIso.
//   3. starts = end-cap.total_visits - anchor.total_visits.
//
// Returns null when we don't have any usable snapshots — the cron
// hasn't fired yet, or the range falls entirely before the first
// snapshot.
async function deriveStartsForRange(formId: string, range: DateRange): Promise<{
  starts: number | null
  partial: boolean
  anchorAt: string | null
}> {
  const sb = createAdminClient()

  // End-cap: latest snapshot at-or-before the range end.
  const { data: endRows, error: endErr } = await sb
    .from('typeform_form_insights_snapshots' as never)
    .select('snapshot_at, total_visits')
    .eq('form_id', formId)
    .lte('snapshot_at', range.endUtcIso)
    .order('snapshot_at', { ascending: false })
    .limit(1)
  if (endErr) throw new Error(`insights snapshots (end) read failed: ${endErr.message}`)
  const end = (endRows ?? [])[0] as { snapshot_at: string; total_visits: number } | undefined
  if (!end) return { starts: null, partial: false, anchorAt: null }

  // Preferred anchor: latest snapshot strictly BEFORE range start.
  const { data: priorRows, error: priorErr } = await sb
    .from('typeform_form_insights_snapshots' as never)
    .select('snapshot_at, total_visits')
    .eq('form_id', formId)
    .lt('snapshot_at', range.startUtcIso)
    .order('snapshot_at', { ascending: false })
    .limit(1)
  if (priorErr) throw new Error(`insights snapshots (prior) read failed: ${priorErr.message}`)
  const prior = (priorRows ?? [])[0] as { snapshot_at: string; total_visits: number } | undefined

  if (prior) {
    const starts = (end.total_visits ?? 0) - (prior.total_visits ?? 0)
    return { starts: Math.max(0, starts), partial: false, anchorAt: prior.snapshot_at }
  }

  // Fallback anchor: earliest snapshot inside the range. Marks
  // result as partial because we're missing the pre-range baseline.
  const { data: insideRows, error: insideErr } = await sb
    .from('typeform_form_insights_snapshots' as never)
    .select('snapshot_at, total_visits')
    .eq('form_id', formId)
    .gte('snapshot_at', range.startUtcIso)
    .lte('snapshot_at', range.endUtcIso)
    .order('snapshot_at', { ascending: true })
    .limit(1)
  if (insideErr) throw new Error(`insights snapshots (inside) read failed: ${insideErr.message}`)
  const inside = (insideRows ?? [])[0] as { snapshot_at: string; total_visits: number } | undefined
  if (!inside) return { starts: null, partial: false, anchorAt: null }
  if (inside.snapshot_at === end.snapshot_at) {
    return { starts: null, partial: true, anchorAt: inside.snapshot_at }
  }
  const starts = (end.total_visits ?? 0) - (inside.total_visits ?? 0)
  return { starts: Math.max(0, starts), partial: true, anchorAt: inside.snapshot_at }
}

export async function getTypeformMetrics(
  arg: Window | DateRange,
  formId: string | string[] = HT_FORM_IDS,
): Promise<TypeformMetrics> {
  const range = resolveRange(arg)
  const ids = formIds(formId)
  const rows = await loadResponses(range, ids)
  // Insights snapshots exist only for the primary form; when this read spans
  // multiple forms, anchor starts/completion to the primary one.
  const insightsFormId = ids.length === 1 ? ids[0] : PRIMARY_FORM_ID
  const startsResult = await deriveStartsForRange(insightsFormId, range)

  let qualified = 0
  let nonQualified = 0
  let unknown = 0
  let ttcTotal = 0
  let ttcCount = 0
  // For the daily series we need a wider window than `window` (14 days)
  // — re-load the broader history once. The per-classification count is
  // still keyed to the window above; the trend below is window-agnostic.
  for (const r of rows) {
    const cls = classifyResponse(r)
    if (cls === 'qualified') qualified++
    else if (cls === 'non-qualified') nonQualified++
    else unknown++

    if (r.landed_at && r.submitted_at) {
      const sec = (new Date(r.submitted_at).getTime() - new Date(r.landed_at).getTime()) / 1000
      if (Number.isFinite(sec) && sec >= 0 && sec <= 3600) {
        ttcTotal += sec
        ttcCount++
      }
    }
  }

  // Trend: last 14 ET calendar days. Pull a slightly wider UTC
  // window so any submission whose UTC timestamp falls in the
  // bordering ET day still gets included.
  const trendStart = new Date(Date.now() - 16 * 24 * 60 * 60 * 1000).toISOString()
  const sb = createAdminClient()
  const { data: trendData, error: trendErr } = await sb
    .from('typeform_responses' as never)
    .select('submitted_at, answers')
    .in('form_id', ids)
    .gte('submitted_at', trendStart)
  if (trendErr) throw new Error(`typeform trend read failed: ${trendErr.message}`)
  const trendRows = (trendData ?? []) as unknown as { submitted_at: string; answers: unknown }[]

  const todayEtStr = etDateStr(new Date())
  const trendSubmits: number[] = []
  const trendQualified: number[] = []
  const trendNonQualified: number[] = []
  for (let i = 13; i >= 0; i--) {
    const key = addDaysToEtDateStr(todayEtStr, -i)
    let s = 0, q = 0, nq = 0
    for (const r of trendRows) {
      if (etDateStr(new Date(r.submitted_at)) !== key) continue
      s++
      const cls = classifyResponse(r as TfRow)
      if (cls === 'qualified') q++
      else if (cls === 'non-qualified') nq++
    }
    trendSubmits.push(s)
    trendQualified.push(q)
    trendNonQualified.push(nq)
  }

  const submitsCount = rows.length
  const completionRate =
    startsResult.starts !== null && startsResult.starts > 0
      ? (submitsCount / startsResult.starts) * 100
      : null

  return {
    submits: submitsCount,
    qualified,
    nonQualified,
    unknownQualification: unknown,
    avgTimeToCompleteSec: ttcCount > 0 ? ttcTotal / ttcCount : null,
    starts: startsResult.starts,
    completionRate,
    startsPartial: startsResult.partial,
    startsAnchorIso: startsResult.anchorAt,
    trendSubmits,
    trendQualified,
    trendNonQualified,
  }
}

// Lightweight count-only fetch for callers that don't need the full
// metrics breakdown (e.g. the funnel-strip LP→submit cascade math).
export async function getSubmitsCount(
  arg: Window | DateRange,
  formId: string | string[] = HT_FORM_IDS,
): Promise<number> {
  const range = resolveRange(arg)
  const sb = createAdminClient()
  const { count, error } = await sb
    .from('typeform_responses' as never)
    .select('response_id', { count: 'exact', head: true })
    .in('form_id', formIds(formId))
    .gte('submitted_at', range.startUtcIso)
    .lt('submitted_at', range.endUtcIso)
  if (error) throw new Error(`typeform_responses count failed: ${error.message}`)
  return count ?? 0
}
