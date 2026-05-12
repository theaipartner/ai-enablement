import {
  PromPage,
  PromPageHeader,
  PromCard,
  PromSection,
  KpiCard,
  PromTable,
  PromTHead,
  PromTH,
  PromTR,
  PromTD,
  Pill,
} from '@/components/promethean/primitives'
import { DIALS, SETTERS, PERIOD_LABEL, SYNC_LABEL } from '@/lib/mock-data'

export const metadata = { title: 'Number Health — Promethean' }

export default function PrometheanNumberHealthPage() {
  const totalDials = DIALS.length
  const noAnswer = DIALS.filter((d) => d.outcome === 'no_answer').length
  const voicemail = DIALS.filter((d) => d.outcome === 'voicemail').length
  const live = DIALS.filter((d) => d.outcome === 'live').length
  const booked = DIALS.filter((d) => d.outcome === 'booked').length
  const totalTalk = DIALS.reduce((s, d) => s + d.talk_time_seconds, 0)

  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · NUMBER HEALTH"
        title="How the dials are holding up."
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
      />

      <PromSection eyebrow="DIAL MIX" headline="What every dial returns.">
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-5">
          <KpiCard label="TOTAL DIALS" value={String(totalDials)} size="sm" />
          <KpiCard label="NO ANSWER" value={String(noAnswer)} size="sm" delta={2} deltaInvert />
          <KpiCard label="VOICEMAIL" value={String(voicemail)} size="sm" />
          <KpiCard label="LIVE CONVOS" value={String(live)} size="sm" accent />
          <KpiCard label="BOOKED" value={String(booked)} size="sm" accent />
        </div>
      </PromSection>

      <PromSection eyebrow="HEALTH" headline="Watchlist — flagged numbers.">
        <PromCard className="p-5 mb-5" style={{ background: 'rgba(244, 183, 64, 0.06)', borderColor: 'var(--color-prom-warn-dim)' } as React.CSSProperties}>
          <div className="text-sm" style={{ color: 'var(--color-prom-text-2)', lineHeight: '1.55' }}>
            2 lines flagged for spam-likely tagging. Aiden&apos;s line is at 14.3% answer rate, 11pts below team avg — recommend swap.
          </div>
        </PromCard>
        <PromTable>
          <PromTHead>
            <tr>
              <PromTH>Setter</PromTH>
              <PromTH>Number</PromTH>
              <PromTH align="right">Dials</PromTH>
              <PromTH align="right">Answer rate</PromTH>
              <PromTH align="right">Avg talk</PromTH>
              <PromTH>Status</PromTH>
            </tr>
          </PromTHead>
          <tbody>
            {SETTERS.map((s, i) => {
              const myDials = DIALS.filter((d) => d.setter_id === s.id)
              const myAnswers = myDials.filter((d) => d.outcome === 'live' || d.outcome === 'booked').length
              const ans = myDials.length ? myAnswers / myDials.length : 0
              const flagged = ans < 0.16
              return (
                <PromTR key={s.id}>
                  <PromTD>{s.name}</PromTD>
                  <PromTD className="prom-numeric text-xs" >
                    +1 ({200 + i * 11}) 555-{(8000 + i * 137).toString().slice(0, 4)}
                  </PromTD>
                  <PromTD align="right" className="prom-numeric">{myDials.length}</PromTD>
                  <PromTD align="right" className="prom-numeric">
                    {(ans * 100).toFixed(1)}%
                  </PromTD>
                  <PromTD align="right" className="prom-numeric">
                    {Math.round(myDials.reduce((s, d) => s + d.talk_time_seconds, 0) / Math.max(1, myDials.length))}s
                  </PromTD>
                  <PromTD>
                    {flagged ? <Pill tone="neg">spam-likely</Pill> : <Pill tone="pos">healthy</Pill>}
                  </PromTD>
                </PromTR>
              )
            })}
          </tbody>
        </PromTable>
      </PromSection>

      <PromSection eyebrow="TALK TIME · ALL HANDS">
        <PromCard className="p-6">
          <div className="prom-numeric font-semibold" style={{ fontSize: 44 }}>
            {Math.round(totalTalk / 3600)}h {Math.round((totalTalk % 3600) / 60)}m
          </div>
          <div className="prom-eyebrow mt-1">TOTAL TALK · LAST 30 DAYS</div>
        </PromCard>
      </PromSection>
    </PromPage>
  )
}
