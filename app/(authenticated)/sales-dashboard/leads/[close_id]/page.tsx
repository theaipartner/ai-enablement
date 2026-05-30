import Link from 'next/link'
import { notFound } from 'next/navigation'
import { HeaderBand } from '@/components/gregory/header-band'
import { getLeadDetail, type LeadCallEntry } from '@/lib/db/lead-detail'
import type { SetterCallReviewFull } from '@/lib/db/setter-calls'

// Per-lead detail page. One Close lead's opt-in facts + full call history,
// each call collapsed by default and expanding to its setter-call review.
// Reached from the appointment-setting lead list, the per-rep drill, and
// the /leads roster. Closing-call detail is stubbed for now (built later).

export const dynamic = 'force-dynamic'

export default async function LeadDetailPage({
  params,
}: {
  params: { close_id: string }
}) {
  const closeId = decodeURIComponent(params.close_id)
  const lead = await getLeadDetail(closeId)
  if (!lead) notFound()

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · LEAD"
        title={`${lead.prospectName ?? 'Unknown lead'}.`}
        actions={
          <Link
            href="/sales-dashboard/leads"
            className="geg-mono"
            style={{ fontSize: 11, letterSpacing: '0.06em', color: 'var(--color-geg-text-3)', textDecoration: 'none' }}
          >
            ← all leads
          </Link>
        }
      />

      <FactStrip lead={lead} />

      <SectionHeading>Calls</SectionHeading>
      {lead.calls.length === 0 ? (
        <Empty>No calls logged for this lead.</Empty>
      ) : (
        <div style={{ marginTop: 4 }}>
          {lead.calls.map((c) => (
            <CallEntry key={c.closeCallId} call={c} />
          ))}
        </div>
      )}

      <SectionHeading>Closing call</SectionHeading>
      <div
        className="geg-mono"
        style={{
          marginTop: 4,
          padding: '18px 16px',
          border: '1px dashed var(--color-geg-border)',
          borderRadius: 8,
          fontSize: 11,
          letterSpacing: '0.06em',
          color: 'var(--color-geg-text-faint)',
          textAlign: 'center',
        }}
      >
        Closing-call detail coming soon.
      </div>
    </div>
  )
}

// ----------------------------------------------------------------------
// Header facts
// ----------------------------------------------------------------------

function FactStrip({ lead }: { lead: Awaited<ReturnType<typeof getLeadDetail>> }) {
  if (!lead) return null
  const optIns = lead.numberOfOptIns ?? null
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 28,
        marginTop: 20,
        padding: '16px 18px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 8,
      }}
    >
      <Fact label="Qualified" value={qualLabel(lead.qualified)} valueColor={qualColor(lead.qualified)} />
      <Fact label="First opted in" value={lead.dateFirstOptedIn ? formatEtDate(lead.dateFirstOptedIn) : '—'} />
      <Fact label="Latest opt-in" value={lead.latestOptInDate ? formatEtTimestamp(lead.latestOptInDate) : '—'} />
      <Fact label="Opt-ins" value={optIns != null ? String(optIns) : '—'} />
      <Fact label="Calls" value={String(lead.totalCalls)} />
      <Fact
        label="Connected"
        value={
          lead.connectedCount > 0
            ? `${lead.connectedCount} · ${formatDuration(lead.totalConnectedDurationSec)}`
            : '0'
        }
        valueColor={lead.connectedCount > 0 ? 'var(--color-geg-pos)' : 'var(--color-geg-text-faint)'}
      />
      <Fact label="Caller" value={lead.primaryCallerName ?? '—'} />
    </div>
  )
}

function Fact({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0 }}>
      <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
        {label}
      </span>
      <span className="geg-serif" style={{ fontSize: 14, color: valueColor ?? 'var(--color-geg-text)', letterSpacing: '-0.002em', whiteSpace: 'nowrap' }}>
        {value}
      </span>
    </div>
  )
}

// ----------------------------------------------------------------------
// Call entry — collapsible when a review exists, plain row otherwise
// ----------------------------------------------------------------------

