import { HeaderBand } from '@/components/gregory/header-band'
import { AdCascadeFilter } from '@/components/sales/ad-cascade-filter'
import { DcAdsCalledSection } from '@/components/sales/dc-ads-called'
import { DcAdsDailyTable } from '@/components/sales/dc-ads-daily-table'
import { DcAdsFunnelSection } from '@/components/sales/dc-ads-funnel'
import { DcAdsTimeOfDaySection } from '@/components/sales/dc-ads-time-of-day'
import { DcAdsByRepSection } from '@/components/sales/dc-ads-by-rep'
import { SpeedToLeadBoxes } from '@/components/sales/speed-to-lead-boxes'
import {
  getDcAdsFunnel,
  getDcAdsByRep,
  getDcAdsSpend,
  getDcAdsMetaOptIns,
  getDcAdsDaily,
  getDcAdsHierarchy,
  getDcAdsSpeedCohort,
  type DcAdsEntityFilter,
} from '@/lib/db/dc-ads'
import { dateRangeFromExplicit, todayEtDate } from '@/lib/db/funnel-window'
import { DateRangePicker } from '../funnel/landing-pages/date-range-picker'
import { PersonPill } from '../header-pills'

// YYYY-MM-DD (ET) → "Jul 8".
function monthDay(ymd: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' })
    .format(new Date(`${ymd}T12:00:00Z`))
}

// Sales Dashboard — DC Ads (top-level page).
//
// The Digital College paid-ads funnel, since the full-program suspension the
// only acquisition motion: Meta ad → instant lead form (name + phone, no
// landing page) → the Meta→Close bridge creates the Close lead in seconds →
// reps dial. Same shape as the Outbound page but with AD SPEND leading the
// funnel and opt-ins instead of outbound leads; scoped ONLY to lead-form
// campaigns (meta_leadgen_campaigns — the adset discriminator), never
// outbound pools. See lib/db/dc-ads.ts + docs/sales/surfaces.md § DC Ads.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// The first lead-form campaign launched 2026-07-08 (the "7/8 - Basic Form"
// era). Default range floor — everything since launch.
const DC_ADS_FLOOR_ET = '2026-07-08'

