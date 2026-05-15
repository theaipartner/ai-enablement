import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

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
    // call_reviewer is Sonnet-only today; bucket renders 0/0/$0 always.
    // `neverUsed` swaps the "(incomplete before …)" caveat for a
    // human-readable "(no usage — Sonnet-only today)" so the box
    // doesn't look broken with a sentinel date.
    earliestReliableDate: NEVER_USED_SENTINEL,
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
  created_at: string
  updated_at: string
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

// ---------------------------------------------------------------------------
// Period boundary helpers — all in America/New_York
// ---------------------------------------------------------------------------

// Returns an ISO timestamp string representing the start of `kind`
// (today / week / month) in America/New_York, converted to UTC.
//
// Implementation: take current UTC date, compute its EST/EDT components
// via Intl.DateTimeFormat, then construct a Date for the desired
// period boundary in EST and convert back. JavaScript handles DST
// transitions automatically.
function getEstPeriodBoundary(kind: 'today' | 'week' | 'month'): Date {
  const now = new Date()
  // Get EST/EDT date parts (year / month / day / weekday).
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
  })
  const parts = fmt.formatToParts(now).reduce<Record<string, string>>(
    (acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value
      return acc
    },
    {},
  )
  const year = parseInt(parts.year, 10)
  const month = parseInt(parts.month, 10) // 1-12
  const day = parseInt(parts.day, 10)
  const weekdayMap: Record<string, number> = {
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6,
    Sun: 7,
  }
  const weekday = weekdayMap[parts.weekday] ?? 1

  let targetYear = year
  let targetMonth = month
  let targetDay = day

  if (kind === 'week') {
    // Roll back to most recent Monday. weekday=1 (Monday) → no change.
    const daysBack = weekday - 1
    const d = new Date(Date.UTC(year, month - 1, day))
    d.setUTCDate(d.getUTCDate() - daysBack)
    targetYear = d.getUTCFullYear()
    targetMonth = d.getUTCMonth() + 1
    targetDay = d.getUTCDate()
  } else if (kind === 'month') {
    targetDay = 1
  }
  // kind === 'today': use today's date as-is.

  // Construct the EST midnight as a string, then have Date parse it
  // in the EST/EDT zone. Easiest: use a known-good offset for the
  // target date, computed by formatting "noon" in EST.
  const noonEst = new Date(
    Date.UTC(targetYear, targetMonth - 1, targetDay, 12, 0, 0),
  )
  const offsetMinutes = getEstOffsetMinutes(noonEst)
  // EST is UTC minus N hours; midnight EST = N hours past UTC midnight
  // for the SAME calendar date. Construct: `Date.UTC(y, m-1, d, 0+offsetHours, 0+offsetMinutes)`.
  return new Date(
    Date.UTC(targetYear, targetMonth - 1, targetDay, 0, 0, 0)
      + offsetMinutes * 60 * 1000,
  )
}

// Returns the UTC offset of America/New_York at `at` in MINUTES
// (e.g., 240 during DST = UTC-4, 300 during standard time = UTC-5).
function getEstOffsetMinutes(at: Date): number {
  // Get the time string for `at` in EST.
  const estFmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = estFmt.formatToParts(at).reduce<Record<string, string>>(
    (acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value
      return acc
    },
    {},
  )
  const estDate = Date.UTC(
    parseInt(parts.year, 10),
    parseInt(parts.month, 10) - 1,
    parseInt(parts.day, 10),
    parseInt(parts.hour, 10) % 24, // Intl can return "24" for midnight in en-US
    parseInt(parts.minute, 10),
  )
  // Offset = UTC - EST.
  return Math.round((at.getTime() - estDate) / 60000)
}

// Returns the first day of the month `offsetMonths` BEFORE the current
// month (offsetMonths=0 = current month start; 1 = last month start).
// All in EST. Used by getRecentMonthTotals to build month boundaries
// going back N months.
function getEstMonthStart(offsetMonths: number): Date {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
  })
  const parts = fmt.formatToParts(now).reduce<Record<string, string>>(
    (acc, p) => {
      if (p.type !== 'literal') acc[p.type] = p.value
      return acc
    },
    {},
  )
  const year = parseInt(parts.year, 10)
  const month = parseInt(parts.month, 10) // 1-12
  // Compute the offset target.
  const targetMonthZero = month - 1 - offsetMonths // 0-indexed
  const adjustedYear = year + Math.floor(targetMonthZero / 12)
  const adjustedMonth = ((targetMonthZero % 12) + 12) % 12 // 0-11

  const noonEst = new Date(Date.UTC(adjustedYear, adjustedMonth, 1, 12, 0, 0))
  const offsetMinutes = getEstOffsetMinutes(noonEst)
  return new Date(
    Date.UTC(adjustedYear, adjustedMonth, 1, 0, 0, 0)
      + offsetMinutes * 60 * 1000,
  )
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
    .select('id, provider, monthly_cost_usd, notes, created_at, updated_at')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
  if (error) throw new Error(`getMonthlySubscriptions: ${error.message}`)
  return (data ?? []).map((row) => ({
    id: row.id,
    provider: row.provider,
    monthly_cost_usd: Number(row.monthly_cost_usd),
    notes: row.notes,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }))
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

  // Subs: use today's price for every historical month (locked
  // trade-off per spec § Historical sub price drift).
  const subs = await getMonthlySubscriptions()
  const subscriptions = subs.reduce(
    (sum, sub) => sum + Number(sub.monthly_cost_usd),
    0,
  )

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
