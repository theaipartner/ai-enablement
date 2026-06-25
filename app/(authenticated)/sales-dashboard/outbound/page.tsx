import { HeaderBand } from '@/components/gregory/header-band'
import { RevivalCalledSection } from '@/components/sales/revival-called'
import { RevivalFunnelSection } from '@/components/sales/revival-funnel'
import { RevivalTimeOfDaySection } from '@/components/sales/revival-time-of-day'
import { OutboundCampaignSwitcher } from '@/components/sales/outbound-campaign-switcher'
import { getOutboundFunnel, getOutboundCampaigns } from '@/lib/db/funnel-revival'
import { PersonPill } from '../header-pills'

// Sales Dashboard — Outbound (top-level page).
//
// One funnel per outbound campaign pool (Revival, Jacob, …), switched by a
// segmented control. Each pool's leads are tagged in Close with that campaign's
// custom field and excluded from every other funnel/roster — this is the only
// surface that counts them. All-time: per-lead activity is anchored to the
// campaign start (greatest(date_created, floor); see lib/db/funnel-revival.ts).

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function CampaignIntro({ campaignKey }: { campaignKey: string }) {
  if (campaignKey === 'jacob') {
    return (
      <>
        The <b>ECJ Reactivation (Jacob)</b> outbound campaign. Every lead matching the ECJ roster
        (tagged <b>Jacob Lead</b> in Close), from the outreach through to the sale. These leads are
        excluded from every other funnel — this is the only place they&apos;re counted.
      </>
    )
  }
  return (
    <>
      The DC re-engagement SMS campaign. Every lead tagged <b>DC Revival Lead</b> in Close, from the
      re-engagement outreach through to the sale. These leads are excluded from every other funnel —
      this is the only place they&apos;re counted.
    </>
  )
}

export default async function OutboundPage({
  searchParams,
}: {
  searchParams?: { campaign?: string | string[] }
}) {
  const campaigns = await getOutboundCampaigns()
  const raw = Array.isArray(searchParams?.campaign) ? searchParams?.campaign[0] : searchParams?.campaign
  const active = campaigns.find((c) => c.key === raw)?.key ?? campaigns[0]?.key ?? 'revival'
  const { funnel, called, timeOfDay } = await getOutboundFunnel(active)

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · OUTBOUND"
        title="Outbound."
        actions={<PersonPill label="EST · Nabeel" />}
      />

      <div style={{ marginTop: 14 }}>
        <OutboundCampaignSwitcher campaigns={campaigns} active={active} />
      </div>

      <div
        className="geg-mono"
        style={{ marginTop: 14, fontSize: 10, letterSpacing: '0.04em', color: 'var(--color-geg-text-2)', lineHeight: 1.7 }}
      >
        <CampaignIntro campaignKey={active} />
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
        plan unit. Activity is counted from each lead&apos;s campaign start (created date, floored at the
        campaign launch) so pre-existing leads&apos; old activity isn&apos;t counted.
      </div>
    </div>
  )
}
