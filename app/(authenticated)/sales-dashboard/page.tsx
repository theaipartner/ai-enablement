import { HeaderBand } from '@/components/gregory/header-band'
import { MetricCard } from '@/components/sales/metric-card'
import {
  METRICS,
  SECTION_ORDER,
  fetchSalesDashboardData,
  getHeroMetrics,
} from '@/lib/db/sales-dashboard'
import { PersonPill, WindowPill } from './header-pills'

// Sales Dashboard v2 — Overview.
//
// Hero contract: exactly 7 cards — 3 lede + 4 support — over the
// catalog-declared hero IDs. Below them, a status strip with derived
// LIVE / PENDING / NOT CONNECTED counts and an "N of 9 sections have at
// least one live signal · Engine coverage X%." note.
//
// Deltas/sparklines + the v2.1 rail block are deferred per spec § Out
// of scope.
//
// Spec: docs/specs/sales-dashboard-v2.md § Slot order — Overview page.

export const dynamic = 'force-dynamic'

export default async function SalesDashboardOverviewPage() {
  const [data, hero] = await Promise.all([
    fetchSalesDashboardData(),
    Promise.resolve(getHeroMetrics()),
  ])

  const liveCount = METRICS.filter((m) => m.status === 'live').length
  const pendingCount = METRICS.filter((m) => m.status === 'pending').length
  const ncCount = METRICS.filter((m) => m.status === 'not_connected').length
  const sectionsWithLive = new Set(
    METRICS.filter((m) => m.status === 'live').map((m) => m.section),
  ).size
  const coverage = METRICS.length > 0 ? Math.round((liveCount / METRICS.length) * 100) : 0

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · ENGINE"
        title="Today."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <WindowPill />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />

      {/* HERO LEDE — 3-up */}
      <HeroRow style={{ marginTop: 36, gridTemplateColumns: 'repeat(3, 1fr)' }}>
        {hero.lede.map((m) => (
          <MetricCard key={m.id} metric={m} result={data[m.id]} size="hero-lede" />
        ))}
      </HeroRow>

      {/* HERO SUPPORT — 4-up */}
      <HeroRow style={{ marginTop: 16, gridTemplateColumns: 'repeat(4, 1fr)' }}>
        {hero.support.map((m) => (
          <MetricCard key={m.id} metric={m} result={data[m.id]} size="hero-support" />
        ))}
      </HeroRow>

      {/* Status strip */}
      <div
        className="geg-mono"
        style={{
          marginTop: 22,
          padding: '14px 20px',
          background: 'var(--color-geg-bg-elev)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 8,
          display: 'flex',
          alignItems: 'center',
          gap: 28,
          flexWrap: 'wrap',
          fontSize: 11,
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-2)',
        }}
      >
        <StatusItem color="var(--color-geg-pos)" label={`${liveCount} LIVE`} />
        <StatusItem color="var(--color-geg-warn)" label={`${pendingCount} PENDING`} />
        <StatusItem color="var(--color-geg-text-faint)" label={`${ncCount} NOT CONNECTED`} />
        <span
          className="geg-serif"
          style={{
            marginLeft: 'auto',
            color: 'var(--color-geg-text-3)',
            fontStyle: 'italic',
            textTransform: 'none',
            letterSpacing: 0,
            fontSize: 13,
          }}
        >
          {sectionsWithLive} of {SECTION_ORDER.length} sections have at least one live signal · Engine coverage {coverage}%.
        </span>
      </div>
    </div>
  )
}

function StatusItem({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <span
        style={{
          width: 7,
          height: 7,
          borderRadius: '50%',
          background: color,
        }}
      />
      {label}
    </span>
  )
}

// Hero row chrome: the mock creates the inter-card dividers by setting
// the grid's background to --color-geg-border and the cells' bg to
// --color-geg-bg-elev, with `gap: 1px` revealing 1px hairlines between
// them. Outer 1px border + 10px radius wraps it.
function HeroRow({ children, style }: { children: React.ReactNode; style: React.CSSProperties }) {
  return (
    <div
      style={{
        display: 'grid',
        gap: 1,
        background: 'var(--color-geg-border)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        overflow: 'hidden',
        ...style,
      }}
    >
      {children}
    </div>
  )
}
