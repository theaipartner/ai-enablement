import Link from 'next/link'
import { notFound } from 'next/navigation'
import { HeaderBand } from '@/components/gregory/header-band'
import { getLeadDetail, type LeadTimelineEvent } from '@/lib/db/lead-detail'

// Per-lead detail page. One Close lead's opt-in facts + header (qualification,
// dials/connected counts, booking stage) + a form-driven lifecycle timeline:
// the opt-in anchor, every Airtable form outcome in chronological order, and
// the trailing follow-up booking. Reached from the appointment-setting lead
// list, the per-rep drill, and the /leads roster.

export const dynamic = 'force-dynamic'

export default async function LeadDetailPage({
  params,
  searchParams,
}: {
  params: { close_id: string }
  searchParams?: { ret?: string | string[] }
}) {
  const closeId = decodeURIComponent(params.close_id)
  const lead = await getLeadDetail(closeId)
  if (!lead) notFound()

  // Return to the leads page preserving the window/filters it was left in
  // (carried as `ret`). Falls back to the bare leads page when arrived directly.
  const ret = (Array.isArray(searchParams?.ret) ? searchParams?.ret[0] : searchParams?.ret) ?? ''
  const backHref = ret ? `/sales-dashboard/leads?${ret}` : '/sales-dashboard/leads'

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · LEAD"
        title={`${lead.prospectName ?? 'Unknown lead'}.`}
        actions={
          <Link
            href={backHref}
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

      <SectionHeading>Journey</SectionHeading>
      <div className="geg-mono" style={{ marginTop: 2, marginBottom: 10, fontSize: 9, letterSpacing: '0.08em', color: 'var(--color-geg-text-faint)' }}>
        funnel progress · direct phase{lead.reactivatedAt ? ' → reactive phase' : ''}
      </div>
      <JourneyProgress lead={lead} />

      <SectionHeading>Lifecycle</SectionHeading>
      <div className="geg-mono" style={{ marginTop: 2, marginBottom: 8, fontSize: 9, letterSpacing: '0.08em', color: 'var(--color-geg-text-faint)' }}>
        in order · since latest opt-in
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
      {lead.reactivatedAt ? (
        <Fact label="Reactivated" value={formatEtDate(lead.reactivatedAt)} valueColor="var(--color-geg-warn)" />
      ) : null}
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

// ----------------------------------------------------------------------
// Journey — explicit funnel-progress view. One segment for the lead's primary
// path (Direct or Setter-led); a SECOND "Reactivation" segment when the lead
// lost its direct strat spot, showing post-handover progress (Drake Step 5).
// DQ leads still render their progress with a terminal "DQ" marker (DQ wins the
// roster colour, but the page shows how far they got).
// ----------------------------------------------------------------------

// Reactivation pale blue (no palette token — matches the leads funnel coat).
const REACT_BLUE = '#7ea8dd'

type JStage = { label: string; hit: boolean }
type JSegment = { label: string; color: string; stages: JStage[]; since?: string | null }

function JourneyProgress({ lead }: { lead: NonNullable<Awaited<ReturnType<typeof getLeadDetail>>> }) {
  const bt = lead.bookingType
  const segments: JSegment[] = []

  // Primary path. A direct or reactivation lead booked the strat link → Direct
  // phase (Booked → Confirmed → Showed → Closed, cumulative). A setter-only
  // lead → Setter-led (Booked → Showed → Closed, no Confirmed stage). A
  // reactivated lead is direct by definition, so it always gets the Direct phase
  // even if the Calendly booking match didn't resolve here.
  if (bt === 'direct' || bt === 'reactivation' || lead.reactivatedAt) {
    segments.push({
      label: 'Direct',
      color: 'var(--color-geg-pos)',
      stages: [
        { label: 'Booked', hit: true },
        // Literal — "Confirmed" means the confirmation call actually confirmed
        // (a confirmation-form DQ is NOT a confirm), so it is NOT back-filled
        // from showed/closed here on the factual per-lead view.
        { label: 'Confirmed', hit: lead.confirmed },
        { label: 'Showed', hit: lead.showed || lead.closed },
        { label: 'Closed', hit: lead.closed },
      ],
    })
  } else if (bt === 'setter') {
    segments.push({
      label: 'Setter-led',
      color: 'var(--color-geg-warn)',
      stages: [
        { label: 'Booked', hit: true },
        { label: 'Showed', hit: lead.showed || lead.closed },
        { label: 'Closed', hit: lead.closed },
      ],
    })
  }

  // Reactive phase — only when the lead lost its spot. Floors at "Eligible"
  // (lost the spot, available for reactivation) UNLESS the lead DQ'd — a DQ'd
  // lead is not eligible, so the terminal DQ chip carries the state instead.
  if (lead.reactivatedAt) {
    segments.push({
      label: 'Reactivation',
      color: REACT_BLUE,
      since: lead.reactivatedAt,
      stages: [
        ...(lead.isDq ? [] : [{ label: 'Eligible', hit: true }]),
        { label: 'Connected', hit: lead.reactConnected || lead.reactBooked || lead.reactShowed || lead.reactClosed },
        { label: 'Booked', hit: lead.reactBooked || lead.reactShowed || lead.reactClosed },
        { label: 'Showed', hit: lead.reactShowed || lead.reactClosed },
        { label: 'Closed', hit: lead.reactClosed },
      ],
    })
  }

  if (segments.length === 0) {
    return (
      <div className="geg-serif" style={{ fontSize: 14, color: 'var(--color-geg-text-faint)', padding: '4px 0' }}>
        Not booked{lead.isDq ? ' · ' : ''}
        {lead.isDq ? <DqChip /> : null}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {segments.map((seg, si) => (
        <div key={seg.label}>
          {si > 0 ? (
            <div className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', margin: '0 0 8px 2px' }}>
              ↓ lost spot{seg.since ? ` · ${formatEtDate(seg.since)}` : ''}
            </div>
          ) : null}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
            <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: seg.color, width: 92, flexShrink: 0 }}>
              {seg.label}
            </span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, flexWrap: 'wrap' }}>
              {seg.stages.map((s, i) => (
                <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  {i > 0 ? <span style={{ color: 'var(--color-geg-text-faint)', fontSize: 10 }}>›</span> : null}
                  <StageChip label={s.label} hit={s.hit} color={seg.color} />
                </span>
              ))}
              {/* DQ terminal marker on the last segment */}
              {lead.isDq && si === segments.length - 1 ? (
                <>
                  <span style={{ color: 'var(--color-geg-text-faint)', fontSize: 10 }}>·</span>
                  <DqChip />
                </>
              ) : null}
            </span>
          </div>
        </div>
      ))}
    </div>
  )
}

