import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import {
  getEstMonthStart,
  getEstPeriodBoundary,
} from '@/lib/time/est-periods'

// Data layer for the admin-tier /cost-hub page. Three categories of
// cost:
//   1. Anthropic spend — aggregated from agent_runs.llm_cost_usd via
//      five named buckets (Ella Sonnet/Haiku, Call review Sonnet/Haiku,
//      Gregory brain Sonnet — filtered by agent_name + model prefix).
//   2. Monthly subscriptions — manually-maintained line items
//      (monthly_subscriptions table, migration 0038).
//   3. One-off extras — manually-maintained one-shot expenses
//      (cost_extras table, migration 0038).
//
// All queries are server-side reads via the admin Supabase client.
// JS-side aggregation rather than Postgres aggregates because
// PostgREST doesn't expose `sum()` cleanly; the per-window row counts
// are small enough (~hundreds) that JS-side rollup is fine.

// ---------------------------------------------------------------------------
// Bucket configuration
// ---------------------------------------------------------------------------

export type BucketKey =
  | 'ella_sonnet'
  | 'ella_haiku'
  | 'call_review_sonnet'
  | 'call_review_haiku'
  | 'gregory_brain_sonnet'

// Sentinel earliestReliableDate for buckets that have never been used
// (call_review_haiku — call_reviewer is Sonnet-only today). Swaps the
// "(incomplete before <date>)" caveat for a human-readable note so the
// box doesn't render a confusing far-future date.
const NEVER_USED_SENTINEL = '9999-12-31'

type BucketDefinition = {
  key: BucketKey
  label: string
  agentName: string
  modelPrefix: string // matches against llm_model via LIKE
  // The earliest date with reliable cost tracking for this bucket.
  // When this falls inside the current month, surface an
  // "(incomplete before YYYY-MM-DD)" caveat on the "This month" row.
  // Values were determined via a pre-flight inventory query against
  // cloud agent_runs (see docs/specs/cost-hub.md § What Drake wants).
  earliestReliableDate: string // YYYY-MM-DD
}

// `gregory_brain_sonnet` filters on agent_name='ai_call_signal' — that's
// where Gregory brain V2's Sonnet calls actually land per
// agents/gregory/ai_call_signal.py (state.md line 26). The user-facing
// label is still "Gregory brain Sonnet" since `ai_call_signal` is an
// implementation detail.
export const BUCKET_DEFINITIONS: BucketDefinition[] = [
  {
    key: 'ella_sonnet',
    label: 'Ella Sonnet',
    agentName: 'ella',
    modelPrefix: 'claude-sonnet',
    earliestReliableDate: '2026-04-24',
  },
  {
    key: 'ella_haiku',
    label: 'Ella Haiku',
    agentName: 'ella',
    modelPrefix: 'claude-haiku',
    earliestReliableDate: '2026-05-11',
  },
  {
    key: 'call_review_sonnet',
    label: 'Call review Sonnet',
    agentName: 'call_reviewer',
    modelPrefix: 'claude-sonnet',
    earliestReliableDate: '2026-05-07',
  },
  {
    key: 'call_review_haiku',
    label: 'Call review Haiku',
    agentName: 'call_reviewer',
    modelPrefix: 'claude-haiku',
    // The sentiment classifier (agents/call_reviewer/sentiment_classifier.py)
    // is a Haiku call that fires on every call review write, under
    // agent_name='call_reviewer' + trigger_type='sentiment_classifier'.
    // Telemetry was added 2026-05-15 (spec
    // cost-hub-call-review-haiku-audit) — pre-fix Haiku spend was never
    // recorded, so this bucket's reliable data starts at the fix date.
    // The "(incomplete before 2026-05-15)" caveat communicates the
    // historical gap; it ages out ~30 days after the fix.
    earliestReliableDate: '2026-05-15',
  },
  {
    key: 'gregory_brain_sonnet',
    label: 'Gregory brain Sonnet',
    agentName: 'ai_call_signal',
    modelPrefix: 'claude-sonnet',
    earliestReliableDate: '2026-05-07',
  },
]

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PeriodSummary = {
  runs: number
  totalCost: number
  avgCost: number
  // True when this bucket's earliest reliable cost-tracking date falls
  // inside this period; UI surfaces an "(incomplete before YYYY-MM-DD)"
  // caveat. Today + This week are always recent enough that they never
  // intersect the earliest reliable date — caveat only fires on
  // This month for the three buckets whose cost-tracking started
  // mid-May 2026.
  dataIncomplete: boolean
  incompleteSinceDate: string | null
  // True for buckets that have never been used (call_review_haiku).
  // The UI shows "(no usage — Sonnet-only today)" instead of an
  // "(incomplete before …)" caveat with a sentinel date.
  neverUsed: boolean
}