function CallEntry({ call }: { call: LeadCallEntry }) {
  const summary = <CallSummary call={call} expandable={call.review !== null} />

  if (call.review === null) {
    // No review to open — plain row, with a transcript link when one exists.
    return (
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '11px 12px',
          borderBottom: '1px dashed var(--color-geg-border)',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>{summary}</div>
        {call.hasTranscript ? <TranscriptLink id={call.closeCallId} /> : null}
      </div>
    )
  }

  return (
    <details style={{ borderBottom: '1px dashed var(--color-geg-border)' }}>
      <summary
        style={{
          listStyle: 'none',
          cursor: 'pointer',
          padding: '11px 12px',
          display: 'block',
        }}
      >
        {summary}
      </summary>
      <div style={{ padding: '4px 12px 18px' }}>
        <ReviewBody review={call.review} />
        {call.hasTranscript ? (
          <div style={{ marginTop: 12 }}>
            <TranscriptLink id={call.closeCallId} />
          </div>
        ) : null}
      </div>
    </details>
  )
}

function CallSummary({ call, expandable }: { call: LeadCallEntry; expandable: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
      {expandable ? (
        <span className="geg-mono" style={{ fontSize: 10, color: 'var(--color-geg-text-faint)', width: 10 }}>
          ▸
        </span>
      ) : (
        <span style={{ width: 10 }} />
      )}
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-2)', letterSpacing: '0.03em', width: 132, flexShrink: 0 }}>
        {formatEtTimestamp(call.activityAt)}
      </span>
      <DirectionTag direction={call.direction} />
      <span
        className="geg-numeric-serif"
        style={{ fontSize: 13, color: call.connected ? 'var(--color-geg-text)' : 'var(--color-geg-text-faint)', width: 64, flexShrink: 0 }}
        title={call.connected ? 'Connected (≥90s)' : 'Did not connect (<90s)'}
      >
        {formatDuration(call.durationSec)}
      </span>
      <span className="geg-serif" style={{ fontSize: 12, color: 'var(--color-geg-text-3)', flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {call.setterName ?? '—'}
      </span>
      {call.review ? (
        <ScorePill score={call.review.lead_score} dq={call.review.should_be_dqd} />
      ) : (
        <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', flexShrink: 0 }}>
          no review
        </span>
      )}
    </div>
  )
}

function DirectionTag({ direction }: { direction: string | null }) {
  const inbound = direction === 'inbound'
  const label = direction === 'inbound' ? 'in' : direction === 'outbound' ? 'out' : '—'
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 8.5,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-faint)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 4,
        padding: '1px 5px',
        width: 34,
        textAlign: 'center',
        flexShrink: 0,
      }}
      title={inbound ? 'Inbound call' : direction === 'outbound' ? 'Outbound dial' : 'Unknown direction'}
    >
      {label}
    </span>
  )
}

function ScorePill({ score, dq }: { score: number; dq: boolean }) {
  const color = score <= 3 ? 'var(--color-geg-neg)' : score >= 7 ? 'var(--color-geg-pos)' : 'var(--color-geg-text-2)'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
      {dq ? (
        <span className="geg-mono" style={{ fontSize: 8.5, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-neg)', border: '1px solid var(--color-geg-neg-border)', borderRadius: 4, padding: '1px 4px' }}>
          DQ
        </span>
      ) : null}
      <span className="geg-numeric-serif" style={{ fontSize: 13, color }} title="Lead score / 10">
        {score}<span style={{ color: 'var(--color-geg-text-faint)', fontSize: 10 }}>/10</span>
      </span>
    </span>
  )
}

function TranscriptLink({ id }: { id: string }) {
  return (
    <Link
      href={`/sales-dashboard/calls/${encodeURIComponent(id)}`}
      className="geg-mono"
      style={{ fontSize: 10, letterSpacing: '0.06em', color: 'var(--color-geg-accent)', textDecoration: 'none', flexShrink: 0 }}
    >
      transcript →
    </Link>
  )
}

// ----------------------------------------------------------------------
// Review body — mirrors the call detail page's ReviewBox sections
// ----------------------------------------------------------------------

