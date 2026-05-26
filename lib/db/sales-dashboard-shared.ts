// Shared (server + client) sales-dashboard catalog + display helpers.
//
// The companion module `lib/db/sales-dashboard.ts` is marked
// `'server-only'` because it imports the service-role Supabase admin
// client. Client Components (e.g. `app/(authenticated)/sales-dashboard/sidebar.tsx`)
// need access to the METRICS catalog + section display helpers for
// rendering nav counts and labels, but can't import the server-only
// module without breaking the client bundle (next-swc rejects it at
// compile time). Splitting the pure utilities here lets both sides
// reach for the same vocabulary.
//
// Anything that lives in this file MUST be free of:
//   - `'server-only'` imports
//   - the Supabase admin client (`@/lib/supabase/admin`)
//   - the cookies/headers/request-context APIs
//   - any other server-side-only Node API
//
// Same split precedent: `lib/auth/access-tier.ts` (server) +
// `lib/auth/access-tier-shared.ts` (shared) — see those files for the
// pattern.

// ---------------------------------------------------------------------------
// Catalog types
// ---------------------------------------------------------------------------

export type MetricStatus = 'live' | 'pending' | 'not_connected'

export type MetricFormat =
  | 'integer' // 1,234
  | 'decimal' // 1,234.56
  | 'usd' // $1,234.56
  | 'usd_precise' // $1.2345 (per-impression scale)
  | 'percent_0_100' // 12.3% — input already in 0-100 scale
  | 'percent_0_1' // 12.3% — input is 0-1 fractional
  | 'duration_seconds' // 1m 23s

export type SectionId =
  | 'ADVERTISING'
  | 'CONTENT'
  | 'FUNNELS'
  | 'APPOINTMENT SETTING'
  | 'CLOSING'
  | 'SALES DATA'
  | 'BACK END REV'
  | 'BUSINESS COSTS'
  | 'FULFILLMENT'

export type MetricEntry = {
  id: string
  section: SectionId
  title: string
  status: MetricStatus
  // Source label echoes the Engine sheet's "Source" column. Shown
  // muted under each card so Nabeel can see provenance at a glance.
  source: string
  // Only set when status === 'live'. Indexes into FETCHERS in the
  // server-side module; client code only reads this to know whether a
  // catalog entry has a wired fetcher.
  fetcher?: string
  // Display format for the LIVE value. Only consulted when status === 'live'.
  format?: MetricFormat
  // Optional per-card caveat shown beneath the value (Clarity rolling
  // 3-day, is_setter_led provisional, etc.).
  note?: string
}

export type FetchResult =
  | {
      state: 'live'
      value: number | null
      // Phase 1: prior-period value (same window-length, immediately
      // preceding) so the card can render a comparative delta. Optional
      // because fetchers haven't all wired it yet — when absent, the
      // card renders the value alone.
      prior?: number | null
      // Phase 1: short trailing series (daily points, typically 14) so
      // the card can render a sparkline beneath the value.
      series?: number[]
    }
  | { state: 'live_error'; message: string }
  | { state: 'pending' }
  | { state: 'not_connected' }

// Direction of "good" for a metric. Costs, no-shows, cancellations and
// DQs are lower-is-better; everything else higher-is-better. Used by
// the delta pill to pick green vs red.
export function isHigherBetter(title: string): boolean {
  const t = title.toLowerCase()
  if (/\b(cost per|cost-per|cpm|cpc|cpl|spend|adspend|ad spend|budget)\b/.test(t)) return false
  if (/(no.?show|cancel|disqualif|\bdq\b|churn|refund|chargeback|reschedule)/.test(t)) return false
  if (/(time to|wait time|response time)/.test(t)) return false
  return true
}

// ---------------------------------------------------------------------------
// Section ordering + display constants
// ---------------------------------------------------------------------------

export const SECTION_ORDER: SectionId[] = [
  'ADVERTISING',
  'CONTENT',
  'FUNNELS',
  'APPOINTMENT SETTING',
  'CLOSING',
  'SALES DATA',
  'BACK END REV',
  'BUSINESS COSTS',
  'FULFILLMENT',
]

// URL-safe slug ↔ canonical SectionId. Single source of truth — the
// v2 sidebar, the [section] dynamic route, and any future deep-link
// reach for this map rather than inventing their own kebab-casing
// rules. Adding a new section means adding it in two places (here +
// SECTION_ORDER); no other file should hardcode a slug.
export const SECTION_SLUGS: Record<string, SectionId> = {
  'advertising': 'ADVERTISING',
  'content': 'CONTENT',
  'funnels': 'FUNNELS',
  'appointment-setting': 'APPOINTMENT SETTING',
  'closing': 'CLOSING',
  'sales-data': 'SALES DATA',
  'back-end-rev': 'BACK END REV',
  'business-costs': 'BUSINESS COSTS',
  'fulfillment': 'FULFILLMENT',
}

// Inverse map for building hrefs from a SectionId. Kept generated
// (not duplicated) so SECTION_SLUGS stays the single edit point.
export const SLUG_BY_SECTION: Record<SectionId, string> = Object.fromEntries(
  Object.entries(SECTION_SLUGS).map(([slug, section]) => [section, slug]),
) as Record<SectionId, string>

