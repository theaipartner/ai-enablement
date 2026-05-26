import 'server-only'

import { cache } from 'react'
import { createAdminClient } from '@/lib/supabase/admin'
import type { MetricEntry, MetricFormat, Window } from './sales-dashboard-shared'
import {
  DEFAULT_WINDOW,
  FUNNEL_STAGES,
  METRICS,
  WINDOW_DAYS,
  inferredFormat,
} from './sales-dashboard-shared'

// Server-side data layer for /sales-dashboard.
//
// Pure types, the catalog (METRICS), display constants, hero IDs, and
// the format helper all live in `./sales-dashboard-shared.ts` (no
// `'server-only'`) so client components can reach them. This file
// adds the bits that genuinely need server context: the Supabase
// admin client, the per-metric fetchers, the orchestrator, and the
// time-window helpers used by fetchers.
//
// Re-exports the whole shared surface so existing imports of
// `@/lib/db/sales-dashboard` continue to work on the server side.

export * from './sales-dashboard-shared'

// ---------------------------------------------------------------------------
// Canonical source ids — kept local to the fetchers (not re-exported)
// because callers consume `METRICS` and shouldn't reach for these
// directly. Source-of-truth modules cited per line.
// ---------------------------------------------------------------------------

// Calendly closer-event names (case-insensitive). Source of truth:
// ingestion/calendly/__init__.py `CLOSER_EVENT_TYPE_NAMES`.
const CLOSER_EVENT_NAMES_LOWER = ['ai partner strategy call']

// Wistia canonical media ids. Source of truth: docs/schema/wistia_medias.md.
const VSL_HASHED_IDS = ['i1173gx76b', 'nbump1crwb']
const TYP_HASHED_ID = 'fbgjxwe62y'
// Stable reference so the React.cache wrapper on loadWistia7d dedupes
// calls for TYP across the two TYP-derived fetchers (engagement rate +
// avg view duration). A fresh `[TYP_HASHED_ID]` per call would miss
// cache via reference inequality.
const TYP_HASHED_IDS: readonly string[] = [TYP_HASHED_ID]

// Clarity canonical paths. Source of truth: ingestion/clarity/__init__.py.
// Updated 2026-05-25 after Zain swapped the Clarity project to track the
// new LP funnel (/lp-vsl, /lp-schedule, /lp-confirmation, /lp-dq).
const CLARITY_LANDING_PAGE_PATH = '/lp-vsl'
const CLARITY_THANK_YOU_PAGE_PATH = '/lp-confirmation'

// ---------------------------------------------------------------------------
// Time window helpers
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

// Rolling window for every fetch — user-selectable 1d / 7d / 30d.
// Returned as an ISO string the PostgREST .gte() filter can consume.
function getWindowStartIso(window: Window): string {
  return new Date(Date.now() - WINDOW_DAYS[window] * DAY_MS).toISOString()
}

// Same window expressed as a calendar-date string (YYYY-MM-DD) for
// columns typed as `date` (meta_ad_daily.day, etc.).
function getWindowStartDate(window: Window): string {
  const d = new Date(Date.now() - WINDOW_DAYS[window] * DAY_MS)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Fetchers — one per LIVE metric. All return `number | null`. NULL means
// "no rows in the window" or "denominator was zero"; the card layer
// renders NULL as a dash so an empty mirror table never reads as a 0.
// ---------------------------------------------------------------------------

type Fetcher = (window: Window) => Promise<number | null>

// Safe number coercion. PostgREST returns numerics as JS numbers or
// strings depending on size; this normalizes both.
function toNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'string' ? parseFloat(v) : (v as number)
  return Number.isFinite(n) ? n : null
}

function sumColumn<T extends Record<string, unknown>>(
  rows: T[] | null,
  col: keyof T,
): number | null {
  if (!rows || rows.length === 0) return null
  let total = 0
  let anyNonNull = false
  for (const r of rows) {
    const v = toNumber(r[col])
    if (v !== null) {
      total += v
      anyNonNull = true
    }
  }
  return anyNonNull ? total : null
}

