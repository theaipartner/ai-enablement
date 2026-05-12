import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  PromPage,
  PromPageHeader,
  PromCard,
  PromSection,
  KpiCard,
  Pill,
  PromTable,
  PromTHead,
  PromTH,
  PromTR,
  PromTD,
  pct,
} from '@/components/promethean/primitives'
import {
  getSetterStats,
  DIALS,
  LEADS,
  PERIOD_LABEL,
  SYNC_LABEL,
} from '@/lib/mock-data'

export default function PrometheanSetterDetailPage({ params }: { params: { id: string } }) {
  const stats = getSetterStats()
  const setter = stats.find((s) => s.id === params.id)
  if (!setter) return notFound()
  const dials = DIALS.filter((d) => d.setter_id === setter.id)
  const recentDials = [...dials]
    .sort((a, b) => b.dialed_at.localeCompare(a.dialed_at))
    .slice(0, 14)

  // Group dials by day for the timeline visualization
  const days = new Map<string, typeof dials>()
  for (const d of dials) {
    const key = d.dialed_at.slice(0, 10)
    if (!days.has(key)) days.set(key, [])
    days.get(key)!.push(d)
  }
  const dayKeys = Array.from(days.keys()).sort().slice(-7)

  return (
    <PromPage>
      <Link
        href="/promethean/setters"
        className="prom-eyebrow hover:underline inline-block mb-4"
        style={{ color: 'var(--color-prom-text-3)' }}
      >
        ← BACK TO SETTERS
      </Link>
      <PromPageHeader
        eyebrow="SETTER BREAKDOWN"
        title={setter.name}
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
      />

      <PromSection>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-5">
          <KpiCard label="DIALS" value={String(setter.dials)} size="sm" />
          <KpiCard label="SPEED · LEAD" value={`${setter.avg_speed_to_lead_minutes}m`} size="sm" />
          <KpiCard label="CONVOS" value={String(setter.conversations)} size="sm" />
          <KpiCard label="BOOKINGS" value={String(setter.bookings)} size="sm" accent />
          <KpiCard label="SHOW RATE" value={pct(setter.show_rate, 0)} size="sm" />
        </div>
      </PromSection>

      <PromSection eyebrow="DIAL TIMELINE" headline="Last 7 days, gap-by-gap.">
        <PromCard className="p-6 overflow-x-auto">
          <div className="flex flex-col gap-3 min-w-[600px]">
            {dayKeys.map((day) => {
              const dayDials = (days.get(day) ?? []).sort((a, b) => a.dialed_at.localeCompare(b.dialed_at))
              return (
                <div key={day} className="flex items-center gap-3">
                  <div className="prom-eyebrow w-20 shrink-0">
                    {new Date(day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </div>
                  <div className="flex-1 flex gap-0.5 h-7 items-stretch">
                    {dayDials.length === 0 ? (
                      <div
                        className="w-full text-xs flex items-center pl-2"
                        style={{ color: 'var(--color-prom-text-3)' }}
                      >
                        no dials
                      </div>
                    ) : (
                      dayDials.map((d, i) => {
                        const gap = i > 0
                          ? (new Date(d.dialed_at).getTime() - new Date(dayDials[i - 1].dialed_at).getTime()) / 1000 / 60
                          : 0
                        const showGap = gap > 8
                        const color =
                          d.outcome === 'booked' ? 'var(--color-prom-accent)' :
                          d.outcome === 'live' ? 'var(--color-prom-warn)' :
                          'rgba(255,255,255,0.18)'
                        return (
                          <div key={d.id} className="flex items-stretch gap-0.5">
                            {showGap ? (
                              <div
                                className="text-[9px] px-1 flex items-center"
                                style={{ color: 'var(--color-prom-text-3)' }}
                              >
                                {Math.round(gap)}m
                              </div>
                            ) : null}
                            <div
                              className="w-2 rounded-sm"
                              style={{ background: color }}
                              title={`${d.outcome} · ${Math.round(d.talk_time_seconds / 60)}m`}
                            />
                          </div>
                        )
                      })
                    )}
                  </div>
                  <div className="prom-eyebrow prom-numeric w-12 text-right">
                    {dayDials.length}
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex items-center gap-4 mt-4 text-xs" style={{ color: 'var(--color-prom-text-3)' }}>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-3 rounded-sm" style={{ background: 'var(--color-prom-accent)' }} /> booked
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-3 rounded-sm" style={{ background: 'var(--color-prom-warn)' }} /> live convo
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="w-2 h-3 rounded-sm" style={{ background: 'rgba(255,255,255,0.18)' }} /> no-answer / voicemail
            </span>
          </div>
        </PromCard>
      </PromSection>

      <PromSection eyebrow="RECENT CALLS" headline="Last 14 dials.">
        <PromTable>
          <PromTHead>
            <tr>
              <PromTH>When</PromTH>
              <PromTH>Lead</PromTH>
              <PromTH>Outcome</PromTH>
              <PromTH align="right">Talk time</PromTH>
            </tr>
          </PromTHead>
          <tbody>
            {recentDials.map((d) => {
              const lead = LEADS.find((l) => l.id === d.lead_id)
              return (
                <PromTR key={d.id}>
                  <PromTD>
                    <span className="text-xs prom-numeric" style={{ color: 'var(--color-prom-text-2)' }}>
                      {new Date(d.dialed_at).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </PromTD>
                  <PromTD>{lead?.name ?? '—'}</PromTD>
                  <PromTD>
                    <Pill tone={d.outcome === 'booked' ? 'pos' : d.outcome === 'live' ? 'warn' : 'neutral'}>
                      {d.outcome.replace('_', ' ')}
                    </Pill>
                  </PromTD>
                  <PromTD align="right" className="prom-numeric">
                    {Math.floor(d.talk_time_seconds / 60)}m {d.talk_time_seconds % 60}s
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