// Section display titles (with trailing period — Gregory editorial
// convention) and eyebrows for the section pages. Source of truth so
// the section route doesn't duplicate the casing.
export type SectionDisplay = { title: string; eyebrow: string }
export const SECTION_DISPLAY: Record<SectionId, SectionDisplay> = {
  'ADVERTISING': { title: 'Advertising.', eyebrow: 'SALES · ADVERTISING' },
  'CONTENT': { title: 'Content.', eyebrow: 'SALES · CONTENT' },
  'FUNNELS': { title: 'Funnels.', eyebrow: 'SALES · FUNNELS' },
  'APPOINTMENT SETTING': { title: 'Appointment Setting.', eyebrow: 'SALES · APPOINTMENT SETTING' },
  'CLOSING': { title: 'Closing.', eyebrow: 'SALES · CLOSING' },
  'SALES DATA': { title: 'Sales Data.', eyebrow: 'SALES · SALES DATA' },
  'BACK END REV': { title: 'Back-End Revenue.', eyebrow: 'SALES · BACK END REV' },
  'BUSINESS COSTS': { title: 'Business Costs.', eyebrow: 'SALES · BUSINESS COSTS' },
  'FULFILLMENT': { title: 'Fulfillment.', eyebrow: 'SALES · FULFILLMENT' },
}

// Sidebar display labels — shorter than the SectionId where useful
// ("Back-End Rev" vs "BACK END REV"). The mock's sidebar labels live
// here as their single source of truth.
export const SECTION_SIDEBAR_LABEL: Record<SectionId, string> = {
  'ADVERTISING': 'Advertising',
  'CONTENT': 'Content',
  'FUNNELS': 'Funnels',
  'APPOINTMENT SETTING': 'Appointment Setting',
  'CLOSING': 'Closing',
  'SALES DATA': 'Sales Data',
  'BACK END REV': 'Back-End Rev',
  'BUSINESS COSTS': 'Business Costs',
  'FULFILLMENT': 'Fulfillment',
}

// ---------------------------------------------------------------------------
// Time window (v2.1) — user-selectable 1d / 7d / 30d, threaded through
// every server-side fetch via ?window= URL param.
// ---------------------------------------------------------------------------

export type Window = '1d' | '7d' | '30d'

export const WINDOW_OPTIONS: Window[] = ['1d', '7d', '30d']

export const DEFAULT_WINDOW: Window = '7d'

export const WINDOW_DAYS: Record<Window, number> = {
  '1d': 1,
  '7d': 7,
  '30d': 30,
}

// Windows are anchored to the start of the period, not rolling. So
// 1d = since 00:00 today, 7d = since Monday this week, 30d = since the
// 1st of this month. As the period progresses, totals climb live.
export const WINDOW_LABELS: Record<Window, string> = {
  '1d': 'Since start of today',
  '7d': 'Since start of this week',
  '30d': 'Since start of this month',
}

export const WINDOW_SHORT_LABELS: Record<Window, string> = {
  '1d': 'TODAY',
  '7d': 'WEEK',
  '30d': 'MONTH',
}

// Parse an arbitrary searchParams.window value into a Window. Anything
// unrecognized falls back to DEFAULT_WINDOW so bad URLs never crash.
export function parseWindow(raw: string | string[] | undefined): Window {
  const v = Array.isArray(raw) ? raw[0] : raw
  if (v === '1d' || v === '7d' || v === '30d') return v
  return DEFAULT_WINDOW
}

// Legacy label kept for any callers that still import this constant.
export const DASHBOARD_WINDOW_LABEL = WINDOW_LABELS[DEFAULT_WINDOW]

// ---------------------------------------------------------------------------
// Monthly goal + projection — defaults that the client-side editor
// (MoneyFlow) reads on first mount. Both are dollar amounts for cash
// collected. Goal = where Nabeel wants to land. Projection = where the
// historical run-rate says we'll land. The editor persists overrides
// to localStorage; once a real backend is wired we'll move these to
// a Supabase row keyed by month + tenant.
// ---------------------------------------------------------------------------

export const DEFAULT_MONTHLY_GOAL = 611_000
export const DEFAULT_MONTHLY_PROJECTION = 540_000

// Prorate a monthly $ target down to the selected window: 30d window
// = full month, 7d = 7/30 of it, 1d = 1/30. Calendar-day anchored,
// not period-elapsed; matches the "since start of period" framing.
export function prorateTarget(monthlyTarget: number, window: Window): number {
  return monthlyTarget * (WINDOW_DAYS[window] / 30)
}

// Compact USD format that drops trailing cents and abbreviates at
// every order of magnitude so values fit in narrow dashboard cells:
//   $1,234,567 → $1.23M
//   $752,470   → $752K
//   $84,320    → $84.3K
//   $4,200     → $4.2K
//   $824       → $824
export function compactUsd(value: number): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? '−' : ''
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 100_000) return `${sign}$${Math.round(abs / 1_000)}K`
  if (abs >= 1_000) return `${sign}$${(abs / 1_000).toFixed(1)}K`
  return `${sign}$${Math.round(abs).toLocaleString('en-US')}`
}

