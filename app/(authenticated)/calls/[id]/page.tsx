import Link from 'next/link'
import { notFound } from 'next/navigation'
import { getCallById, type CallDetail } from '@/lib/db/calls'
import { SentimentPill } from '@/components/gregory/sentiment-pill'
import { ActionItemsBox } from './action-items-box'

// Calls redesign · § 2 — call detail page (/calls/[id]).
//
// Single-screen at 1440 × 900 baseline · two-column grid · three
// translucent gold-bordered boxes. Transcript, classification, and
// participants sections removed (out of scope for this surface — they
// live in the audit-data layer if needed).

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  const mm = Math.floor(seconds / 60)
  const ss = seconds % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

function formatStarted(iso: string): string {
  // "5/12/2026, 11:48 PM" — matches the mock.
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function formatStartedDetailed(iso: string): string {
  // "5/12/2026, 11:48:36 PM" — same shape with seconds for the Data box.
  return new Date(iso).toLocaleString('en-US', {
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  })
}

// Map a call's call_review sentiment_arc → the tier we'd display in
// the review header. Same derivation as the list-page batch fetch, but
// here we receive the call_review object directly from getCallById so
// no extra round trip is needed.
//
// `documents.metadata.sentiment_tier` is the source of truth; the
// detail-page review fetch returns the parsed content + generated_at,
// but does NOT thread the metadata.sentiment_tier through. We fetch
// the tier with a single tiny query co-located with this page.
//
// Returning null when no review exists keeps the SentimentPill
// invisible in the review header until one lands.
async function fetchSentimentTier(callId: string): Promise<
  'green' | 'yellow' | 'red' | null
> {
  const { createAdminClient } = await import('@/lib/supabase/admin')
  const supabase = createAdminClient()
  const { data } = await supabase
    .from('documents')
    .select('metadata')
    .eq('document_type', 'call_review')
    .filter('metadata->>call_id', 'eq', callId)
    .limit(1)
    .maybeSingle()
  const tier = (data as { metadata?: { sentiment_tier?: string } } | null)
    ?.metadata?.sentiment_tier
  if (tier === 'green' || tier === 'yellow' || tier === 'red') return tier
  return null
}

export default async function CallDetailPage({
  params,
}: {
  params: { id: string }
}) {
  const call = await getCallById(params.id)
  if (!call) notFound()

  const sentimentTier = await fetchSentimentTier(call.id)

  return (
    <div style={{ padding: '24px 48px 28px' }}>
      <Link
        href="/calls"
        className="geg-mono"
        style={{
          color: 'var(--color-geg-accent)',
          textDecoration: 'none',
          fontSize: 11,
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
        }}
      >
        ← BACK TO CALLS
      </Link>

      <header
        style={{
          padding: '28px 0 24px',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        <div className="geg-eyebrow">CALL · DETAIL</div>
        <h1
          className="geg-serif"
          style={{
            fontWeight: 500,
            fontSize: 36,
            lineHeight: 1.1,
            letterSpacing: '-0.012em',
            color: 'var(--color-geg-text)',
            margin: '8px 0 0',
          }}
        >
          {call.title ?? 'Untitled call'}.
        </h1>
        <div
          className="geg-mono"
          style={{
            marginTop: 10,
            fontSize: 12,
            color: 'var(--color-geg-text-2)',
            letterSpacing: '0.02em',
          }}
        >
          {formatStarted(call.started_at)}
          <span style={{ color: 'var(--color-geg-text-dim)', margin: '0 10px' }}>
            ·
          </span>
          {formatDuration(call.duration_seconds)}
          <span style={{ color: 'var(--color-geg-text-dim)', margin: '0 10px' }}>
            ·
          </span>
          Fathom
        </div>
      </header>

      <div
        className="geg-detail-grid"
        style={{
          display: 'grid',
          gridTemplateColumns: '420px 1fr',
          gap: 20,
          paddingTop: 24,
        }}
      >
        {/* LEFT COLUMN — Data + Action items */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 20,
            minHeight: 0,
          }}
        >
          <DataBox call={call} />
          <ActionItemsContainer call={call} />
        </div>

        {/* RIGHT COLUMN — Call review */}
        <ReviewBox review={call.call_review} sentimentTier={sentimentTier} />
      </div>
    </div>
  )
}

function DataBox({ call }: { call: CallDetail }) {
  const csmName = call.csm_team_member?.full_name
  return (
    <div className="geg-gold-box" style={{ flexShrink: 0 }}>
      <div className="geg-gold-box-header">
        <h3>Data</h3>
      </div>
      <div className="geg-gold-box-body">
        <DataRow
          k="Client"
          v={
            call.primary_client ? (
              <Link
                href={`/clients/${call.primary_client.id}`}
                style={{
                  color: 'var(--color-geg-accent)',
                  textDecoration: 'none',
                }}
                className="geg-link"
              >
                {call.primary_client.full_name} →
              </Link>
            ) : (
              <span style={{ color: 'var(--color-geg-text-3)' }}>—</span>
            )
          }
        />
        <DataRow
          k="CSM"
          v={
            csmName ?? (
              <span style={{ color: 'var(--color-geg-text-3)' }}>—</span>
            )
          }
        />
        <DataRow
          k="Started"
          v={<span className="geg-mono">{formatStartedDetailed(call.started_at)}</span>}
          mono
        />
        <DataRow
          k="Duration"
          v={<span className="geg-mono">{formatDuration(call.duration_seconds)}</span>}
          mono
        />
        <DataRow
          k="Recording"
          v={
            call.recording_url ? (
              <a
                href={call.recording_url}
                target="_blank"
                rel="noopener noreferrer"
                style={{
                  color: 'var(--color-geg-accent)',
                  textDecoration: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  fontWeight: 500,
                }}
                className="geg-link"
              >
                Open in Fathom <span className="geg-mono">→</span>
              </a>
            ) : (
              <span style={{ color: 'var(--color-geg-text-3)' }}>—</span>
            )
          }
        />
      </div>
    </div>
  )
}

function DataRow({
  k,
  v,
  mono,
}: {
  k: string
  v: React.ReactNode
  mono?: boolean
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '110px 1fr',
        gap: 12,
        padding: '8px 0',
        fontSize: 13,
        alignItems: 'baseline',
        borderTop: '1px dashed rgba(160, 136, 80, 0.18)',
      }}
      className="geg-data-row"
    >
      <span
        className="geg-mono"
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-faint)',
        }}
      >
        {k}
      </span>
      <span
        style={{
          color: mono ? 'var(--color-geg-text-2)' : 'var(--color-geg-text)',
          fontSize: mono ? 12 : 13,
          letterSpacing: mono ? '0.02em' : undefined,
        }}
      >
        {v}
      </span>
    </div>
  )
}

