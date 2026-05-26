import { HeaderBand } from '@/components/gregory/header-band'
import { RevenueTile } from '@/components/sales/revenue-tile'
import { ProjectionBlock } from '@/components/sales/projection-block'
import {
  getRevenueSummary,
  getMtdDailyCash,
  OFFERS,
  type OfferType,
} from '@/lib/db/revenue-mocks'
import { parseWindow } from '@/lib/db/sales-dashboard'
import { PersonPill } from '../header-pills'
import { WindowSwitcher } from '../window-switcher'

// Sales Dashboard — Revenue.
//
// The "money page." Five tiles ladder up to Profit: New Cash + Future
// + Refunds + Expenses, with Profit doing the math on top. Each tile
// is a doorway — click opens a drill-down sub-route with the
// underlying records.
//
// Below the tiles, a projection block lets Nabeel set this-month's
// assumptions (units per offer, % upfront, ad spend, expense target)
// and compares the resulting projected new cash + profit against the
// actual MTD pace.

export const dynamic = 'force-dynamic'

export default async function SalesDashboardRevenuePage({
  searchParams,
}: {
  searchParams?: { window?: string | string[] }
}) {
  const window = parseWindow(searchParams?.window)
  const summary = getRevenueSummary(window)
  const mtd = getMtdDailyCash()

  // Offer list passed to the projection editor — derived from the
  // canonical OFFERS catalog so the form stays in sync if products
  // change. Render in deal-flow order; renewals/upsells move into
  // their own group via being marked as backend in the mock.
  const offers = (Object.keys(OFFERS) as OfferType[]).map((id) => ({
    id,
    label: OFFERS[id].label,
    price: OFFERS[id].price,
    defaultUpfrontPct: OFFERS[id].defaultUpfrontPct,
  }))

  // Today's MTD actuals (cumulative cash + a rough profit reuse for
  // pace context). For now profit-so-far reuses the same period's
  // summary; real wiring will recompute MTD profit independently.
  const actualCashSoFar = mtd.points.reduce((s, p) => s + p.actual, 0)
  const actualProfitSoFar = summary.profit

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · REVENUE"
        title="Revenue."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <WindowSwitcher />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />

      {/* New Cash hero — top of the ladder */}
      <div style={{ marginTop: 36 }}>
        <RevenueTile
          href="/sales-dashboard/revenue/new-cash"
          eyebrow="HERO · NEW CASH"
          label="What landed in the bank"
          value={summary.newCash}
          delta={summary.newCashDelta}
          sub="Includes payment-plan installments"
          variant="hero"
        />
      </div>

      {/* Supporting row — Future / Refunds / Expenses */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(3, 1fr)',
          gap: 12,
          marginTop: 12,
        }}
      >
        <RevenueTile
          href="/sales-dashboard/revenue/future"
          eyebrow="FUTURE"
          label="Total contract value sold"
          value={summary.future}
          sub="Sales performance — not pipeline"
          variant="support"
        />
        <RevenueTile
          href="/sales-dashboard/revenue/refunds"
          eyebrow="REFUNDS"
          label="Out the door this period"
          value={summary.refunds}
          sub="Click for reasons"
          variant="support"
          tone="neg"
        />
        <RevenueTile
          href="/sales-dashboard/revenue/expenses"
          eyebrow="EXPENSES"
          label="Spend this period"
          value={summary.expenses}
          sub="Click for itemized"
          variant="support"
          tone="neg"
        />
      </div>

      {/* Profit hero — the ladder's conclusion (the math lands here) */}
      <div style={{ marginTop: 12 }}>
        <RevenueTile
          href="/sales-dashboard/revenue/profit"
          eyebrow="HERO · PROFIT"
          label="Cash profit this period"
          value={summary.profit}
          delta={summary.profitDelta}
          sub="New cash − refunds − expenses"
          variant="hero"
          tone={summary.profit >= 0 ? 'pos' : 'neg'}
        />
      </div>

      <ProjectionBlock
        offers={offers}
        mtd={mtd}
        actualCashSoFar={actualCashSoFar}
        actualProfitSoFar={actualProfitSoFar}
      />
    </div>
  )
}
