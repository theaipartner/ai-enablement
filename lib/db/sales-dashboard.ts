import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

// Data layer for /sales-dashboard (admin-tier).
//
// Reads DIRECTLY from the seven ingested mirror tables — no aggregation
// layer, no views. The metric catalog below mirrors the Engine sheet
// (`Data Sheet - Overall Engine.csv` at repo root) row-for-row across
// its 9 sections. Each catalog entry declares one of three states:
//
//   - 'live'          — single-source query against one mirror table
//                       (or one source's tables, e.g. Calendly events +
//                       invitees). Fetcher key resolves to a function
//                       in the FETCHERS map below; the result populates
//                       `value` at render time.
//   - 'pending'       — needs a cross-source join, a derived ratio, or
//                       hits a flagged ambiguity from the schema docs.
//                       No fetcher; renders as a "pending" placeholder.
//   - 'not_connected' — the upstream source (IG / YT / GHL / Wix / Gamma
//                       / TrustPilot etc.) is not ingested. Renders as
//                       a "source not connected" placeholder.
//
// All windows are last-7-days rolling, UTC-anchored. The 5-hour
// EST-vs-UTC drift on the window's lower boundary is ~0.7% of the
// span — within the tolerance for an admin overview. Clarity is the
// one special case (latest snapshot = trailing 3 days per the API's
// constraint); marked in the card subtitle.

// ---------------------------------------------------------------------------
// Canonical source ids — pulled from the existing source-of-truth modules.
// Keeping them as local constants avoids a stack-crossing import (the
// dashboard data layer is TS; CLOSER_EVENT_TYPE_NAMES lives in Python).
// Any change to the source-of-truth list there should be mirrored here.
// ---------------------------------------------------------------------------

// Calendly closer-event names (case-insensitive). Source of truth:
// ingestion/calendly/__init__.py `CLOSER_EVENT_TYPE_NAMES`.
const CLOSER_EVENT_NAMES_LOWER = ['ai partner strategy call']

// Typeform: NO form-id filter. The Setter Funnel (`PWSNd0h2`) went
// dormant; `SFedWelr` is the active funnel today. Hardcoding either
// would go stale as funnels rotate. The Engine row "Typeform Submits
// ('Leads')" is best read as total opt-ins across all active funnels.

// Wistia canonical media ids. Source of truth: docs/schema/wistia_medias.md.
const VSL_HASHED_IDS = ['i1173gx76b', 'nbump1crwb']
const TYP_HASHED_ID = 'fbgjxwe62y'

// Clarity canonical paths. Source of truth: ingestion/clarity/__init__.py.
const CLARITY_LANDING_PAGE_PATH = '/lp'
const CLARITY_THANK_YOU_PAGE_PATH = '/confirmation'

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

export type MetricEntry = {
  id: string
  section: SectionId
  title: string
  status: MetricStatus
  // Source label echoes the Engine sheet's "Source" column. Shown
  // muted under each card so Nabeel can see provenance at a glance.
  source: string
  // Only set when status === 'live'. Indexes into FETCHERS below.
  fetcher?: string
  // Display format for the LIVE value. Only consulted when status === 'live'.
  format?: MetricFormat
  // Optional per-card caveat shown beneath the value (Clarity rolling
  // 3-day, is_setter_led provisional, etc.).
  note?: string
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

export const DASHBOARD_WINDOW_LABEL = 'Last 7 days · rolling'

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

export type FetchResult =
  | { state: 'live'; value: number | null }
  | { state: 'live_error'; message: string }
  | { state: 'pending' }
  | { state: 'not_connected' }

// Runs all LIVE fetchers in parallel. Each fetcher's error is caught
// per-card so one bad query doesn't take the whole page down — failing
// cards render as a small "error" state with the message in a tooltip.
export async function fetchSalesDashboardData(): Promise<Record<string, FetchResult>> {
  const liveMetrics = METRICS.filter((m) => m.status === 'live' && m.fetcher)
  const results = await Promise.all(
    liveMetrics.map(async (m): Promise<[string, FetchResult]> => {
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

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

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