function avgColumn<T extends Record<string, unknown>>(
  rows: T[] | null,
  col: keyof T,
): number | null {
  if (!rows || rows.length === 0) return null
  let total = 0
  let count = 0
  for (const r of rows) {
    const v = toNumber(r[col])
    if (v !== null) {
      total += v
      count += 1
    }
  }
  return count > 0 ? total / count : null
}

// ----- Meta (single-table reads against meta_ad_daily) -----

const loadMeta = cache(async function loadMeta(window: Window) {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('meta_ad_daily' as never)
    .select('day, amount_spent, frequency, impressions, unique_link_clicks, cpm, cost_per_unique_link_click, ctr')
    .gte('day', getWindowStartDate(window))
  if (error) throw new Error(`meta_ad_daily read failed: ${error.message}`)
  return (data ?? []) as Array<{
    day: string
    amount_spent: number | null
    frequency: number | null
    impressions: number | null
    unique_link_clicks: number | null
    cpm: number | null
    cost_per_unique_link_click: number | null
    ctr: number | null
  }>
})

const metaAdspend: Fetcher = async (w) => sumColumn(await loadMeta(w), 'amount_spent')
const metaFrequency: Fetcher = async (w) => avgColumn(await loadMeta(w), 'frequency')
const metaImpressions: Fetcher = async (w) => sumColumn(await loadMeta(w), 'impressions')
const metaUniqueLinkClicks: Fetcher = async (w) => sumColumn(await loadMeta(w), 'unique_link_clicks')

// Cost per impression = total spend / total impressions. Single-table.
const metaCostPerImpression: Fetcher = async (w) => {
  const rows = await loadMeta(w)
  const spend = sumColumn(rows, 'amount_spent')
  const impressions = sumColumn(rows, 'impressions')
  if (spend === null || impressions === null || impressions === 0) return null
  return spend / impressions
}

const metaCostPerUniqueClick: Fetcher = async (w) => {
  const rows = await loadMeta(w)
  const spend = sumColumn(rows, 'amount_spent')
  const clicks = sumColumn(rows, 'unique_link_clicks')
  if (spend === null || clicks === null || clicks === 0) return null
  return spend / clicks
}

// Volume-weighted CTR — total link_clicks / total impressions × 100.
// Schema doc notes ctr is already %-scaled; weighted is more honest
// across days with different volume.
const metaCtr: Fetcher = async (w) => avgColumn(await loadMeta(w), 'ctr')

// ----- Clarity -----

// Clarity rows are rolling-3-day snapshots — each `snapshot_date` value
// represents the trailing 3 days from that observation. Different
// metric blocks (Traffic / EngagementTime / ...) populate disjoint
// columns: Traffic carries `total_session_count`, EngagementTime
// carries `active_time` but not sessions. To get a per-session
// engagement-time average, both blocks need to be read and paired by
// (snapshot_date, url).
const loadClarityLatestRows = cache(async function loadClarityLatestRows(metricName: string, urlPath: string) {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('clarity_metrics_daily' as never)
    .select('snapshot_date, url, total_session_count, active_time')
    .eq('metric_name', metricName)
    .eq('url_path', urlPath)
    .order('snapshot_date', { ascending: false })
    .limit(50)
  if (error) throw new Error(`clarity ${metricName}/${urlPath} read failed: ${error.message}`)
  return (data ?? []) as Array<{
    snapshot_date: string
    url: string
    total_session_count: number | null
    active_time: number | null
  }>
})

function latestSnapshotRows<T extends { snapshot_date: string }>(rows: T[]): T[] {
  if (rows.length === 0) return []
  const latest = rows[0].snapshot_date
  return rows.filter((r) => r.snapshot_date === latest)
}

// Clarity is snapshot-based — each row is a rolling-3-day window — so
// the dashboard's user-selectable window doesn't change which rows are
// considered. Accept `_w` for the Fetcher signature but ignore it.
const clarityLpVisits: Fetcher = async (_w) => {
  const rows = latestSnapshotRows(await loadClarityLatestRows('Traffic', CLARITY_LANDING_PAGE_PATH))
  return sumColumn(rows, 'total_session_count')
}

