import { notFound } from 'next/navigation'
import { HeaderBand } from '@/components/gregory/header-band'
import { MetricCard } from '@/components/sales/metric-card'
import { SectionTrend } from '@/components/sales/section-trend'
import { AdvertisingSection } from '@/components/sales/sections/advertising'
import { AppointmentSettingSection } from '@/components/sales/sections/appointment-setting'
import { BusinessCostsSection } from '@/components/sales/sections/business-costs'
import { ClosingSection } from '@/components/sales/sections/closing'
import { ContentSection } from '@/components/sales/sections/content'
import { FulfillmentSection } from '@/components/sales/sections/fulfillment'
import { FunnelsSection } from '@/components/sales/sections/funnels'
import { RevenueSection } from '@/components/sales/sections/revenue'
import {
  METRICS,
  SECTION_DISPLAY,
  SECTION_SLUGS,
  fetchSalesDashboardData,
  parseWindow,
  type SectionId,
} from '@/lib/db/sales-dashboard'
import { SectionStatusPill } from '../header-pills'
import { WindowSwitcher } from '../window-switcher'

// Sales Dashboard — Section detail.
//
// Decision-driven per section (not a catalog grid). The router
// dispatches by sectionId to a per-section content component:
//
//   ADVERTISING         → AdvertisingSection
//   CONTENT             → ContentSection (NC stub)
//   FUNNELS             → FunnelsSection
//   APPOINTMENT SETTING → AppointmentSettingSection
//   CLOSING             → ClosingSection
//   SALES DATA          → RevenueSection (view='sales')
//   BACK END REV        → RevenueSection (view='backend')
//   BUSINESS COSTS      → BusinessCostsSection
//   FULFILLMENT         → FulfillmentSection
//
// Every section also gets the SectionTrend lead-indicator band at the
// top (when the section has one) and an optional full-catalog grid at
// the bottom for completeness — collapsed visual weight so the section-
// specific content above stays primary.

export const dynamic = 'force-dynamic'

type SectionRouteParams = {
  params: { section: string }
  searchParams?: { window?: string | string[] }
}

export default async function SalesDashboardSectionPage({
  params,
  searchParams,
}: SectionRouteParams) {
  const sectionId: SectionId | undefined = SECTION_SLUGS[params.section]
  if (!sectionId) notFound()

  const window = parseWindow(searchParams?.window)
  const data = await fetchSalesDashboardData(window)

  const metrics = METRICS.filter((m) => m.section === sectionId)
  const stateOf = (m: typeof METRICS[number]): string => data[m.id]?.state ?? m.status
  const live = metrics.filter((m) => stateOf(m) === 'live')
  const pending = metrics.filter((m) => stateOf(m) === 'pending')
  const nc = metrics.filter((m) => stateOf(m) === 'not_connected')
  const display = SECTION_DISPLAY[sectionId]

  return (
    <div>
      <HeaderBand
        eyebrow={display.eyebrow}
        title={display.title}
        backlink={{ href: '/sales-dashboard', label: 'BACK TO PULSE' }}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <WindowSwitcher />
            <SectionStatusPill live={live.length} pending={pending.length} nc={nc.length} />
          </div>
        }
      />

      <SectionTrend sectionId={sectionId} metrics={METRICS} data={data} />

      <SectionDispatch sectionId={sectionId} window={window} />

      <FullCatalogTail metrics={metrics} data={data} />
    </div>
  )
}

function SectionDispatch({
  sectionId,
  window,
}: {
  sectionId: SectionId
  window: ReturnType<typeof parseWindow>
}) {
  switch (sectionId) {
    case 'ADVERTISING':
      return <AdvertisingSection window={window} />
    case 'CONTENT':
      return <ContentSection />
    case 'FUNNELS':
      return <FunnelsSection window={window} />
    case 'APPOINTMENT SETTING':
      return <AppointmentSettingSection window={window} />
    case 'CLOSING':
      return <ClosingSection window={window} />
    case 'SALES DATA':
      return <RevenueSection window={window} view="sales" />
    case 'BACK END REV':
      return <RevenueSection window={window} view="backend" />
    case 'BUSINESS COSTS':
      return <BusinessCostsSection window={window} />
    case 'FULFILLMENT':
      return <FulfillmentSection window={window} />
    default:
      return null
  }
}

function FullCatalogTail({
  metrics,
  data,
}: {
  metrics: typeof METRICS
  data: Awaited<ReturnType<typeof fetchSalesDashboardData>>
}) {
  if (metrics.length === 0) return null
  return (
    <section
      style={{
        marginTop: 32,
        paddingTop: 18,
        borderTop: '1px dashed var(--color-geg-border)',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 12,
          marginBottom: 12,
        }}
      >
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-faint)',
          }}
        >
          FULL CATALOG · REFERENCE
        </span>
        <span
          className="geg-serif"
          style={{ fontSize: 13, color: 'var(--color-geg-text-3)', fontStyle: 'italic' }}
        >
          {metrics.length} metrics in sheet order — drilldown grid.
        </span>
      </div>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, minmax(0, 1fr))',
          gap: 10,
        }}
      >
        {metrics.map((m) => (
          <MetricCard
            key={m.id}
            metric={m}
            result={data[m.id]}
            size="grid"
            sectionTagOverride={null}
          />
        ))}
      </div>
    </section>
  )
}

export function generateStaticParams(): { section: string }[] {
  return Object.keys(SECTION_SLUGS).map((section) => ({ section }))
}
