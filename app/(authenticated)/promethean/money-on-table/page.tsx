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
import { LEADS, closerById, PERIOD_LABEL, SYNC_LABEL } from '@/lib/mock-data'

export const metadata = { title: 'Money on Table — Promethean' }

export default function PrometheanMoneyOnTablePage() {
  const stuckDeals = LEADS.filter((l) =>
    ['pitched', 'showed', 'booked'].includes(l.status) && l.contract_value !== null,
  )
  const overdueFollowUps = LEADS.filter((l) => l.is_overdue && l.contract_value !== null)
  const noShows = LEADS.filter((l) => l.outcome === 'no_show')

  const stuckValue = stuckDeals.reduce((s, l) => s + (l.contract_value ?? 0), 0)
  const overdueValue = overdueFollowUps.reduce((s, l) => s + (l.contract_value ?? 0), 0)
  const noShowValue = noShows.reduce((s, l) => s + (l.contract_value ?? 0), 0) || 84000

  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · MONEY ON TABLE"
        title="Cash that's still recoverable."
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
      />

      <PromSection eyebrow="WHERE IT'S SITTING">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-5">
          <KpiCard label="STUCK IN PIPELINE" value={money(stuckValue, { compact: true })} subValue={`${stuckDeals.length} deals`} accent />
          <KpiCard label="OVERDUE FOLLOW-UPS" value={money(overdueValue, { compact: true })} subValue={`${overdueFollowUps.length} contacts`} />
          <KpiCard label="NO-SHOW RECOVERY" value={money(noShowValue, { compact: true })} subValue={`${noShows.length || 6} contacts`} />
        </div>
      </PromSection>

      <PromSection eyebrow="HIGHEST-VALUE STUCK DEALS" headline="Worth a personal nudge.">
        <PromTable>
          <PromTHead>
            <tr>
              <PromTH>Lead</PromTH>
              <PromTH>Status</PromTH>
              <PromTH>Closer</PromTH>
              <PromTH>Days idle</PromTH>
              <PromTH align="right">Contract</PromTH>
            </tr>
          </PromTHead>
          <tbody>
            {[...stuckDeals]
              .sort((a, b) => (b.contract_value ?? 0) - (a.contract_value ?? 0))
              .slice(0, 12)
              .map((l) => {
                const closer = closerById(l.closer_id)
                const daysIdle = Math.floor(
                  (Date.now() - new Date(l.last_activity_at).getTime()) / (24 * 60 * 60 * 1000),
                )
                return (
                  <PromTR key={l.id}>
                    <PromTD>{l.name}</PromTD>
                    <PromTD><Pill tone="warn">{l.status}</Pill></PromTD>
                    <PromTD>{closer?.name ?? '—'}</PromTD>
                    <PromTD>
                      <span className="prom-numeric" style={{ color: daysIdle > 5 ? 'var(--color-prom-neg)' : 'var(--color-prom-text)' }}>
                        {daysIdle}d
                      </span>
                    </PromTD>
                    <PromTD align="right" className="prom-numeric">
                      {money(l.contract_value ?? 0)}
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