// Per-session avg active time = sum(EngagementTime.active_time) /
// sum(Traffic.total_session_count), paired by url within the latest
// snapshot that BOTH blocks share. Falls back to a flat
// avg(active_time) across the EngagementTime rows when traffic sessions
// aren't populated (defensive — Clarity's typical shape DOES populate
// sessions on Traffic).
async function clarityPerSessionAvgTime(urlPath: string): Promise<number | null> {
  const [traffic, engagement] = await Promise.all([
    loadClarityLatestRows('Traffic', urlPath),
    loadClarityLatestRows('EngagementTime', urlPath),
  ])
  // Find latest snapshot present in BOTH metric blocks. Traffic latest
  // might lead EngagementTime by one cron tick or vice versa; pick the
  // shared date so the sums line up.
  const trafficDates = new Set(traffic.map((r) => r.snapshot_date))
  const engagementShared = engagement.filter((r) => trafficDates.has(r.snapshot_date))
  if (engagementShared.length === 0) return null
  const sharedDate = engagementShared[0].snapshot_date
  const trafficRows = traffic.filter((r) => r.snapshot_date === sharedDate)
  const engagementRows = engagement.filter((r) => r.snapshot_date === sharedDate)
  const sessions = sumColumn(trafficRows, 'total_session_count')
  const activeTotal = sumColumn(engagementRows, 'active_time')
  if (activeTotal === null) return null
  if (sessions && sessions > 0) return activeTotal / sessions
  return avgColumn(engagementRows, 'active_time')
}

const clarityLpAvgTime: Fetcher = async (_w) => clarityPerSessionAvgTime(CLARITY_LANDING_PAGE_PATH)
const clarityTypAvgTime: Fetcher = async (_w) => clarityPerSessionAvgTime(CLARITY_THANK_YOU_PAGE_PATH)

// ----- Wistia -----

const loadWistia = cache(async function loadWistia(hashedIds: readonly string[], window: Window) {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('wistia_media_daily' as never)
    .select('hashed_id, day, played_time_seconds, plays_filtered, engagement_rate')
    .in('hashed_id', hashedIds)
    .gte('day', getWindowStartDate(window))
  if (error) throw new Error(`wistia read failed: ${error.message}`)
  return (data ?? []) as Array<{
    hashed_id: string
    day: string
    played_time_seconds: number | null
    plays_filtered: number | null
    engagement_rate: number | null
  }>
})

const wistiaVslEngagementRate: Fetcher = async (w) => avgColumn(await loadWistia(VSL_HASHED_IDS, w), 'engagement_rate')

const wistiaVslAvgViewDuration: Fetcher = async (w) => {
  const rows = await loadWistia(VSL_HASHED_IDS, w)
  const playedTotal = sumColumn(rows, 'played_time_seconds')
  const plays = sumColumn(rows, 'plays_filtered')
  if (playedTotal === null || plays === null || plays === 0) return null
  return playedTotal / plays
}

const wistiaTypEngagementRate: Fetcher = async (w) => avgColumn(await loadWistia(TYP_HASHED_IDS, w), 'engagement_rate')

const wistiaTypAvgViewDuration: Fetcher = async (w) => {
  const rows = await loadWistia(TYP_HASHED_IDS, w)
  const playedTotal = sumColumn(rows, 'played_time_seconds')
  const plays = sumColumn(rows, 'plays_filtered')
  if (playedTotal === null || plays === null || plays === 0) return null
  return playedTotal / plays
}

// ----- Typeform -----

const typeformSubmits: Fetcher = async (w) => {
  const sb = createAdminClient()
  const { count, error } = await sb
    .from('typeform_responses' as never)
    .select('response_id', { count: 'exact', head: true })
    .gte('submitted_at', getWindowStartIso(w))
  if (error) throw new Error(`typeform_responses count failed: ${error.message}`)
  return count ?? 0
}

