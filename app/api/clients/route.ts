import { NextResponse, type NextRequest } from 'next/server'

import { bearerOk } from '@/lib/api/bearer-auth'
import { getClientByEmail } from '@/lib/db/clients'

// Read-only client-lookup API for Zane.
//
//   GET /api/clients?email=<address>
//   Authorization: Bearer <CLIENT_LOOKUP_API_KEY>
//
// Resolves an email to the full client record we hold (every column on
// the clients row). Matches the primary email first, then the client's
// metadata.alternate_emails — same identity surface the rest of the
// system uses. Archived clients are excluded.
//
// Scoped on purpose: a single narrow read guarded by its own bearer key
// (rotate by changing the env var) — NOT a Supabase credential. The key
// only unlocks this endpoint.
//
// Runbook: docs/runbooks/client_lookup_api.md.

export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const expected = process.env.CLIENT_LOOKUP_API_KEY
  if (!expected) {
    // Missing env var is our deploy bug, not the caller's — fail loud.
    return NextResponse.json({ error: 'server_misconfigured' }, { status: 500 })
  }
  if (!bearerOk(req, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const email = req.nextUrl.searchParams.get('email')?.trim()
  if (!email) {
    return NextResponse.json({ error: 'email_required' }, { status: 400 })
  }

  const client = await getClientByEmail(email)
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  return NextResponse.json({ client })
}
