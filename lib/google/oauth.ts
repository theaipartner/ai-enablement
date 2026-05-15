import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'

// Google OAuth2 helpers for the Teams Meeting Tracker.
//
// Three surfaces:
//   - buildAuthUrl(state) — constructs the consent screen URL for the
//     `/api/auth/google/connect` route to redirect into.
//   - exchangeCodeForTokens(code) — runs the authorization-code → tokens
//     handshake at the callback. Returns the full token set.
//   - refreshAccessToken(refresh_token) — mints a fresh access token
//     when the stored one is expired.
//   - getValidAccessToken(team_member_id) — orchestrator that reads the
//     stored row, refreshes if expired, updates the DB, returns a live
//     access token.
//
// No SDK dependency. Two `fetch()` calls — clean, auditable, no transitive
// surface area. Pattern mirrors `shared/slack_post.py`'s deliberate
// no-SDK posture for Slack chat.postMessage.
//
// Spec: docs/specs/teams-meeting-tracker.md § 3.

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'

// Refresh tokens 60 seconds BEFORE the stored expiry. The Google access
// token nominally lasts 3600s; the buffer absorbs round-trip latency on
// the cron tick so a token doesn't expire mid-sync.
const _ACCESS_TOKEN_REFRESH_BUFFER_MS = 60_000

export type TokenSet = {
  access_token: string
  refresh_token: string
  expires_in: number // seconds
  scope: string
  token_type: string
}

export function buildAuthUrl(state: string): string {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!clientId || !appUrl) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID or NEXT_PUBLIC_APP_URL not configured')
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: `${appUrl}/api/auth/google/callback`,
    response_type: 'code',
    scope: SCOPE,
    access_type: 'offline',
    // `consent` forces the consent screen even on re-auth so we always
    // get a fresh refresh_token. Without this, Google's behavior on
    // repeat auth is to omit refresh_token, which breaks the sync.
    prompt: 'consent',
    state,
  })
  return `${GOOGLE_AUTH_URL}?${params.toString()}`
}

export async function exchangeCodeForTokens(code: string): Promise<TokenSet> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  const appUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!clientId || !clientSecret || !appUrl) {
    throw new Error(
      'GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, or NEXT_PUBLIC_APP_URL not configured',
    )
  }
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: `${appUrl}/api/auth/google/callback`,
    grant_type: 'authorization_code',
  })
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text()
    // Body may contain client_secret echoes — drop everything but the
    // status + Google's error code by truncating aggressively.
    throw new Error(
      `Google token exchange failed: ${resp.status} ${text.slice(0, 200)}`,
    )
  }
  const json = (await resp.json()) as TokenSet
  if (!json.access_token || !json.refresh_token) {
    throw new Error('Google token response missing access_token or refresh_token')
  }
  return json
}

export async function refreshAccessToken(
  refresh_token: string,
): Promise<{ access_token: string; expires_in: number; scope: string }> {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET
  if (!clientId || !clientSecret) {
    throw new Error('GOOGLE_OAUTH_CLIENT_ID or GOOGLE_OAUTH_CLIENT_SECRET not configured')
  }
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token,
    grant_type: 'refresh_token',
  })
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  })
  if (!resp.ok) {
    const text = await resp.text()
    throw new Error(
      `Google token refresh failed: ${resp.status} ${text.slice(0, 200)}`,
    )
  }
  const json = (await resp.json()) as {
    access_token?: string
    expires_in?: number
    scope?: string
  }
  if (!json.access_token || typeof json.expires_in !== 'number') {
    throw new Error('Google refresh response missing access_token or expires_in')
  }
  return {
    access_token: json.access_token,
    expires_in: json.expires_in,
    scope: json.scope ?? SCOPE,
  }
}

// Read the stored token row, refresh access_token if expired (or close
// to expiring), update the row, return a live access token. Throws when
// no row exists or the refresh fails — caller logs + audits + skips that
// cron tick rather than crashing the whole sync.
export async function getValidAccessToken(team_member_id: string): Promise<string> {
  const admin = createAdminClient()
  const { data, error } = await admin
    .from('oauth_tokens')
    .select('access_token, refresh_token, access_token_expires_at')
    .eq('team_member_id', team_member_id)
    .eq('provider', 'google')
    .maybeSingle()
  if (error || !data) {
    throw new Error(
      `oauth_tokens lookup failed for team_member_id=${team_member_id}: ${error?.message ?? 'no row'}`,
    )
  }

  const expiresAtMs = new Date(data.access_token_expires_at).getTime()
  const nowMs = Date.now()
  if (expiresAtMs - nowMs > _ACCESS_TOKEN_REFRESH_BUFFER_MS) {
    return data.access_token
  }

  // Stored access_token is expired (or about to be). Mint a new one
  // and persist.
  const refreshed = await refreshAccessToken(data.refresh_token)
  const newExpiresAt = new Date(nowMs + refreshed.expires_in * 1000).toISOString()
  const { error: updateError } = await admin
    .from('oauth_tokens')
    .update({
      access_token: refreshed.access_token,
      access_token_expires_at: newExpiresAt,
      scope: refreshed.scope,
      updated_at: new Date().toISOString(),
    })
    .eq('team_member_id', team_member_id)
    .eq('provider', 'google')
  if (updateError) {
    // Refresh worked but the DB update didn't — surface so the caller
    // knows the next tick will hit the same refresh again. The token
    // itself is still valid for this call.
    throw new Error(
      `oauth_tokens update failed after refresh: ${updateError.message}`,
    )
  }
  return refreshed.access_token
}