// ----- Calendly -----
//
// `calendly_scheduled_events` and `calendly_invitees` have NO FK on
// event_uri (per the schema doc: webhook delivery ordering + retired
// event-type tolerance). PostgREST embedded-relation syntax (`!inner`)
// requires an FK, so the join runs as two queries with a JS-side merge.

type EventRow = {
  uri: string
  name: string | null
  status: string
  start_time: string
  event_created_at: string
}
type InviteeRow = { event_uri: string; status: string; rescheduled: boolean }

const loadActiveEvents = cache(async function loadActiveEvents(window: Window): Promise<EventRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('calendly_scheduled_events' as never)
    .select('uri, name, status, start_time, event_created_at')
    .eq('status', 'active')
    .gte('event_created_at', getWindowStartIso(window))
  if (error) throw new Error(`calendly events read failed: ${error.message}`)
  return (data ?? []) as unknown as EventRow[]
})

const loadActiveInviteesForEvents = cache(async function loadActiveInviteesForEvents(eventUris: string[]): Promise<InviteeRow[]> {
  if (eventUris.length === 0) return []
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('calendly_invitees' as never)
    .select('event_uri, status, rescheduled')
    .in('event_uri', eventUris)
    .eq('status', 'active')
  if (error) throw new Error(`calendly invitees read failed: ${error.message}`)
  return (data ?? []) as unknown as InviteeRow[]
})

// Partition events into: (a) those with at least one active non-
// rescheduled invitee (NEW bookings), (b) those with at least one
// active rescheduled invitee (RESCHEDULED bookings). An event can land
// in both buckets if it has multiple invitees with mixed flags —
// vanishingly rare; defended in the schema doc tests.
const partitionBookings = cache(async function partitionBookings(window: Window): Promise<{
  events: EventRow[]
  newByUri: Set<string>
  reschByUri: Set<string>
}> {
  const events = await loadActiveEvents(window)
  const invitees = await loadActiveInviteesForEvents(events.map((e) => e.uri))
  const newByUri = new Set<string>()
  const reschByUri = new Set<string>()
  for (const i of invitees) {
    if (i.rescheduled === false) newByUri.add(i.event_uri)
    else if (i.rescheduled === true) reschByUri.add(i.event_uri)
  }
  return { events, newByUri, reschByUri }
})

const calendlyNewScheduled: Fetcher = async (w) => {
  const { events, newByUri } = await partitionBookings(w)
  return events.filter((e) => newByUri.has(e.uri)).length
}

const calendlyNewRescheduled: Fetcher = async (w) => {
  const { events, reschByUri } = await partitionBookings(w)
  return events.filter((e) => reschByUri.has(e.uri)).length
}

function isCloserEvent(name: string | null): boolean {
  return !!name && CLOSER_EVENT_NAMES_LOWER.includes(name.toLowerCase())
}

const calendlyCloserBookings: Fetcher = async (w) => {
  const { events, newByUri } = await partitionBookings(w)
  return events.filter((e) => isCloserEvent(e.name) && newByUri.has(e.uri)).length
}

const calendlyCloserBookingNextDay: Fetcher = async (w) => {
  const { events, newByUri } = await partitionBookings(w)
  return events.filter(
    (e) =>
      isCloserEvent(e.name) &&
      newByUri.has(e.uri) &&
      bookingDaysOutEst(e.event_created_at, e.start_time) === 1,
  ).length
}

const calendlyCloserBookingTwoDays: Fetcher = async (w) => {
  const { events, newByUri } = await partitionBookings(w)
  return events.filter(
    (e) =>
      isCloserEvent(e.name) &&
      newByUri.has(e.uri) &&
      bookingDaysOutEst(e.event_created_at, e.start_time) === 2,
  ).length
}

// Compute days-between in America/New_York per the schema's date-math
// gotcha. A booking made at 22:00 EDT for a meeting 09:00 EDT next
// morning is "1 day out" — not 0 (UTC drift).
function bookingDaysOutEst(eventCreatedAtIso: string, startTimeIso: string): number {
  const createdDate = estCalendarDate(new Date(eventCreatedAtIso))
  const startDate = estCalendarDate(new Date(startTimeIso))
  const a = new Date(createdDate + 'T00:00:00Z').getTime()
  const b = new Date(startDate + 'T00:00:00Z').getTime()
  return Math.round((b - a) / DAY_MS)
}

