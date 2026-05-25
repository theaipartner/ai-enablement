import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { MetricEntry, MetricFormat } from './sales-dashboard-shared'
import { METRICS } from './sales-dashboard-shared'

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

// Clarity canonical paths. Source of truth: ingestion/clarity/__init__.py.
const CLARITY_LANDING_PAGE_PATH = '/lp'
const CLARITY_THANK_YOU_PAGE_PATH = '/confirmation'

// ---------------------------------------------------------------------------
// Time window helpers
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000

// Window for the v1 dashboard: rolling last 7 days (UTC).
// Returned as an ISO string the PostgREST .gte() filter can consume.
function getWindowStartIso(): string {
  return new Date(Date.now() - 7 * DAY_MS).toISOString()
}

// Same window expressed as a calendar-date string (YYYY-MM-DD) for
// columns typed as `date` (meta_ad_daily.day, etc.). 7 days ago UTC.
function getWindowStartDate(): string {
  const d = new Date(Date.now() - 7 * DAY_MS)
  return d.toISOString().slice(0, 10)
}

// ---------------------------------------------------------------------------
// Fetchers — one per LIVE metric. All return `number | null`. NULL means
// "no rows in the window" or "denominator was zero"; the card layer
// renders NULL as a dash so an empty mirror table never reads as a 0.
// ---------------------------------------------------------------------------

type Fetcher = () => Promise<number | null>

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

async function loadMeta7d() {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('meta_ad_daily' as never)
    .select('day, amount_spent, frequency, impressions, unique_link_clicks, cpm, cost_per_unique_link_click, ctr')
    .gte('day', getWindowStartDate())
  if (error) throw new Error(`meta_ad_daily 7d read failed: ${error.message}`)
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
}

const metaAdspend: Fetcher = async () => sumColumn(await loadMeta7d(), 'amount_spent')
const metaFrequency: Fetcher = async () => avgColumn(await loadMeta7d(), 'frequency')
const metaImpressions: Fetcher = async () => sumColumn(await loadMeta7d(), 'impressions')
const metaUniqueLinkClicks: Fetcher = async () => sumColumn(await loadMeta7d(), 'unique_link_clicks')

// Cost per impression = total spend / total impressions. Single-table.
const metaCostPerImpression: Fetcher = async () => {
  const rows = await loadMeta7d()
  const spend = sumColumn(rows, 'amount_spent')
  const impressions = sumColumn(rows, 'impressions')
  if (spend === null || impressions === null || impressions === 0) return null
  return spend / impressions
}

const metaCostPerUniqueClick: Fetcher = async () => {
  const rows = await loadMeta7d()
  const spend = sumColumn(rows, 'amount_spent')
  const clicks = sumColumn(rows, 'unique_link_clicks')
  if (spend === null || clicks === null || clicks === 0) return null
  return spend / clicks
}

// Volume-weighted CTR — total link_clicks / total impressions × 100.
// Schema doc notes ctr is already %-scaled; weighted is more honest
// across days with different volume.
const metaCtr: Fetcher = async () => avgColumn(await loadMeta7d(), 'ctr')

// ----- Clarity -----

// Clarity rows are rolling-3-day snapshots — each `snapshot_date` value
// represents the trailing 3 days from that observation. Different
// metric blocks (Traffic / EngagementTime / ...) populate disjoint
// columns: Traffic carries `total_session_count`, EngagementTime
// carries `active_time` but not sessions. To get a per-session
// engagement-time average, both blocks need to be read and paired by
// (snapshot_date, url).
async function loadClarityLatestRows(metricName: string, urlPath: string) {
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
}

function latestSnapshotRows<T extends { snapshot_date: string }>(rows: T[]): T[] {
  if (rows.length === 0) return []
  const latest = rows[0].snapshot_date
  return rows.filter((r) => r.snapshot_date === latest)
}

