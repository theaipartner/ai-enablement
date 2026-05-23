import { HeaderBand } from '@/components/gregory/header-band'
import {
  BUCKET_DEFINITIONS,
  getAnthropicBucketSummaries,
  getCurrentMonthExtrasForTotal,
  getCurrentMonthTotal,
  getSubscriptionsActiveInCurrentMonth,
  getRecentMonthTotals,
  type BucketSummary,
  type PeriodSummary,
} from '@/lib/db/cost-hub'
import {
  CostExtrasTable,
  MonthlySubscriptionsTable,
  type CostExtraRow,
  type SubscriptionRow,
} from './cost-hub-tables'
import { HistoryView } from './history-view'

// Admin-tier cost-hub page. Server Component composes the page from
// six parallel data fetches:
//   - Anthropic bucket summaries (five buckets x three periods)
//   - Active monthly subscriptions
//   - Current-month one-off extras
//   - Total-this-month (computed read-time from the three above)
//   - Recent month totals (last 12 completed months for the History view)
//
// All client-side state (edit mode on rows, history expander, per-row
// breakdown toggle) lives in the two Client Components below.
//
// Spec: docs/specs/cost-hub.md.

export const dynamic = 'force-dynamic'

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

function formatRunsInt(n: number): string {
  return n.toLocaleString('en-US')
}

function formatAvg(n: number): string {
  // Avg-cost-per-run is typically small; show 4 decimals.
  return `$${n.toFixed(4)}`
}

function currentMonthLabel(): string {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'long',
  })
  return fmt.format(new Date())
}

export default async function CostHubPage() {
  // Three parallel fetches per surface, post-2026-05-24:
  //   - `subsActiveInMonth` (archive-INCLUSIVE; includes provider/notes
  //     for render) — feeds BOTH the running total AND the visible
  //     subscriptions table. Per Part 2 of spec
  //     `cost-hub-total-cancel-remove-and-add`, cancelled subs whose
  //     archived_at is in this month STILL show in the table with a
  //     "Cancelled" badge so the visible line items sum to the running
  //     total. Cancelled rows whose paid month has passed don't reach
  //     here (subscriptionActiveInMonth filters them out).
  //   - `extrasForTotal` (archive-INCLUSIVE, this-month) — feeds BOTH
  //     the running total AND the visible extras table for the same
  //     sum-to-total invariant. (The archive-excluded
  //     `getCurrentMonthExtras` still lives in lib/db/cost-hub.ts but
  //     no longer has callers in this page; future callers can adopt
  //     either shape per their needs.)
  //   - `summaries` + `recentMonths` for the Anthropic boxes + History.
  const [summaries, subsActiveInMonth, extrasForTotal, recentMonths] =
    await Promise.all([
      getAnthropicBucketSummaries(),
      getSubscriptionsActiveInCurrentMonth(),
      getCurrentMonthExtrasForTotal(),
      getRecentMonthTotals(12),
    ])

  // Running total — sums everything counted toward this month. Uses
  // the archive-inclusive lists end-to-end. `getCurrentMonthTotal` is
  // a pure sum; it doesn't know or care about archive state.
  const totalThisMonth = await getCurrentMonthTotal(
    summaries,
    subsActiveInMonth,
    extrasForTotal,
  )

  // Visible subscriptions row list. Includes BOTH active rows (the
  // editable ones) AND cancelled-this-month rows (rendered with a
  // "Cancelled" badge + non-editable + Remove-only). Cancelled rows
  // whose paid month has passed never reach this list (they're
  // already excluded by `subscriptionActiveInMonth`). All needed
  // fields (provider/notes/effective_from/archived_at) come from the
  // widened `SubscriptionWithArchive` shape — no separate metadata
  // lookup needed.
  const subRows: SubscriptionRow[] = subsActiveInMonth.map((s) => ({
    id: s.id,
    provider: s.provider,
    monthly_cost_usd: s.monthly_cost_usd,
    notes: s.notes,
    effective_from: s.effective_from,
    is_cancelled: s.archived_at !== null,
  }))

  const extraRows: CostExtraRow[] = extrasForTotal.map((e) => ({
    id: e.id,
    incurred_on: e.incurred_on,
    description: e.description,
    cost_usd: e.cost_usd,
  }))

  return (
    <div style={{ padding: '32px 48px 80px', maxWidth: 1200, margin: '0 auto' }}>
      <HeaderBand
        eyebrow="COST · HUB"
        title="Cost Hub."
        actions={
          <span
            className="geg-mono"
            style={{
              fontSize: 11,
              color: 'var(--color-geg-text-3)',
              textTransform: 'uppercase',
              letterSpacing: '0.16em',
            }}
          >
            Admin · monthly running total
          </span>
        }
      />

      {/* Total this month — big number box */}
      <div className="geg-gold-box" style={{ marginTop: 32 }}>
        <div className="geg-gold-box-header">
          <h3>TOTAL · THIS MONTH</h3>
          <span
            className="geg-mono"
            style={{ fontSize: 11, color: 'var(--color-geg-text-3)' }}
          >
            {currentMonthLabel()} · running
          </span>
        </div>
        <div className="geg-gold-box-body">
          <div
            className="geg-serif"
            style={{
              fontSize: 56,
              lineHeight: '60px',
              color: 'var(--color-geg-text)',
              marginBottom: 16,
            }}
          >
            {formatUsd(totalThisMonth)}
          </div>
          <HistoryView recentMonths={recentMonths} />
        </div>
      </div>

      {/* Anthropic spend — five bucket boxes */}
      <h2
        className="geg-display"
        style={{ fontSize: 28, marginTop: 48, marginBottom: 20 }}
      >
        Anthropic spend.
      </h2>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))',
          gap: 16,
        }}
      >
        {BUCKET_DEFINITIONS.map((bucket) => (
          <BucketBox key={bucket.key} summary={summaries[bucket.key]} />
        ))}
      </div>

      {/* Monthly subscriptions */}
      <div className="geg-gold-box" style={{ marginTop: 48 }}>
        <div className="geg-gold-box-header">
          <h3>MONTHLY · SUBSCRIPTIONS</h3>
          <span
            className="geg-mono"
            style={{ fontSize: 11, color: 'var(--color-geg-text-3)' }}
          >
            Manually maintained
          </span>
        </div>
        <div className="geg-gold-box-body">
          <MonthlySubscriptionsTable rows={subRows} />
        </div>
      </div>

      {/* One-off extras */}
      <div className="geg-gold-box" style={{ marginTop: 24 }}>
        <div className="geg-gold-box-header">
          <h3>ONE-OFF · EXTRAS · {currentMonthLabel().toUpperCase()}</h3>
          <span
            className="geg-mono"
            style={{ fontSize: 11, color: 'var(--color-geg-text-3)' }}
          >
            This month only
          </span>
        </div>
        <div className="geg-gold-box-body">
          <CostExtrasTable rows={extraRows} />
        </div>
      </div>
    </div>
  )
}

