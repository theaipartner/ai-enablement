import { NextResponse } from 'next/server'
import { cookies } from 'next/headers'
import crypto from 'crypto'
import { buildAuthUrl } from '@/lib/google/oauth'
import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'

// GET /api/auth/google/connect
//
// Initiates the Google OAuth2 authorization-code flow. Only the Creator
// tier (Drake today) can OAuth — the Teams Meeting Tracker spec § 3
// gates this to creator and uses Drake's stored token for every CSM's
// calendar read via Workspace sharing.
//
// Generates a random `state` nonce, stores it in a short-lived
// httpOnly cookie, then redirects the browser to Google's consent
// screen. The callback route validates the cookie before exchanging
// the code for tokens.

const STATE_COOKIE = 'google_oauth_state'
const STATE_TTL_SECONDS = 600 // 10 minutes — generous; consent flow rarely takes this long

export async function GET() {
  const access = await getCurrentUserAccessTier()
  if (!access || access.tier !== 'creator') {
    // Creator-only per spec. Surface a plain 403 rather than redirecting
    // to /login — anyone hitting this URL without creator access is
    // likely poking at the surface, not lost.
    return new NextResponse('Forbidden', { status: 403 })
  }

  const state = crypto.randomBytes(32).toString('hex')
  const cookieStore = cookies()
  cookieStore.set(STATE_COOKIE, state, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: STATE_TTL_SECONDS,
  })

  const url = buildAuthUrl(state)
  return NextResponse.redirect(url)
}