// Compact integer for high-cardinality counts (impressions, clicks
// etc.). Aggressive — at the funnel scale (impressions in the 6-7
// digit range) commas don't fit either, so abbreviate at 10K too.
//   3,463,200 → 3.46M
//   840,000   → 840K
//   84,320    → 84K
//   8,432     → 8.4K
//   824       → 824
export function compactCount(value: number): string {
  const abs = Math.abs(value)
  const sign = value < 0 ? '−' : ''
  if (abs >= 1_000_000) return `${sign}${(abs / 1_000_000).toFixed(2)}M`
  if (abs >= 10_000) return `${sign}${Math.round(abs / 1_000)}K`
  if (abs >= 1_000) return `${sign}${(abs / 1_000).toFixed(1)}K`
  return `${sign}${Math.round(abs).toLocaleString('en-US')}`
}

// MoneyFlow shape — declared in shared so the client MoneyFlow
// component can import the type without crossing the `'server-only'`
// boundary that lives in sales-dashboard-mocks.ts. The mocks module
// re-uses this type when building the data.
export type MoneyFlow = {
  cashCollected: number
  futureCash: number
  refunds: number
  expenses: number
  netProfit: number
  priorCashCollected: number
  cashSeries: number[]
}

// ---------------------------------------------------------------------------
// Funnel stages (Phase 2 — Overview) — the conversion path the engine
// actually pushes leads through. Stage IDs are catalog IDs so the
// funnel + the cards share one source of truth. Labels are short for
// the funnel chrome; the catalog title is also surfaced on hover.
// ---------------------------------------------------------------------------

export type FunnelStage = {
  id: string
  label: string
}

export const FUNNEL_STAGES: FunnelStage[] = [
  { id: 'adv_impressions', label: 'Impressions' },
  { id: 'fun_lp_visits', label: 'LP Visits' },
  { id: 'fun_typeform_submits', label: 'Submits' },
  { id: 'fun_total_closer_bookings', label: 'Bookings' },
  { id: 'cls_showed', label: 'Showed' },
  { id: 'cls_closed_total', label: 'Closed' },
  { id: 'cls_total_cash', label: 'Cash' },
]

// ---------------------------------------------------------------------------
// Section lead-indicators — the one metric per section that headlines
// the section page's trend chart. Sections without a sensible single
// indicator (CONTENT — all NC) omit themselves; the section page
// gracefully drops the trend block in that case.
// ---------------------------------------------------------------------------

export const SECTION_LEAD_INDICATOR: Partial<Record<SectionId, string>> = {
  'ADVERTISING': 'adv_total_adspend',
  'FUNNELS': 'fun_typeform_submits',
  'APPOINTMENT SETTING': 'aps_total_setter_triages',
  'CLOSING': 'cls_closed_total',
  'SALES DATA': 'cls_total_cash',
  'BACK END REV': 'cls_total_cash',
}

// ---------------------------------------------------------------------------
// Hero metrics — Overview page
// ---------------------------------------------------------------------------

// The 7 hero IDs in display order. Spec § Hero metric catalog. Kept
// here (not in the page) so any future page or eval can reach the
// list without parsing component code. Order matters: the first three
// are the lede row, the last four are support.
export const HERO_LEDE_IDS = [
  'cls_total_cash',
  'cls_closed_total',
  'fun_typeform_submits',
] as const

export const HERO_SUPPORT_IDS = [
  'fun_total_closer_bookings',
  'adv_total_adspend',
  'aps_total_dials',
  'ful_calls_held',
] as const

export const HERO_IDS = [...HERO_LEDE_IDS, ...HERO_SUPPORT_IDS]

export function getHeroMetrics(): { lede: MetricEntry[]; support: MetricEntry[] } {
  const byId = new Map(METRICS.map((m) => [m.id, m]))
  const ledeMissing = HERO_LEDE_IDS.filter((id) => !byId.has(id))
  const supportMissing = HERO_SUPPORT_IDS.filter((id) => !byId.has(id))
  if (ledeMissing.length || supportMissing.length) {
    // Catalog drift — the hero references a metric that no longer
    // exists. Surface loudly rather than silently dropping the slot.
    throw new Error(
      `getHeroMetrics: catalog drift — missing IDs: ${[...ledeMissing, ...supportMissing].join(', ')}`,
    )
  }
  return {
    lede: HERO_LEDE_IDS.map((id) => byId.get(id)!),
    support: HERO_SUPPORT_IDS.map((id) => byId.get(id)!),
  }
}

// ---------------------------------------------------------------------------
// Catalog — Engine sheet, row-for-row.
// ---------------------------------------------------------------------------

