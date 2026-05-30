import Link from 'next/link'
import { notFound } from 'next/navigation'
import { HeaderBand } from '@/components/gregory/header-band'
import { getLeadDetail, type LeadTimelineEvent } from '@/lib/db/lead-detail'

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
            style={{
              fontSize: 11,
              letterSpacing: '0.06em',
              color: 'var(--color-geg-text-2)',
              textDecoration: 'none',
              border: '1px solid var(--color-geg-border)',
              borderRadius: 6,
              padding: '6px 12px',
              background: 'var(--color-geg-bg-elev)',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            ← Back to leads
          </Link>
        }
      />

      <FactStrip lead={lead} />

      <SectionHeading>Lifecycle</SectionHeading>
      <div className="geg-mono" style={{ marginTop: 2, marginBottom: 8, fontSize: 9, letterSpacing: '0.08em', color: 'var(--color-geg-text-faint)' }}>
        newest first · since latest opt-in
      </div>
      {lead.timeline.length === 0 ? (
        <Empty>No activity since the latest opt-in.</Empty>
      ) : (
        <Lifecycle events={lead.timeline} />
      )}
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
      <StageFact lead={lead} />
      <Fact label="Dials" value={String(lead.totalCalls)} />
      <Fact
        label="Connected"
        value={
          lead.connectedCount > 0
            ? `${lead.connectedCount} · ${formatDuration(lead.totalConnectedDurationSec)}`
            : '0'
        }
        valueColor={lead.connectedCount > 0 ? 'var(--color-geg-pos)' : 'var(--color-geg-text-faint)'}
      />
      <Fact label="Reschedules" value={String(lead.rescheduleCount)} />
      <Fact label="Follow-ups" value={String(lead.followUpCount)} />
      <Fact label="Caller" value={lead.primaryCallerName ?? '—'} />
    </div>
  )
}

// Booking path + funnel progress (Booked → [Confirmed] → Showed → Closed;
// Confirmed only on the direct path).
function StageFact({ lead }: { lead: NonNullable<Awaited<ReturnType<typeof getLeadDetail>>> }) {
  const bt = lead.bookingType
  const typeLabel = bt === 'direct' ? 'Direct' : bt === 'reactivation' ? 'Reactivation' : bt === 'setter' ? 'Setter-led' : null
  const stages: Array<{ label: string; hit: boolean }> = bt
    ? [
        { label: 'Booked', hit: true },
        ...(bt === 'direct' ? [{ label: 'Confirmed', hit: lead.confirmed }] : []),
        { label: 'Showed', hit: lead.showed },
        { label: 'Closed', hit: lead.closed },
      ]
    : []
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 }}>
      <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
        Stage{typeLabel ? ` · ${typeLabel}` : ''}
      </span>
      {bt ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {stages.map((s, i) => (
            <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              {i > 0 ? <span style={{ color: 'var(--color-geg-text-faint)', fontSize: 9 }}>›</span> : null}
              <span
                className="geg-mono"
                style={{
                  fontSize: 9,
                  letterSpacing: '0.04em',
                  textTransform: 'uppercase',
                  padding: '2px 6px',
                  borderRadius: 4,
                  border: `1px solid ${s.hit ? 'var(--color-geg-pos)' : 'var(--color-geg-border)'}`,
                  color: s.hit ? 'var(--color-geg-pos)' : 'var(--color-geg-text-faint)',
                }}
              >
                {s.label}
              </span>
            </span>
          ))}
        </span>
      ) : (
        <span className="geg-serif" style={{ fontSize: 14, color: 'var(--color-geg-text-faint)' }}>Not booked</span>
      )}
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

// ----------------------------------------------------------------------
// Lifecycle timeline — newest first; dial-runs, connected calls (link to the
// review), bookings, and form dispositions as rows.
// ----------------------------------------------------------------------

