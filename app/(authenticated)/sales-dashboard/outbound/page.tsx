import { HeaderBand } from '@/components/gregory/header-band'
import { RevivalCalledSection } from '@/components/sales/revival-called'
import { RevivalFunnelSection } from '@/components/sales/revival-funnel'
import { RevivalTimeOfDaySection } from '@/components/sales/revival-time-of-day'
import { OutboundByRepSection } from '@/components/sales/outbound-by-rep'
import { OutboundCampaignSwitcher } from '@/components/sales/outbound-campaign-switcher'
import { getOutboundFunnel, getOutboundCampaigns, getOutboundByRep } from '@/lib/db/funnel-revival'
import { dateRangeFromExplicit, todayEtDate } from '@/lib/db/funnel-window'
import { DateRangePicker } from '../funnel/landing-pages/date-range-picker'
import { PersonPill } from '../header-pills'

// YYYY-MM-DD (ET) → "Jun 3".
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
// scopes by that anchor (migration 0102), and the "Started …" label shows the
// campaign's launch date (hard-quoted, see CAMPAIGN_START below). See
// lib/db/funnel-revival.ts.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

function CampaignIntro({ campaignKey, label }: { campaignKey: string; label: string }) {
  if (campaignKey === 'all') {
    return (
      <>
        <b>All outbound campaigns</b> combined. Every outbound lead, from the outreach through to the
        sale. Pick a campaign from the dropdown to scope to just that pool.
      </>
    )
  }
  if (campaignKey === 'jacob') {
    return (
      <>
        The <b>ECJ Reactivation (Jacob)</b> outbound campaign. Every lead matching the ECJ roster
        (tagged <b>Jacob Lead</b> in Close), from the outreach through to the sale.
      </>
    )
  }
  if (campaignKey === 'revival') {
    return (
      <>
        The DC re-engagement SMS campaign. Every lead tagged <b>DC Revival Lead</b> in Close, from the
        re-engagement outreach through to the sale.
      </>
    )
  }
  return (
    <>
      The <b>{label}</b> outbound campaign. Every lead carrying its custom-field value — in Close or
      GHL — from the outreach through to the sale.
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
  // Default to the combined "All" view; ?campaign=<key> scopes to one pool.
  const active = campaigns.find((c) => c.key === param(searchParams?.campaign))?.key ?? 'all'

  // Date range (calendar). The funnel is ALWAYS scoped to an explicit range —
  // there is no "all-time" mode. When the calendar is untouched the range
  // defaults to [campaign start → today], so the funnel and the calendar always
  // agree and the number reflects everything since launch. (The old all-time
  // default disagreed with the ranged view and didn't reliably pick up new
  // closes.) dateRangeFromExplicit gives ET-anchored UTC bounds.
  const startP = param(searchParams?.start)
  const endP = param(searchParams?.end)

  const todayEt = todayEtDate()
  // Campaign launch date from the registry (no hard-coded per-campaign dates).
  // For "All" it's the earliest active campaign's floor — the combined floor.
  const allFloorEt = campaigns.reduce<string | null>(
    (min, c) => (c.floorEt && (!min || c.floorEt < min) ? c.floorEt : min),
    null,
  )
  const campaignStartEt =
    active === 'all' ? allFloorEt : (campaigns.find((c) => c.key === active)?.floorEt ?? null)
  const activeLabel = campaigns.find((c) => c.key === active)?.label ?? active
  const startEt = startP ?? campaignStartEt ?? todayEt
  const endEt = endP ?? todayEt

  const range = dateRangeFromExplicit(startEt, endEt)
  const rangeBounds = { startUtcIso: range.startUtcIso, endUtcIso: range.endUtcIso }
  const [{ funnel, called, timeOfDay }, byRep] = await Promise.all([
    getOutboundFunnel(active, rangeBounds),
    getOutboundByRep(active, rangeBounds),
  ])

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
        {campaignStartEt ? (
          <span
            className="geg-mono"
            title="When this campaign started (its floor) — independent of the date range"
            style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}
          >
            Started {monthDay(campaignStartEt)}
          </span>
        ) : null}
      </div>

      <div
        className="geg-mono"
        style={{ marginTop: 14, fontSize: 10, letterSpacing: '0.04em', color: 'var(--color-geg-text-2)', lineHeight: 1.7 }}
      >
        <CampaignIntro campaignKey={active} label={activeLabel} />
      </div>

      <RevivalFunnelSection funnel={funnel} />

      <OutboundByRepSection rows={byRep.reps} totals={byRep.totals} />

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
        Called = ≥1 call (inbound or outbound, any length) · Connected = a <b>call ≥90s</b> (either
        direction; so a text-DQ with no call is not a connect) · Booked = a DC or HT booking ·
        Showed = a closer-report show · Closed = a DC close <b>with an explicit plan</b> (a &ldquo;DC
        Closed&rdquo; form with no plan is counted as a show, not a close) · Cash = $300 per Digital College
        plan unit. Activity is counted from each lead&apos;s campaign start (created date, floored at the
        campaign launch) so pre-existing leads&apos; old activity isn&apos;t counted.
      </div>
    </div>
  )
}