function ActionItemsContainer({ call }: { call: CallDetail }) {
  // Filter to OPEN action items for the redesigned UX. The X-delete is
  // a hard delete (server action), so passing closed items here would
  // let a CSM accidentally remove historical context.
  const openItems = call.action_items.filter((it) => it.status === 'open')
  return (
    <div className="geg-gold-box" style={{ flex: 1, minHeight: 0 }}>
      <div className="geg-gold-box-header">
        <h3>
          Action items{' '}
          <span style={{ color: 'var(--color-geg-accent)', marginLeft: 6 }}>
            {openItems.length}
          </span>
        </h3>
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            color: 'var(--color-geg-text-faint)',
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
          }}
        >
          Click to edit
        </span>
      </div>
      <div className="geg-gold-box-body">
        <ActionItemsBox
          callId={call.id}
          items={openItems.map((it) => ({
            id: it.id,
            description: it.description,
          }))}
        />
      </div>
    </div>
  )
}

function ReviewBox({
  review,
  sentimentTier,
}: {
  review: CallDetail['call_review']
  sentimentTier: 'green' | 'yellow' | 'red' | null
}) {
  return (
    <div className="geg-gold-box" style={{ height: '100%' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 16,
          paddingBottom: 14,
          marginBottom: 16,
          borderBottom: '1px solid var(--color-geg-accent-border)',
        }}
      >
        <div>
          <h3
            className="geg-serif"
            style={{
              fontWeight: 500,
              fontSize: 22,
              margin: 0,
              letterSpacing: '-0.01em',
              color: 'var(--color-geg-text)',
            }}
          >
            Call review.
          </h3>
          {review ? (
            <div
              className="geg-mono"
              style={{
                marginTop: 6,
                fontSize: 11,
                color: 'var(--color-geg-text-faint)',
                letterSpacing: '0.02em',
              }}
            >
              Generated{' '}
              <b style={{ color: 'var(--color-geg-text-2)', fontWeight: 400 }}>
                {formatStarted(review.generated_at)}
              </b>
            </div>
          ) : null}
        </div>
        <SentimentPill tier={sentimentTier} />
      </div>

      {review === null ? (
        <p
          style={{
            color: 'var(--color-geg-text-2)',
            fontSize: 13,
            fontStyle: 'italic',
            margin: 0,
          }}
        >
          No review for this call yet.
        </p>
      ) : (
        <div
          style={{
            flex: 1,
            overflowY: 'auto',
            paddingRight: 8,
            minHeight: 0,
          }}
        >
          <ReviewSection title="Sentiment arc">
            <p
              className="geg-serif"
              style={{
                fontWeight: 400,
                fontSize: 15,
                lineHeight: 1.6,
                color: 'var(--color-geg-text)',
                margin: 0,
              }}
            >
              {review.sentiment_arc}
            </p>
          </ReviewSection>

          <ReviewSection title="Pain points" count={review.pain_points.length}>
            <ReviewList items={review.pain_points} />
          </ReviewSection>

          <ReviewSection title="Wins" count={review.wins.length}>
            <ReviewList items={review.wins} />
          </ReviewSection>

          <ReviewSection
            title="Conversation pivots"
            count={review.dodged_questions.length}
          >
            <ReviewList items={review.dodged_questions} withPivotTag />
          </ReviewSection>
        </div>
      )}
    </div>
  )
}