function estCalendarDate(at: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  return fmt.format(at) // 'YYYY-MM-DD'
}

// ----- Airtable: setter triage -----

// Setter triage time-axis: `airtable_created_at` (the Airtable
// record-creation timestamp) — not the user-entered `booked_at` column
// from the schema doc. Reason: `booked_at` is sparsely populated in
// the mirror today (0 of 4 rows have it filled as of 2026-05-24, the
// day after ingestion went live). Card subtitles call this out so
// Nabeel reads the number with the right semantic.
async function countSetterTriages(window: Window, filter?: { booking_status?: string }): Promise<number> {
  const sb = createAdminClient()
  let q = sb
    .from('airtable_setter_triage_calls' as never)
    .select('record_id', { count: 'exact', head: true })
    .gte('airtable_created_at', getWindowStartIso(window))
  if (filter?.booking_status) {
    q = q.eq('booking_status', filter.booking_status)
  }
  const { count, error } = await q
  if (error) throw new Error(`airtable_setter_triage_calls count failed: ${error.message}`)
  return count ?? 0
}

const airtableTotalSetterTriages: Fetcher = async (w) => countSetterTriages(w)
const airtableSetterDqs: Fetcher = async (w) => countSetterTriages(w, { booking_status: 'Disqualified Lead' })
const airtableSetterDownsells: Fetcher = async (w) => countSetterTriages(w, { booking_status: 'Downsell' })
const airtableCloserConfirmedMeetings: Fetcher = async (w) => countSetterTriages(w, { booking_status: 'Confirmed Booked with Closer' })

// ----- Close calls -----

const closeTotalDials: Fetcher = async (w) => {
  const sb = createAdminClient()
  const { count, error } = await sb
    .from('close_calls' as never)
    .select('close_id', { count: 'exact', head: true })
    .eq('direction', 'outbound')
    .gte('date_created', getWindowStartIso(w))
  if (error) throw new Error(`close_calls count failed: ${error.message}`)
  return count ?? 0
}

// ----- Airtable: full closer report -----

async function countCloserRecords(window: Window, predicates: Record<string, string>): Promise<number> {
  const sb = createAdminClient()
  let q = sb
    .from('airtable_full_closer_report' as never)
    .select('record_id', { count: 'exact', head: true })
    .gte('date_time_of_call', getWindowStartIso(window))
  for (const [k, v] of Object.entries(predicates)) {
    q = q.eq(k, v)
  }
  const { count, error } = await q
  if (error) throw new Error(`airtable_full_closer_report count failed: ${error.message}`)
  return count ?? 0
}

const airtableShowed: Fetcher = async (w) => countCloserRecords(w, { call_type: 'Consultation Call', showed: 'Yes' })
const airtableNoShows: Fetcher = async (w) => countCloserRecords(w, { call_type: 'Consultation Call', no_show_reason: 'Ghost - NoShow' })
const airtableReschedules: Fetcher = async (w) => countCloserRecords(w, { call_type: 'Consultation Call', no_show_reason: 'Rescheduled' })

// "Cancelled Meetings" rolls up TWO no_show_reason values. Two queries
// + sum keeps it single-table.
const airtableCancelled: Fetcher = async (w) => {
  const sb = createAdminClient()
  const { count, error } = await sb
    .from('airtable_full_closer_report' as never)
    .select('record_id', { count: 'exact', head: true })
    .gte('date_time_of_call', getWindowStartIso(w))
    .eq('call_type', 'Consultation Call')
    .in('no_show_reason', ['Closer Cancelled Call', 'Client Cancelled Call'])
  if (error) throw new Error(`airtable cancelled count failed: ${error.message}`)
  return count ?? 0
}

const airtableClosedNew: Fetcher = async (w) => countCloserRecords(w, { call_type: 'Consultation Call', closed: 'Yes' })
const airtableClosedFollowUp: Fetcher = async (w) => countCloserRecords(w, { call_type: 'Follow Up Call', closed: 'Yes' })
const airtableClosedTotal: Fetcher = async (w) => countCloserRecords(w, { closed: 'Yes' })

