import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import { FunnelStack } from '@/components/sales/funnel-stack'
import { DcFunnelSection } from '@/components/sales/dc-funnel'
import { getLeadsForRange, type LeadRow } from '@/lib/db/leads'
import { AdCascadeFilter, type AdHierarchy, type AdsetNode, type AdNode } from '@/components/sales/ad-cascade-filter'
import { getLeadsFunnel } from '@/lib/db/leads-funnel'
import { getDcFunnel } from '@/lib/db/funnel-dc'
import { getFunnelCash } from '@/lib/db/funnel-cash'
import { getSpeedToLeadCohort } from '@/lib/db/funnel-appointment-setting'
import { resolveFunnelRange } from '@/lib/db/funnel-stages'
import { todayEtDate } from '@/lib/db/funnel-window'
import { resolveSalesWindow } from '@/lib/db/sales-window-cookie'
import { PersonPill } from '../header-pills'
import { DateRangePicker } from './landing-pages/date-range-picker'
import { PersistPageState } from '@/components/sales/persist-page-state'

// Sales Dashboard — Funnel (the top-of-funnel overview).
//
// The stacked Total / Direct / Setter-led / Reactivation funnel over the
// window's cohort. Each stage node links to the Leads roster pre-filtered to
// that funnel's (type, stage); the Total adspend node links to the Ads page;
// a link near the top goes to the Landing Pages page. Those two links replace
// the old funnel-stage sub-bars in the sidebar.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export default async function SalesDashboardFunnelPage({
  searchParams,
}: {
  searchParams?: { start?: string | string[]; end?: string | string[]; ad?: string | string[]; campaign?: string | string[]; adset?: string | string[] }
}) {
  const { start, end } = resolveSalesWindow(searchParams)
  const range = resolveFunnelRange(start ?? undefined, end ?? undefined)
  const todayEt = todayEtDate()
  const param = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || null
  const campaign = param(searchParams?.campaign)
  const adset = param(searchParams?.adset)
  const ad = param(searchParams?.ad)

  // Cohort → roster rows fetched CONCURRENTLY with the Digital College funnel
  // (independent). The ad filter then narrows the rows in-memory and the HT
  // funnel re-scopes for free — getLeadsFunnel counts only the leads passed in,
  // so filtering the rows filters every box + the rosters they link to. Cash
  // needs both funnels, so it follows.
  const [allRows, dcFunnel] = await Promise.all([
    (async () => {
      // Same cohort spine as the Leads roster, so the funnel and the rosters it
      // links to can't drift.
      const cohort = await getSpeedToLeadCohort(range)
      return getLeadsForRange(range, cohort)
    })(),
    // Digital College funnel — tag-driven, unique leads only, same window as HT.
    getDcFunnel(range),
  ])
  const hierarchy = buildAdHierarchy(allRows)
  // Deepest active filter wins (ad > ad set > campaign); rows + funnel scope to it.
  const rows = ad
    ? allRows.filter((r) => r.adId === ad)
    : adset
      ? allRows.filter((r) => r.adsetId === adset)
      : campaign
        ? allRows.filter((r) => r.campaignId === campaign)
        : allRows
  const filterOpts = ad ? { adId: ad } : adset ? { adsetId: adset } : campaign ? { campaignId: campaign } : {}
  const filterActive = !!(ad || adset || campaign)
  const funnel = await getLeadsFunnel(rows, range, filterOpts)
  // Per-funnel cash collected. `rows` is already view/ad-filtered, so HT cash
  // scopes to the active entity for free; under a filter DC is excluded (separate
  // campaign). ROAS renders on the Total box only (window adspend → whole cohort).
  const cash = await getFunnelCash(range, rows, funnel.adspendUsd, { excludeDc: filterActive })

  const lpHref = `/sales-dashboard/funnel/landing-pages?start=${range.startEtDate}&end=${range.endEtDate}`

  return (
    <div>
      <PersistPageState window filters={['campaign', 'adset', 'ad']} />
      <HeaderBand
        eyebrow="SALES · FUNNEL"
        title="Funnel."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Link
              href={lpHref}
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
              }}
            >
              Landing pages →
            </Link>
            <AdCascadeFilter hierarchy={hierarchy} campaign={campaign} adset={adset} ad={ad} startEtDate={range.startEtDate} endEtDate={range.endEtDate} />
            <DateRangePicker startEtDate={range.startEtDate} endEtDate={range.endEtDate} todayEt={todayEt} />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />

      {(() => {
        const clean = funnel.warnings.length === 0
        const color = clean ? 'var(--color-geg-pos)' : 'var(--color-geg-neg)'
        return (
          <div
            style={{
              marginTop: 14,
              padding: '12px 16px',
              border: `1px solid ${color}`,
              borderRadius: 8,
              background: `color-mix(in srgb, ${color} 8%, transparent)`,
            }}
          >
            <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color, marginBottom: clean ? 0 : 6 }}>
              {clean
                ? '✓ Funnel integrity · all checks pass'
                : `⚠ Funnel integrity — ${funnel.warnings.length} issue${funnel.warnings.length === 1 ? '' : 's'}`}
            </div>
            {funnel.warnings.map((msg, i) => (
              <div key={i} className="geg-mono" style={{ fontSize: 10, color: 'var(--color-geg-text-2)', lineHeight: 1.6 }}>
                · {msg}
              </div>
            ))}
          </div>
        )
      })()}

      <FunnelStack funnel={funnel} cash={cash} range={range} ad={ad} campaign={campaign} adset={adset} />

      {filterActive ? null : <DcFunnelSection dc={dcFunnel} />}

      <div
        className="geg-mono"
        style={{ marginTop: 20, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', textAlign: 'center' }}
      >
        Click any stage to open the matching leads · adspend opens the ads page
      </div>
    </div>
  )
}