function ReviewBody({ review }: { review: SetterCallReviewFull }) {
  return (
    <div>
      <ReviewSection title="Sentiment">
        <p className="geg-serif" style={{ fontSize: 14, lineHeight: 1.55, color: 'var(--color-geg-text)', margin: 0 }}>
          {review.sentiment}
        </p>
      </ReviewSection>

      <ReviewSection title={`Why this score · ${review.lead_score} / 10`}>
        <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--color-geg-text)', margin: 0 }}>
          {review.lead_score_reason}
        </p>
      </ReviewSection>

      {review.setter_strengths.length > 0 ? (
        <ReviewSection title="Setter strengths" count={review.setter_strengths.length}>
          <ReviewList items={review.setter_strengths} />
        </ReviewSection>
      ) : null}

      {review.setter_weaknesses.length > 0 ? (
        <ReviewSection title="Setter weaknesses" count={review.setter_weaknesses.length}>
          <ReviewList items={review.setter_weaknesses} />
        </ReviewSection>
      ) : null}

      {review.lead_attributes.length > 0 ? (
        <ReviewSection title="Lead attributes">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {review.lead_attributes.map((attr) => (
              <span
                key={attr}
                className="geg-mono"
                style={{ fontSize: 10, letterSpacing: '0.04em', color: 'var(--color-geg-text-2)', border: '1px solid var(--color-geg-border)', borderRadius: 4, padding: '2px 7px' }}
              >
                {attr}
              </span>
            ))}
          </div>
        </ReviewSection>
      ) : null}

      {review.booked === false && review.no_book_reason ? (
        <ReviewSection title="Why didn't book">
          <p style={{ fontSize: 13, lineHeight: 1.55, color: 'var(--color-geg-text)', margin: 0, paddingLeft: 12, borderLeft: '2px solid var(--color-geg-neg-border)' }}>
            {review.no_book_reason}
          </p>
        </ReviewSection>
      ) : null}
    </div>
  )
}

function ReviewSection({ title, count, children }: { title: string; count?: number; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <h4
        className="geg-mono"
        style={{ fontSize: 9.5, fontWeight: 500, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-geg-text-2)', margin: '0 0 8px', display: 'flex', alignItems: 'center', gap: 8 }}
      >
        {title}
        {count !== undefined ? <span style={{ color: 'var(--color-geg-text-faint)' }}>{count}</span> : null}
      </h4>
      {children}
    </div>
  )
}

function ReviewList({ items }: { items: SetterCallReviewFull['setter_strengths'] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {items.map((it, i) => (
        <div key={i} style={{ paddingLeft: 12, borderLeft: '2px solid var(--color-geg-border)' }}>
          <div className="geg-serif" style={{ fontSize: 13, color: 'var(--color-geg-text)', lineHeight: 1.5 }}>
            {it.point}
          </div>
          {it.evidence ? (
            <div className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-3)', marginTop: 3, lineHeight: 1.45, fontStyle: 'italic' }}>
              {it.evidence}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  )
}

// ----------------------------------------------------------------------
// Small shared bits
// ----------------------------------------------------------------------

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', margin: '30px 0 0' }}>
      {children}
    </h3>
  )
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="geg-mono" style={{ marginTop: 4, padding: '28px 0', textAlign: 'center', fontSize: 11, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
      {children}
    </div>
  )
}

function qualLabel(q: 'qualified' | 'non-qualified' | 'unknown'): string {
  return q === 'qualified' ? 'Qualified' : q === 'non-qualified' ? 'Not qualified' : '—'
}
function qualColor(q: 'qualified' | 'non-qualified' | 'unknown'): string {
  return q === 'qualified' ? 'var(--color-geg-pos)' : q === 'non-qualified' ? 'var(--color-geg-text-3)' : 'var(--color-geg-text-faint)'
}

function formatEtTimestamp(iso: string): string {
  if (!iso) return '—'
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso))
}

function formatEtDate(iso: string): string {
  if (!iso) return '—'
  // date_first_opted_in is a bare `date` — append midnight so it parses,
  // and render in ET without a time component.
  const d = iso.length <= 10 ? new Date(`${iso}T00:00:00`) : new Date(iso)
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(d)
}

function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '—'
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) {
    const m = Math.floor(sec / 60)
    const s = Math.round(sec % 60)
    return s === 0 ? `${m}m` : `${m}m ${s}s`
  }
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec - h * 3600) / 60)
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}
