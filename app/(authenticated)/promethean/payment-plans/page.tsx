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
  LEADS,
  PAYMENTS,
  PERIOD_LABEL,
  SYNC_LABEL,
} from '@/lib/mock-data'

export const metadata = { title: 'Payment Plans — Promethean' }

export default function PrometheanPaymentPlansPage() {
  const planLeads = LEADS.filter((l) => l.payment_plan && l.contract_value !== null)
  type PlanRow = {
    lead: typeof LEADS[number]
    total: number
    paid: number
    paidCount: number
    totalCount: number
    nextChargeAt: string | null
  }
  const rows: PlanRow[] = planLeads.map((l) => {
    const pmts = PAYMENTS.filter((p) => p.lead_id === l.id)
    const paid = pmts.reduce((s, p) => s + p.amount, 0)
    const paidCount = pmts.length
    const totalCount = pmts[0]?.payment_plan_total ?? 4
    const lastPaidAt = pmts.length
      ? pmts.map((p) => p.paid_at).sort().pop() ?? null
      : null
    let nextChargeAt: string | null = null
    if (lastPaidAt && paidCount < totalCount) {
      const next = new Date(lastPaidAt)
      next.setUTCDate(next.getUTCDate() + 30)
      nextChargeAt = next.toISOString()
    }
    return {
      lead: l,
      total: l.contract_value ?? 0,
      paid,
      paidCount,
      totalCount,
      nextChargeAt,
    }
  })

  const totalCollected = rows.reduce((s, r) => s + r.paid, 0)
  const totalContract = rows.reduce((s, r) => s + r.total, 0)
  const totalOutstanding = totalContract - totalCollected

  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · PAYMENT PLANS"
        title="Recurring revenue, in flight."
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
      />

      <PromSection eyebrow="PLAN HEALTH">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-5">
          <KpiCard label="ACTIVE PLANS" value={String(rows.length)} delta={4} />
          <KpiCard label="COLLECTED" value={money(totalCollected, { compact: true })} accent />
          <KpiCard label="OUTSTANDING" value={money(totalOutstanding, { compact: true })} />
        </div>
      </PromSection>

      <PromSection eyebrow="ALL PLANS">
        <PromTable>
          <PromTHead>
            <tr>
              <PromTH>Lead</PromTH>
              <PromTH>Plan</PromTH>
              <PromTH align="right">Total</PromTH>
              <PromTH align="right">Paid</PromTH>
              <PromTH align="right">Remaining</PromTH>
              <PromTH>Next charge</PromTH>
              <PromTH>Status</PromTH>
            </tr>
          </PromTHead>
          <tbody>
            {rows.map((r) => {
              const complete = r.paidCount >= r.totalCount
              return (
                <PromTR key={r.lead.id}>
                  <PromTD>{r.lead.name}</PromTD>
                  <PromTD>
                    <span className="prom-numeric text-xs" style={{ color: 'var(--color-prom-text-2)' }}>
                      {r.paidCount} of {r.totalCount}
                    </span>
                  </PromTD>
                  <PromTD align="right" className="prom-numeric">{money(r.total)}</PromTD>
                  <PromTD align="right" className="prom-numeric">{money(r.paid)}</PromTD>
                  <PromTD align="right" className="prom-numeric">{money(r.total - r.paid)}</PromTD>
                  <PromTD>
                    {r.nextChargeAt ? (
                      <span className="prom-numeric text-xs" style={{ color: 'var(--color-prom-text-2)' }}>
                        {new Date(r.nextChargeAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                      </span>
                    ) : (
                      <span style={{ color: 'var(--color-prom-text-3)' }}>—</span>
                    )}
                  </PromTD>
                  <PromTD>
                    {complete ? <Pill tone="pos">complete</Pill> : <Pill tone="warn">in progress</Pill>}
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
