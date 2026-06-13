import type { CSSProperties } from 'react'
import { HeaderBand } from '@/components/gregory/header-band'

// Skeleton fallbacks for the sales routes' loading.tsx. The App Router shows
// these the INSTANT a nav link is clicked, while the server component streams —
// so a click gives immediate feedback (the header is real, the body shimmers)
// instead of a frozen page. Purely presentational; no data.

function Sk({ w = '100%', h = 16, style }: { w?: number | string; h?: number; style?: CSSProperties }) {
  return <div className="geg-skeleton" style={{ width: w, height: h, ...style }} />
}

function Rows({ n, h = 30 }: { n: number; h?: number }) {
  return (
    <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {Array.from({ length: n }).map((_, i) => (
        <Sk key={i} h={h} />
      ))}
    </div>
  )
}

export function FunnelSkeleton() {
  return (
    <div>
      <HeaderBand eyebrow="SALES · FUNNEL" title="Funnel." />
      <Sk h={44} style={{ marginTop: 14 }} />
      <div style={{ marginTop: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {[0, 1, 2, 3].map((i) => (
          <Sk key={i} h={70} />
        ))}
      </div>
      <Sk h={120} style={{ marginTop: 20 }} />
    </div>
  )
}

export function LeadsSkeleton() {
  return (
    <div>
      <HeaderBand eyebrow="SALES · LEADS" title="Leads." />
      <Sk h={40} style={{ marginTop: 16, maxWidth: 440 }} />
      <Rows n={12} h={28} />
    </div>
  )
}

export function TalentSkeleton() {
  return (
    <div>
      <HeaderBand eyebrow="SALES · TALENT" title="Talent." />
      <Sk h={36} style={{ marginTop: 16, maxWidth: 320 }} />
      <Rows n={6} />
      <Rows n={4} />
    </div>
  )
}

// Catch-all for the remaining sales routes (ads, landing-pages, revival, …).
export function GenericSalesSkeleton() {
  return (
    <div>
      <Sk h={48} style={{ maxWidth: 280 }} />
      <Rows n={8} h={32} />
    </div>
  )
}
