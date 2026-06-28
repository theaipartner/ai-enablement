// Shared (server + client) types for landing pages + the admin manager.
//
// The data modules `landing-pages.ts` and `landing-page-assets.ts` are
// `server-only` (they import the service-role admin client). The admin manager
// is a Client Component and can't import those without pulling the server bundle
// into the browser — so the pure types live here (same pattern as
// lib/auth/access-tier-shared.ts). The server modules re-export these.

export type LandingPageVsl = { hashedId: string; label: string }

export type LandingPageForm = {
  formId: string
  typeformTitle: string | null
  qualifyFieldRef: string | null
  qualifyAnswers: string[]
  isPrimary: boolean
}

export type LandingPage = {
  slug: string
  label: string
  lpPath: string
  lpUrl: string
  typeformFormId: string
  forms: LandingPageForm[]
  typeformLabel: string
  vsl: LandingPageVsl[]
  confirmVideoHashedId: string
  confirmVideoLabel: string
  active: boolean
  sortOrder: number
}

export type WistiaVideoOption = { hashedId: string; name: string }
export type TypeformOption = { formId: string; title: string }
export type TypeformFieldChoice = { label: string }
export type TypeformField = {
  ref: string
  title: string
  type: string
  choices: TypeformFieldChoice[]
}

export type LpDiscovery = {
  ok: boolean
  error?: string
  vslCandidates: WistiaVideoOption[]
  typeformGuessId: string | null
}