export type BucketSummary = {
  key: BucketKey
  label: string
  today: PeriodSummary
  thisWeek: PeriodSummary
  thisMonth: PeriodSummary
}

export type BucketSummaries = Record<BucketKey, BucketSummary>

export type MonthlySubscription = {
  id: string
  provider: string
  monthly_cost_usd: number
  notes: string | null
  effective_from: string // ISO date YYYY-MM-DD
  created_at: string
  updated_at: string
}

// A subscription's archive state, needed by the history-month rollup
// (an archived sub still counts toward months it was active in). The
// live editable table only ever sees non-archived rows, so the public
// MonthlySubscription type omits archived_at; the history path uses
// this richer internal shape.
type SubscriptionForHistory = {
  id: string
  monthly_cost_usd: number
  effective_from: string // ISO date YYYY-MM-DD
  archived_at: string | null
}

// A subscription contributes to month M when it had started by the end
// of M and had not been archived before M began:
//   effective_from <= last_day_of_M
//   AND (archived_at IS NULL OR archived_at >= first_day_of_M)
//
// `monthStart` is the first instant of M (UTC, representing EST
// midnight); `monthEnd` is the first instant of M+1 (exclusive upper).
// So "effective_from <= last_day_of_M" is equivalently
// "effective_from < monthEnd".
export function subscriptionActiveInMonth(
  sub: { effective_from: string; archived_at: string | null },
  monthStart: Date,
  monthEnd: Date,
): boolean {
  const eff = new Date(`${sub.effective_from}T00:00:00Z`)
  if (eff >= monthEnd) return false
  if (sub.archived_at === null) return true
  return new Date(sub.archived_at) >= monthStart
}

export type CostExtra = {
  id: string
  incurred_on: string // ISO date YYYY-MM-DD
  description: string
  cost_usd: number
  created_at: string
  updated_at: string
}

export type MonthTotalRow = {
  // YYYY-MM label (e.g., '2026-05')
  month: string
  // Display label (e.g., 'May 2026')
  monthLabel: string
  total: number
  breakdown: {
    anthropic: number
    subscriptions: number
    extras: number
    perBucket: Record<BucketKey, number>
  }
}

function formatMonthLabel(monthStart: Date): { ym: string; label: string } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'long',
  })
  const parts = fmt.formatToParts(monthStart).reduce<Record<string, string>>(
    (acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value
      return acc
    },
    {},
  )
  const ymFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
  })
  const ymParts = ymFmt.formatToParts(monthStart).reduce<Record<string, string>>(
    (acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value
      return acc
    },
    {},
  )
  return {
    ym: `${ymParts.year}-${ymParts.month}`,
    label: `${parts.month} ${parts.year}`,
  }
}

// ---------------------------------------------------------------------------
// Anthropic bucket aggregator
// ---------------------------------------------------------------------------

async function aggregateBucketWindow(
  bucket: BucketDefinition,
  startIso: string,
  endIso: string,
): Promise<{ runs: number; totalCost: number }> {
  const supabase = createAdminClient()
  // Fetch only llm_cost_usd; aggregate JS-side. Page size: PostgREST
  // defaults to 1000; the windows are small enough to fit in one page
  // for every bucket today.
  const { data, error } = await supabase
    .from('agent_runs')
    .select('llm_cost_usd')
    .eq('agent_name', bucket.agentName)
    .like('llm_model', `${bucket.modelPrefix}%`)
    .gte('started_at', startIso)
    .lt('started_at', endIso)
    .not('llm_cost_usd', 'is', null)
  if (error) {
    throw new Error(
      `aggregateBucketWindow(${bucket.key}): ${error.message}`,
    )
  }
  let runs = 0
  let totalCost = 0
  for (const row of data ?? []) {
    runs += 1
    totalCost += Number(row.llm_cost_usd ?? 0)
  }
  return { runs, totalCost }
}

