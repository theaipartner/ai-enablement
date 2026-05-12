import {
  PromPage,
  PromPageHeader,
  PromSection,
  KpiCard,
  PromTable,
  PromTHead,
  PromTH,
  PromTR,
  PromTD,
  money,
} from '@/components/promethean/primitives'
import { getOverviewMetrics, PERIOD_LABEL, SYNC_LABEL } from '@/lib/mock-data'

export const metadata = { title: 'P&L — Promethean' }

export default function PrometheanPnlPage() {
  const m = getOverviewMetrics()

  // Compose a simple P&L line set anchored on real cash + ad spend
  const grossRevenue = m.cash_received
  const adSpend = m.ad_spend
  const closerCommissions = Math.round(m.cash_collected * 0.10)
  const setterCommissions = Math.round(m.cash_collected * 0.04)
  const tools = 4200
  const overhead = 12500
  const totalOpex = adSpend + closerCommissions + setterCommissions + tools + overhead
  const netProfit = grossRevenue - totalOpex
  const margin = grossRevenue ? netProfit / grossRevenue : 0

  const lines: { label: string; value: number; kind: 'rev' | 'opex' | 'profit'; sub?: string }[] = [
    { label: 'Gross revenue (cash cleared)', value: grossRevenue, kind: 'rev' },
    { label: 'Ad spend', value: -adSpend, kind: 'opex', sub: 'Meta · YouTube' },
    { label: 'Closer commissions (10%)', value: -closerCommissions, kind: 'opex' },
    { label: 'Setter commissions (4%)', value: -setterCommissions, kind: 'opex' },
    { label: 'Tooling', value: -tools, kind: 'opex', sub: 'Stripe / CRM / phone' },
    { label: 'Overhead', value: -overhead, kind: 'opex' },
    { label: 'Net profit', value: netProfit, kind: 'profit' },
  ]

  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · P&L"
        title="Top line to bottom line."
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
      />

      <PromSection eyebrow="SUMMARY">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          <KpiCard label="GROSS REVENUE" value={money(grossRevenue, { compact: true })} delta={18} />
          <KpiCard label="TOTAL OPEX" value={money(totalOpex, { compact: true })} delta={4} deltaInvert />
          <KpiCard label="NET PROFIT" value={money(netProfit, { compact: true })} accent delta={9} />
          <KpiCard label="MARGIN" value={`${(margin * 100).toFixed(1)}%`} delta={2} accent />
        </div>
      </PromSection>

      <PromSection eyebrow="LINE BY LINE">
        <PromTable>
          <PromTHead>
            <tr>
              <PromTH>Line</PromTH>
              <PromTH align="right">Amount</PromTH>
            </tr>
          </PromTHead>
          <tbody>
            {lines.map((line) => (
              <PromTR key={line.label}>
                <PromTD>
                  <div className={line.kind === 'profit' ? 'font-medium' : ''}>{line.label}</div>
                  {line.sub ? (
                    <div className="text-xs" style={{ color: 'var(--color-prom-text-3)' }}>
                      {line.sub}
                    </div>
                  ) : null}
                </PromTD>
                <PromTD
                  align="right"
                  className="prom-numeric"
                  style={{
                    color: line.kind === 'profit'
                      ? 'var(--color-prom-accent)'
                      : line.value < 0
                      ? 'var(--color-prom-text-2)'
                      : 'var(--color-prom-text)',
                    fontWeight: line.kind === 'profit' ? 600 : 400,
                  } as React.CSSProperties}
                >
                  {line.value < 0 ? `(${money(Math.abs(line.value))})` : money(line.value)}
                </PromTD>
              </PromTR>
            ))}
          </tbody>
        </PromTable>
      </PromSection>
    </PromPage>
  )
}
