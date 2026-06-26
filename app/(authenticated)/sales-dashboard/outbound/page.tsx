import { HeaderBand } from '@/components/gregory/header-band'
import { RevivalCalledSection } from '@/components/sales/revival-called'
import { RevivalFunnelSection } from '@/components/sales/revival-funnel'
import { RevivalTimeOfDaySection } from '@/components/sales/revival-time-of-day'
import { OutboundCampaignSwitcher } from '@/components/sales/outbound-campaign-switcher'
import { getOutboundFunnel, getOutboundCampaigns } from '@/lib/db/funnel-revival'
import { dateRangeFromExplicit, todayEtDate } from '@/lib/db/funnel-window'
import { DateRangePicker } from '../funnel/landing-pages/date-range-picker'
import { PersonPill } from '../header-pills'

// YYYY-MM-DD (ET) → "Jun 3"; a UTC ISO timestamp → its ET YYYY-MM-DD.
function etYmd(iso: string | null): string | null {
  if (!iso) return null
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(iso))
}
function monthDay(ymd: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
    .format(new Date(`${ymd}T12:00:00Z`))
}

// Sales Dashboard — Outbound (top-level page).
//
// One funnel per outbound campaign pool (Revival, Jacob, …), switched by a
// segmented control + an optional date range (calendar). Each pool's leads are
// tagged in Close with that campaign's custom field and excluded from every
// other funnel/roster — the only surface that counts them. Per-lead activity is
// anchored to campaign entry (greatest(date_created, floor)); the date range
// scopes by that anchor (migration 0102), and the "Active …" label shows the
// campaign's full span. See lib/db/funnel-revival.ts.

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
  searchParams?: { campaign?: string | string[]; start?: string | string[]; end?: string | string[] }
}) {
  const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || null
  const campaigns = await getOutboundCampaigns()
  const active = campaigns.find((c) => c.key === param(searchParams?.campaign))?.key ?? campaigns[0]?.key ?? 'revival'

  // Optional date range (calendar). Absent → all-time; the picker then defaults
  // to [campaign start … today]. dateRangeFromExplicit gives ET-anchored UTC bounds.
  const startP = param(searchParams?.start)
  const endP = param(searchParams?.end)
  const range = startP && endP ? dateRangeFromExplicit(startP, endP) : undefined
  const { funnel, called, timeOfDay, activeFrom, activeTo } = await getOutboundFunnel(
    active,
    range ? { startUtcIso: range.startUtcIso, endUtcIso: range.endUtcIso } : undefined,
  )

  const todayEt = todayEtDate()
  const activeFromEt = etYmd(activeFrom)
  const activeToEt = etYmd(activeTo)
  const startEt = startP ?? activeFromEt ?? todayEt
  const endEt = endP ?? todayEt

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · OUTBOUND"
        title="Outbound."
        actions={<PersonPill label="EST · Nabeel" />}
      />

      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <OutboundCampaignSwitcher campaigns={campaigns} active={active} />
        <DateRangePicker startEtDate={startEt} endEtDate={endEt} todayEt={todayEt} />
        {activeFromEt && activeToEt ? (
          <span
            className="geg-mono"
            title="When this campaign's leads first entered (its floor) through the most recent — independent of the date range above"
            style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}
          >
            Active {monthDay(activeFromEt)} – {monthDay(activeToEt)}
          </span>
        ) : null}
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