function buildPeriodSummary(
  bucket: BucketDefinition,
  agg: { runs: number; totalCost: number },
  periodStart: Date,
  periodLabel: 'today' | 'thisWeek' | 'thisMonth',
): PeriodSummary {
  const avgCost = agg.runs > 0 ? agg.totalCost / agg.runs : 0
  // Caveat only on "thisMonth" — today/this-week never intersect
  // earliest-reliable dates in practice. Bucket-by-bucket: if the
  // earliest reliable date falls AFTER the period start, the period
  // is partially uncovered.
  const neverUsed = bucket.earliestReliableDate === NEVER_USED_SENTINEL
  let dataIncomplete = false
  let incompleteSinceDate: string | null = null
  if (periodLabel === 'thisMonth' && !neverUsed) {
    const earliest = new Date(`${bucket.earliestReliableDate}T00:00:00Z`)
    if (earliest > periodStart) {
      dataIncomplete = true
      incompleteSinceDate = bucket.earliestReliableDate
    }
  }
  return {
    runs: agg.runs,
    totalCost: agg.totalCost,
    avgCost,
    dataIncomplete,
    incompleteSinceDate,
    neverUsed,
  }
}

export async function getAnthropicBucketSummaries(): Promise<BucketSummaries> {
  const todayStart = getEstPeriodBoundary('today')
  const weekStart = getEstPeriodBoundary('week')
  const monthStart = getEstPeriodBoundary('month')
  const now = new Date()
  const nowIso = now.toISOString()

  const results = await Promise.all(
    BUCKET_DEFINITIONS.flatMap((bucket) => [
      aggregateBucketWindow(bucket, todayStart.toISOString(), nowIso).then(
        (agg) => ({ bucket, period: 'today' as const, agg, periodStart: todayStart }),
      ),
      aggregateBucketWindow(bucket, weekStart.toISOString(), nowIso).then(
        (agg) => ({ bucket, period: 'thisWeek' as const, agg, periodStart: weekStart }),
      ),
      aggregateBucketWindow(bucket, monthStart.toISOString(), nowIso).then(
        (agg) => ({ bucket, period: 'thisMonth' as const, agg, periodStart: monthStart }),
      ),
    ]),
  )

  const summaries: Partial<BucketSummaries> = {}
  for (const bucket of BUCKET_DEFINITIONS) {
    summaries[bucket.key] = {
      key: bucket.key,
      label: bucket.label,
      today: { runs: 0, totalCost: 0, avgCost: 0, dataIncomplete: false, incompleteSinceDate: null, neverUsed: false },
      thisWeek: { runs: 0, totalCost: 0, avgCost: 0, dataIncomplete: false, incompleteSinceDate: null, neverUsed: false },
      thisMonth: { runs: 0, totalCost: 0, avgCost: 0, dataIncomplete: false, incompleteSinceDate: null, neverUsed: false },
    }
  }
  for (const r of results) {
    const summary = summaries[r.bucket.key]!
    summary[r.period] = buildPeriodSummary(r.bucket, r.agg, r.periodStart, r.period)
  }
  return summaries as BucketSummaries
}

// ---------------------------------------------------------------------------
// Manual cost tables — monthly_subscriptions + cost_extras
// ---------------------------------------------------------------------------

export async function getMonthlySubscriptions(): Promise<MonthlySubscription[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('monthly_subscriptions')
    .select(
      'id, provider, monthly_cost_usd, notes, effective_from, created_at, updated_at',
    )
    .is('archived_at', null)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`getMonthlySubscriptions: ${error.message}`)
  return (data ?? []).map((row) => ({
    id: row.id,
    provider: row.provider,
    monthly_cost_usd: Number(row.monthly_cost_usd),
    notes: row.notes,
    effective_from: row.effective_from,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }))
}

// Internal: every subscription INCLUDING archived ones, with the
// fields the history-month rollup needs. An archived sub still counts
// toward the months it was active in, so the history path can't use
// the archived_at-IS-NULL-filtered public getter.
async function fetchSubscriptionsForHistory(): Promise<SubscriptionForHistory[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('monthly_subscriptions')
    .select('id, monthly_cost_usd, effective_from, archived_at')
  if (error) {
    throw new Error(`fetchSubscriptionsForHistory: ${error.message}`)
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    monthly_cost_usd: Number(row.monthly_cost_usd),
    effective_from: row.effective_from,
    archived_at: row.archived_at,
  }))
}

// Current-month [start, end) boundaries in America/New_York, as UTC
// instants. The page uses these to filter subscriptions to
// active-this-month before rendering the editable table + computing
// the running total.
export function getCurrentMonthBoundaries(): {
  monthStart: Date
  monthEnd: Date
} {
  return {
    monthStart: getEstMonthStart(0),
    monthEnd: getEstMonthStart(-1),
  }
}

