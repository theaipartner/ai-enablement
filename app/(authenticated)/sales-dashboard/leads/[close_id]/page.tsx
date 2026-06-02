import Link from 'next/link'
import { notFound } from 'next/navigation'
import { HeaderBand } from '@/components/gregory/header-band'
import { getLeadDetail, type LeadTimelineEvent, type LeadCallEntry } from '@/lib/db/lead-detail'

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
        funnel progress · {lead.tagIsDirect ? 'direct' : 'opt-in'} phase{lead.tagReactivatedAt ? ' → reactive phase' : ''}
      </div>
      <JourneyProgress lead={lead} />

      {lead.closeDetail ? <CloseDetails detail={lead.closeDetail} /> : null}

      <SectionHeading>Lifecycle</SectionHeading>
      <div className="geg-mono" style={{ marginTop: 2, marginBottom: 8, fontSize: 9, letterSpacing: '0.08em', color: 'var(--color-geg-text-faint)' }}>
        by day · newest first · full history (opt-ins divide journeys)
      </div>
      {lead.timeline.length === 0 && lead.calls.length === 0 ? (
        <Empty>No activity yet.</Empty>
      ) : (
        <Lifecycle timeline={lead.timeline} calls={lead.calls} leadId={lead.leadId} />
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
          // Broad connected (form-OR-call). Show the ≥90s call count + talk time
          // when there is one; otherwise just "Yes" (reached via a form).
          lead.connected
            ? lead.connectedCount > 0
              ? `${lead.connectedCount} · ${formatDuration(lead.totalConnectedDurationSec)}`
              : 'Yes'
            : 'No'
        }
        valueColor={lead.connected ? 'var(--color-geg-pos)' : 'var(--color-geg-text-faint)'}
      />
      <Fact label="Reschedules" value={String(lead.rescheduleCount)} />
      <Fact label="Follow-ups" value={String(lead.followUpCount)} />
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
  const segments: JSegment[] = []
  // Terminal stage reads the offer (HT-only today; DC is excluded from the tags).
  const closedLabel =
    lead.tagCloseType === 'dc' ? 'Digital College' : lead.tagCloseType === 'ht' ? 'High Ticket' : 'Closed'
  const P = lead.journeyPrimary
  const R = lead.journeyReactive ?? { connected: false, booked: false, confirmed: false, showed: false, closed: false }

  // Primary lane — Direct (self-booked a strat call) or Opt-in, by the tag.
  // A direct lead is NOT shown an opt-in lane; an opt-in lead (incl. one that
  // later reactivated) shows the Opt-in lane (Drake 2026-06-02). The tagger's
  // per-phase stage hits are already monotonic and encode the direct
  // connected-skip, so we render them directly — no page-side back-fill.
  if (lead.tagIsDirect) {
    segments.push({
      label: 'Direct',
      color: 'var(--color-geg-pos)',
      stages: [
        { label: 'Booked', hit: P.booked },
        { label: 'Connected', hit: P.connected },
        { label: 'Confirmed', hit: P.confirmed },
        { label: 'Showed', hit: P.showed },
        { label: closedLabel, hit: P.closed },
      ],
    })
  } else {
    segments.push({
      label: 'Opt-in',
      color: 'var(--color-geg-warn)',
      stages: [
        { label: 'Connected', hit: P.connected },
        { label: 'Booked', hit: P.booked },
        { label: 'Showed', hit: P.showed },
        { label: closedLabel, hit: P.closed },
      ],
    })
  }

  // Reactive lane — only when the lead lost its spot. Floors at "Eligible".
  if (lead.tagReactivatedAt) {
    segments.push({
      label: 'Reactivation',
      color: REACT_BLUE,
      since: lead.tagReactivatedAt,
      stages: [
        { label: 'Eligible', hit: true },
        { label: 'Connected', hit: R.connected },
        { label: 'Booked', hit: R.booked },
        { label: 'Showed', hit: R.showed },
        { label: closedLabel, hit: R.closed },
      ],
    })
  }

  // Every lead now has at least one lane (direct or opt-in), so the journey is
  // always surfaced — no "not booked" empty state.
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
              {lead.tagIsDq && si === segments.length - 1 ? (
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

// Close details — the offer closed (High Ticket / Digital College), the closer,
// the DC plan breakdown (Base44 / Wix × Mo/Yr), and the meeting time.
function CloseDetails({ detail }: { detail: NonNullable<Awaited<ReturnType<typeof getLeadDetail>>>['closeDetail'] }) {
  if (!detail) return null
  const offerLabel = detail.offer === 'dc' ? 'Digital College' : 'High Ticket'
  const planText = detail.plans.length ? formatDcPlans(detail.plans) : null
  return (
    <>
      <SectionHeading>Close details</SectionHeading>
      <div
        style={{
          display: 'flex', flexWrap: 'wrap', gap: 28, marginTop: 10,
          padding: '16px 18px', background: 'var(--color-geg-pos-fill)',
          border: '1px solid var(--color-geg-pos-border)', borderRadius: 8,
        }}
      >
        <Fact label="Offer" value={offerLabel} valueColor="var(--color-geg-pos)" />
        <Fact label="Closer" value={detail.closer ?? '—'} />
        {planText ? <Fact label="Plan" value={planText} /> : null}
        <Fact label="Closed on" value={detail.at ? formatEtTimestamp(detail.at) : '—'} />
      </div>
    </>
  )
}

// Render the DC plan multi-select with the Base44 display label.
function formatDcPlans(plans: string[]): string {
  return plans
    .map((p) => {
      const v = p.toLowerCase()
      const product = v.includes('wix') ? 'Wix' : v.includes('base') ? 'Base44' : p
      const cadence = v.includes('year') || v.includes('annual') ? 'Yearly' : v.includes('month') ? 'Monthly' : ''
      return cadence ? `${product} ${cadence}` : product
    })
    .join(' · ')
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
// Lifecycle — grouped BY DAY (newest first), since latest opt-in. Each day
// lists the calls (time · caller · duration · link to the per-call review) and
// the forms filled (disposition · source · who filled it), plus opt-in /
// follow-up markers. Calls and forms are shown side by side, NOT matched.
// ----------------------------------------------------------------------

function etDayKey(iso: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
}
function etDayHeader(iso: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(iso))
}

type FormEvt = Extract<LeadTimelineEvent, { kind: 'form' }>
type DayGroup = {
  key: string
  at: string // representative instant for sorting/header
  forms: FormEvt[]
  calls: LeadCallEntry[]
  optIn: 'opted' | 'reopted' | null
  followUps: string[]
}

function Lifecycle({ timeline, calls, leadId }: { timeline: LeadTimelineEvent[]; calls: LeadCallEntry[]; leadId: string }) {
  const byDay = new Map<string, DayGroup>()
  const get = (iso: string): DayGroup => {
    const key = etDayKey(iso)
    let g = byDay.get(key)
    if (!g) {
      g = { key, at: iso, forms: [], calls: [], optIn: null, followUps: [] }
      byDay.set(key, g)
    }
    return g
  }
  for (const ev of timeline) {
    const g = get(ev.at)
    if (ev.kind === 'form') g.forms.push(ev)
    // A re-opt-in wins the day's marker (it's the journey divider).
    else if (ev.kind === 'optin') g.optIn = ev.reopt ? 'reopted' : g.optIn ?? 'opted'
    else if (ev.kind === 'followup') g.followUps.push(ev.name)
  }
  for (const c of calls) get(c.activityAt).calls.push(c)

  const days = Array.from(byDay.values()).sort((a, b) => (a.key < b.key ? 1 : -1)) // newest first
  for (const d of days) {
    d.calls.sort((a, b) => (a.activityAt < b.activityAt ? -1 : 1))
    d.forms.sort((a, b) => (a.at < b.at ? -1 : 1))
  }

  return (
    <div style={{ marginTop: 4, display: 'flex', flexDirection: 'column', gap: 14 }}>
      {days.map((d) => (
        <DayBlock key={d.key} day={d} leadId={leadId} />
      ))}
    </div>
  )
}

function DayBlock({ day, leadId }: { day: DayGroup; leadId: string }) {
  return (
    <div style={{ border: '1px solid var(--color-geg-border)', borderRadius: 8, overflow: 'hidden' }}>
      <div
        className="geg-mono"
        style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', padding: '8px 12px', background: 'var(--color-geg-bg-elev)', borderBottom: '1px solid var(--color-geg-border)', display: 'flex', justifyContent: 'space-between', gap: 8 }}
      >
        <span>{etDayHeader(day.at)}</span>
        <span style={{ color: 'var(--color-geg-text-faint)' }}>
          {day.calls.length ? `${day.calls.length} call${day.calls.length === 1 ? '' : 's'}` : ''}
          {day.calls.length && day.forms.length ? ' · ' : ''}
          {day.forms.length ? `${day.forms.length} form${day.forms.length === 1 ? '' : 's'}` : ''}
          {day.optIn === 'reopted' ? ' · re-opted in' : day.optIn === 'opted' ? ' · opted in' : ''}
        </span>
      </div>
      <div style={{ padding: '6px 12px 8px' }}>
        {day.optIn ? (
          <Row time="">
            <Dot color={day.optIn === 'reopted' ? 'var(--color-geg-accent)' : 'var(--color-geg-text-3)'} />
            <span
              className="geg-serif"
              style={{ fontSize: 13, color: day.optIn === 'reopted' ? 'var(--color-geg-accent)' : 'var(--color-geg-text-2)', fontWeight: day.optIn === 'reopted' ? 600 : 400 }}
            >
              {day.optIn === 'reopted' ? 'Re-opted in — new journey' : 'Opted in'}
            </span>
          </Row>
        ) : null}
        {day.calls.map((c) => (
          <CallRow key={c.closeCallId} c={c} leadId={leadId} />
        ))}
        {day.forms.map((f, i) => (
          <FormRow key={`f${i}`} ev={f} />
        ))}
        {day.followUps.map((name, i) => (
          <Row key={`fu${i}`} time="">
            <Dot color="var(--color-geg-warn)" />
            <span className="geg-serif" style={{ fontSize: 13, color: 'var(--color-geg-text)' }}>Follow-up booked</span>
            <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-3)' }}>{name}</span>
          </Row>
        ))}
      </div>
    </div>
  )
}

function Row({ time, children }: { time: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'baseline', padding: '7px 0', borderBottom: '1px dashed var(--color-geg-border)' }}>
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.03em', width: 64, flexShrink: 0 }}>{time}</span>
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>{children}</div>
    </div>
  )
}

