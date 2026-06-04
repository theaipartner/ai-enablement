import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import {
  getSentimentCallFlags,
  getMissingRecordingFlags,
  getGhostClientFlags,
  getNeedsReviewClients,
  getNeedsReviewMergeCandidates,
  getUninstrumentedChannels,
  getMissingSlackClients,
  type SentimentCallFlag,
  type MissingRecordingFlag,
  type UninstrumentedChannel,
} from '@/lib/db/fulfillment-dashboard'
import { CollapsibleSection } from './collapsible-section'
import { NeedsReviewList, GhostList } from './client-flags'
import { MissingSlackList } from './missing-slack'
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
  const [
    sentimentCalls,
    missingRecordings,
    needsReview,
    mergeCandidates,
    ghosts,
    uninstrumented,
    missingSlack,
  ] = await Promise.all([
    getSentimentCallFlags(),
    getMissingRecordingFlags(),
    getNeedsReviewClients(),
    getNeedsReviewMergeCandidates(),
    getGhostClientFlags(),
    getUninstrumentedChannels(),
    getMissingSlackClients(),
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
        <CollapsibleSection
          eyebrow="CHANNEL FLAGS"
          title="No Ella."
          count={uninstrumented.length}
        >
          {uninstrumented.length === 0 ? (
            <EmptyFlags message="Ella is in every active client channel." />
          ) : (
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              {uninstrumented.map((u) => (
                <UninstrumentedRow key={u.client_id} channel={u} />
              ))}
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          eyebrow="MISSING SLACK IDS"
          title="No IDs."
          count={missingSlack.length}
        >
          <MissingSlackList clients={missingSlack} />
        </CollapsibleSection>

        <CollapsibleSection
          eyebrow="CALL FLAGS"
          title="Sentiment."
          count={sentimentCalls.length}
        >
          {sentimentCalls.length === 0 ? (
            <EmptyFlags message="No mixed or negative calls in the past 3 days." />
          ) : (
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              {sentimentCalls.map((c) => (
                <SentimentRow key={c.call_id} flag={c} />
              ))}
            </div>
          )}
        </CollapsibleSection>

        <CollapsibleSection
          eyebrow="MISSING RECORDINGS"
          title="No Fathom."
          count={missingRecordings.length}
        >
          {missingRecordings.length === 0 ? (
            <EmptyFlags message="No missing recordings for at-risk or problem clients in the past 3 days." />
          ) : (
            <div style={{ maxHeight: 300, overflowY: 'auto' }}>
              {missingRecordings.map((m) => (
                <MissingRecordingRow key={m.google_event_id} flag={m} />
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

// ---------------------------------------------------------------------------
// Channel flags — active client channels the bot/Ella isn't in (zero ingested
// messages). Informational: invite the bot in Slack and it resolves itself.
// ---------------------------------------------------------------------------

function UninstrumentedRow({ channel }: { channel: UninstrumentedChannel }) {
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
      <Link
        href={`/clients/${channel.client_id}`}
        style={{
          fontSize: 14,
          color: 'var(--color-geg-text)',
          textDecoration: 'underline',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
      >
        {channel.full_name}
      </Link>
      <span
        className="geg-mono"
        style={{
          fontSize: 11,
          color: 'var(--color-geg-text-faint)',
          flexShrink: 0,
        }}
      >
        {channel.channel_name ?? '—'}
      </span>
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
// Call flags (mixed / negative sentiment, past 3 days) + missing recordings
// ---------------------------------------------------------------------------

function formatFlagDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: EST_LOCALE,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso))
}

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '11px 2px',
  borderBottom: '1px solid var(--color-geg-border)',
}

const META_STYLE: React.CSSProperties = {
  marginTop: 3,
  fontSize: 11,
  color: 'var(--color-geg-text-faint)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const DATE_STYLE: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--color-geg-text-2)',
  letterSpacing: '0.04em',
  flexShrink: 0,
}

function SentimentRow({ flag }: { flag: SentimentCallFlag }) {
  const isNegative = flag.sentiment === 'red'
  return (
    <div style={ROW_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <FlagTaskPill
          label={isNegative ? 'Negative' : 'Mixed'}
          tone={isNegative ? 'neg' : 'warn'}
        />
        <div style={{ minWidth: 0 }}>
          <Link
            href={`/calls/${flag.call_id}`}
            style={{
              fontSize: 14,
              color: 'var(--color-geg-text)',
              textDecoration: 'underline',
            }}
          >
            {flag.call_title ?? 'Untitled call'}
          </Link>
          <div className="geg-mono" style={META_STYLE}>
            {flag.client_name ?? '—'}
          </div>
        </div>
      </div>
      <div className="geg-mono" style={DATE_STYLE}>
        {formatFlagDate(flag.occurred_at)}
      </div>
    </div>
  )
}

function MissingRecordingRow({ flag }: { flag: MissingRecordingFlag }) {
  return (
    <div style={ROW_STYLE}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <FlagTaskPill
          label={flag.csm_standing === 'problem' ? 'Problem' : 'At risk'}
          tone="neg"
        />
        <div style={{ minWidth: 0 }}>
          <Link
            href={`/clients/${flag.client_id}`}
            style={{
              fontSize: 14,
              color: 'var(--color-geg-text)',
              textDecoration: 'underline',
            }}
          >
            {flag.client_name}
          </Link>
          <div className="geg-mono" style={META_STYLE}>
            {flag.event_title ?? 'Untitled event'}
            {flag.csm_name ? ` · ${flag.csm_name}` : ''}
          </div>
        </div>
      </div>
      <div className="geg-mono" style={DATE_STYLE}>
        {formatFlagDate(flag.occurred_at)}
      </div>
    </div>
  )
}