export async function getCurrentMonthExtras(): Promise<CostExtra[]> {
  const monthStart = getEstPeriodBoundary('month')
  // `incurred_on` is a date column; compare against the YYYY-MM-DD
  // string of monthStart in EST. We format the date in EST so the
  // boundary aligns with the user's expectation of "first of the month."
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const monthStartDate = fmt.format(monthStart) // YYYY-MM-DD
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('cost_extras')
    .select('id, incurred_on, description, cost_usd, created_at, updated_at')
    .is('archived_at', null)
    .gte('incurred_on', monthStartDate)
    .order('incurred_on', { ascending: false })
  if (error) throw new Error(`getCurrentMonthExtras: ${error.message}`)
  return (data ?? []).map((row) => ({
    id: row.id,
    incurred_on: row.incurred_on,
    description: row.description,
    cost_usd: Number(row.cost_usd),
    created_at: row.created_at,
    updated_at: row.updated_at,
  }))
}

// ---------------------------------------------------------------------------
// History — last N months' totals
// ---------------------------------------------------------------------------

async function getMonthTotal(offsetMonths: number): Promise<MonthTotalRow> {
  const monthStart = getEstMonthStart(offsetMonths)
  const monthEnd = getEstMonthStart(offsetMonths - 1)
  const monthStartIso = monthStart.toISOString()
  const monthEndIso = monthEnd.toISOString()

  // Anthropic per-bucket totals for this month.
  const bucketTotals = await Promise.all(
    BUCKET_DEFINITIONS.map((bucket) =>
      aggregateBucketWindow(bucket, monthStartIso, monthEndIso).then(
        (agg) => ({ key: bucket.key, total: agg.totalCost }),
      ),
    ),
  )
  const perBucket: Record<BucketKey, number> = {
    ella_sonnet: 0,
    ella_haiku: 0,
    call_review_sonnet: 0,
    call_review_haiku: 0,
    gregory_brain_sonnet: 0,
  }
  let anthropic = 0
  for (const b of bucketTotals) {
    perBucket[b.key] = b.total
    anthropic += b.total
  }

  // Subs: only those active in THIS month (effective_from started by
  // month-end AND not archived before month-start). Uses today's
  // price for every active month (locked trade-off per spec
  // § Historical sub price drift). Includes archived subs because an
  // archived sub still counts toward the months it was active in.
  const allSubs = await fetchSubscriptionsForHistory()
  const subscriptions = allSubs
    .filter((sub) => subscriptionActiveInMonth(sub, monthStart, monthEnd))
    .reduce((sum, sub) => sum + Number(sub.monthly_cost_usd), 0)

  // Extras: rows where incurred_on falls in this month.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const monthStartDate = fmt.format(monthStart)
  const monthEndDate = fmt.format(monthEnd)
  const supabase = createAdminClient()
  const { data: extrasRows, error: extrasErr } = await supabase
    .from('cost_extras')
    .select('cost_usd')
    .is('archived_at', null)
    .gte('incurred_on', monthStartDate)
    .lt('incurred_on', monthEndDate)
  if (extrasErr) throw new Error(`getMonthTotal extras: ${extrasErr.message}`)
  const extras = (extrasRows ?? []).reduce(
    (sum, row) => sum + Number(row.cost_usd ?? 0),
    0,
  )

  const { ym, label } = formatMonthLabel(monthStart)
  return {
    month: ym,
    monthLabel: label,
    total: anthropic + subscriptions + extras,
    breakdown: {
      anthropic,
      subscriptions,
      extras,
      perBucket,
    },
  }
}

export async function getRecentMonthTotals(
  months: number = 12,
): Promise<MonthTotalRow[]> {
  const results: MonthTotalRow[] = []
  // Skip offset 0 (current month) — that's the live "Total this month"
  // box; history shows COMPLETED past months only.
  for (let offset = 1; offset <= months; offset += 1) {
    results.push(await getMonthTotal(offset))
  }
  return results
}

// ---------------------------------------------------------------------------
// Total-this-month aggregator (for the big-number box)
// ---------------------------------------------------------------------------

export async function getCurrentMonthTotal(
  bucketSummaries: BucketSummaries,
  subscriptions: MonthlySubscription[],
  currentMonthExtras: CostExtra[],
): Promise<number> {
  const anthropic = Object.values(bucketSummaries).reduce(
    (sum, summary) => sum + summary.thisMonth.totalCost,
    0,
  )
  const subs = subscriptions.reduce(
    (sum, sub) => sum + Number(sub.monthly_cost_usd),
    0,
  )
  const extras = currentMonthExtras.reduce(
    (sum, extra) => sum + Number(extra.cost_usd),
    0,
  )
  return anthropic + subs + extras
}
