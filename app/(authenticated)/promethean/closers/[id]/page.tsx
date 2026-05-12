import Link from 'next/link'
import { notFound } from 'next/navigation'
import {
  PromPage,
  PromPageHeader,
  PromCard,
  PromSection,
  KpiCard,
  LeverageCard,
  PreviewBadge,
  money,
  pct,
} from '@/components/promethean/primitives'
import {
  getCloserStats,
  LEADS,
  PERIOD_LABEL,
  SYNC_LABEL,
} from '@/lib/mock-data'

export default function PrometheanCloserDetailPage({ params }: { params: { id: string } }) {
  const stats = getCloserStats()
  const closer = stats.find((c) => c.id === params.id)
  if (!closer) return notFound()
  const won = LEADS.filter((l) => l.closer_id === closer.id && l.outcome === 'won')
  const lost = LEADS.filter((l) => l.closer_id === closer.id && l.outcome === 'lost')
  const noShows = LEADS.filter((l) => l.closer_id === closer.id && l.outcome === 'no_show')
  const followUps = LEADS.filter((l) => l.closer_id === closer.id && ['booked', 'showed'].includes(l.status))

  return (
    <PromPage>
      <Link
        href="/promethean/closers"
        className="prom-eyebrow hover:underline inline-block mb-4"
        style={{ color: 'var(--color-prom-text-3)' }}
      >
        ← BACK TO CLOSERS
      </Link>
      <PromPageHeader
        eyebrow="CLOSER BREAKDOWN"
        title={closer.name}
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
      />

      <PromSection>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          <KpiCard label="SHOW RATE" value={pct(0.74)} delta={4} />
          <KpiCard label="PITCH RATE" value={pct(0.62)} delta={-3} />
          <KpiCard label="CLOSE RATE" value={pct(closer.close_rate, 1)} delta={6} accent />
          <KpiCard label="APPT → SALE" value={pct(0.18)} delta={2} />
        </div>
      </PromSection>

      <PromSection eyebrow="LEVERAGE" headline={`If ${closer.name.split(' ')[0]} fixed one thing.`}>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <LeverageCard
            rank={1}
            metricLabel="OBJECTION HANDLING"
            cashDelta="+$22.4K"
            cashSub="projected · +3 wins"
            current={0.42}
            target={0.61}
            comparison="42% → 51% halfway to peer best at 61%"
            coachingQuestion="Where in the price reframe is the slip — at $X or at terms? Listen to last 5 lost calls at the 18-22 min mark."
            lift="+9.4% LIFT"
          />
          <LeverageCard
            rank={2}
            metricLabel="CASH AOV"
            cashDelta="+$11.0K"
            cashSub="projected · 0 extra wins"
            current={closer.cash_aov || 9200}
            target={11200}
            comparison={`${money(closer.cash_aov || 9200, { compact: true })} → $10.2K halfway to team best`}
            coachingQuestion="Are full-pay offers being presented first or last? Try first-offer for two weeks."
            lift="+4.1% LIFT"
          />
        </div>
      </PromSection>

      <PromSection eyebrow="OUTCOMES" headline="Wins, losses, follow-ups.">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          <KpiCard label="WON" value={String(won.length)} accent />
          <KpiCard label="LOST" value={String(lost.length)} />
          <KpiCard label="FOLLOW UP" value={String(followUps.length)} />
          <KpiCard label="NO SHOWS" value={String(noShows.length)} />
        </div>
      </PromSection>

      <PromSection eyebrow="CONSISTENCY" headline="Steady, or spiky.">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          <KpiCard label="ACTIVE DAYS" value="22 / 30" size="sm" />
          <KpiCard label="AVG CALLS / DAY" value="4.6" size="sm" />
          <KpiCard label="STD DEV" value="1.9" size="sm" />
          <KpiCard label="CV" value="0.41" size="sm" />
        </div>
      </PromSection>

      <PromSection eyebrow="AI COACHING" trailing={<PreviewBadge />}>
        <PromCard className="p-7">
          <h3
            className="prom-serif"
            style={{ fontSize: 26, lineHeight: '30px' }}
          >
            How do we help {closer.name.split(' ')[0]}?
          </h3>
          <div
            className="mt-4 text-sm"
            style={{ color: 'var(--color-prom-text-2)', lineHeight: '1.65' }}
          >
            Across the last 14 days, {closer.name.split(' ')[0]} loses {Math.round(closer.lost / Math.max(1, closer.pitched) * 100)}% of pitches in the
            18-22 minute mark — the price reframe. Two clear patterns: prospects asking about
            payment plans get full-pay re-pitched (working); prospects asking about timing
            get reassurance without anchor (failing). Suggested: prep a &ldquo;timing anchor&rdquo; sequence
            for next Mon clinic. Pair with Sebastian Brown for a tactic clinic on the timing
            handle specifically.
          </div>
        </PromCard>
      </PromSection>
    </PromPage>
  )
}
