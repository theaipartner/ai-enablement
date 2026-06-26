// Landing-page registry — the single source of truth for which landing
// pages the sales dashboard knows about and what assets each one owns.
//
// One entry per landing page. Each entry composes the low-level
// asset-lock constants (funnel-assets.ts) into a page-shaped record the
// LP detail page + the funnel-page landing-page dropdown both read.
//
// ⚠️ Adding a landing page is (almost) just a new entry here: a label,
// the Typeform form_id (the lead-attribution key), the VSL hashed_id(s),
// and the thank-you/confirmation video hashed_id. ALSO add the form to
// the lead tagger's OPT_IN_FORMS (shared/lead_tagging.py) + funnel-assets'
// HIGH_TICKET_TYPEFORM_FORM_IDS so its opt-ins enter lead_cycles and the
// aggregate funnel. The LP detail page (VSL / thank-you / Typeform stats)
// is driven entirely by this entry. NOTE: the lead tagger merges all
// OPT_IN_FORMS into one combined cohort — lead_cycles does NOT yet record
// which form/LP each cycle came from, so the funnel BOXES are combined
// across LPs (the LP dropdown scopes the ads/LP/VSL/Typeform summary, not
// the cohort boxes). Per-LP box filtering would need a source_form_id on
// lead_cycles. See docs/sales/data-model.md § The lead definition.

import {
  HIGH_TICKET_TYPEFORM_FORM_ID,
  HIGH_TICKET_VSL_HASHED_IDS,
  HIGH_TICKET_CONFIRM_VIDEO_HASHED_ID,
} from './funnel-assets'

// The /training LP (live 2026-06-20): its own VSL + Typeform, same high-ticket
// funnel. VSL "6/20 | New Vsl | Call Funnel" (t05pq6ra0u) — confirmed via the
// Wistia embed_url join.theaipartner.io/training. Reuses the shared confirm
// video. Its form Os4c0q6V is in the asset lock + the lead tagger.
const TRAINING_VSL_HASHED_ID = 't05pq6ra0u'
const TRAINING_TYPEFORM_FORM_ID = 'Os4c0q6V'

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
  t05pq6ra0u: '6/20 · New VSL · Call Funnel',
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
  {
    slug: 'training',
    label: 'Training LP · /training',
    lpPath: '/training',
    typeformFormId: TRAINING_TYPEFORM_FORM_ID,
    typeformLabel: '6/20 Longer Form · Call Funnel',
    vsl: [{ hashedId: TRAINING_VSL_HASHED_ID, label: HT_VSL_LABELS[TRAINING_VSL_HASHED_ID] }],
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