function CallRow({ c, leadId }: { c: LeadCallEntry; leadId: string }) {
  const color = c.connected ? 'var(--color-geg-pos)' : 'var(--color-geg-text-faint)'
  // Carry the source lead so the per-call page's "Back to lead" returns here.
  const callHref = `/sales-dashboard/calls/${encodeURIComponent(c.closeCallId)}?lead=${encodeURIComponent(leadId)}`
  const label = `${c.direction === 'inbound' ? 'Inbound call' : 'Call'}${c.setterName ? ` · ${c.setterName}` : ''}`
  // Sub-90s calls aren't connected and never get a transcript/review, so they
  // don't link anywhere — render the label as plain text and drop the open
  // button. Connected calls link to the per-call review/open page.
  return (
    <Row time={formatEtTime(c.activityAt)}>
      <Dot color={color} />
      {c.connected ? (
        <Link href={callHref} className="geg-serif" style={{ fontSize: 13, color: 'var(--color-geg-text)', textDecoration: 'none' }}>
          {label}
        </Link>
      ) : (
        <span className="geg-serif" style={{ fontSize: 13, color: 'var(--color-geg-text-2)' }}>{label}</span>
      )}
      <span className="geg-mono" style={{ fontSize: 11, color }}>{formatDuration(c.durationSec)}</span>
      {!c.connected ? <span className="geg-mono" style={{ fontSize: 9, color: 'var(--color-geg-text-faint)' }}>(not connected)</span> : null}
      {c.connected ? (
        <Link
          href={callHref}
          className="geg-mono"
          style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-accent)', border: '1px solid var(--color-geg-border)', borderRadius: 4, padding: '1px 6px', textDecoration: 'none', marginLeft: 'auto' }}
        >
          {c.hasTranscript ? 'review →' : 'open →'}
        </Link>
      ) : null}
    </Row>
  )
}

