import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  getSetterCallById,
  type SetterCallDetail,
  type SetterCallReviewFull,
  type SetterCallReviewItem,
  type SetterCallWord,
} from '@/lib/db/setter-calls'
import { TranscriptSection } from './transcript-section'

// Sales Dashboard · Calls · Detail.
//
// Mirrors the CS /calls/[id] page shape — two-column gold-bordered
// grid with Data box (left) and Call Review box (right). Header
// surfaces three pills: lead score (always), booked/not-booked
// (always), and DQ (only when should_be_dqd=true). Transcript is
// collapsed under a "Show transcript" toggle below the grid.
//
// "Review is the main focus" — the right column is wider and carries
// the structured analysis. Drake reads this to coach setters and
// triage lead quality.

export const dynamic = 'force-dynamic'

export default async function SetterCallDetailPage({
  params,
  searchParams,
}: {
  params: { close_id: string }
  searchParams?: { lead?: string | string[] }
}) {
  const id = decodeURIComponent(params.close_id)
  const detail = await getSetterCallById(id)
  if (!detail) notFound()

  // Return to the lead this call was opened from (carried as ?lead=), falling
  // back to the call's own lead, then the leads roster.
  const fromLead = (Array.isArray(searchParams?.lead) ? searchParams?.lead[0] : searchParams?.lead) ?? null
  const leadId = fromLead || detail.prospect_lead_id || null
  const backHref = leadId ? `/sales-dashboard/leads/${encodeURIComponent(leadId)}` : '/sales-dashboard/leads'

  return (
    <div style={{ padding: '4px 8px 28px' }}>
      <BackLink href={backHref} hasLead={!!leadId} />
      <HeaderBlock detail={detail} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '380px 1fr',
          gap: 20,
          paddingTop: 24,
          alignItems: 'start',
        }}
      >
        <DataBox detail={detail} />
        <ReviewBox detail={detail} />
      </div>

      <TranscriptSection
        transcriptText={detail.transcript_text}
        words={detail.words}
        speakerCount={detail.speaker_count}
      />
    </div>
  )
}

// ----------------------------------------------------------------------
// Header — eyebrow + title + pill row
// ----------------------------------------------------------------------

function BackLink({ href, hasLead }: { href: string; hasLead: boolean }) {
  return (
    <Link
      href={href}
      className="geg-mono"
      style={{
        display: 'inline-block',
        marginTop: 4,
        fontSize: 10,
        letterSpacing: '0.16em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-3)',
        textDecoration: 'none',
      }}
    >
      {hasLead ? '← Back to lead' : '← Back to leads'}
    </Link>
  )
}

function HeaderBlock({ detail }: { detail: SetterCallDetail }) {
  const review = detail.full_review
  return (
    <header
      style={{
        padding: '20px 0 22px',
        borderBottom: '1px solid var(--color-geg-border)',
      }}
    >
      <div className="geg-eyebrow">SALES · CALL · DETAIL</div>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 16,
          flexWrap: 'wrap',
          marginTop: 8,
        }}
      >
        <h1
          className="geg-serif"
          style={{
            fontWeight: 500,
            fontSize: 34,
            lineHeight: 1.1,
            letterSpacing: '-0.012em',
            color: 'var(--color-geg-text)',
            margin: 0,
          }}
        >
          {detail.prospect_name ?? 'Unknown prospect'}.
        </h1>
        {review ? (
          <div style={{ display: 'inline-flex', gap: 8, alignItems: 'baseline' }}>
            <ScorePill score={review.lead_score} />
            <OutcomePill review={review} />
            {review.should_be_dqd ? <DqPill reason={review.dq_reason ?? ''} /> : null}
          </div>
        ) : (
          <span
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-faint)',
              padding: '4px 10px',
              border: '1px dashed var(--color-geg-border)',
              borderRadius: 999,
            }}
          >
            Review pending
          </span>
        )}
      </div>
      <div
        className="geg-mono"
        style={{
          marginTop: 12,
          fontSize: 12,
          color: 'var(--color-geg-text-2)',
          letterSpacing: '0.02em',
        }}
      >
        {formatStarted(detail.activity_at)}
        <Dot />
        {formatDurationLong(detail.duration_s)}
        <Dot />
        {detail.setter_name ?? 'Unknown setter'}
        {detail.setter_role ? (
          <span
            style={{ color: 'var(--color-geg-text-faint)', marginLeft: 6 }}
          >
            · {detail.setter_role}
          </span>
        ) : null}
        <Dot />
        {detail.direction ?? '—'}
      </div>
    </header>
  )
}

function Dot() {
  return (
    <span style={{ color: 'var(--color-geg-text-faint)', margin: '0 10px' }}>·</span>
  )
}