export const METRICS: MetricEntry[] = [
  // ADVERTISING (rows 2-8). All single-table reads from meta_ad_daily.
  { id: 'adv_total_adspend', section: 'ADVERTISING', title: 'Total Adspend', status: 'live', source: 'Meta', fetcher: 'metaAdspend', format: 'usd' },
  { id: 'adv_frequency', section: 'ADVERTISING', title: 'Frequency', status: 'live', source: 'Meta', fetcher: 'metaFrequency', format: 'decimal' },
  { id: 'adv_impressions', section: 'ADVERTISING', title: 'Total Impressions', status: 'live', source: 'Meta', fetcher: 'metaImpressions', format: 'integer' },
  { id: 'adv_unique_link_clicks', section: 'ADVERTISING', title: 'Unique Link Clicks', status: 'live', source: 'Meta', fetcher: 'metaUniqueLinkClicks', format: 'integer' },
  { id: 'adv_cost_per_impression', section: 'ADVERTISING', title: 'Cost per Impression', status: 'live', source: 'Meta', fetcher: 'metaCostPerImpression', format: 'usd_precise' },
  { id: 'adv_cost_per_uniq_click', section: 'ADVERTISING', title: 'Cost per Unique Link Click', status: 'live', source: 'Meta', fetcher: 'metaCostPerUniqueClick', format: 'usd' },
  { id: 'adv_ctr', section: 'ADVERTISING', title: 'Click Through Rate', status: 'live', source: 'Meta', fetcher: 'metaCtr', format: 'percent_0_100' },

  // CONTENT (rows 9-24). IG + YT analytics not ingested.
  { id: 'con_ig_views', section: 'CONTENT', title: 'IG Views', status: 'not_connected', source: 'IG Analytics' },
  { id: 'con_ig_followers', section: 'CONTENT', title: 'IG Follower Count', status: 'not_connected', source: 'IG Analytics' },
  { id: 'con_ig_followers_gained', section: 'CONTENT', title: 'IG Followers Gained', status: 'not_connected', source: 'IG Analytics' },
  { id: 'con_ig_followers_lost', section: 'CONTENT', title: 'IG Followers Lost', status: 'not_connected', source: 'IG Analytics' },
  { id: 'con_ig_interactions', section: 'CONTENT', title: 'IG Interactions', status: 'not_connected', source: 'IG Analytics' },
  { id: 'con_ig_profile_visits', section: 'CONTENT', title: 'IG Profile Visits', status: 'not_connected', source: 'IG Analytics' },
  { id: 'con_ig_reels_posted', section: 'CONTENT', title: 'IG Reels Posted', status: 'not_connected', source: 'IG Analytics' },
  { id: 'con_ig_posts_posted', section: 'CONTENT', title: 'IG Posts Posted', status: 'not_connected', source: 'IG Analytics' },
  { id: 'con_ig_stories_posted', section: 'CONTENT', title: 'IG Stories Posted', status: 'not_connected', source: 'IG Analytics' },
  { id: 'con_ig_trial_reels_posted', section: 'CONTENT', title: 'IG Trial Reels Posted', status: 'not_connected', source: 'IG Analytics' },
  { id: 'con_yt_impressions', section: 'CONTENT', title: 'YT Impressions', status: 'not_connected', source: 'YT Analytics' },
  { id: 'con_yt_views', section: 'CONTENT', title: 'YT Views', status: 'not_connected', source: 'YT Analytics' },
  { id: 'con_yt_watch_time', section: 'CONTENT', title: 'YT Watch Time', status: 'not_connected', source: 'YT Analytics' },
  { id: 'con_yt_subscribers', section: 'CONTENT', title: 'YT Subscribers', status: 'not_connected', source: 'YT Analytics' },
  { id: 'con_yt_long_posted', section: 'CONTENT', title: 'YT Long-Form Posted', status: 'not_connected', source: 'YT Analytics' },
  { id: 'con_yt_shorts_posted', section: 'CONTENT', title: 'YT Shorts Posted', status: 'not_connected', source: 'YT Analytics' },

  // FUNNELS (rows 25-45).
  { id: 'fun_lp_visits', section: 'FUNNELS', title: 'Landing Page Visits', status: 'live', source: 'Microsoft Clarity', fetcher: 'clarityLpVisits', format: 'integer', note: 'Latest 3-day snapshot (Clarity API constraint)' },
  { id: 'fun_lp_time_avg', section: 'FUNNELS', title: 'Average Time on Landing Page', status: 'live', source: 'Microsoft Clarity', fetcher: 'clarityLpAvgTime', format: 'duration_seconds', note: 'Latest 3-day snapshot' },
  { id: 'fun_vsl_engagement_rate', section: 'FUNNELS', title: 'VSL Engagement Rate', status: 'live', source: 'Wistia', fetcher: 'wistiaVslEngagementRate', format: 'percent_0_1' },
  { id: 'fun_vsl_avg_view_duration', section: 'FUNNELS', title: 'VSL Average View Duration', status: 'live', source: 'Wistia', fetcher: 'wistiaVslAvgViewDuration', format: 'duration_seconds' },
  { id: 'fun_typeform_engagement', section: 'FUNNELS', title: 'Typeform Engagement', status: 'pending', source: 'Typeform' },
  { id: 'fun_typeform_completion_rate', section: 'FUNNELS', title: 'Typeform Completion Rate', status: 'pending', source: 'Typeform' },
  { id: 'fun_typeform_submits', section: 'FUNNELS', title: 'Typeform Submits ("Leads")', status: 'live', source: 'Typeform', fetcher: 'typeformSubmits', format: 'integer', note: 'All active funnels' },
  { id: 'fun_qualified_optins', section: 'FUNNELS', title: 'Qualified Opt-Ins', status: 'pending', source: 'Typeform' },
  { id: 'fun_non_qualified_optins', section: 'FUNNELS', title: 'Non-Qualified Opt-Ins', status: 'pending', source: 'Typeform' },
  { id: 'fun_total_closer_bookings', section: 'FUNNELS', title: 'Total Closer Bookings', status: 'live', source: 'Calendly', fetcher: 'calendlyCloserBookings', format: 'integer' },
  { id: 'fun_closer_booking_next_day', section: 'FUNNELS', title: 'Closer Booking Next Day', status: 'live', source: 'Calendly', fetcher: 'calendlyCloserBookingNextDay', format: 'integer' },
  { id: 'fun_closer_booking_two_days', section: 'FUNNELS', title: 'Closer Booking Two Days Out', status: 'live', source: 'Calendly', fetcher: 'calendlyCloserBookingTwoDays', format: 'integer' },
  { id: 'fun_typ_time_avg', section: 'FUNNELS', title: 'Average Time on Thank-You Page', status: 'live', source: 'Microsoft Clarity', fetcher: 'clarityTypAvgTime', format: 'duration_seconds', note: 'Latest 3-day snapshot' },
  { id: 'fun_typ_engagement_rate', section: 'FUNNELS', title: 'TYP Engagement Rate', status: 'live', source: 'Wistia', fetcher: 'wistiaTypEngagementRate', format: 'percent_0_1' },
  { id: 'fun_typ_avg_view_duration', section: 'FUNNELS', title: 'TYP Average View Duration', status: 'live', source: 'Wistia', fetcher: 'wistiaTypAvgViewDuration', format: 'duration_seconds' },
  { id: 'fun_cost_per_optin', section: 'FUNNELS', title: 'Cost per opt-in / CPL', status: 'pending', source: 'Meta × Typeform' },
  { id: 'fun_cost_per_mql', section: 'FUNNELS', title: 'Cost per MQL', status: 'pending', source: 'Meta × Typeform' },
  { id: 'fun_cost_per_direct_book', section: 'FUNNELS', title: 'Cost per Direct Book', status: 'pending', source: 'Meta × Calendly' },
  { id: 'fun_lp_conversion_rate', section: 'FUNNELS', title: 'LP Conversion Rate', status: 'pending', source: 'Clarity × Typeform' },
  { id: 'fun_link_click_to_mql', section: 'FUNNELS', title: 'Link Click to MQL', status: 'pending', source: 'Meta × Typeform' },
  { id: 'fun_qualified_lead_to_book', section: 'FUNNELS', title: 'Qualified Lead to Direct Book', status: 'pending', source: 'Typeform × Calendly' },

  // APPOINTMENT SETTING (rows 46-92). Most rows depend on Close Smartview
  // semantics that aren't fully reproduced from raw close_calls /
  // close_leads. Default to pending; only the single-table-clean ones
  // go live.
  { id: 'aps_first_msg_responses', section: 'APPOINTMENT SETTING', title: 'First Message Responses', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_total_closer_triages', section: 'APPOINTMENT SETTING', title: 'Total Closer Triages', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_closer_triages_next_day', section: 'APPOINTMENT SETTING', title: 'Closer Triages for Next Day Calls', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_closer_triages_two_days', section: 'APPOINTMENT SETTING', title: 'Closer Triages for Two Days Out', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_avg_time_to_closer_dial', section: 'APPOINTMENT SETTING', title: 'Average Time to Closer Dial', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_avg_closer_triage_duration', section: 'APPOINTMENT SETTING', title: 'Average Closer Triage Call Duration', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_closer_dqs', section: 'APPOINTMENT SETTING', title: 'Closer DQs after Triage', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_closer_triage_downsells', section: 'APPOINTMENT SETTING', title: 'Closer Triage Downsells', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_closer_confirmed_meetings', section: 'APPOINTMENT SETTING', title: 'Closer Confirmed Meetings', status: 'live', source: 'Airtable (setter triage)', fetcher: 'airtableCloserConfirmedMeetings', format: 'integer', note: 'By Airtable record-create time' },
  { id: 'aps_hand_downs', section: 'APPOINTMENT SETTING', title: 'Hand Downs', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_total_setter_triages', section: 'APPOINTMENT SETTING', title: 'Total Setter Triages', status: 'live', source: 'Airtable (setter triage)', fetcher: 'airtableTotalSetterTriages', format: 'integer', note: 'By Airtable record-create time' },
  { id: 'aps_setter_triages_fresh', section: 'APPOINTMENT SETTING', title: 'Setter Triages from fresh opt-ins (<3 days)', status: 'pending', source: 'Airtable × Typeform' },
  { id: 'aps_setter_triages_old', section: 'APPOINTMENT SETTING', title: 'Setter Triages from old opt-ins (>3 days)', status: 'pending', source: 'Airtable × Typeform' },
  { id: 'aps_setter_triages_handdowns', section: 'APPOINTMENT SETTING', title: 'Setter Triages from hand downs', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_total_setter_meetings', section: 'APPOINTMENT SETTING', title: 'Total Setter Meetings', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_setter_meetings_fresh', section: 'APPOINTMENT SETTING', title: 'Setter Meetings from fresh opt-ins', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_setter_meetings_old', section: 'APPOINTMENT SETTING', title: 'Setter Meetings from old opt-ins', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_setter_meetings_handdowns', section: 'APPOINTMENT SETTING', title: 'Setter Meetings from hand downs', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_hand_offs_completed', section: 'APPOINTMENT SETTING', title: 'Hand Offs Completed', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_setter_dials_fresh', section: 'APPOINTMENT SETTING', title: 'Setter Dials to fresh opt-ins', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_setter_dials_old', section: 'APPOINTMENT SETTING', title: 'Setter Dials to old opt-ins', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_setter_dials_noshows', section: 'APPOINTMENT SETTING', title: 'Setter Dials to No Shows', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_setter_dials_handdowns', section: 'APPOINTMENT SETTING', title: 'Setter Dials to hand downs', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_avg_time_to_setter_dial', section: 'APPOINTMENT SETTING', title: 'Average time to setter dial', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_avg_setter_triage_duration', section: 'APPOINTMENT SETTING', title: 'Average setter triage duration', status: 'pending', source: 'Airtable (no duration field)' },
  { id: 'aps_setter_dqs', section: 'APPOINTMENT SETTING', title: 'Setter DQs after Triage', status: 'live', source: 'Airtable (setter triage)', fetcher: 'airtableSetterDqs', format: 'integer', note: 'By Airtable record-create time' },
  { id: 'aps_setter_triage_downsells', section: 'APPOINTMENT SETTING', title: 'Setter Triage Downsells', status: 'live', source: 'Airtable (setter triage)', fetcher: 'airtableSetterDownsells', format: 'integer', note: 'By Airtable record-create time' },
  { id: 'aps_total_dials', section: 'APPOINTMENT SETTING', title: 'Total Dials', status: 'live', source: 'Close calls', fetcher: 'closeTotalDials', format: 'integer' },
  { id: 'aps_total_triage_dqs', section: 'APPOINTMENT SETTING', title: 'Total Triage DQs', status: 'pending', source: 'Close + Airtable' },
  { id: 'aps_total_triage_downsells', section: 'APPOINTMENT SETTING', title: 'Total Triage Downsells', status: 'pending', source: 'Close + Airtable' },
  { id: 'aps_total_booked_meetings', section: 'APPOINTMENT SETTING', title: 'Total Booked Meetings', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_tier1_booked', section: 'APPOINTMENT SETTING', title: 'Tier 1 Booked Meetings', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_tier2_booked', section: 'APPOINTMENT SETTING', title: 'Tier 2 Booked Meetings', status: 'pending', source: 'Close Smartviews' },
  { id: 'aps_gamma_avg_time', section: 'APPOINTMENT SETTING', title: 'Pre-Call Gamma Average Time Spent', status: 'not_connected', source: 'Gamma' },
  { id: 'aps_hand_down_rate', section: 'APPOINTMENT SETTING', title: 'Hand Down Rate', status: 'pending', source: 'Derived' },
  { id: 'aps_hand_off_completion_rate', section: 'APPOINTMENT SETTING', title: 'Hand Off Completion Rate', status: 'pending', source: 'Derived' },
  { id: 'aps_dq_rate', section: 'APPOINTMENT SETTING', title: 'DQ Rate', status: 'pending', source: 'Derived' },
  { id: 'aps_downsell_rate', section: 'APPOINTMENT SETTING', title: 'Downsell Rate', status: 'pending', source: 'Derived' },
  { id: 'aps_cost_per_downsell', section: 'APPOINTMENT SETTING', title: 'Cost per Downsell', status: 'pending', source: 'Meta × Airtable' },
  { id: 'aps_first_msg_response_rate', section: 'APPOINTMENT SETTING', title: 'First Message Response Rate', status: 'pending', source: 'Derived' },
  { id: 'aps_triage_rate', section: 'APPOINTMENT SETTING', title: 'Triage Rate', status: 'pending', source: 'Derived' },
  { id: 'aps_cost_per_first_msg_response', section: 'APPOINTMENT SETTING', title: 'Cost per First Message Response', status: 'pending', source: 'Meta × Close' },
  { id: 'aps_cost_per_triage', section: 'APPOINTMENT SETTING', title: 'Cost per Triage', status: 'pending', source: 'Meta × Airtable' },
  { id: 'aps_convo_to_book_rate', section: 'APPOINTMENT SETTING', title: 'Conversation to Book Rate', status: 'pending', source: 'Derived' },
  { id: 'aps_cost_per_booked_meeting', section: 'APPOINTMENT SETTING', title: 'Cost Per Booked Meeting', status: 'pending', source: 'Meta × Calendly' },
  { id: 'aps_meeting_rate', section: 'APPOINTMENT SETTING', title: 'Meeting Rate', status: 'pending', source: 'Derived' },
  { id: 'aps_direct_book_to_meeting', section: 'APPOINTMENT SETTING', title: 'Direct Booking to Meeting', status: 'pending', source: 'Derived' },

  // CLOSING (rows 93-122).
  { id: 'cls_new_scheduled', section: 'CLOSING', title: 'New Scheduled Meetings', status: 'live', source: 'Calendly', fetcher: 'calendlyNewScheduled', format: 'integer' },
  { id: 'cls_new_rescheduled', section: 'CLOSING', title: 'New Rescheduled Meetings', status: 'live', source: 'Calendly', fetcher: 'calendlyNewRescheduled', format: 'integer' },
  { id: 'cls_follow_up_meetings', section: 'CLOSING', title: 'Follow Up Meetings', status: 'pending', source: 'Calendly (event-type unmapped)' },
  { id: 'cls_showed', section: 'CLOSING', title: 'Showed Meetings (new meetings)', status: 'live', source: 'Airtable (closer EOC)', fetcher: 'airtableShowed', format: 'integer' },
  { id: 'cls_ccmi', section: 'CLOSING', title: 'CCMI (new meetings)', status: 'pending', source: 'Airtable (semantic unclear)' },
  { id: 'cls_no_shows', section: 'CLOSING', title: 'No Shows / Ghosts (new meetings)', status: 'live', source: 'Airtable (closer EOC)', fetcher: 'airtableNoShows', format: 'integer' },
  { id: 'cls_reschedules', section: 'CLOSING', title: 'Reschedules (new meetings)', status: 'live', source: 'Airtable (closer EOC)', fetcher: 'airtableReschedules', format: 'integer' },
  { id: 'cls_cancelled', section: 'CLOSING', title: 'Cancelled Meetings (new meetings)', status: 'live', source: 'Airtable (closer EOC)', fetcher: 'airtableCancelled', format: 'integer' },
  { id: 'cls_obj_shopping', section: 'CLOSING', title: 'Shopping Around Objections', status: 'pending', source: 'Airtable (no structured field)' },
  { id: 'cls_obj_think_fear', section: 'CLOSING', title: 'Think About It / Fear Objections', status: 'pending', source: 'Airtable (no structured field)' },
  { id: 'cls_obj_spouse', section: 'CLOSING', title: 'Spouse Objections', status: 'pending', source: 'Airtable (no structured field)' },
  { id: 'cls_follow_up_looms', section: 'CLOSING', title: 'Follow Up Looms Sent', status: 'pending', source: 'Close Smartviews' },
  { id: 'cls_avg_meeting_duration', section: 'CLOSING', title: 'Average Meeting Duration', status: 'live', source: 'Fathom (calls)', fetcher: 'fathomAvgMeetingDuration', format: 'duration_seconds' },
  { id: 'cls_total_deposits', section: 'CLOSING', title: 'Total Deposits', status: 'pending', source: 'Airtable (count vs sum ambiguous)' },
  { id: 'cls_closed_new', section: 'CLOSING', title: 'Closed Deals - New Meetings', status: 'live', source: 'Airtable (closer EOC)', fetcher: 'airtableClosedNew', format: 'integer' },
  { id: 'cls_closed_followup', section: 'CLOSING', title: 'Closed Deals - Follow Up Meetings', status: 'live', source: 'Airtable (closer EOC)', fetcher: 'airtableClosedFollowUp', format: 'integer' },
  { id: 'cls_closed_direct_led', section: 'CLOSING', title: 'Closed Deals - Direct Booking Led', status: 'pending', source: 'Airtable (is_setter_led provisional)' },
  { id: 'cls_closed_setter_led', section: 'CLOSING', title: 'Closed Deals - Setter Led', status: 'pending', source: 'Airtable (is_setter_led provisional)' },
  { id: 'cls_closed_total', section: 'CLOSING', title: 'Total Closed Deals', status: 'live', source: 'Airtable (closer EOC)', fetcher: 'airtableClosedTotal', format: 'integer' },
  { id: 'cls_cash_deposits', section: 'CLOSING', title: 'Cash Collected - Deposits', status: 'pending', source: 'Airtable (cash field ambiguous)' },
  { id: 'cls_cash_new', section: 'CLOSING', title: 'Cash Collected - New Calls', status: 'pending', source: 'Airtable (cash field ambiguous)' },
  { id: 'cls_cash_followup', section: 'CLOSING', title: 'Cash Collected - Follow Up Calls', status: 'pending', source: 'Airtable (cash field ambiguous)' },
  { id: 'cls_cash_direct_led', section: 'CLOSING', title: 'Cash Collected - Direct Booking Led', status: 'pending', source: 'Airtable (cash + is_setter_led)' },
  { id: 'cls_cash_setter_led', section: 'CLOSING', title: 'Cash Collected - Setter Led', status: 'pending', source: 'Airtable (cash + is_setter_led)' },
  { id: 'cls_total_cash', section: 'CLOSING', title: 'Total Cash Collected', status: 'pending', source: 'Derived' },
  { id: 'cls_total_contracted', section: 'CLOSING', title: 'Total Contracted Revenue', status: 'pending', source: 'Derived' },
  { id: 'cls_show_rate_new', section: 'CLOSING', title: 'Show Rate on New Calls', status: 'pending', source: 'Derived' },
  { id: 'cls_one_call_close_rate', section: 'CLOSING', title: 'One-Call Close Rate', status: 'pending', source: 'Derived' },
  { id: 'cls_overall_close_rate', section: 'CLOSING', title: 'Overall Close Rate', status: 'pending', source: 'Derived' },
  { id: 'cls_aov', section: 'CLOSING', title: 'AOV', status: 'pending', source: 'Derived' },

  // SALES DATA (rows 123-130). All derived ratios.
  { id: 'sd_downsell_roas', section: 'SALES DATA', title: 'Downsell ROAS', status: 'pending', source: 'Derived' },
  { id: 'sd_one_call_cash_roas', section: 'SALES DATA', title: 'One-Call Cash ROAS', status: 'pending', source: 'Derived' },
  { id: 'sd_overall_cash_roas', section: 'SALES DATA', title: 'Overall Cash ROAS', status: 'pending', source: 'Derived' },
  { id: 'sd_overall_revenue_roas', section: 'SALES DATA', title: 'Overall Revenue ROAS', status: 'pending', source: 'Derived' },
  { id: 'sd_cash_per_booked_meeting', section: 'SALES DATA', title: 'Cash Per Booked Meeting', status: 'pending', source: 'Derived' },
  { id: 'sd_cost_per_showed', section: 'SALES DATA', title: 'Cost Per Showed Meeting', status: 'pending', source: 'Derived' },
  { id: 'sd_cost_per_sale', section: 'SALES DATA', title: 'Cost Per Sale', status: 'pending', source: 'Derived' },
  { id: 'sd_lead_to_close_rate', section: 'SALES DATA', title: 'Lead to Close Rate', status: 'pending', source: 'Derived' },

  // BACK END REV (rows 131-139). None of these upstream sources are ingested.
  { id: 'br_ghl_cash', section: 'BACK END REV', title: 'GoHighLevel Cash', status: 'not_connected', source: 'GoHighLevel' },
  { id: 'br_wix_cash', section: 'BACK END REV', title: 'Wix Cash', status: 'not_connected', source: 'Wix' },
  { id: 'br_base44_cash', section: 'BACK END REV', title: 'Base44 Cash', status: 'not_connected', source: 'Base44' },
  { id: 'br_llc_cash', section: 'BACK END REV', title: 'LLC Cash', status: 'not_connected', source: 'Manual' },
  { id: 'br_instantly_cash', section: 'BACK END REV', title: 'Instantly Cash', status: 'not_connected', source: 'Instantly' },
  { id: 'br_payplan_cash', section: 'BACK END REV', title: 'Payplan Cash', status: 'not_connected', source: 'Manual' },
  { id: 'br_upsell_cash', section: 'BACK END REV', title: 'Upsell Cash', status: 'not_connected', source: 'Manual' },
  { id: 'br_referral_cash', section: 'BACK END REV', title: 'Referral Cash', status: 'not_connected', source: 'Manual' },
  { id: 'br_client_sales_5pct', section: 'BACK END REV', title: 'Client Sales (5%)', status: 'not_connected', source: 'Manual' },

  // BUSINESS COSTS (rows 140-145). No category-tagged cost ingestion today.
  { id: 'bc_closer_costs', section: 'BUSINESS COSTS', title: 'Closer Costs', status: 'not_connected', source: 'Manual' },
  { id: 'bc_setter_costs', section: 'BUSINESS COSTS', title: 'Setter Costs', status: 'not_connected', source: 'Manual' },
  { id: 'bc_mgmt_costs', section: 'BUSINESS COSTS', title: 'Mgmt Costs', status: 'not_connected', source: 'Manual' },
  { id: 'bc_fulfillment_costs', section: 'BUSINESS COSTS', title: 'Fulfillment Costs', status: 'not_connected', source: 'Manual' },
  { id: 'bc_software_costs', section: 'BUSINESS COSTS', title: 'Software Costs', status: 'not_connected', source: 'Cost Hub (untagged)' },
  { id: 'bc_other_costs', section: 'BUSINESS COSTS', title: 'Other Costs', status: 'not_connected', source: 'Manual' },

  // FULFILLMENT (rows 149-152).
  { id: 'ful_calls_held', section: 'FULFILLMENT', title: 'Calls Held', status: 'live', source: 'Fathom (calls)', fetcher: 'fathomClientCallsHeld', format: 'integer' },
  { id: 'ful_trustpilots', section: 'FULFILLMENT', title: 'TrustPilots Generated', status: 'not_connected', source: 'TrustPilot' },
  { id: 'ful_pos_sentiment', section: 'FULFILLMENT', title: 'Positive Sentiment Call', status: 'pending', source: 'Call reviewer sentiment classifier' },
  { id: 'ful_neg_sentiment', section: 'FULFILLMENT', title: 'Negative Sentiment Call', status: 'pending', source: 'Call reviewer sentiment classifier' },
]

// ---------------------------------------------------------------------------
// Formatter (pure — safe on either side of the server/client boundary)
// ---------------------------------------------------------------------------

// Infer a sensible format from a metric title when the catalog doesn't
// declare one (pending metrics). Used by the card layer to keep mock
// values readable and as a graceful fallback in any future state where
// a metric ships before its format is finalized.
export function inferredFormat(title: string): MetricFormat {
  const t = title.toLowerCase()
  if (/(cash collected|total cash|contracted revenue|revenue|gross sales)/.test(t)) return 'usd'
  if (/\b(aov|average order|per order|per deal|per appointment|cost per|cost-per)\b/.test(t)) return 'usd'
  if (/(spend|cpm|cpc|cpl|adspend|ad spend)/.test(t)) return 'usd'
  if (/(rate|ratio|share|%|percentage|conversion)/.test(t)) return 'percent_0_100'
  if (/(duration|time watched|engagement time|avg.*time|active time)/.test(t)) return 'duration_seconds'
  if (/(roas|multiple|score|index)/.test(t)) return 'decimal'
  return 'integer'
}

export function formatMetricValue(value: number | null, format: MetricFormat | undefined): string {
  if (value === null || value === undefined) return '—'
  if (!Number.isFinite(value)) return '—'
  switch (format) {
    case 'integer':
      return Math.round(value).toLocaleString('en-US')
    case 'decimal':
      return value.toLocaleString('en-US', { maximumFractionDigits: 2 })
    case 'usd':
      return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 })
    case 'usd_precise':
      return value.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 4, maximumFractionDigits: 4 })
    case 'percent_0_100':
      return `${value.toFixed(2)}%`
    case 'percent_0_1':
      return `${(value * 100).toFixed(2)}%`
    case 'duration_seconds':
      return formatSeconds(value)
    default:
      return String(value)
  }
}

function formatSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`
  const totalSec = Math.round(seconds)
  const mins = Math.floor(totalSec / 60)
  const secs = totalSec % 60
  if (mins < 60) return `${mins}m ${secs}s`
  const hours = Math.floor(mins / 60)
  const remMins = mins % 60
  return `${hours}h ${remMins}m`
}