function ReviewSection({
  title,
  count,
  children,
}: {
  title: string
  count?: number
  children: React.ReactNode
}) {
  return (
    <div style={{ marginBottom: 22 }}>
      <h4
        className="geg-mono"
        style={{
          fontSize: 10,
          fontWeight: 500,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-2)',
          margin: '0 0 10px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        {title}
        {count !== undefined ? (
          <span style={{ color: 'var(--color-geg-accent)', fontWeight: 500 }}>
            {count}
          </span>
        ) : null}
      </h4>
      {children}
    </div>
  )
}

function ReviewList({
  items,
  withPivotTag,
}: {
  items: Array<{ description: string; evidence: string; who?: string }>
  withPivotTag?: boolean
}) {
  if (items.length === 0) {
    return (
      <p
        style={{
          fontSize: 12,
          color: 'var(--color-geg-text-faint)',
          fontStyle: 'italic',
          margin: 0,
        }}
      >
        None surfaced.
      </p>
    )
  }
  return (
    <ul
      style={{
        listStyle: 'none',
        margin: 0,
        padding: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
      }}
    >
      {items.map((item, idx) => (
        <li
          key={idx}
          style={{
            paddingLeft: 12,
            borderLeft: '1px solid var(--color-geg-accent-border)',
          }}
        >
          <p
            style={{
              color: 'var(--color-geg-text)',
              fontSize: 13.5,
              lineHeight: 1.55,
              margin: '0 0 6px',
            }}
          >
            {withPivotTag && item.who ? (
              <PivotTag who={item.who} />
            ) : null}
            {item.description}
          </p>
          <p
            style={{
              color: 'var(--color-geg-text-2)',
              fontSize: 12,
              lineHeight: 1.55,
              fontStyle: 'italic',
              margin: 0,
            }}
          >
            {item.evidence}
          </p>
        </li>
      ))}
    </ul>
  )
}

function PivotTag({ who }: { who: string }) {
  const isCsm = who.toLowerCase() === 'csm'
  return (
    <span
      className="geg-mono"
      style={{
        display: 'inline-block',
        fontSize: 9,
        fontWeight: 500,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        padding: '2px 7px',
        borderRadius: 3,
        marginRight: 8,
        verticalAlign: 1,
        color: isCsm
          ? 'var(--color-geg-accent)'
          : 'var(--color-geg-text-2)',
        background: isCsm
          ? 'var(--color-geg-accent-fill)'
          : 'rgba(255, 255, 255, 0.03)',
        border: isCsm
          ? '1px solid var(--color-geg-accent-border)'
          : '1px solid var(--color-geg-border-strong)',
      }}
    >
      {who}
    </span>
  )
}