export default async function DcAdsPage({
  searchParams,
}: {
  searchParams?: {
    start?: string | string[]
    end?: string | string[]
    campaign?: string | string[]
    adset?: string | string[]
    ad?: string | string[]
    form?: string | string[]
  }
}) {
  const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || null

  // Always an explicit range (no all-time mode), same contract as Outbound:
  // calendar untouched → [launch floor → today].
  const todayEt = todayEtDate()
  const startEt = param(searchParams?.start) ?? DC_ADS_FLOOR_ET
  const endEt = param(searchParams?.end) ?? todayEt

  // Ad cascade selection (?campaign / ?adset / ?ad) — same URL contract as the
  // Advertising Hub's chooser — plus the Forms facet (?form, an AND filter).
  // Scopes everything: spend, funnel, by-rep, speed-to-lead, speed-to-dial,
  // time-of-day, and the last-5-days strip.
  const campaign = param(searchParams?.campaign)
  const adset = param(searchParams?.adset)
  const ad = param(searchParams?.ad)
  const form = param(searchParams?.form)
  const filter: DcAdsEntityFilter = { campaignId: campaign, adsetId: adset, adId: ad, formId: form }
  const filterActive = !!(ad || adset || campaign || form)

  const range = dateRangeFromExplicit(startEt, endEt)
  const rangeBounds = { startUtcIso: range.startUtcIso, endUtcIso: range.endUtcIso }
  const [{ funnel, called, timeOfDay }, byRep, spend, metaOptIns, dailyRows, hierarchy, speedCohort] =
    await Promise.all([
      getDcAdsFunnel(rangeBounds, filter),
      getDcAdsByRep(rangeBounds, filter),
      getDcAdsSpend(startEt, endEt, filter),
      getDcAdsMetaOptIns(rangeBounds),
      getDcAdsDaily(todayEt, filter),
      getDcAdsHierarchy(rangeBounds),
      getDcAdsSpeedCohort(rangeBounds, filter),
    ])

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · DIGITAL COLLEGE"
        title="DC Ads."
        actions={<PersonPill label="EST · Nabeel" />}
      />

      <div style={{ marginTop: 14, display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
        <AdCascadeFilter hierarchy={hierarchy} campaign={campaign} adset={adset} ad={ad} forms={hierarchy.forms} form={form} startEtDate={startEt} endEtDate={endEt} />
        <DateRangePicker startEtDate={startEt} endEtDate={endEt} todayEt={todayEt} />
        <span
          className="geg-mono"
          title="When the first lead-form campaign started — independent of the date range"
          style={{ fontSize: 10, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}
        >
          Started {monthDay(DC_ADS_FLOOR_ET)}
        </span>
      </div>

      <div
        className="geg-mono"
        style={{ marginTop: 14, fontSize: 10, letterSpacing: '0.04em', color: 'var(--color-geg-text-2)', lineHeight: 1.7 }}
      >
        The <b>Digital College ads</b> funnel. Someone clicks a Meta ad, fills the instant lead form
        (name + phone — no landing page), lands in Close tagged <b>Digital College</b> within seconds,
        and gets dialed. Ad spend covers the lead-form campaigns only ({spend.campaigns} detected) —
        no outbound leads on this page, no ad leads on Outbound.
      </div>

      {/* Bridge-drift check only reads on the unfiltered view — the Meta-side
          count isn't cascade-scoped, so comparing it under a filter would
          false-alarm. */}
      {!filterActive && metaOptIns !== funnel.optIns ? (
        <div
          className="geg-mono"
          style={{ marginTop: 8, fontSize: 9.5, letterSpacing: '0.04em', color: 'var(--color-geg-text-3)', lineHeight: 1.6 }}
        >
          ⚠ Meta reports {metaOptIns.toLocaleString('en-US')} ad-attributed form submissions in this
          range vs {funnel.optIns.toLocaleString('en-US')} mirrored into Close — a growing gap means
          the Meta→Close bridge is dropping leads (see docs/runbooks/meta_leads_ingestion.md).
        </div>
      ) : null}

      <DcAdsFunnelSection funnel={funnel} spendUsd={spend.spendUsd} />

      <DcAdsDailyTable rows={dailyRows} />

      <DcAdsByRepSection rows={byRep.reps} totals={byRep.totals} />

      {/* Speed-to-lead boxes — the Leads page's four top-line stats, computed
          over the DC ads opt-in cohort only (same 10a–10p ET business-hours
          clock + 24h cap, so the numbers are comparable across pages). */}
      <div style={{ marginTop: 26 }}>
        <div
          className="geg-mono"
          style={{ fontSize: 10, letterSpacing: '0.16em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', marginBottom: 10 }}
        >
          Speed to lead · DC ad opt-ins · selected dates
        </div>
        <SpeedToLeadBoxes
          cohort={speedCohort}
          connectedLeads={speedCohort.connectedBroad}
          connectedDenominator={speedCohort.dialedOrConnected}
        />
      </div>

      <DcAdsCalledSection called={called} />

      <div
        className="geg-mono"
        style={{ marginTop: 14, fontSize: 9, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)', lineHeight: 1.8 }}
      >
        Of the opt-ins we dialed, how fast we got to them and whether the dial connected. <b>Speed to
        dial</b> = form submit → first outbound call (the opt-in is the hand-raise — no reply needed
        first); bars stack connected (purple) over not-connected, with the connect % inside. Small n per
        bucket — read the trend, not single bars.
      </div>

      <DcAdsTimeOfDaySection buckets={timeOfDay.buckets} />

      <div
        className="geg-mono"
        style={{ marginTop: 14, fontSize: 9, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)', lineHeight: 1.8 }}
      >
        When leads <b>opt in</b> vs when we <b>dial</b> vs when we <b>connect</b>, by 2-hour ET window —
        wall-clock, no business-hours adjustment. Opt-in volume that lands outside the dialing window is
        the coverage gap to staff for. Connects are timed by the call (never the form).
      </div>

      <div
        className="geg-mono"
        style={{ marginTop: 16, fontSize: 9, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)', lineHeight: 1.8 }}
      >
        Opt-ins = Digital College lead-form leads mirrored into Close (anchored at the form submit; a
        returning phone number re-anchors at its newest opt-in) · Called = ≥1 call (inbound or outbound,
        any length) · Connected = a <b>call ≥90s</b> (either direction) or a filed pitch form · Showed = a
        filed <b>DC sale form</b> or closer report (the lead got a pitch) · Closed = a DC close <b>with an
        explicit plan</b> — from the DC sale form or a closer report (a closed form with no plan counts as
        a show, not a close) · Cash = $300 per Digital College plan unit · Adspend = the lead-form
        campaigns&apos; spend (Meta API, ET days; with only a form selected, that form&apos;s ads) ·
        ROAS = cash ÷ adspend.
      </div>
    </div>
  )
}
