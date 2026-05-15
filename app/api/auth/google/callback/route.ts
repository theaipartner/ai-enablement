import { NextResponse, type NextRequest } from 'next/server'
import { cookies } from 'next/headers'
import { exchangeCodeForTokens } from '@/lib/google/oauth'
import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'
import { createAdminClient } from '@/lib/supabase/admin'

// GET /api/auth/google/callback
//
// Receives Google's redirect after the consent screen. Validates the
// state cookie set by the /connect route, exchanges the authorization
// code for an access + refresh token pair, and upserts into
// `oauth_tokens` keyed by (Drake's team_member_id, 'google').
//
// Spec: docs/specs/teams-meeting-tracker.md § 3.
// Creator-tier gate (same as /connect) so only Drake's session can
// complete the handshake. Bouncing other tiers prevents a CSM with a
// crafted URL from binding a token to their team_member_id.

const STATE_COOKIE = 'google_oauth_state'
const TEAMS_REDIRECT = '/teams'
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

function redirectWithError(req: NextRequest, code: string) {
  const url = new URL(TEAMS_REDIRECT, req.nextUrl.origin)
  url.searchParams.set('error', code)
  return NextResponse.redirect(url)
}

export async function GET(req: NextRequest) {
  const access = await getCurrentUserAccessTier()
  if (!access || access.tier !== 'creator') {
    return new NextResponse('Forbidden', { status: 403 })
  }

  const url = req.nextUrl
  const googleError = url.searchParams.get('error')
  if (googleError) {
    // User declined consent, or Google returned an error. The 'access_denied'
    // case is the common one when the user clicks Cancel.
    return redirectWithError(req, `google_${googleError}`)
  }

  const code = url.searchParams.get('code')
  const stateFromUrl = url.searchParams.get('state')
  if (!code || !stateFromUrl) {
    return redirectWithError(req, 'missing_code_or_state')
  }

  const cookieStore = cookies()
  const stateFromCookie = cookieStore.get(STATE_COOKIE)?.value
  // Clear the state cookie no matter what — it's single-use.
  cookieStore.delete(STATE_COOKIE)
  if (!stateFromCookie || stateFromCookie !== stateFromUrl) {
    return redirectWithError(req, 'state_mismatch')
  }

  let tokens
  try {
    tokens = await exchangeCodeForTokens(code)
  } catch (err) {
    console.error('google_oauth_callback: token exchange failed', err)
    return redirectWithError(req, 'token_exchange_failed')
  }

  // Stamp into the row keyed by (Drake's team_member_id, 'google').
  // Upsert via the unique index handles re-OAuth cleanly.
  const admin = createAdminClient()
  const expiresAtIso = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
  const nowIso = new Date().toISOString()
  const { error: upsertError } = await admin.from('oauth_tokens').upsert(
    {
      team_member_id: access.team_member.id,
      provider: 'google',
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      access_token_expires_at: expiresAtIso,
      scope: tokens.scope || SCOPE,
      updated_at: nowIso,
    },
    { onConflict: 'team_member_id,provider' },
  )
  if (upsertError) {
    console.error('google_oauth_callback: oauth_tokens upsert failed', upsertError)
    return redirectWithError(req, 'token_store_failed')
  }

  const successUrl = new URL(TEAMS_REDIRECT, req.nextUrl.origin)
  successUrl.searchParams.set('connected', 'google')
  return NextResponse.redirect(successUrl)
}