// ----- Fathom (calls) -----

const fathomAvgMeetingDuration: Fetcher = async (w) => {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('calls' as never)
    .select('duration_seconds, started_at, call_category')
    .eq('call_category', 'client')
    .gte('started_at', getWindowStartIso(w))
  if (error) throw new Error(`calls avg duration read failed: ${error.message}`)
  const rows = (data ?? []) as Array<{ duration_seconds: number | null }>
  return avgColumn(rows, 'duration_seconds')
}

const fathomClientCallsHeld: Fetcher = async (w) => {
  const sb = createAdminClient()
  const { count, error } = await sb
    .from('calls' as never)
    .select('id', { count: 'exact', head: true })
    .eq('call_category', 'client')
    .gte('started_at', getWindowStartIso(w))
  if (error) throw new Error(`calls held count failed: ${error.message}`)
  return count ?? 0
}

// ---------------------------------------------------------------------------
// Fetcher registry
// ---------------------------------------------------------------------------

const FETCHERS: Record<string, Fetcher> = {
  metaAdspend,
  metaFrequency,
  metaImpressions,
  metaUniqueLinkClicks,
  metaCostPerImpression,
  metaCostPerUniqueClick,
  metaCtr,
  clarityLpVisits,
  clarityLpAvgTime,
  clarityTypAvgTime,
  wistiaVslEngagementRate,
  wistiaVslAvgViewDuration,
  wistiaTypEngagementRate,
  wistiaTypAvgViewDuration,
  typeformSubmits,
  calendlyCloserBookings,
  calendlyCloserBookingNextDay,
  calendlyCloserBookingTwoDays,
  calendlyNewScheduled,
  calendlyNewRescheduled,
  airtableTotalSetterTriages,
  airtableSetterDqs,
  airtableSetterDownsells,
  airtableCloserConfirmedMeetings,
  closeTotalDials,
  airtableShowed,
  airtableNoShows,
  airtableReschedules,
  airtableCancelled,
  airtableClosedNew,
  airtableClosedFollowUp,
  airtableClosedTotal,
  fathomAvgMeetingDuration,
  fathomClientCallsHeld,
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

import type { FetchResult } from './sales-dashboard-shared'

// Runs all LIVE fetchers in parallel. Each fetcher's error is caught
// per-card so one bad query doesn't take the whole page down — failing
// cards render as a small "error" state with the message in a tooltip.
export async function fetchSalesDashboardData(window: Window = DEFAULT_WINDOW): Promise<Record<string, FetchResult>> {
  if (process.env.SALES_DASHBOARD_MOCK === 'true') {
    return mockSalesDashboardData(window)
  }
  const liveMetrics = METRICS.filter((m: MetricEntry) => m.status === 'live' && m.fetcher)
  const results = await Promise.all(
    liveMetrics.map(async (m: MetricEntry): Promise<[string, FetchResult]> => {
      const fn = FETCHERS[m.fetcher!]
      if (!fn) {
        return [m.id, { state: 'live_error', message: `no fetcher registered for "${m.fetcher}"` }]
      }
      try {
        const value = await fn(window)
        return [m.id, { state: 'live', value }]
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e)
        return [m.id, { state: 'live_error', message }]
      }
    }),
  )
  const map: Record<string, FetchResult> = {}
  for (const [id, r] of results) map[id] = r
  for (const m of METRICS) {
    if (m.status === 'pending') map[m.id] = { state: 'pending' }
    else if (m.status === 'not_connected') map[m.id] = { state: 'not_connected' }
  }
  return map
}

// `MetricFormat` is re-exported from shared above; this local re-export
// keeps callers that import it directly from `./sales-dashboard.ts`
// (e.g. the v1 card variants) working without a wave of import-path
// rewrites.
export type { MetricFormat }