const clarityLpVisits: Fetcher = async () => {
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

const clarityLpAvgTime: Fetcher = async () => clarityPerSessionAvgTime(CLARITY_LANDING_PAGE_PATH)
const clarityTypAvgTime: Fetcher = async () => clarityPerSessionAvgTime(CLARITY_THANK_YOU_PAGE_PATH)

// ----- Wistia -----

async function loadWistia7d(hashedIds: string[]) {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('wistia_media_daily' as never)
    .select('hashed_id, day, played_time_seconds, plays_filtered, engagement_rate')
    .in('hashed_id', hashedIds)
    .gte('day', getWindowStartDate())
  if (error) throw new Error(`wistia 7d read failed: ${error.message}`)
  return (data ?? []) as Array<{
    hashed_id: string
    day: string
    played_time_seconds: number | null
    plays_filtered: number | null
    engagement_rate: number | null
  }>
}

const wistiaVslEngagementRate: Fetcher = async () => avgColumn(await loadWistia7d(VSL_HASHED_IDS), 'engagement_rate')

const wistiaVslAvgViewDuration: Fetcher = async () => {
  const rows = await loadWistia7d(VSL_HASHED_IDS)
  const playedTotal = sumColumn(rows, 'played_time_seconds')
  const plays = sumColumn(rows, 'plays_filtered')
  if (playedTotal === null || plays === null || plays === 0) return null
  return playedTotal / plays
}

const wistiaTypEngagementRate: Fetcher = async () => avgColumn(await loadWistia7d([TYP_HASHED_ID]), 'engagement_rate')

const wistiaTypAvgViewDuration: Fetcher = async () => {
  const rows = await loadWistia7d([TYP_HASHED_ID])
  const playedTotal = sumColumn(rows, 'played_time_seconds')
  const plays = sumColumn(rows, 'plays_filtered')
  if (playedTotal === null || plays === null || plays === 0) return null
  return playedTotal / plays
}

// ----- Typeform -----

const typeformSubmits: Fetcher = async () => {
  const sb = createAdminClient()
  const { count, error } = await sb
    .from('typeform_responses' as never)
    .select('response_id', { count: 'exact', head: true })
    .gte('submitted_at', getWindowStartIso())
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

async function loadActiveEvents7d(): Promise<EventRow[]> {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('calendly_scheduled_events' as never)
    .select('uri, name, status, start_time, event_created_at')
    .eq('status', 'active')
    .gte('event_created_at', getWindowStartIso())
  if (error) throw new Error(`calendly events read failed: ${error.message}`)
  return (data ?? []) as unknown as EventRow[]
}

async function loadActiveInviteesForEvents(eventUris: string[]): Promise<InviteeRow[]> {
  if (eventUris.length === 0) return []
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('calendly_invitees' as never)
    .select('event_uri, status, rescheduled')
    .in('event_uri', eventUris)
    .eq('status', 'active')
  if (error) throw new Error(`calendly invitees read failed: ${error.message}`)
  return (data ?? []) as unknown as InviteeRow[]
}

// Partition events into: (a) those with at least one active non-
// rescheduled invitee (NEW bookings), (b) those with at least one
// active rescheduled invitee (RESCHEDULED bookings). An event can land
// in both buckets if it has multiple invitees with mixed flags —
// vanishingly rare; defended in the schema doc tests.
async function partitionBookings(): Promise<{
  events: EventRow[]
  newByUri: Set<string>
  reschByUri: Set<string>
}> {
  const events = await loadActiveEvents7d()
  const invitees = await loadActiveInviteesForEvents(events.map((e) => e.uri))
  const newByUri = new Set<string>()
  const reschByUri = new Set<string>()
  for (const i of invitees) {
    if (i.rescheduled === false) newByUri.add(i.event_uri)
    else if (i.rescheduled === true) reschByUri.add(i.event_uri)
  }
  return { events, newByUri, reschByUri }
}

const calendlyNewScheduled: Fetcher = async () => {
  const { events, newByUri } = await partitionBookings()
  return events.filter((e) => newByUri.has(e.uri)).length
}

const calendlyNewRescheduled: Fetcher = async () => {
  const { events, reschByUri } = await partitionBookings()
  return events.filter((e) => reschByUri.has(e.uri)).length
}

function isCloserEvent(name: string | null): boolean {
  return !!name && CLOSER_EVENT_NAMES_LOWER.includes(name.toLowerCase())
}

const calendlyCloserBookings: Fetcher = async () => {
  const { events, newByUri } = await partitionBookings()
  return events.filter((e) => isCloserEvent(e.name) && newByUri.has(e.uri)).length
}

const calendlyCloserBookingNextDay: Fetcher = async () => {
  const { events, newByUri } = await partitionBookings()
  return events.filter(
    (e) =>
      isCloserEvent(e.name) &&
      newByUri.has(e.uri) &&
      bookingDaysOutEst(e.event_created_at, e.start_time) === 1,
  ).length
}

const calendlyCloserBookingTwoDays: Fetcher = async () => {
  const { events, newByUri } = await partitionBookings()
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
async function countSetterTriages(filter?: { booking_status?: string }): Promise<number> {
  const sb = createAdminClient()
  let q = sb
    .from('airtable_setter_triage_calls' as never)
    .select('record_id', { count: 'exact', head: true })
    .gte('airtable_created_at', getWindowStartIso())
  if (filter?.booking_status) {
    q = q.eq('booking_status', filter.booking_status)
  }
  const { count, error } = await q
  if (error) throw new Error(`airtable_setter_triage_calls count failed: ${error.message}`)
  return count ?? 0
}

const airtableTotalSetterTriages: Fetcher = async () => countSetterTriages()
const airtableSetterDqs: Fetcher = async () => countSetterTriages({ booking_status: 'Disqualified Lead' })
const airtableSetterDownsells: Fetcher = async () => countSetterTriages({ booking_status: 'Downsell' })
const airtableCloserConfirmedMeetings: Fetcher = async () => countSetterTriages({ booking_status: 'Confirmed Booked with Closer' })

// ----- Close calls -----

const closeTotalDials: Fetcher = async () => {
  const sb = createAdminClient()
  const { count, error } = await sb
    .from('close_calls' as never)
    .select('close_id', { count: 'exact', head: true })
    .eq('direction', 'outbound')
    .gte('date_created', getWindowStartIso())
  if (error) throw new Error(`close_calls count failed: ${error.message}`)
  return count ?? 0
}

// ----- Airtable: full closer report -----

async function countCloserRecords(predicates: Record<string, string>): Promise<number> {
  const sb = createAdminClient()
  let q = sb
    .from('airtable_full_closer_report' as never)
    .select('record_id', { count: 'exact', head: true })
    .gte('date_time_of_call', getWindowStartIso())
  for (const [k, v] of Object.entries(predicates)) {
    q = q.eq(k, v)
  }
  const { count, error } = await q
  if (error) throw new Error(`airtable_full_closer_report count failed: ${error.message}`)
  return count ?? 0
}

const airtableShowed: Fetcher = async () => countCloserRecords({ call_type: 'Consultation Call', showed: 'Yes' })
const airtableNoShows: Fetcher = async () => countCloserRecords({ call_type: 'Consultation Call', no_show_reason: 'Ghost - NoShow' })
const airtableReschedules: Fetcher = async () => countCloserRecords({ call_type: 'Consultation Call', no_show_reason: 'Rescheduled' })

// "Cancelled Meetings" rolls up TWO no_show_reason values. Two queries
// + sum keeps it single-table.
const airtableCancelled: Fetcher = async () => {
  const sb = createAdminClient()
  const { count, error } = await sb
    .from('airtable_full_closer_report' as never)
    .select('record_id', { count: 'exact', head: true })
    .gte('date_time_of_call', getWindowStartIso())
    .eq('call_type', 'Consultation Call')
    .in('no_show_reason', ['Closer Cancelled Call', 'Client Cancelled Call'])
  if (error) throw new Error(`airtable cancelled count failed: ${error.message}`)
  return count ?? 0
}

const airtableClosedNew: Fetcher = async () => countCloserRecords({ call_type: 'Consultation Call', closed: 'Yes' })
const airtableClosedFollowUp: Fetcher = async () => countCloserRecords({ call_type: 'Follow Up Call', closed: 'Yes' })
const airtableClosedTotal: Fetcher = async () => countCloserRecords({ closed: 'Yes' })

// ----- Fathom (calls) -----

const fathomAvgMeetingDuration: Fetcher = async () => {
  const sb = createAdminClient()
  const { data, error } = await sb
    .from('calls' as never)
    .select('duration_seconds, started_at, call_category')
    .eq('call_category', 'client')
    .gte('started_at', getWindowStartIso())
  if (error) throw new Error(`calls avg duration read failed: ${error.message}`)
  const rows = (data ?? []) as Array<{ duration_seconds: number | null }>
  return avgColumn(rows, 'duration_seconds')
}

const fathomClientCallsHeld: Fetcher = async () => {
  const sb = createAdminClient()
  const { count, error } = await sb
    .from('calls' as never)
    .select('id', { count: 'exact', head: true })
    .eq('call_category', 'client')
    .gte('started_at', getWindowStartIso())
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
export async function fetchSalesDashboardData(): Promise<Record<string, FetchResult>> {
  const liveMetrics = METRICS.filter((m: MetricEntry) => m.status === 'live' && m.fetcher)
  const results = await Promise.all(
    liveMetrics.map(async (m: MetricEntry): Promise<[string, FetchResult]> => {
      const fn = FETCHERS[m.fetcher!]
      if (!fn) {
        return [m.id, { state: 'live_error', message: `no fetcher registered for "${m.fetcher}"` }]
      }
      try {
        const value = await fn()
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
