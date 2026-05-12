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
  Pill,
  money,
} from '@/components/promethean/primitives'
import {
  getOverviewMetrics,
  LEADS,
  PAYMENTS,
  PERIOD_LABEL,
  SYNC_LABEL,
} from '@/lib/mock-data'

export const metadata = { title: 'Financials — Promethean' }

export default function PrometheanFinancialsPage() {
  const m = getOverviewMetrics()
  const recentPayments = [...PAYMENTS]
    .sort((a, b) => b.paid_at.localeCompare(a.paid_at))
    .slice(0, 12)

  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · FINANCIALS"
        title="Cash, contracts, profit."
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
      />

      <PromSection eyebrow="THIS PERIOD" headline="The headline numbers.">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          <KpiCard label="REVENUE" value={money(m.contract_value, { compact: true })} delta={12} />
          <KpiCard label="CASH COLLECTED" value={money(m.cash_collected, { compact: true })} delta={-43} />
          <KpiCard label="CASH RECEIVED (STRIPE)" value={money(m.cash_received, { compact: true })} delta={18} />
          <KpiCard label="PROFIT" value={money(m.profit, { compact: true })} delta={9} accent />
        </div>
      </PromSection>

      <PromSection eyebrow="RECENT" headline="Last 12 payments cleared.">
        <PromTable>
          <PromTHead>
            <tr>
              <PromTH>Date</PromTH>
              <PromTH>Lead</PromTH>
              <PromTH>Plan position</PromTH>
              <PromTH align="right">Amount</PromTH>
            </tr>
          </PromTHead>
          <tbody>
            {recentPayments.map((p) => {
              const lead = LEADS.find((l) => l.id === p.lead_id)
              return (
                <PromTR key={p.id}>
                  <PromTD>
                    <span className="text-xs prom-numeric" style={{ color: 'var(--color-prom-text-2)' }}>
                      {new Date(p.paid_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </PromTD>
                  <PromTD>{lead?.name ?? '—'}</PromTD>
                  <PromTD>
                    {p.payment_plan_position !== null && p.payment_plan_total !== null ? (
                      <Pill tone="warn">
                        {p.payment_plan_position} / {p.payment_plan_total}
                      </Pill>
                    ) : (
                      <Pill tone="pos">full pay</Pill>
                    )}
                  </PromTD>
                  <PromTD align="right" className="prom-numeric">
                    {money(p.amount)}
                  </PromTD>
                </PromTR>
              )
            })}
          </tbody>
        </PromTable>
      </PromSection>
    </PromPage>
  )
}