// ---------------------------------------------------------------------------
// Mock data — short-circuits fetchSalesDashboardData when
// SALES_DASHBOARD_MOCK=true in env. Generates deterministic
// per-metric values that scale with the window so the switcher feels
// real without hitting Supabase. Used for local visual iteration when
// the network or DB is unreliable; off by default.
// ---------------------------------------------------------------------------

const WINDOW_MOCK_SCALE: Record<Window, number> = {
  '1d': 0.15,
  '7d': 1,
  '30d': 4,
}

function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

// Plausible USD magnitude tier inferred from the metric's title. Lets
// the mock generate $80k for "Cash Collected" and $400 for "Cost Per
// Click" instead of using a single uniform USD range.
function usdTier(title: string): 'large' | 'mid' | 'small' | 'tiny' {
  const t = title.toLowerCase()
  if (/(cash collected|total cash|contracted revenue|revenue|gross sales)/.test(t)) return 'large'
  if (/\b(aov|average order|per order|per deal|per appointment)\b/.test(t)) return 'mid'
  if (/\b(cost per|cost-per|cpm|cpc|cpl)\b/.test(t)) return 'small'
  if (/(spend|adspend|ad spend|budget)/.test(t)) return 'mid'
  return 'small'
}

function mockValueFor(m: MetricEntry, window: Window): number {
  const base = hashId(m.id) % 1000
  const scale = WINDOW_MOCK_SCALE[window]
  const format = m.format ?? inferredFormat(m.title)

  switch (format) {
    case 'usd': {
      const tier = usdTier(m.title)
      if (tier === 'large') return Math.round((40000 + (base % 80000)) * scale)
      if (tier === 'mid') return Math.round((1500 + (base % 9000)) * scale)
      if (tier === 'small') return Math.round(50 + (base % 1950))
      return Math.round(1 + (base % 50))
    }
    case 'usd_precise':
      return ((base % 200) + 10) / 1000
    case 'percent_0_100':
      return ((base % 75) + 5)
    case 'percent_0_1':
      return ((base % 75) + 5) / 100
    case 'duration_seconds':
      return Math.round((30 + (base % 240)) * Math.min(scale, 1.5))
    case 'decimal':
      return +(((base % 80) + 5) / 10).toFixed(2)
    case 'integer':
    default:
      return Math.max(1, Math.round((1 + (base % 200)) * scale))
  }
}

// 14 daily points trailing the current window — the sparkline series.
// Each point is computed from the same hash-based base but perturbed
// per day so the line has texture. The last point matches (within a
// small tolerance) the headline value's per-day average so the
// sparkline reads as the underlying daily trend.
const SPARK_POINTS = 14

function mockSeries(m: MetricEntry, window: Window): number[] {
  const base = hashId(m.id) % 1000
  const dailyMean = mockValueFor(m, window) / WINDOW_DAYS[window]
  const series: number[] = []
  // Trend bias per metric — some climb, some decay, some are flat-ish.
  const biasSeed = hashId(m.id + ':bias') % 100
  const trendPct = ((biasSeed - 50) / 50) * 0.3 // -30% to +30% over the series
  for (let i = 0; i < SPARK_POINTS; i++) {
    const t = i / (SPARK_POINTS - 1) // 0..1
    const trendMultiplier = 1 + trendPct * (t - 0.5) // centered
    const wobbleSeed = hashId(`${m.id}:${i}`) % 1000
    const wobble = 0.85 + (wobbleSeed / 1000) * 0.3 // 0.85..1.15
    let v = dailyMean * trendMultiplier * wobble
    if (m.format === 'percent_0_100' || (m.format === undefined && inferredFormat(m.title) === 'percent_0_100')) {
      // Percent series isn't summed over a window — it's a rate. Use
      // the headline value directly as the mean, not the per-day avg.
      v = mockValueFor(m, window) * trendMultiplier * wobble
    } else if (m.format === 'percent_0_1') {
      v = mockValueFor(m, window) * trendMultiplier * wobble
    }
    series.push(Math.max(0, v))
  }
  return series
}

