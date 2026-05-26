import { HeaderBand } from '@/components/gregory/header-band'
import { getRevenueSummary } from '@/lib/db/revenue-mocks'
import { parseWindow } from '@/lib/db/sales-dashboard'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import { PersonPill } from '../../header-pills'
import { WindowSwitcher } from '../../window-switcher'

// Revenue · Profit drill-down.
//
// Profit's not a list of records — it's a derivation. This page shows
// the math: New Cash − Refunds − Expenses, with each component
// linked back to its own drill-down.

export const dynamic = 'force-dynamic'

export default async function ProfitDrillPage({
  searchParams,
}: {
  searchParams?: { window?: string | string[] }
}) {
  const window = parseWindow(searchParams?.window)
  const summary = getRevenueSummary(window)

  return (
    <div>
      <HeaderBand
        eyebrow="REVENUE · PROFIT"
        title="The math."
        backlink={{ href: '/sales-dashboard/revenue', label: 'BACK TO REVENUE' }}
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <WindowSwitcher />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />
      <section
        style={{
          marginTop: 28,
          padding: '32px 36px 36px',
          background: 'var(--color-geg-bg-elev)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 10,
        }}
      >
        <div
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-3)',
            marginBottom: 18,
          }}
        >
          CASH PROFIT — DELIBERATELY USES NEW CASH, NOT FUTURE
        </div>
        <Row label="New cash" value={summary.newCash} sign="+" href="/sales-dashboard/revenue/new-cash" />
        <Row label="Refunds" value={summary.refunds} sign="−" href="/sales-dashboard/revenue/refunds" />
        <Row label="Expenses" value={summary.expenses} sign="−" href="/sales-dashboard/revenue/expenses" />
        <hr
          style={{
            border: 'none',
            borderTop: '1px solid var(--color-geg-border-strong)',
            margin: '18px 0 12px',
          }}
        />
        <Row label="Profit" value={summary.profit} sign="=" tone={summary.profit >= 0 ? 'pos' : 'neg'} big />
      </section>

      <div
        className="geg-serif"
        style={{
          marginTop: 18,
          padding: '16px 22px',
          color: 'var(--color-geg-text-3)',
          fontStyle: 'italic',
          fontSize: 13.5,
          letterSpacing: '-0.002em',
          maxWidth: 720,
        }}
      >
        Why this excludes Future: contracted revenue counted at full
        value is sales performance, not cash. You can&apos;t pay for ads
        with money that hasn&apos;t arrived. Profit pulls only what&apos;s
        already in the bank.
      </div>
    </div>
  )
}

function Row({
  label,
  value,
  sign,
  href,
  tone,
  big,
}: {
  label: string
  value: number
  sign: string
  href?: string
  tone?: 'pos' | 'neg'
  big?: boolean
}) {
  const valColor =
    tone === 'pos'
      ? 'var(--color-geg-pos)'
      : tone === 'neg'
        ? 'var(--color-geg-neg)'
        : 'var(--color-geg-text)'
  const Wrap = href ? 'a' : 'div'
  return (
    <Wrap
      {...(href ? { href } : {})}
      style={{
        display: 'grid',
        gridTemplateColumns: '32px 1fr auto',
        gap: 18,
        padding: '12px 0',
        alignItems: 'baseline',
        textDecoration: 'none',
        color: 'inherit',
      }}
    >
      <span
        className="geg-mono"
        style={{
          fontSize: big ? 22 : 18,
          color: tone === 'neg' ? 'var(--color-geg-neg)' : tone === 'pos' ? 'var(--color-geg-pos)' : 'var(--color-geg-text-faint)',
          letterSpacing: '0.04em',
        }}
      >
        {sign}
      </span>
      <span
        className="geg-serif"
        style={{
          fontSize: big ? 22 : 17,
          color: 'var(--color-geg-text)',
          letterSpacing: '-0.005em',
        }}
      >
        {label}
        {href ? (
          <span
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              color: 'var(--color-geg-text-faint)',
              marginLeft: 10,
            }}
          >
            OPEN →
          </span>
        ) : null}
      </span>
      <span
        className="geg-numeric-serif"
        style={{
          fontSize: big ? 44 : 26,
          letterSpacing: '-0.025em',
          color: valColor,
          lineHeight: big ? '46px' : '28px',
        }}
      >
        {compactUsd(value)}
      </span>
    </Wrap>
  )
}
