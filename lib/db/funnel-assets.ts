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

// Typeform: the high-ticket Closer Funnel application forms. The funnel now
// spans more than one landing page, each with its own form, all high-ticket:
//   - SFedWelr  — "US TF Funnel -> CF (go.theaipartner.io/lp)" — the original LP.
//   - Os4c0q6V  — "6/20 | Longer Form | Call Funnel" — the /training LP (live
//                 2026-06-20). Same qualification question/field ref (5138f17b).
// The Setter Funnel (PWSNd0h2), YouTube (vYPmrq5V), and any non-high-ticket
// (e.g. Digital College) form remain deliberately excluded.
export const HIGH_TICKET_TYPEFORM_FORM_IDS = ['SFedWelr', 'Os4c0q6V'] as const

// The PRIMARY form. Used where a single id is required — the LP registry's
// original "main" entry and the Typeform Insights snapshots (which exist only
// for this form). Aggregate reads should use HIGH_TICKET_TYPEFORM_FORM_IDS.
export const HIGH_TICKET_TYPEFORM_FORM_ID = HIGH_TICKET_TYPEFORM_FORM_IDS[0]

// True iff the form_id is one of the locked high-ticket Typeform forms.
export function isHighTicketForm(formId: string | null | undefined): boolean {
  return (
    formId != null &&
    (HIGH_TICKET_TYPEFORM_FORM_IDS as readonly string[]).includes(formId)
  )
}

// Wistia: the LP VSL for the high-ticket funnel.
//   i1173gx76b — "VSL Vídeo Motion - Nabeel (Horizontal) Direct Closer Funnel"
// The "Horizontal v2" variant (nbump1crwb) was removed 2026-06-16 — its
// A/B test had concluded (traffic had dropped to a trickle) and the new
// per-landing-page setup doesn't need an in-page variant toggle.
export const HIGH_TICKET_VSL_HASHED_IDS = ['i1173gx76b'] as const

// The primary VSL for single-video surfaces (the LP detail page default).
export const HIGH_TICKET_PRIMARY_VSL_HASHED_ID = HIGH_TICKET_VSL_HASHED_IDS[0]

// Wistia: the confirmation / thank-you-page video. Wistia name
// "V2 precall shortened". Updated 2026-06-16 from the prior
// "3 - Nabeel - Confirm Video" (fbgjxwe62y). The same video may be
// embedded on more than one landing page — Wistia reports per-embed,
// so per-LP breakouts come from the embed dimension, not a new id.
export const HIGH_TICKET_CONFIRM_VIDEO_HASHED_ID = '4v9rok4kct'

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