function mockPriorFor(m: MetricEntry, window: Window): number {
  // Deterministic prior-period value: bias around current with a
  // metric-stable ±25% shift so the delta isn't always the same sign.
  const current = mockValueFor(m, window)
  const seed = hashId(m.id + ':prior') % 100
  const shift = 0.75 + (seed / 100) * 0.5 // 0.75..1.25
  return Math.max(0, current * shift)
}

// Realistic conversion rates between funnel stages so mock values
// descend coherently instead of being random per-metric. Order matches
// FUNNEL_STAGES; first stage uses its standalone mock value.
const FUNNEL_CONVERSION_RATES: number[] = [
  0.06,  // Impressions → LP Visits (CTR-ish through the LP)
  0.05,  // LP Visits → Submits
  0.38,  // Submits → Bookings
  0.62,  // Bookings → Showed
  0.28,  // Showed → Closed
  4200,  // Closed → Cash ($ AOV — special-cased; it's a multiplier in dollars)
]

function coerceFunnelValues(map: Record<string, FetchResult>, window: Window): void {
  // Anchor the top of the funnel at a realistic impressions volume so
  // the cascade through LP → Submit → Book → Show → Close → Cash
  // produces believable numbers. The default integer-format mock caps
  // at ~200×scale which is fine for catalog cells but lands the funnel
  // in the dozens; we override it with a Meta-scale impressions count
  // tied to the window.
  const stages = FUNNEL_STAGES
  const firstStage = METRICS.find((m) => m.id === stages[0].id)
  if (!firstStage) return
  // ~120K impressions/day baseline with light per-window jitter so the
  // numbers refresh believably between window clicks.
  const dailyImpressions = 120_000
  const jitter = 0.9 + (hashId(firstStage.id + ':funnel-anchor') % 100) / 500 // 0.90..1.10
  let prior = dailyImpressions * WINDOW_DAYS[window] * jitter
  const firstRes = map[stages[0].id]
  if (firstRes && firstRes.state === 'live') {
    map[stages[0].id] = { ...firstRes, value: Math.round(prior) }
  }
  for (let i = 1; i < stages.length; i++) {
    const stage = stages[i]
    const rate = FUNNEL_CONVERSION_RATES[i - 1]
    const m = METRICS.find((mm) => mm.id === stage.id)
    if (!m) continue
    const jitterSeed = hashId(stage.id + ':funnel-jitter') % 100
    const jitter = 0.88 + (jitterSeed / 100) * 0.24 // 0.88..1.12
    const next = Math.max(1, Math.round(prior * rate * jitter))
    const res = map[stage.id]
    if (res && res.state === 'live') {
      // Keep prior + sparkline as-is; just override the headline value.
      // Then rescale series so the last point aligns with the new value.
      const lastSeriesPoint = res.series && res.series.length > 0 ? res.series[res.series.length - 1] : null
      const series = lastSeriesPoint && lastSeriesPoint > 0 && res.series
        ? res.series.map((p) => (p / lastSeriesPoint) * next)
        : res.series
      // Prior also scales — keep its relative shift to the new headline.
      const priorShiftSeed = hashId(stage.id + ':funnel-prior') % 100
      const priorShift = 0.78 + (priorShiftSeed / 100) * 0.44 // 0.78..1.22
      map[stage.id] = { ...res, value: next, prior: Math.round(next * priorShift), series }
    }
    prior = next
  }
}

function mockSalesDashboardData(window: Window): Record<string, FetchResult> {
  const map: Record<string, FetchResult> = {}
  for (const m of METRICS) {
    // Pending metrics get filled with mock values too so the dashboard
    // looks fully wired during local visual iteration. NOT_CONNECTED
    // stays as-is — those have no upstream source so faking them would
    // misrepresent the system.
    if ((m.status === 'live' && m.fetcher) || m.status === 'pending') {
      map[m.id] = {
        state: 'live',
        value: mockValueFor(m, window),
        prior: mockPriorFor(m, window),
        series: mockSeries(m, window),
      }
    } else if (m.status === 'not_connected') {
      map[m.id] = { state: 'not_connected' }
    }
  }
  coerceFunnelValues(map, window)
  return map
}