function FormRow({ ev }: { ev: FormEvt }) {
  const color = dispositionColor(ev.label)
  return (
    <Row time="">
      <Dot color={color} />
      <span className="geg-serif" style={{ fontSize: 13, color }}>{ev.label}</span>
      <span className="geg-mono" style={{ fontSize: 9, color: 'var(--color-geg-text-faint)', letterSpacing: '0.06em', textTransform: 'uppercase', border: '1px solid var(--color-geg-border)', borderRadius: 4, padding: '1px 5px' }}>{sourceLabel(ev.source)}</span>
      {ev.by ? <span className="geg-mono" style={{ fontSize: 10, color: 'var(--color-geg-text-3)' }}>by {ev.by}</span> : null}
    </Row>
  )
}

function Dot({ color }: { color: string }) {
  return <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flexShrink: 0, display: 'inline-block' }} />
}

function sourceLabel(s: 'triage' | 'confirmation' | 'closer' | 'dc'): string {
  return s === 'triage'
    ? 'Setter triage'
    : s === 'confirmation'
      ? 'Confirmation'
      : s === 'dc'
        ? 'Digital College'
        : 'Closer'
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

// Time-of-day only (ET), for the per-day lifecycle call rows.
function formatEtTime(iso: string): string {
  if (!iso) return ''
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
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
