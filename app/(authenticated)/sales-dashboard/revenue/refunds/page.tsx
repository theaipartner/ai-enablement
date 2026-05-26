import { HeaderBand } from '@/components/gregory/header-band'
import { DrillTable, Cell, NumCell, MutedCell } from '@/components/sales/drill-table'
import {
  getRefunds,
  getRevenueSummary,
  type Refund,
} from '@/lib/db/revenue-mocks'
import { parseWindow } from '@/lib/db/sales-dashboard'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import { PersonPill } from '../../header-pills'
import { WindowSwitcher } from '../../window-switcher'

// Revenue · Refunds drill-down.
// Each refund with reason + current client status.

export const dynamic = 'force-dynamic'

export default async function RefundsDrillPage({
  searchParams,
}: {
  searchParams?: { window?: string | string[] }
}) {
  const window = parseWindow(searchParams?.window)
  const refunds = getRefunds(window)
  const summary = getRevenueSummary(window)

  return (
    <div>
      <HeaderBand
        eyebrow="REVENUE · REFUNDS"
        title="What went out and why."
        backlink={{ href: '/sales-dashboard/revenue', label: 'BACK TO REVENUE' }}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <WindowSwitcher />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />
      <SummaryStrip count={refunds.length} total={summary.refunds} />
      <DrillTable<Refund>
        rows={refunds}
        columns={[
          { key: 'date', label: 'Date', align: 'left', width: '110px',
            render: (r) => <MutedCell>{formatDay(r.dateRefunded)}</MutedCell> },
          { key: 'lead', label: 'Lead', align: 'left', width: 'minmax(0, 1.2fr)',
            render: (r) => <Cell align="left">{r.leadName}</Cell> },
          { key: 'reason', label: 'Reason', align: 'left', width: 'minmax(0, 1.6fr)',
            render: (r) => <Cell align="left">{r.reason}</Cell> },
          { key: 'closer', label: 'Closer', align: 'left', width: '110px',
            render: (r) => <Cell align="left">{r.closer}</Cell> },
          { key: 'csm', label: 'CSM', align: 'left', width: '110px',
            render: (r) => <Cell align="left">{r.csm}</Cell> },
          { key: 'amount', label: 'Amount', align: 'right', width: '110px',
            render: (r) => <NumCell tone="neg">−{compactUsd(r.amount)}</NumCell> },
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
        REFUNDS · {count} REFUND{count === 1 ? '' : 'S'}
      </span>
      <span
        className="geg-numeric-serif"
        style={{ fontSize: 28, letterSpacing: '-0.02em', color: 'var(--color-geg-neg)' }}
      >
        −{compactUsd(total)}
      </span>
    </div>
  )
}

function formatDay(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).toUpperCase()
}
