// Landing-page registry — the single source of truth for which landing
// pages the sales dashboard knows about and what assets each one owns.
//
// One entry per landing page. Each entry composes the low-level
// asset-lock constants (funnel-assets.ts) into a page-shaped record the
// LP detail page + the funnel-page landing-page dropdown both read.
//
// ⚠️ Adding a landing page is (almost) just a new entry here: a label,
// the Typeform form_id (the lead-attribution key), the VSL hashed_id(s),
// and the thank-you/confirmation video hashed_id. The ONE extra step —
// the part that makes the funnel BOXES re-scope to that LP — is teaching
// the lead tagger to ingest the new form and stamp each lead_cycle with
// its source form_id. Until that lands, a new entry shows correct VSL /
// thank-you / Typeform stats on its detail page, but the funnel boxes
// can't yet filter to it. See docs/sales/data-model.md § The lead
// definition (the cohort is currently form-gated on a single form).

import {
  HIGH_TICKET_TYPEFORM_FORM_ID,
  HIGH_TICKET_VSL_HASHED_IDS,
  HIGH_TICKET_CONFIRM_VIDEO_HASHED_ID,
} from './funnel-assets'

export type LandingPageVsl = { hashedId: string; label: string }

export type LandingPage = {
  // URL param value (?lp=<slug>) + stable key. kebab-case.
  slug: string
  // Shown in the dropdown and the detail-page eyebrow.
  label: string
  // Canonical LP url path — reference / labeling only (the stats come
  // from Wistia + Typeform, not the path).
  lpPath: string
  // Typeform form_id — the lead-attribution key for this LP.
  typeformFormId: string
  // Short human name for the Typeform section subtitle.
  typeformLabel: string
  // VSL variant(s) embedded on this LP.
  vsl: LandingPageVsl[]
  // Thank-you / confirmation-page video.
  confirmVideoHashedId: string
  confirmVideoLabel: string
}

// Display labels for the high-ticket VSL(s).
const HT_VSL_LABELS: Record<string, string> = {
  i1173gx76b: 'Vídeo Motion · Nabeel (Horizontal) · Direct Closer Funnel',
}

export const LANDING_PAGES: LandingPage[] = [
  {
    slug: 'main',
    label: 'Main LP · /lp-vsl',
    lpPath: '/lp-vsl',
    typeformFormId: HIGH_TICKET_TYPEFORM_FORM_ID,
    typeformLabel: 'SFedWelr coaching application',
    vsl: HIGH_TICKET_VSL_HASHED_IDS.map((hashedId) => ({
      hashedId,
      label: HT_VSL_LABELS[hashedId] ?? 'VSL',
    })),
    confirmVideoHashedId: HIGH_TICKET_CONFIRM_VIDEO_HASHED_ID,
    confirmVideoLabel: 'V2 precall shortened',
  },
]

export const DEFAULT_LANDING_PAGE_SLUG = LANDING_PAGES[0].slug

// Resolve a ?lp= slug to its entry, falling back to the default LP for
// an unknown / missing slug (stale link, hand-edited URL).
export function getLandingPage(slug?: string | string[] | null): LandingPage {
  const s = Array.isArray(slug) ? slug[0] : slug
  return LANDING_PAGES.find((p) => p.slug === s) ?? LANDING_PAGES[0]
}
