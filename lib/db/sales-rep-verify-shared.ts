// Shared (server + client) types + pure helpers for the sales-rep verify page.
//
// The companion module `lib/db/sales-rep-verify.ts` is `server-only` (it imports
// the service-role admin client). The verify-page Client Component needs the
// types + the role-default helper but can't import the server-only module
// without pulling it into the browser bundle — so the pure pieces live here,
// mirroring `lib/auth/access-tier-shared.ts`.

export type SalesRole = 'setter' | 'closer' | 'dc_closer'

export type RepCandidate = {
  airtableRecordId: string
  fullName: string | null
  jobTitle: string | null
  airtableCreatedAt: string | null
  // Draft / in-progress verification state (null = untouched candidate).
  status: 'draft' | null
  draft: {
    fullName: string | null
    salesRole: SalesRole | null
    email: string | null
    closeUserId: string | null
    calendlyEventTypeUri: string | null
    updatedBy: string | null
    updatedAt: string | null
  } | null
}

export type CloseUserOption = {
  closeUserId: string
  email: string | null
  fullName: string | null
}

// Map an Airtable Job Title to a default sales_role guess. Only Closer / Setter
// map cleanly; Sales Manager / CSM / anything else → no default (admin picks).
export function defaultSalesRoleFromJobTitle(
  jobTitle: string | null,
): SalesRole | null {
  const t = (jobTitle ?? '').trim().toLowerCase()
  if (t === 'closer') return 'closer'
  if (t === 'setter') return 'setter'
  return null
}
