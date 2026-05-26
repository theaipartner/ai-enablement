import { HeaderBand } from '@/components/gregory/header-band'
import { DrillTable, Cell, NumCell, MutedCell } from '@/components/sales/drill-table'
import {
  getDeals,
  getRevenueSummary,
  OFFERS,
  type Deal,
} from '@/lib/db/revenue-mocks'
import { parseWindow } from '@/lib/db/sales-dashboard'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import { PersonPill } from '../../header-pills'
import { WindowSwitcher } from '../../window-switcher'

// Revenue · Future drill-down.
//
// Every deal CLOSED in the period — counted once at full contract
// value. Sales-performance number, not pipeline. Backend deals
// (renewals / upsells) show the CSM in the closer column with an
// inline backend marker.

export const dynamic = 'force-dynamic'

export default async function FutureDrillPage({
  searchParams,
}: {
  searchParams?: { window?: string | string[] }
}) {
  const window = parseWindow(searchParams?.window)
  const deals = getDeals(window)
  const summary = getRevenueSummary(window)

  return (
    <div>
      <HeaderBand
        eyebrow="REVENUE · FUTURE"
        title="Deals closed — full contract value."
        backlink={{ href: '/sales-dashboard/revenue', label: 'BACK TO REVENUE' }}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <WindowSwitcher />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />
      <SummaryStrip count={deals.length} total={summary.future} />
      <DrillTable<Deal>
        rows={deals}
        columns={[
          { key: 'date', label: 'Closed', align: 'left', width: '110px',
            render: (d) => <MutedCell>{formatDay(d.dateClosed)}</MutedCell> },
          { key: 'lead', label: 'Lead', align: 'left', width: 'minmax(0, 1.6fr)',
            render: (d) => <Cell align="left">{d.leadName}</Cell> },
          { key: 'offer', label: 'Offer', align: 'left', width: 'minmax(0, 1.4fr)',
            render: (d) => <Cell align="left">{OFFERS[d.offerType].label}</Cell> },
          { key: 'closer', label: 'Closer / CSM', align: 'left', width: '160px',
            render: (d) => (
              <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
                <Cell align="left">{d.closer}</Cell>
                {d.isBackend ? (
                  <span
                    className="geg-mono"
                    style={{
                      fontSize: 9,
                      letterSpacing: '0.14em',
                      color: 'var(--color-geg-accent)',
                      border: '1px solid var(--color-geg-accent)',
                      padding: '1px 5px',
                      borderRadius: 3,
                    }}
                  >
                    CSM
                  </span>
                ) : null}
              </span>
            ) },
          { key: 'source', label: 'Source', align: 'left', width: '120px',
            render: (d) => <MutedCell>{d.source.toUpperCase()}</MutedCell> },
          { key: 'amount', label: 'Contract', align: 'right', width: '110px',
            render: (d) => <NumCell accent>{compactUsd(d.contractAmount)}</NumCell> },
        ]}
      />
    </div>
  )
}

function SummaryStrip({ count, total }: { count: number; total: number }) {
  return (
    <div
      style={{
        marginTop: 28,
        padding: '16px 22px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 8,
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        gap: 14,
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
        FUTURE · {count} DEAL{count === 1 ? '' : 'S'} CLOSED
      </span>
      <span
        className="geg-numeric-serif"
        style={{ fontSize: 28, letterSpacing: '-0.02em', color: 'var(--color-geg-text)' }}
      >
        {compactUsd(total)}
      </span>
    </div>
  )
}

function formatDay(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
}
