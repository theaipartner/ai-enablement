import { HeaderBand } from '@/components/gregory/header-band'
import { RevivalCalledSection } from '@/components/sales/revival-called'
import { RevivalFunnelSection } from '@/components/sales/revival-funnel'
import { RevivalTimeOfDaySection } from '@/components/sales/revival-time-of-day'
import { getOutboundFunnel } from '@/lib/db/funnel-revival'
import { PersonPill } from '../header-pills'

// Sales Dashboard — Outbound (top-level page).
//
// The DC re-engagement (outbound SMS) campaign's own funnel: every revival-tagged
// lead through responded → connected → booked → showed → closed, with a cash row.
// These leads are excluded from every other funnel/roster (they're SMS auto-creates,
// not real opt-ins), so this is the only surface that counts them. All-time —
// per-lead activity is anchored to the campaign start (see lib/db/funnel-revival.ts),
// there is no date window. (Internally still "revival"; the user-facing name is Outbound.)

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export default async function OutboundPage() {
  const { funnel, called, timeOfDay } = await getOutboundFunnel('revival')

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · OUTBOUND"
        title="Outbound."
        actions={<PersonPill label="EST · Nabeel" />}
      />

      <div
        className="geg-mono"
        style={{ marginTop: 14, fontSize: 10, letterSpacing: '0.04em', color: 'var(--color-geg-text-2)', lineHeight: 1.7 }}
      >
        The DC re-engagement SMS campaign. Every lead tagged <b>DC Revival Lead</b> in Close, from the
        re-engagement outreach through to the sale. These leads are excluded from every other funnel —
        this is the only place they&apos;re counted.
      </div>

      <RevivalFunnelSection funnel={funnel} />

      <RevivalCalledSection called={called} />

      <div
        className="geg-mono"
        style={{ marginTop: 14, fontSize: 9, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)', lineHeight: 1.8 }}
      >
        Of the leads we outbound-dialed after their reply, how fast we got to them and whether the dial
        connected. <b>Speed to dial</b> = first reply → first outbound call; bars stack connected (coral)
        over not-connected, with the connect % inside. Small n per bucket — read the trend, not single bars.
      </div>

      <RevivalTimeOfDaySection buckets={timeOfDay.buckets} />

      <div
        className="geg-mono"
        style={{ marginTop: 14, fontSize: 9, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)', lineHeight: 1.8 }}
      >
        When leads <b>reply</b> vs when we <b>dial</b> vs when we <b>connect</b>, by 2-hour ET window —
        wall-clock, no business-hours adjustment. Reply volume that lands outside the dialing window is the
        coverage gap to staff for. Connects are timed by the call (never the form).
      </div>

      <div
        className="geg-mono"
        style={{ marginTop: 16, fontSize: 9, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)', lineHeight: 1.8 }}
      >
        Called = ≥1 call (inbound or outbound, any length) · Connected = a <b>call</b> backed by a form{' '}
        <b>or</b> a call ≥90s (so a text-DQ with no call is not a connect) · Booked = a DC or HT booking ·
        Showed = a closer-report show · Closed = a DC close <b>with an explicit plan</b> (a &ldquo;DC
        Closed&rdquo; form with no plan is counted as a show, not a close) · Cash = $300 per Digital College
        plan unit. Activity is counted from each lead&apos;s revival start (created date, floored at the
        Jun 3 blast launch) so pre-existing leads&apos; old activity isn&apos;t counted.
      </div>
    </div>
  )
}
