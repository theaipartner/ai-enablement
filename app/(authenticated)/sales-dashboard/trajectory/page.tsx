import { HeaderBand } from '@/components/gregory/header-band'
import { PacingBand } from '@/components/sales/pacing-band'
import { MtdChart } from '@/components/sales/mtd-chart'
import { SourcePacing } from '@/components/sales/source-pacing'
import { parseWindow } from '@/lib/db/sales-dashboard'
import { getPacing, getSourcePacing } from '@/lib/db/sales-dashboard-mocks'
import { PersonPill } from '../header-pills'
import { WindowSwitcher } from '../window-switcher'

// Sales Dashboard — Trajectory view.
//
// MTD pacing in detail: the band repeated from Pulse for context, then
// the cumulative-cash chart vs target line, then per-source pacing
// against each source's target slice.

export const dynamic = 'force-dynamic'

export default async function SalesDashboardTrajectoryPage({
  searchParams,
}: {
  searchParams?: { window?: string | string[] }
}) {
  // Window switcher is decorative on this page — Trajectory is always
  // MTD-anchored. Parse for URL stability so the switcher works the
  // same way visually.
  parseWindow(searchParams?.window)
  const pacing = getPacing()
  const sourceRows = getSourcePacing(pacing.monthTarget)

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · TRAJECTORY"
        title="On pace?"
        backlink={{ href: '/sales-dashboard', label: 'BACK TO PULSE' }}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <WindowSwitcher />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />
      <PacingBand pacing={pacing} />
      <MtdChart pacing={pacing} />
      <SourcePacing pacing={pacing} rows={sourceRows} />
    </div>
  )
}