// ----------------------------------------------------------------------
// Pills — score / booked / DQ
// ----------------------------------------------------------------------

function ScorePill({ score }: { score: number }) {
  // 0-3 → red, 4-6 → neutral, 7-10 → green. Stays mono-cap to match
  // the rest of the chrome.
  const tone =
    score <= 3
      ? { color: 'var(--color-geg-neg)', bg: 'var(--color-geg-neg-fill)', border: 'var(--color-geg-neg-border)' }
      : score <= 6
        ? { color: 'var(--color-geg-text-2)', bg: 'var(--color-geg-bg-elev)', border: 'var(--color-geg-border)' }
        : { color: 'var(--color-geg-pos)', bg: 'var(--color-geg-pos-fill)', border: 'var(--color-geg-pos-border)' }
  return (
    <span
      className="geg-mono"
      title={`Lead score ${score}/10`}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        color: tone.color,
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        fontWeight: 500,
      }}
    >
      <span style={{ fontSize: 13, letterSpacing: '0.04em' }}>{score}</span>
      <span style={{ opacity: 0.7 }}>/ 10</span>
    </span>
  )
}

// Outcome pill — call-type aware. Outbound calls are graded on booking;
// revival (Digital College) calls on closing the sale on the phone.
function OutcomePill({ review }: { review: SetterCallReviewFull }) {
  const isRevival = review.call_type === 'revival'
  const hit = isRevival ? review.closed === true : review.booked === true
  const yes = isRevival ? 'Closed' : 'Booked'
  const no = isRevival ? 'Not closed' : 'Not booked'
  const tone = hit
    ? { color: 'var(--color-geg-pos)', bg: 'var(--color-geg-pos-fill)', border: 'var(--color-geg-pos-border)', label: yes }
    : { color: 'var(--color-geg-text-3)', bg: 'transparent', border: 'var(--color-geg-border)', label: no }
  return (
    <span
      className="geg-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        color: tone.color,
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        fontWeight: 500,
      }}
    >
      {tone.label}
    </span>
  )
}

function DqPill({ reason }: { reason: string }) {
  return (
    <span
      className="geg-mono"
      title={reason || 'Flagged DQ — see review'}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '4px 10px',
        borderRadius: 999,
        border: '1px solid var(--color-geg-neg-border)',
        background: 'var(--color-geg-neg-fill)',
        color: 'var(--color-geg-neg)',
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        fontWeight: 500,
      }}
    >
      DQ flagged
    </span>
  )
}

// ----------------------------------------------------------------------
// Data box
// ----------------------------------------------------------------------

function DataBox({ detail }: { detail: SetterCallDetail }) {
  const review = detail.full_review
  const expiresAt = detail.recording_expires_at ? new Date(detail.recording_expires_at) : null
  const isPlayable = expiresAt ? expiresAt > new Date() : false

  // Talk ratio prefers the review row's stored value (computed off
  // the diarized words at review time). When the review hasn't run
  // yet, we'd need to recompute here — for V1 we just show "—".
  const talkRatio =
    review?.setter_words != null && review?.prospect_words != null
      ? `${review.setter_words} / ${review.prospect_words} words (${Math.round((review.talk_ratio_setter ?? 0) * 100)}% setter)`
      : '—'

  return (
    <div className="geg-gold-box" style={{ flexShrink: 0 }}>
      <div className="geg-gold-box-header">
        <h3>Data</h3>
      </div>
      <div className="geg-gold-box-body">
        <DataRow k="Setter" v={detail.setter_name ?? '—'} />
        <DataRow k="Prospect" v={detail.prospect_name ?? '—'} />
        <DataRow k="Direction" v={detail.direction ?? '—'} />
        <DataRow
          k="Duration"
          v={<span className="geg-mono">{formatDurationLong(detail.duration_s)}</span>}
          mono
        />
        <DataRow k="Talk time" v={<span className="geg-mono" style={{ fontSize: 12 }}>{talkRatio}</span>} mono />
        <DataRow
          k="Recording"
          v={
            isPlayable ? (
              <a
                href={detail.close_app_url}
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
              >
                Open in Close <span className="geg-mono">→</span>
              </a>
            ) : (
              <span style={{ color: 'var(--color-geg-text-3)' }}>
                Expired{expiresAt ? ` ${formatRelative(expiresAt)}` : ''}
              </span>
            )
          }
        />
        <DataRow
          k="Transcribed"
          v={
            <span className="geg-mono" style={{ fontSize: 11 }}>
              {detail.model} ·{' '}
              {detail.confidence != null
                ? `${(detail.confidence * 100).toFixed(1)}%`
                : '—'}
            </span>
          }
          mono
        />
      </div>
    </div>
  )
}

