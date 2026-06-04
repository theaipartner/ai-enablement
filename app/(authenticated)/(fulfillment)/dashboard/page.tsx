import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import {
  getDashboardNotifications,
  getNeedsReviewClients,
  getNeedsReviewMergeCandidates,
  type Notification,
} from '@/lib/db/fulfillment-dashboard'
import { ClientFlags } from './client-flags'
import { FlagTaskPill } from './flag-task-pill'

// Fulfillment Dashboard — notification surface.
//
// One stacked notification section split into flag groups: Channel flags,
// Call flags, Client flags. Each group is a card listing flag items, each
// item tagged with a task-type pill so multiple kinds can coexist in a
// group. Channel flags is a placeholder for now; Call flags carries the
// negative-sentiment + missing-recording notifications; Client flags carries
// needs-review (auto-created) clients with their dispositions.

export const dynamic = 'force-dynamic'

const EST_LOCALE = 'America/New_York'

export default async function FulfillmentDashboardPage() {
  const [notifications, needsReview, mergeCandidates] = await Promise.all([
    getDashboardNotifications(),
    getNeedsReviewClients(),
    getNeedsReviewMergeCandidates(),
  ])

  return (
    <div style={{ padding: '32px 48px 64px', maxWidth: 1480, width: '100%' }}>
      <HeaderBand eyebrow="FULFILLMENT" title="Notifications." />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 18,
          marginTop: 28,
        }}
      >
        <FlagGroup eyebrow="CHANNEL FLAGS" title="Channels." count={0}>
          <EmptyFlags message="No channel flags yet." />
        </FlagGroup>

        <FlagGroup
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
        </FlagGroup>

        <FlagGroup
          eyebrow="CLIENT FLAGS"
          title="Clients."
          count={needsReview.length}
        >
          <ClientFlags clients={needsReview} candidates={mergeCandidates} />
        </FlagGroup>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Section shell
// ---------------------------------------------------------------------------

function FlagGroup({
  eyebrow,
  title,
  count,
  children,
}: {
  eyebrow: string
  title: string
  count: number
  children: React.ReactNode
}) {
  return (
    <section
      style={{
        padding: '22px 26px 24px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          marginBottom: 14,
        }}
      >
        <div>
          <div
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.18em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-3)',
            }}
          >
            {eyebrow}
          </div>
          <div
            className="geg-serif"
            style={{
              marginTop: 6,
              fontSize: 22,
              color: 'var(--color-geg-text)',
              letterSpacing: '-0.012em',
            }}
          >
            {title}
          </div>
        </div>
        <div
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-faint)',
          }}
        >
          {count} {count === 1 ? 'flag' : 'flags'}
        </div>
      </div>
      {children}
    </section>
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
        padding: '12px 2px',
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