function StageChip({ label, hit, color }: { label: string; hit: boolean; color: string }) {
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 9,
        letterSpacing: '0.04em',
        textTransform: 'uppercase',
        padding: '3px 8px',
        borderRadius: 4,
        border: `1px solid ${hit ? color : 'var(--color-geg-border)'}`,
        color: hit ? color : 'var(--color-geg-text-faint)',
        background: hit ? 'color-mix(in srgb, ' + color + ' 10%, transparent)' : 'transparent',
      }}
    >
      {label}
    </span>
  )
}

function DqChip() {
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 9,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        padding: '3px 8px',
        borderRadius: 4,
        border: '1px solid var(--color-geg-neg)',
        color: 'var(--color-geg-neg)',
      }}
    >
      DQ
    </span>
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
// Lifecycle timeline — form-driven, oldest first: the opt-in anchor, every
// Airtable form outcome (setter triage / confirmation / closer EOC) in order,
// and the trailing follow-up booking. No close_calls (no reliable form↔call
// link) — see lib/db/lead-detail.ts.
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
  if (ev.kind === 'followup') {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <Dot color="var(--color-geg-warn)" />
        <span className="geg-serif" style={{ fontSize: 13, color: 'var(--color-geg-text)' }}>Follow-up booked</span>
        <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-3)' }}>{ev.name}</span>
      </span>
    )
  }
  // form outcome (setter triage / confirmation / closer EOC)
  const color = dispositionColor(ev.label)
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <Dot color={color} />
      <span className="geg-serif" style={{ fontSize: 13, color }}>{ev.label}</span>
      <span className="geg-mono" style={{ fontSize: 9, color: 'var(--color-geg-text-faint)', letterSpacing: '0.06em', textTransform: 'uppercase', border: '1px solid var(--color-geg-border)', borderRadius: 4, padding: '1px 5px' }}>{sourceLabel(ev.source)}</span>
    </span>
  )
}

function sourceLabel(s: 'triage' | 'confirmation' | 'closer'): string {
  return s === 'triage' ? 'Setter triage' : s === 'confirmation' ? 'Confirmation' : 'Closer'
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
