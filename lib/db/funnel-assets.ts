// High-ticket (AI Partner) funnel asset lock — single source of truth.
//
// These IDs define WHICH Wistia videos and WHICH Typeform form the
// high-ticket funnel surfaces are allowed to read. Ingestion stays wide
// open: the cron pipelines mirror every funnel's assets account-wide per
// the source-of-truth principle (a new funnel's LP / VSL / form lands in
// Supabase automatically — e.g. the Digital College / Base44 low-ticket
// funnel's `/base44` LP and "Base 44_VSL_v1" video already flow into the
// mirror tables today). These constants are the READ-SIDE lock that keeps
// any other funnel's rows from muddying high-ticket numbers.
//
// ⚠️ Adding a new funnel? Give it its OWN asset set (a sibling module) and
// its OWN surfaces. NEVER widen these to "all", and never add a
// non-high-ticket id here — that's exactly the cross-funnel contamination
// this lock exists to prevent.

// Typeform: the high-ticket Closer Funnel application form
// ("US TF Funnel -> CF (go.theaipartner.io/lp) -> Closer Funnel").
// The Setter Funnel (PWSNd0h2), YouTube (vYPmrq5V), and any future
// (e.g. Digital College) form are deliberately excluded.
export const HIGH_TICKET_TYPEFORM_FORM_ID = 'SFedWelr'

// Wistia: the LP VSL variants in rotation for the high-ticket funnel.
//   i1173gx76b — "VSL Vídeo Motion - Nabeel (Horizontal) Direct Closer Funnel"
//   nbump1crwb — "VSL Vídeo Motion - Nabeel (Horizontal) v2"
export const HIGH_TICKET_VSL_HASHED_IDS = ['i1173gx76b', 'nbump1crwb'] as const

// The primary VSL for single-video surfaces (the LP detail page default).
export const HIGH_TICKET_PRIMARY_VSL_HASHED_ID = HIGH_TICKET_VSL_HASHED_IDS[0]

// Wistia: the confirmation / thank-you-page video ("3 - Nabeel - Confirm Video").
export const HIGH_TICKET_CONFIRM_VIDEO_HASHED_ID = 'fbgjxwe62y'

// True iff the hashed_id is one of the locked high-ticket VSL videos.
// Use to clamp any caller-supplied id (stale link, another funnel) back to
// the locked set before it reaches a Wistia read.
export function isHighTicketVsl(hashedId: string | null | undefined): boolean {
  return (
    hashedId != null &&
    (HIGH_TICKET_VSL_HASHED_IDS as readonly string[]).includes(hashedId)
  )
}

// Meta ad-campaign funnel token. High-ticket campaigns are named
// `... | Booking | Closer Funnel` (cortana_campaign_daily.entity_name).
// Adspend is locked by summing ONLY campaigns matching this token, so a new
// funnel's campaigns (carrying their own token) never inflate high-ticket
// spend. Matched case-insensitively as a substring so `Closer Funnel (Copy)`
// also counts. The retired "Call Funnel" high-ticket name is intentionally
// not matched — those days predate the per-campaign mirror and fall back to
// the account total anyway (see funnel-ads.ts loadMetaRows).
export const HIGH_TICKET_AD_CAMPAIGN_TOKEN = 'closer funnel'

export function isHighTicketCampaign(campaignName: string | null | undefined): boolean {
  return (
    campaignName != null &&
    campaignName.toLowerCase().includes(HIGH_TICKET_AD_CAMPAIGN_TOKEN)
  )
}
