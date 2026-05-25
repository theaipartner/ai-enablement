import { notFound } from 'next/navigation'
import { HeaderBand } from '@/components/gregory/header-band'
import { MetricCard } from '@/components/sales/metric-card'
import {
  METRICS,
  SECTION_DISPLAY,
  SECTION_SLUGS,
  fetchSalesDashboardData,
  type SectionId,
} from '@/lib/db/sales-dashboard'
import { SectionStatusPill, WindowPill } from '../header-pills'

// Sales Dashboard v2 — Section detail.
//
// Two slots, both rendered through the same MetricCard primitive:
// (1) Top-Live row — first 3 LIVE metrics in catalog order, 3-up.
//     Sections with zero LIVE show an italic empty-section-stub
//     instead. (2) Full catalog grid — every metric in the section in
//     catalog order, 4-up. The three states sit side-by-side; the
//     visual contract handles all weight distinction.
//
// Spec: docs/specs/sales-dashboard-v2.md § Slot order — Section page.
// `EmptyStateAwareSection` is referenced in the spec but its built-in
// H2 title chrome doesn't match the mock's mono-eyebrow group-head;
// the visibility contract (show / stub when zero) is implemented
// directly. Surfaced as a judgment call in the report.

export const dynamic = 'force-dynamic'

type SectionRouteParams = { params: { section: string } }

export default async function SalesDashboardSectionPage({
  params,
}: SectionRouteParams) {
  const sectionId: SectionId | undefined = SECTION_SLUGS[params.section]
  if (!sectionId) notFound()

  const data = await fetchSalesDashboardData()

  const metrics = METRICS.filter((m) => m.section === sectionId)
  const live = metrics.filter((m) => m.status === 'live')
  const pending = metrics.filter((m) => m.status === 'pending')
  const nc = metrics.filter((m) => m.status === 'not_connected')
  const topLive = live.slice(0, 3)
  const display = SECTION_DISPLAY[sectionId]

  return (
    <div>
      <HeaderBand
        eyebrow={display.eyebrow}
        title={display.title}
        backlink={{ href: '/sales-dashboard', label: 'BACK TO OVERVIEW' }}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <WindowPill />
            <SectionStatusPill live={live.length} pending={pending.length} nc={nc.length} />
          </div>
        }
      />

      {/* TOP LIVE — first 3 live in catalog order */}
      {topLive.length > 0 ? (
        <>
          <GroupHead
            eyebrow="TOP LIVE"
            title="The numbers that lead this section."
            count={`${topLive.length} OF ${live.length} LIVE`}
            firstOfType
          />
          <TopLiveRow>
            {topLive.map((m) => (
              <MetricCard key={m.id} metric={m} result={data[m.id]} size="top-live" />
            ))}
          </TopLiveRow>
        </>
      ) : (
        <div
          className="geg-serif"
          style={{
            marginTop: 40,
            padding: '28px 24px',
            border: '1px dashed var(--color-geg-border-strong)',
            borderRadius: 8,
            textAlign: 'center',
            color: 'var(--color-geg-text-3)',
            fontStyle: 'italic',
          }}
        >
          No live metrics in this section yet. Everything below is pending or not-connected — wire a source to light up this slot.
        </div>
      )}

      {/* FULL CATALOG — every metric, catalog order */}
      <GroupHead
        eyebrow="FULL CATALOG"
        title={`All ${metrics.length} metrics · sheet order.`}
        count={`${live.length} LIVE · ${pending.length} PENDING · ${nc.length} N/C`}
      />
      <MetricGrid>
        {metrics.map((m) => (
          <MetricCard key={m.id} metric={m} result={data[m.id]} size="grid" sectionTagOverride={null} />
        ))}
      </MetricGrid>
    </div>
  )
}

function GroupHead({
  eyebrow,
  title,
  count,
  firstOfType,
}: {
  eyebrow: string
  title: string
  count: string
  firstOfType?: boolean
}) {
  return (
    <div
      style={{
        margin: firstOfType ? '4px 0 14px' : '28px 0 14px',
        display: 'flex',
        alignItems: 'baseline',
        gap: 12,
        borderBottom: '1px dashed var(--color-geg-border)',
        paddingBottom: 8,
      }}
    >
      <span
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
        }}
      >
        {eyebrow}
      </span>
      <span
        className="geg-serif"
        style={{
          fontSize: 17,
          color: 'var(--color-geg-text)',
          letterSpacing: '-0.01em',
        }}
      >
        {title}
      </span>
      <span
        className="geg-mono"
        style={{
          marginLeft: 'auto',
          color: 'var(--color-geg-text-faint)',
          fontSize: 10,
          letterSpacing: '0.1em',
        }}
      >
        {count}
      </span>
    </div>
  )
}

function TopLiveRow({ children }: { children: React.ReactNode }) {
  // Same hairline-divider trick as the hero rows on Overview.
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 1,
        background: 'var(--color-geg-border)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        overflow: 'hidden',
        marginBottom: 36,
      }}
    >
      {children}
    </div>
  )
}

function MetricGrid({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 12,
      }}
    >
      {children}
    </div>
  )
}

// Pre-render the 9 section slugs so /sales-dashboard/[slug] is
// generated at build time (and stays SSR'd at request time given
// `dynamic = 'force-dynamic'`). Unknown slugs still 404 via notFound().
export function generateStaticParams(): { section: string }[] {
  return Object.keys(SECTION_SLUGS).map((section) => ({ section }))
}