function BucketBox({ summary }: { summary: BucketSummary }) {
  return (
    <div className="geg-gold-box">
      <div className="geg-gold-box-header">
        <h3>{summary.label.toUpperCase()}</h3>
      </div>
      <div className="geg-gold-box-body">
        <PeriodRow
          period="Today"
          summary={summary.today}
        />
        <PeriodRow
          period="This week"
          summary={summary.thisWeek}
        />
        <PeriodRow
          period="This month"
          summary={summary.thisMonth}
        />
      </div>
    </div>
  )
}

function PeriodRow({
  period,
  summary,
}: {
  period: string
  summary: PeriodSummary
}) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '1.4fr 0.8fr 1fr 1fr',
        gap: 10,
        padding: '10px 0',
        borderBottom: '1px solid var(--color-geg-border)',
        alignItems: 'baseline',
      }}
    >
      <div>
        <div
          className="geg-mono"
          style={{
            fontSize: 11,
            color: 'var(--color-geg-text-2)',
            textTransform: 'uppercase',
            letterSpacing: '0.12em',
          }}
        >
          {period}
        </div>
        {summary.neverUsed && period === 'This month' ? (
          <div
            className="geg-mono"
            style={{
              fontSize: 10,
              color: 'var(--color-geg-text-3)',
              marginTop: 2,
              fontStyle: 'italic',
            }}
          >
            (no usage — Sonnet-only today)
          </div>
        ) : summary.dataIncomplete && summary.incompleteSinceDate ? (
          <div
            className="geg-mono"
            style={{
              fontSize: 10,
              color: 'var(--color-geg-text-3)',
              marginTop: 2,
              fontStyle: 'italic',
            }}
          >
            (incomplete before {summary.incompleteSinceDate})
          </div>
        ) : null}
      </div>
      <div
        className="geg-mono"
        style={{ fontSize: 13, color: 'var(--color-geg-text)', textAlign: 'right' }}
      >
        {formatRunsInt(summary.runs)}
      </div>
      <div
        className="geg-mono"
        style={{ fontSize: 13, color: 'var(--color-geg-text)', textAlign: 'right' }}
      >
        {formatUsd(summary.totalCost)}
      </div>
      <div
        className="geg-mono"
        style={{ fontSize: 12, color: 'var(--color-geg-text-3)', textAlign: 'right' }}
      >
        {summary.runs > 0 ? formatAvg(summary.avgCost) : '—'}
      </div>
    </div>
  )
}