// Campaign → Ad Set → Ad hierarchy across the cohort's rows, with per-node lead
// counts, for the cascade filter. Each level sorted by volume; leads with no
// ad_id (organic/direct) are omitted. Ad names collide (Meta reuses creative
// names) → disambiguate with a short ad-id suffix.
function buildAdHierarchy(rows: LeadRow[]): AdHierarchy {
  type C = { campaignName: string; count: number; adsets: Map<string, { count: number; ads: Map<string, { adName: string; count: number }> }> }
  const camps = new Map<string, C>()
  const adsetsAll = new Map<string, { count: number; ads: Map<string, { adName: string; count: number }> }>()
  const adsAll = new Map<string, { adName: string; count: number }>()
  for (const r of rows) {
    if (!r.adId) continue
    const cId = r.campaignId ?? '—'
    const aId = r.adsetId ?? '—'
    const c = camps.get(cId) ?? { campaignName: r.campaignName ?? cId, count: 0, adsets: new Map() }
    c.count += 1
    const aset = c.adsets.get(aId) ?? { count: 0, ads: new Map() }
    aset.count += 1
    const ad = aset.ads.get(r.adId) ?? { adName: r.adName ?? r.adId, count: 0 }
    ad.count += 1
    aset.ads.set(r.adId, ad)
    c.adsets.set(aId, aset)
    camps.set(cId, c)
    // Flat fallbacks (used when no parent is selected).
    const fa = adsetsAll.get(aId) ?? { count: 0, ads: new Map() }
    fa.count += 1
    const faAd = fa.ads.get(r.adId) ?? { adName: r.adName ?? r.adId, count: 0 }
    faAd.count += 1
    fa.ads.set(r.adId, faAd)
    adsetsAll.set(aId, fa)
    const ga = adsAll.get(r.adId) ?? { adName: r.adName ?? r.adId, count: 0 }
    ga.count += 1
    adsAll.set(r.adId, ga)
  }
  const dedupeAds = (ads: Map<string, { adName: string; count: number }>): AdNode[] => {
    const list = Array.from(ads.entries()).map(([adId, v]) => ({ adId, adName: v.adName, count: v.count }))
    const names = new Map<string, number>()
    for (const a of list) names.set(a.adName, (names.get(a.adName) ?? 0) + 1)
    return list
      .map((a) => ((names.get(a.adName) ?? 0) > 1 ? { ...a, adName: `${a.adName} · …${a.adId.slice(-4)}` } : a))
      .sort((x, y) => y.count - x.count)
  }
  const adsetNodes = (m: Map<string, { count: number; ads: Map<string, { adName: string; count: number }> }>): AdsetNode[] =>
    Array.from(m.entries())
      .map(([adsetId, v]) => ({ adsetId, count: v.count, ads: dedupeAds(v.ads) }))
      .sort((x, y) => y.count - x.count)
  return {
    campaigns: Array.from(camps.entries())
      .map(([campaignId, v]) => ({ campaignId, campaignName: v.campaignName, count: v.count, adsets: adsetNodes(v.adsets) }))
      .sort((x, y) => y.count - x.count),
    adsetsAll: adsetNodes(adsetsAll),
    adsAll: dedupeAds(adsAll),
  }
}