function DataRow({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div
      className="geg-data-row"
      style={{
        display: 'grid',
        gridTemplateColumns: '110px 1fr',
        gap: 12,
        padding: '8px 0',
        fontSize: 13,
        alignItems: 'baseline',
        borderTop: '1px dashed rgba(160, 136, 80, 0.18)',
      }}
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

// ----------------------------------------------------------------------
// Review box
// ----------------------------------------------------------------------

function ReviewBox({ detail }: { detail: SetterCallDetail }) {
  const review = detail.full_review
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
              fontSize: 10,
              color: 'var(--color-geg-text-faint)',
              letterSpacing: '0.02em',
            }}
          >
            {review.prompt_version} ·{' '}
            <b style={{ color: 'var(--color-geg-text-2)', fontWeight: 400 }}>
              {formatStarted(review.reviewed_at)}
            </b>
          </div>
        ) : null}
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
          Sonnet review hasn&apos;t run for this call yet — usually within a minute of
          the transcript landing. Refresh shortly.
        </p>
      ) : (
        <>
          <ReviewSection title="Sentiment">
            <p
              className="geg-serif"
              style={{
                fontSize: 15,
                lineHeight: 1.55,
                color: 'var(--color-geg-text)',
                margin: 0,
              }}
            >
              {review.sentiment}
            </p>
          </ReviewSection>

          <ReviewSection title={`Why this score · ${review.lead_score} / 10`}>
            <p
              style={{
                fontSize: 13.5,
                lineHeight: 1.55,
                color: 'var(--color-geg-text)',
                margin: 0,
              }}
            >
              {review.lead_score_reason}
            </p>
          </ReviewSection>

          <ReviewSection
            title="Setter strengths"
            count={review.setter_strengths.length}
          >
            <ReviewList items={review.setter_strengths} />
          </ReviewSection>

          <ReviewSection
            title="Setter weaknesses"
            count={review.setter_weaknesses.length}
          >
            <ReviewList items={review.setter_weaknesses} />
          </ReviewSection>

          {review.lead_attributes.length > 0 ? (
            <ReviewSection title="Lead attributes">
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {review.lead_attributes.map((attr) => (
                  <AttributePill key={attr} value={attr} />
                ))}
              </div>
            </ReviewSection>
          ) : null}

          {(() => {
            // Outcome blocker — call-type aware. Revival (DC) calls show
            // "Why didn't close"; outbound calls show "Why didn't book".
            const isRevival = review.call_type === 'revival'
            const missed = isRevival ? review.closed === false : review.booked === false
            const reason = isRevival ? review.no_close_reason : review.no_book_reason
            if (!missed || !reason) return null
            return (
              <ReviewSection title={isRevival ? "Why didn't close" : "Why didn't book"}>
                <p
                  style={{
                    fontSize: 13.5,
                    lineHeight: 1.55,
                    color: 'var(--color-geg-text)',
                    margin: 0,
                    paddingLeft: 12,
                    borderLeft: '2px solid var(--color-geg-neg-border)',
                  }}
                >
                  {reason}
                </p>
              </ReviewSection>
            )
          })()}
        </>
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

function ReviewList({ items }: { items: SetterCallReviewItem[] }) {
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
            {item.point}
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

function AttributePill({ value }: { value: string }) {
  // value is "key:value" — split for visual separation.
  const colon = value.indexOf(':')
  const [k, v] = colon > -1 ? [value.slice(0, colon), value.slice(colon + 1)] : [value, '']
  return (
    <span
      className="geg-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'baseline',
        gap: 5,
        padding: '3px 8px',
        borderRadius: 4,
        background: 'var(--color-geg-bg)',
        border: '1px solid var(--color-geg-border)',
        fontSize: 11,
        color: 'var(--color-geg-text-2)',
        letterSpacing: '0.04em',
      }}
    >
      <span style={{ color: 'var(--color-geg-text-faint)' }}>{k}</span>
      {v ? <span>{v}</span> : null}
    </span>
  )
}

// ----------------------------------------------------------------------
// Formatters
// ----------------------------------------------------------------------

function formatStarted(iso: string): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })
}

function formatDurationLong(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds - m * 60)
  return `${m}m ${s}s`
}

function formatRelative(date: Date): string {
  const diffMs = date.getTime() - Date.now()
  const diffDays = Math.round(diffMs / 86400000)
  if (diffDays < 0) return `${Math.abs(diffDays)}d ago`
  if (diffDays === 0) return 'today'
  return `in ${diffDays}d`
}

// Silence unused-warning for SetterCallWord re-export — referenced by
// TranscriptSection's `words` prop type.
export type { SetterCallWord }
