import { HeaderBand } from '@/components/gregory/header-band'
import { DrillTable, Cell, NumCell, MutedCell } from '@/components/sales/drill-table'
import {
  getExpenses,
  getRevenueSummary,
  type Expense,
} from '@/lib/db/revenue-mocks'
import { parseWindow } from '@/lib/db/sales-dashboard'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import { PersonPill } from '../../header-pills'
import { WindowSwitcher } from '../../window-switcher'

// Revenue · Expenses drill-down.
// Itemized expenses for the period with category.

export const dynamic = 'force-dynamic'

const CATEGORY_LABEL: Record<Expense['category'], string> = {
  labor: 'LABOR',
  marketing: 'MARKETING',
  overhead: 'OVERHEAD',
  coaching: 'COACHING',
  software: 'SOFTWARE',
}

const CATEGORY_COLOR: Record<Expense['category'], string> = {
  labor: 'var(--color-geg-accent)',
  marketing: 'var(--color-geg-text-2)',
  overhead: 'var(--color-geg-text-3)',
  coaching: 'var(--color-geg-text-3)',
  software: 'var(--color-geg-text-3)',
}

export default async function ExpensesDrillPage({
  searchParams,
}: {
  searchParams?: { window?: string | string[] }
}) {
  const window = parseWindow(searchParams?.window)
  const expenses = getExpenses(window)
  const summary = getRevenueSummary(window)

  // Optional category totals shown in the strip — folded into the
  // summary at the top so Nabeel sees the breakdown at a glance.
  const byCategory: Record<string, number> = {}
  for (const e of expenses) {
    byCategory[e.category] = (byCategory[e.category] ?? 0) + e.amount
  }

  return (
    <div>
      <HeaderBand
        eyebrow="REVENUE · EXPENSES"
        title="Where the money went."
        backlink={{ href: '/sales-dashboard/revenue', label: 'BACK TO REVENUE' }}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <WindowSwitcher />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />
      <SummaryStrip count={expenses.length} total={summary.expenses} byCategory={byCategory} />
      <DrillTable<Expense>
        rows={expenses}
        columns={[
          { key: 'date', label: 'Logged', align: 'left', width: '110px',
            render: (e) => <MutedCell>{formatDay(e.dateLogged)}</MutedCell> },
          { key: 'vendor', label: 'Vendor', align: 'left', width: 'minmax(0, 1.8fr)',
            render: (e) => <Cell align="left">{e.vendor}</Cell> },
          { key: 'category', label: 'Category', align: 'left', width: '140px',
            render: (e) => (
              <span
                className="geg-mono"
                style={{
                  fontSize: 9.5,
                  letterSpacing: '0.14em',
                  color: CATEGORY_COLOR[e.category],
                  border: `1px solid ${CATEGORY_COLOR[e.category]}`,
                  padding: '3px 7px',
                  borderRadius: 4,
                }}
              >
                {CATEGORY_LABEL[e.category]}
              </span>
            ) },
          { key: 'amount', label: 'Amount', align: 'right', width: '120px',
            render: (e) => <NumCell tone="neg">−{compactUsd(e.amount)}</NumCell> },
        ]}
      />
    </div>
  )
}

function SummaryStrip({
  count,
  total,
  byCategory,
}: {
  count: number
  total: number
  byCategory: Record<string, number>
}) {
  const sorted = Object.entries(byCategory).sort((a, b) => b[1] - a[1])
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
        gap: 18,
        flexWrap: 'wrap',
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
          EXPENSES · {count} LINE ITEM{count === 1 ? '' : 'S'}
        </span>
        <span
          className="geg-mono"
          style={{
            fontSize: 11,
            color: 'var(--color-geg-text-faint)',
            letterSpacing: '0.06em',
            display: 'inline-flex',
            gap: 12,
            flexWrap: 'wrap',
          }}
        >
          {sorted.map(([cat, val]) => (
            <span key={cat}>
              {CATEGORY_LABEL[cat as Expense['category']]} {compactUsd(val)}
            </span>
          ))}
        </span>
      </div>
      <span
        className="geg-numeric-serif"
        style={{ fontSize: 28, letterSpacing: '-0.02em', color: 'var(--color-geg-text)' }}
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
