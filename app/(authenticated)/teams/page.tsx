import { HeaderBand } from '@/components/gregory/header-band'
import { getTeamsThisWeek, getDrakeOAuthState } from '@/lib/db/teams'
import { getCurrentUserAccessTier } from '@/lib/auth/access-tier'
import { CsmBlock } from './csm-block'

// /teams — Meeting tracker for the current week, head_csm-and-up.
// Layout-level gate sits in ./layout.tsx; this page presumes the gate
// already passed.
//
// Server-side data fetch: CSMs + calendar_events for the current EST
// week + matched `calls` for the title-and-time join + per-CSM
// calendar_api_denied state from the most recent audit row. The page
// never calls Google directly.
//
// Reconnect-Calendar banner shown only to the Creator (Drake) when his
// stored token is missing or the most recent sync failed with
// oauth_token_unavailable. Other tiers see a muted "Calendar data is
// currently unavailable" line in the same slot.

const ESTLOCALE = 'America/New_York'

function formatWeekRange(startIso: string, endIso: string): string {
  // "May 12 – May 18, 2026"
  const start = new Date(startIso)
  // endIso is the *next* Monday midnight, so subtract a day to get
  // Sunday as the inclusive last day.
  const sunday = new Date(new Date(endIso).getTime() - 24 * 60 * 60 * 1000)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: ESTLOCALE,
    month: 'short',
    day: 'numeric',
  })
  const year = new Intl.DateTimeFormat('en-US', {
    timeZone: ESTLOCALE,
    year: 'numeric',
  }).format(sunday)
  return `${fmt.format(start)} – ${fmt.format(sunday)}, ${year}`
}

export default async function TeamsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const [{ csms, weekStart, weekEnd }, oauthState, access] = await Promise.all([
    getTeamsThisWeek(),
    getDrakeOAuthState(),
    getCurrentUserAccessTier(),
  ])

  const isCreator = access?.tier === 'creator'
  const connected = searchParams.connected
  const errorRaw = Array.isArray(searchParams.error)
    ? searchParams.error[0]
    : searchParams.error

  return (
    <div style={{ padding: '32px 48px 28px' }}>
      <HeaderBand
        eyebrow="TEAM"
        title="Meeting tracker."
        actions={
          <span
            className="geg-mono"
            style={{
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-3)',
            }}
          >
            {formatWeekRange(weekStart, weekEnd)}
          </span>
        }
      />

      {/* Success / error banners from the OAuth callback redirect. */}
      {connected === 'google' ? (
        <div
          role="status"
          style={{
            background: 'var(--color-geg-pos-fill)',
            border: '1px solid var(--color-geg-pos-border)',
            borderRadius: 6,
            color: 'var(--color-geg-pos)',
            padding: '10px 14px',
            margin: '20px 0 0',
            fontSize: 14,
          }}
        >
          Google Calendar connected.
        </div>
      ) : null}
      {errorRaw ? (
        <div
          role="alert"
          style={{
            background: 'var(--color-geg-warn-fill)',
            border: '1px solid var(--color-geg-warn-border)',
            borderRadius: 6,
            color: 'var(--color-geg-warn)',
            padding: '10px 14px',
            margin: '20px 0 0',
            fontSize: 14,
          }}
        >
          OAuth flow failed: <span className="geg-mono">{errorRaw}</span>. Try{' '}
          {isCreator ? (
            <a
              href="/api/auth/google/connect"
              style={{ color: 'var(--color-geg-warn)', textDecoration: 'underline' }}
            >
              reconnecting Google Calendar
            </a>
          ) : (
            'reconnecting'
          )}{' '}
          or contact Drake.
        </div>
      ) : null}

      {/* Persistent OAuth state surface — visible to Drake when not
          connected or refresh is failing; muted version to others. */}
      {!oauthState.connected ? (
        isCreator ? (
          <div
            role="alert"
            style={{
              background: 'var(--color-geg-warn-fill)',
              border: '1px solid var(--color-geg-warn-border)',
              borderRadius: 6,
              padding: '14px 18px',
              margin: '20px 0 0',
              color: 'var(--color-geg-text)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 16,
            }}
          >
            <div>
              <div style={{ fontSize: 14, color: 'var(--color-geg-text)' }}>
                Google Calendar is not connected.
              </div>
              <div
                className="geg-mono"
                style={{
                  fontSize: 11,
                  letterSpacing: '0.05em',
                  color: 'var(--color-geg-text-3)',
                  marginTop: 4,
                }}
              >
                {oauthState.last_error ?? 'no stored token'}
              </div>
            </div>
            <a
              href="/api/auth/google/connect"
              style={{
                background: 'var(--color-geg-accent)',
                color: '#ffffff',
                padding: '8px 14px',
                borderRadius: 6,
                fontSize: 14,
                fontWeight: 500,
                textDecoration: 'none',
                whiteSpace: 'nowrap',
              }}
            >
              {oauthState.last_error ? 'Reconnect' : 'Connect'} Google Calendar
            </a>
          </div>
        ) : (
          <div
            style={{
              color: 'var(--color-geg-text-3)',
              padding: '14px 0 0',
              fontSize: 13,
              fontStyle: 'italic',
            }}
          >
            Calendar data is currently unavailable — Drake needs to reconnect.
          </div>
        )
      ) : null}

      {/* CSM blocks. */}
      <div style={{ marginTop: 28 }}>
        {csms.length === 0 ? (
          <div
            className="geg-mono"
            style={{
              fontSize: 12,
              color: 'var(--color-geg-text-3)',
              padding: '24px 0',
            }}
          >
            No CSMs configured. Flip `is_csm=true` on a team_members row.
          </div>
        ) : (
          csms.map((block) => (
            <CsmBlock key={block.team_member.id} block={block} />
          ))
        )}
      </div>
    </div>
  )
}
