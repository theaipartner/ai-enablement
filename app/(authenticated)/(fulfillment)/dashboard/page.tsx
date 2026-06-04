import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import {
  getDashboardNotifications,
  getGhostClientFlags,
  getNeedsReviewClients,
  getNeedsReviewMergeCandidates,
  type Notification,
} from '@/lib/db/fulfillment-dashboard'
import { CollapsibleSection } from './collapsible-section'
import { NeedsReviewList, GhostList } from './client-flags'
import { FlagTaskPill } from './flag-task-pill'

// Fulfillment Dashboard — notification surface.
//
// A responsive grid of collapsible flag sections, collapsed by default and
// laid out side by side (the page is expected to grow many sections, so the
// default view stays compact). Today: Channel flags (placeholder), Call flags
// (negative-sentiment + missing-recording), Needs review (auto-created
// clients), Ghost (active clients silent in Slack 14+ days). Needs review and
// Ghost are their own sections now (formerly bundled under "Client flags").

export const dynamic = 'force-dynamic'

const EST_LOCALE = 'America/New_York'

export default async function FulfillmentDashboardPage() {
  const [notifications, needsReview, mergeCandidates, ghosts] =
    await Promise.all([
      getDashboardNotifications(),
      getNeedsReviewClients(),
      getNeedsReviewMergeCandidates(),
      getGhostClientFlags(),
    ])

  return (
    <div style={{ padding: '32px 48px 64px', maxWidth: 1480, width: '100%' }}>
      <HeaderBand eyebrow="FULFILLMENT" title="Notifications." />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(380px, 1fr))',
          gap: 16,
          marginTop: 28,
          alignItems: 'start',
        }}
      >
        <CollapsibleSection eyebrow="CHANNEL FLAGS" title="Channels." count={0}>
          <EmptyFlags message="No channel flags yet." />
        </CollapsibleSection>

        <CollapsibleSection
          eyebrow="CALL FLAGS"
          title="Calls."
          count={notifications.length}
        >
          {notifications.length === 0 ? (
            <EmptyFlags message="No call flags. All recordings landed and reviewed calls came back green or yellow." />
          ) : (
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              {notifications.map((n) => (
                <CallFlagRow key={callFlagKey(n)} n={n} />
              ))}
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          eyebrow="NEEDS REVIEW"
          title="Auto-created."
          count={needsReview.length}
        >
          <NeedsReviewList clients={needsReview} candidates={mergeCandidates} />
        </CollapsibleSection>

        <CollapsibleSection
          eyebrow="GHOST"
          title="Gone quiet."
          count={ghosts.length}
        >
          <GhostList ghosts={ghosts} />
        </CollapsibleSection>
      </div>
    </div>
  )
}

function EmptyFlags({ message }: { message: string }) {
  return (
    <div
      style={{
        padding: '4px 0',
        fontSize: 13,
        color: 'var(--color-geg-text-3)',
        fontStyle: 'italic',
      }}
    >
      {message}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Call flags
// ---------------------------------------------------------------------------

function callFlagKey(n: Notification): string {
  return n.kind === 'negative_sentiment'
    ? `sent:${n.call_id}`
    : `miss:${n.google_event_id}`
}

function formatNotificationDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: EST_LOCALE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso))
}

function CallFlagRow({ n }: { n: Notification }) {
  const isNegative = n.kind === 'negative_sentiment'
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '11px 2px',
        borderBottom: '1px solid var(--color-geg-border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <FlagTaskPill
          label={isNegative ? 'Negative sentiment' : 'Missing recording'}
          tone={isNegative ? 'neg' : 'warn'}
        />
        <div style={{ minWidth: 0 }}>
          {isNegative ? (
            <Link
              href={`/calls/${n.call_id}`}
              style={{
                fontSize: 14,
                color: 'var(--color-geg-text)',
                textDecoration: 'underline',
              }}
            >
              {n.call_title ?? 'Untitled call'}
            </Link>
          ) : (
            <span style={{ fontSize: 14, color: 'var(--color-geg-text)' }}>
              {n.event_title ?? 'Untitled event'}
            </span>
          )}
          <div
            className="geg-mono"
            style={{
              marginTop: 3,
              fontSize: 11,
              color: 'var(--color-geg-text-faint)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {isNegative
              ? n.client_id && n.client_name
                ? n.client_name
                : '—'
              : (n.csm_name ?? 'Unassigned')}
          </div>
        </div>
      </div>
      <div
        className="geg-mono"
        style={{
          fontSize: 11,
          color: 'var(--color-geg-text-2)',
          letterSpacing: '0.04em',
          flexShrink: 0,
        }}
      >
        {formatNotificationDate(n.occurred_at)}
      </div>
    </div>
  )
}