function Lifecycle({ events }: { events: LeadTimelineEvent[] }) {
  return (
    <div style={{ marginTop: 4 }}>
      {events.map((e, i) => (
        <TimelineRow key={i} ev={e} />
      ))}
    </div>
  )
}

function TimelineRow({ ev }: { ev: LeadTimelineEvent }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '9px 12px', borderBottom: '1px dashed var(--color-geg-border)' }}>
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.03em', width: 120, flexShrink: 0 }}>
        {formatEtTimestamp(ev.at)}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <EventBody ev={ev} />
      </div>
    </div>
  )
}

function Dot({ color }: { color: string }) {
  return <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
}

function EventBody({ ev }: { ev: LeadTimelineEvent }) {
  if (ev.kind === 'optin') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Dot color="var(--color-geg-text-3)" />
        <span className="geg-serif" style={{ fontSize: 13, color: 'var(--color-geg-text-2)' }}>Opted in</span>
      </span>
    )
  }
  if (ev.kind === 'dials') {
    return (
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.04em' }}>
        {ev.count} dial{ev.count === 1 ? '' : 's'}
      </span>
    )
  }
  if (ev.kind === 'connected') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Dot color="var(--color-geg-pos)" />
        <span className="geg-serif" style={{ fontSize: 13, color: 'var(--color-geg-text)' }}>Connected call</span>
        <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-3)' }}>
          {ev.caller ?? '—'} · {formatDuration(ev.durationSec)}
        </span>
        <Link
          href={`/sales-dashboard/calls/${encodeURIComponent(ev.closeCallId)}`}
          className="geg-mono"
          style={{ fontSize: 10, letterSpacing: '0.06em', color: 'var(--color-geg-accent)', textDecoration: 'none' }}
        >
          {ev.hasReview ? 'review →' : 'open →'}
        </Link>
      </span>
    )
  }
  if (ev.kind === 'booking') {
    const label = ev.link === 'direct' ? 'Direct' : ev.link === 'setter' ? 'Setter-led' : ev.link === 'sync' ? 'Sync follow-up' : 'Call'
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <Dot color="var(--color-geg-accent)" />
        <span className="geg-serif" style={{ fontSize: 13, color: 'var(--color-geg-text)' }}>Booked</span>
        <span className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-accent)', border: '1px solid var(--color-geg-accent)', borderRadius: 4, padding: '1px 5px' }}>
          {label}
        </span>
        {ev.bookedBy ? (
          <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-3)' }}>by {ev.bookedBy}</span>
        ) : null}
      </span>
    )
  }
  const color = dispositionColor(ev.label)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <Dot color={color} />
      <span className="geg-serif" style={{ fontSize: 13, color }}>{ev.label}</span>
      <span className="geg-mono" style={{ fontSize: 9, color: 'var(--color-geg-text-faint)', letterSpacing: '0.06em', textTransform: 'uppercase' }}>{ev.source}</span>
    </span>
  )
}

function dispositionColor(label: string): string {
  const v = label.toLowerCase()
  if (v.includes('closed')) return 'var(--color-geg-pos)'
  if (v.includes('ghost') || v.includes('no show') || v.includes('dq') || v.includes('cancel') || v.includes('lost') || v.includes('interest')) return 'var(--color-geg-neg)'
  if (v.includes('follow') || v.includes('reschedul') || v.includes('pipeline') || v.includes('deposit')) return 'var(--color-geg-warn)'
  if (v.includes('confirm') || v.includes('book')) return 'var(--color-geg-accent)'
  return 'var(--color-geg-text-2)'
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
  // A bare `date` (YYYY-MM-DD, e.g. date_first_opted_in) is a calendar day, NOT
  // an instant — parse + render in UTC so it stays on its day. (Rendering it in
  // ET shifts UTC-midnight back a day; the Rahul Chakri "new opt-in, two
  // different dates" symptom. ADR 0003.)
  if (iso.length <= 10) {
    return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${iso}T00:00:00Z`))
  }
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso))
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
