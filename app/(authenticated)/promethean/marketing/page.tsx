import {
  PromPage,
  PromPageHeader,
  PromCard,
  PromSection,
  KpiCard,
  PromTable,
  PromTHead,
  PromTH,
  PromTR,
  PromTD,
  PromDropdownStub,
  money,
} from '@/components/promethean/primitives'
import {
  getMarketingMetrics,
  AD_SPEND,
  PERIOD_LABEL,
  SYNC_LABEL,
} from '@/lib/mock-data'

export const metadata = { title: 'Marketing — Promethean' }

export default function PrometheanMarketingPage() {
  const m = getMarketingMetrics()

  // Aggregate by campaign
  const byCampaign = new Map<string, { spend: number; leads: number; clicks: number; impressions: number }>()
  for (const r of AD_SPEND) {
    const prev = byCampaign.get(r.campaign) ?? { spend: 0, leads: 0, clicks: 0, impressions: 0 }
    byCampaign.set(r.campaign, {
      spend: prev.spend + r.spend,
      leads: prev.leads + r.leads_generated,
      clicks: prev.clicks + r.clicks,
      impressions: prev.impressions + r.impressions,
    })
  }

  // Aggregate by country
  const byCountry = new Map<string, { spend: number; leads: number }>()
  for (const r of AD_SPEND) {
    const prev = byCountry.get(r.country) ?? { spend: 0, leads: 0 }
    byCountry.set(r.country, {
      spend: prev.spend + r.spend,
      leads: prev.leads + r.leads_generated,
    })
  }

  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · MARKETING"
        title="Every dollar, where it lands."
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
        trailing={<PromDropdownStub label="All countries" />}
      />

      <PromSection eyebrow="ECONOMICS" headline="The cash-and-cost loop.">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          <KpiCard label="AD SPEND" value={money(m.spend, { compact: true })} delta={6} deltaInvert />
          <KpiCard label="LEADS" value={String(m.leads)} delta={11} accent />
          <KpiCard label="CASH ROAS" value={`${m.cash_roas.toFixed(2)}×`} delta={-4} />
          <KpiCard label="REV ROAS" value={`${m.revenue_roas.toFixed(2)}×`} delta={8} accent />
        </div>
      </PromSection>

      <PromSection eyebrow="UNIT ECONOMICS" headline="Cost per anything you can name.">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          <KpiCard label="COST PER LEAD" value={money(m.cost_per_lead)} size="sm" delta={4} deltaInvert />
          <KpiCard label="COST PER CALL" value={money(m.cost_per_call)} size="sm" delta={-7} deltaInvert />
          <KpiCard label="COST PER SHOW" value={money(m.cost_per_show)} size="sm" delta={2} deltaInvert />
          <KpiCard label="COST PER ACQUISITION" value={money(m.cost_per_acquisition)} size="sm" delta={-3} deltaInvert />
        </div>
      </PromSection>

      <PromSection eyebrow="BY CAMPAIGN">
        <PromTable>
          <PromTHead>
            <tr>
              <PromTH>Campaign</PromTH>
              <PromTH align="right">Spend</PromTH>
              <PromTH align="right">Impressions</PromTH>
              <PromTH align="right">Clicks</PromTH>
              <PromTH align="right">Leads</PromTH>
              <PromTH align="right">CPL</PromTH>
            </tr>
          </PromTHead>
          <tbody>
            {Array.from(byCampaign.entries()).map(([campaign, v]) => (
              <PromTR key={campaign}>
                <PromTD>{campaign}</PromTD>
                <PromTD align="right" className="prom-numeric">{money(v.spend)}</PromTD>
                <PromTD align="right" className="prom-numeric">{v.impressions.toLocaleString()}</PromTD>
                <PromTD align="right" className="prom-numeric">{v.clicks.toLocaleString()}</PromTD>
                <PromTD align="right" className="prom-numeric">{v.leads}</PromTD>
                <PromTD align="right" className="prom-numeric">{money(v.leads ? v.spend / v.leads : 0)}</PromTD>
              </PromTR>
            ))}
          </tbody>
        </PromTable>
      </PromSection>

      <PromSection eyebrow="BY COUNTRY">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from(byCountry.entries()).map(([country, v]) => (
            <PromCard key={country} className="p-5">
              <div className="prom-eyebrow">{country}</div>
              <div
                className="prom-numeric font-semibold mt-2"
                style={{ fontSize: 26 }}
              >
                {money(v.spend, { compact: true })}
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--color-prom-text-2)' }}>
                {v.leads} leads · {money(v.leads ? v.spend / v.leads : 0)} CPL
              </div>
            </PromCard>
          ))}
        </div>
      </PromSection>
    </PromPage>
  )
}
