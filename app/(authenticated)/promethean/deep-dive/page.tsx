import {
  PromPage,
  PromPageHeader,
  PromCard,
  PromSection,
  KpiCard,
  Pill,
  PreviewBadge,
  PromDropdownStub,
  money,
} from '@/components/promethean/primitives'
import {
  getPairingMatrix,
  SETTERS,
  CLOSERS,
  LEADS,
  PERIOD_LABEL,
  SYNC_LABEL,
} from '@/lib/mock-data'

export const metadata = { title: 'Deep Dive — Promethean' }

export default function PrometheanDeepDivePage() {
  const pairings = getPairingMatrix(2)
  const totalNoShows = LEADS.filter((l) => l.outcome === 'no_show').length
  const totalBooked = LEADS.filter((l) => l.booked_at).length
  const noShowRate = totalBooked ? totalNoShows / totalBooked : 0

  // Build a map for matrix rendering
  const cellLookup = new Map<string, { cash: number; deals: number }>()
  for (const p of pairings) {
    cellLookup.set(`${p.setter.id}::${p.closer.id}`, { cash: p.cash, deals: p.deals })
  }
  const maxCash = Math.max(...pairings.map((p) => p.cash), 1)

  // Lead quality outcome breakdown
  const qualityBuckets: Record<string, { total: number; won: number }> = {
    ready_to_buy: { total: 0, won: 0 },
    good: { total: 0, won: 0 },
    average: { total: 0, won: 0 },
    poor: { total: 0, won: 0 },
  }
  for (const l of LEADS) {
    if (l.lead_quality && qualityBuckets[l.lead_quality]) {
      qualityBuckets[l.lead_quality].total++
      if (l.outcome === 'won') qualityBuckets[l.lead_quality].won++
    }
  }

  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · DEEP DIVE"
        title="The patterns under the patterns."
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
        trailing={
          <div className="flex items-center gap-2">
            <PromDropdownStub label="Cash collected" />
            <PromDropdownStub label="Min 2 samples" />
          </div>
        }
      />

      <PromSection eyebrow="NO-SHOW WINDOWS" headline="When do bookings most likely ghost?">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          <KpiCard label="NO-SHOW RATE" value={`${(noShowRate * 100).toFixed(1)}%`} delta={-3} deltaInvert />
          <KpiCard label="PEAK GHOST HOUR" value="11–12 AM" size="sm" />
          <KpiCard label="MON GHOST RATE" value="22%" size="sm" delta={5} deltaInvert />
          <KpiCard label="FRI GHOST RATE" value="14%" size="sm" delta={-2} deltaInvert />
        </div>
      </PromSection>

      <PromSection eyebrow="PAIRING MATRIX" headline="Which setter–closer combo prints money?">
        <PromCard className="p-6 overflow-x-auto">
          <div className="text-xs mb-4" style={{ color: 'var(--color-prom-text-2)' }}>
            Cell intensity = cash collected. Min 2 won deals to show. Click for breakdown.
          </div>
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="px-2 py-2 text-left prom-eyebrow"></th>
                {CLOSERS.map((c) => (
                  <th key={c.id} className="px-2 py-2 text-center prom-eyebrow">
                    {c.name.split(' ')[0]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {SETTERS.map((s) => (
                <tr key={s.id}>
                  <td className="px-2 py-2 prom-eyebrow" style={{ borderTop: '1px solid var(--color-prom-border)' }}>
                    {s.name.split(' ')[0]}
                  </td>
                  {CLOSERS.map((c) => {
                    const cell = cellLookup.get(`${s.id}::${c.id}`)
                    const intensity = cell ? cell.cash / maxCash : 0
                    return (
                      <td
                        key={c.id}
                        className="px-2 py-2 text-center prom-numeric"
                        style={{
                          borderTop: '1px solid var(--color-prom-border)',
                          background: cell ? `rgba(212, 225, 87, ${0.04 + intensity * 0.25})` : 'transparent',
                          color: cell ? 'var(--color-prom-text)' : 'var(--color-prom-text-3)',
                        }}
                      >
                        {cell ? (
                          <div>
                            <div className="font-medium">{money(cell.cash, { compact: true })}</div>
                            <div className="text-[10px]" style={{ color: 'var(--color-prom-text-2)' }}>
                              {cell.deals} deals
                            </div>
                          </div>
                        ) : (
                          '—'
                        )}
                      </td>
                    )
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </PromCard>
      </PromSection>

      <PromSection eyebrow="LEAD QUALITY → OUTCOME" trailing={<PreviewBadge />} headline="Does the score predict the sale?">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          {Object.entries(qualityBuckets).map(([bucket, v]) => (
            <PromCard key={bucket} className="p-5">
              <div className="prom-eyebrow">{bucket.replace('_', ' ').toUpperCase()}</div>
              <div className="prom-numeric font-semibold mt-2" style={{ fontSize: 30 }}>
                {v.total ? Math.round((v.won / v.total) * 100) : 0}%
              </div>
              <div className="text-xs mt-1" style={{ color: 'var(--color-prom-text-2)' }}>
                {v.won} of {v.total} won
              </div>
              <div className="mt-3">
                <Pill tone={bucket === 'ready_to_buy' ? 'pos' : bucket === 'poor' ? 'neg' : 'warn'}>
                  {bucket === 'ready_to_buy' ? 'highest' : bucket === 'poor' ? 'lowest' : 'middle'} band
                </Pill>
              </div>
            </PromCard>
          ))}
        </div>
      </PromSection>
    </PromPage>
  )
}
