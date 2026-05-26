import { HeaderBand } from '@/components/gregory/header-band'
import { DrillTable, Cell, NumCell, MutedCell } from '@/components/sales/drill-table'
import {
  getTransactions,
  getRevenueSummary,
  OFFERS,
  type Transaction,
} from '@/lib/db/revenue-mocks'
import { parseWindow } from '@/lib/db/sales-dashboard'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import { PersonPill } from '../../header-pills'
import { WindowSwitcher } from '../../window-switcher'

// Revenue · New Cash drill-down.
//
// Every transaction (payment) that landed in the period. Each row =
// one payment, not one deal — payment-plan deals show multiple rows.

export const dynamic = 'force-dynamic'

export default async function NewCashDrillPage({
  searchParams,
}: {
  searchParams?: { window?: string | string[] }
}) {
  const window = parseWindow(searchParams?.window)
  const transactions = getTransactions(window)
  const summary = getRevenueSummary(window)

  return (
    <div>
      <HeaderBand
        eyebrow="REVENUE · NEW CASH"
        title="Every payment that landed."
        backlink={{ href: '/sales-dashboard/revenue', label: 'BACK TO REVENUE' }}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <WindowSwitcher />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />
      <SummaryStrip
        count={transactions.length}
        total={summary.newCash}
      />
      <DrillTable<Transaction>
        rows={transactions}
        columns={[
          { key: 'date', label: 'Landed', align: 'left', width: '110px',
            render: (t) => <MutedCell>{formatDay(t.dateLanded)}</MutedCell> },
          { key: 'lead', label: 'Lead', align: 'left', width: 'minmax(0, 1.6fr)',
            render: (t) => <Cell align="left">{t.leadName}</Cell> },
          { key: 'offer', label: 'Offer', align: 'left', width: 'minmax(0, 1.4fr)',
            render: (t) => <Cell align="left">{OFFERS[t.offerType].label}</Cell> },
          { key: 'closer', label: 'Closer / CSM', align: 'left', width: '160px',
            render: (t) => (
              <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 8 }}>
                <Cell align="left">{t.closer}</Cell>
                {t.isBackend ? (
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
            render: (t) => <MutedCell>{t.source.toUpperCase()}</MutedCell> },
          { key: 'amount', label: 'Amount', align: 'right', width: '110px',
            render: (t) => <NumCell accent>{compactUsd(t.amount)}</NumCell> },
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
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 18 }}>
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-3)',
          }}
        >
          NEW CASH · {count} PAYMENT{count === 1 ? '' : 'S'}
        </span>
      </div>
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
