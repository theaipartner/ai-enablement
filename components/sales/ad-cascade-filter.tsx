'use client'

import { useRouter, usePathname } from 'next/navigation'
import type { ChangeEvent } from 'react'

// Campaign → Ad Set → Ad cascade filter for the Funnel page. Selecting a level
// re-scopes the whole HT funnel (and the rosters its stages link to) to that
// entity's leads, and clears the downstream selections. URL-param driven
// (?campaign / ?adset / ?ad), preserving the window; persisted by
// PersistPageState. Campaign + Ad show names; Ad Set shows the id (no Cortana
// ad-set feed → no name). The option lists cascade: ad sets reflect the chosen
// campaign, ads reflect the chosen ad set.

export type AdNode = { adId: string; adName: string; count: number }
export type AdsetNode = { adsetId: string; count: number; ads: AdNode[] }
export type CampaignNode = { campaignId: string; campaignName: string; count: number; adsets: AdsetNode[] }
export type AdHierarchy = { campaigns: CampaignNode[]; adsetsAll: AdsetNode[]; adsAll: AdNode[] }

// Narrow fixed-width trigger (Drake 2026-06-15): the closed select clips its
// label, but the OPEN option list still shows full text — so the header row
// stays compact and never forces a horizontal scroll. Leaves room for more
// filter dropdowns (landing pages) on the wrapping filter row.
const selectStyle = {
  fontSize: 11,
  letterSpacing: '0.04em',
  color: 'var(--color-geg-text-2)',
  background: 'var(--color-geg-bg-elev)',
  border: '1px solid var(--color-geg-border)',
  borderRadius: 6,
  padding: '6px 10px',
  width: 140,
} as const

export function AdCascadeFilter({
  hierarchy,
  campaign,
  adset,
  ad,
  startEtDate,
  endEtDate,
}: {
  hierarchy: AdHierarchy
  campaign: string | null
  adset: string | null
  ad: string | null
  startEtDate: string
  endEtDate: string
}) {
  const router = useRouter()
  const pathname = usePathname()

  function go(next: { campaign?: string; adset?: string; ad?: string }) {
    const p = new URLSearchParams()
    p.set('start', startEtDate)
    p.set('end', endEtDate)
    if (next.campaign) p.set('campaign', next.campaign)
    if (next.adset) p.set('adset', next.adset)
    if (next.ad) p.set('ad', next.ad)
    router.push(`${pathname}?${p.toString()}`)
  }

  // Cascading option lists: ad sets narrow to the chosen campaign, ads to the
  // chosen ad set (falling back to all when no parent is selected).
  const campNode = hierarchy.campaigns.find((c) => c.campaignId === campaign) ?? null
  const adsetOptions = campNode ? campNode.adsets : hierarchy.adsetsAll
  const adsetNode = adsetOptions.find((a) => a.adsetId === adset) ?? null
  const adOptions = adsetNode
    ? adsetNode.ads
    : campNode
      ? campNode.adsets.flatMap((a) => a.ads)
      : hierarchy.adsAll

  const onCampaign = (e: ChangeEvent<HTMLSelectElement>) =>
    go({ campaign: e.target.value || undefined }) // changing campaign clears adset + ad
  const onAdset = (e: ChangeEvent<HTMLSelectElement>) =>
    go({ campaign: campaign || undefined, adset: e.target.value || undefined }) // clears ad
  const onAd = (e: ChangeEvent<HTMLSelectElement>) =>
    go({ campaign: campaign || undefined, adset: adset || undefined, ad: e.target.value || undefined })

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <select value={campaign ?? ''} onChange={onCampaign} className="geg-mono" aria-label="Filter by campaign" style={selectStyle}>
        <option value="">All campaigns</option>
        {hierarchy.campaigns.map((c) => (
          <option key={c.campaignId} value={c.campaignId}>
            {c.campaignName} ({c.count})
          </option>
        ))}
      </select>
      <select value={adset ?? ''} onChange={onAdset} className="geg-mono" aria-label="Filter by ad set" style={selectStyle}>
        <option value="">All ad sets</option>
        {adsetOptions.map((a) => (
          <option key={a.adsetId} value={a.adsetId}>
            {a.adsetId} ({a.count})
          </option>
        ))}
      </select>
      <select value={ad ?? ''} onChange={onAd} className="geg-mono" aria-label="Filter by ad" style={selectStyle}>
        <option value="">All ads</option>
        {adOptions.map((a) => (
          <option key={a.adId} value={a.adId}>
            {a.adName} ({a.count})
          </option>
        ))}
      </select>
    </div>
  )
}
