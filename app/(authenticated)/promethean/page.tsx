import {
  PromPage,
  PromPageHeader,
  PromCard,
  PromSection,
  KpiCard,
  LeverageCard,
  DeltaPill,
  PromDropdownStub,
  money,
} from '@/components/promethean/primitives'
import { getOverviewMetrics, PERIOD_LABEL, SYNC_LABEL, getCloserStats } from '@/lib/mock-data'

export const metadata = {
  title: 'Promethean — Helios',
}

export default function PrometheanOverviewPage() {
  const m = getOverviewMetrics()
  const closerStats = getCloserStats()
  const topCloser = closerStats[0]

  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · SCALE-2 · CEO VIEW"
        title="Every dollar, tracked."
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
        trailing={
          <div className="flex items-center gap-2">
            <PromDropdownStub label="All countries" />
            <PromDropdownStub label="Last 30 days" />
          </div>
        }
      />

      {/* ============================================================ */}
      {/* Top section: Monthly Pace + Live Pipeline                    */}
      {/* ============================================================ */}
      <section className="mt-12">
        <div className="prom-eyebrow">THIS MONTH · LIVE</div>
        <h2
          className="prom-serif mt-2"
          style={{ fontSize: 38, lineHeight: '42px' }}
        >
          Where we stand, where we&apos;re headed.
        </h2>

        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 mt-6">
          {/* Monthly Pace — left, 3 cols */}
          <PromCard className="lg:col-span-3 p-7">
            <div className="prom-eyebrow">MONTHLY PACE</div>
            <div
              className="prom-serif mt-4"
              style={{ fontSize: 28, lineHeight: '32px', color: 'var(--color-prom-text-2)' }}
            >
              Set a target to unlock pace tracking.
            </div>
            <div
              className="mt-5 rounded-lg p-4 text-xs"
              style={{
                background: 'rgba(255,255,255,0.02)',
                border: '1px dashed var(--color-prom-border-strong)',
                color: 'var(--color-prom-text-2)',
                lineHeight: '1.6',
              }}
            >
              <span className="prom-eyebrow mr-2" style={{ color: 'var(--color-prom-accent)' }}>
                CONFIG HINT
              </span>
              Add a <code className="prom-numeric" style={{ color: 'var(--color-prom-text)' }}>Settings</code> tab to
              this client&apos;s sheet with a row:{' '}
              <code className="prom-numeric" style={{ color: 'var(--color-prom-text)' }}>
                monthly_cash_target
              </code>{' '}
              ·{' '}
              <code className="prom-numeric" style={{ color: 'var(--color-prom-text)' }}>
                150000
              </code>
              .
            </div>
            <div className="mt-6 flex items-end justify-between">
              <div>
                <div className="prom-eyebrow">MTD CASH COLLECTED</div>
                <div
                  className="prom-numeric font-semibold mt-2"
                  style={{ fontSize: 42, lineHeight: '44px' }}
                >
                  {money(m.cash_collected, { compact: true })}
                </div>
              </div>
              <div className="text-right">
                <div className="prom-eyebrow">VS LAST MONTH</div>
                <div className="mt-2"><DeltaPill value={18} /></div>
              </div>
            </div>
          </PromCard>

          {/* Live Pipeline — right, 2 cols */}
          <PromCard className="lg:col-span-2 p-7 flex flex-col">
            <div className="prom-eyebrow">LIVE PIPELINE</div>
            <div
              className="prom-numeric font-semibold mt-4"
              style={{
                fontSize: 56,
                lineHeight: '56px',
                color: 'var(--color-prom-accent)',
              }}
            >
              {money(m.pipeline.projected_cash, { compact: true })}
            </div>
            <div
              className="mt-3 text-sm"
              style={{ color: 'var(--color-prom-text-2)', lineHeight: '1.55' }}
            >
              Expected cash from {m.pipeline.active} active follow-ups, based on a historical 0.8% recovery rate.
            </div>
            <div
              className="mt-auto pt-5 grid grid-cols-3 gap-2"
              style={{ borderTop: '1px solid var(--color-prom-border)' }}
            >
              <div className="pt-4">
                <div className="prom-eyebrow">ACTIVE</div>
                <div className="prom-numeric mt-1 font-medium" style={{ fontSize: 20 }}>
                  {m.pipeline.active}
                </div>
              </div>
              <div className="pt-4">
                <div className="prom-eyebrow">OVERDUE</div>
                <div
                  className="prom-numeric mt-1 font-medium"
                  style={{ fontSize: 20, color: 'var(--color-prom-neg)' }}
                >
                  {m.pipeline.overdue}
                </div>
              </div>
              <div className="pt-4">
                <div className="prom-eyebrow">AVG WHEN WON</div>
                <div className="prom-numeric mt-1 font-medium" style={{ fontSize: 20 }}>
                  {money(m.pipeline.avgWhenWon, { compact: true })}
                </div>
              </div>
            </div>
          </PromCard>
        </div>
      </section>

      {/* ============================================================ */}
      {/* Leverage — three cards, the brand-defining surface           */}
      {/* ============================================================ */}
      <section className="mt-14">
        <div className="prom-eyebrow">LEVERAGE</div>
        <h2
          className="prom-serif mt-2"
          style={{ fontSize: 38, lineHeight: '42px' }}
        >
          If you fixed one thing.
        </h2>
        <div
          className="mt-3 text-sm max-w-[60ch]"
          style={{ color: 'var(--color-prom-text-2)', lineHeight: '1.55' }}
        >
          Each card halves the gap to the team-best on that lever and projects the cash impact.
          Sequencing matters — start with #1.
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5 mt-7">
          <LeverageCard
            rank={1}
            metricLabel="CLOSE RATE"
            cashDelta="+$40.2K"
            cashSub="projected cash · +7 wins"
            current={0.223}
            target={0.290}
            comparison="22.3% → 25.6% halfway to Sebastian Brown's 29.0%"
            coachingQuestion={`Have ${topCloser?.name ?? 'Sebastian Brown'} run a tactic clinic — what objections do they handle that the rest don't?`}
            lift="+14.9% LIFT ON THIS LEVER"
          />
          <LeverageCard
            rank={2}
            metricLabel="BOOKED CALLS"
            cashDelta="+$27.0K"
            cashSub="projected cash · +4.8 wins"
            current={0.052}
            target={0.073}
            comparison="5.2% → 6.2% halfway to James Whitford's 7.3% booking rate"
            coachingQuestion="Where in the dial → booked sequence does the team lose the most? Speed-to-lead under 5 min, or framing on the live convo?"
            lift="+10.2% LIFT ON THIS LEVER"
          />
          <LeverageCard
            rank={3}
            metricLabel="CASH AOV"
            cashDelta="+$18.1K"
            cashSub="projected cash · 0 extra wins"
            current={8400}
            target={11200}
            comparison="$8.4K → $9.8K halfway to Aiden Rodriguez's $11.2K cash AOV"
            coachingQuestion="Why does Aiden Rodriguez collect more per deal — payment plans, qualifying for full-pay, or pricing tier presented?"
            lift="+6.4% LIFT ON THIS LEVER"
          />
        </div>
      </section>

      {/* ============================================================ */}
      {/* Money KPI strip                                              */}
      {/* ============================================================ */}
      <section className="mt-14">
        <div className="prom-eyebrow">MONEY</div>
        <h2
          className="prom-serif mt-2"
          style={{ fontSize: 38, lineHeight: '42px' }}
        >
          The numbers that pay the bills.
        </h2>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5 mt-6">
          <KpiCard
            label="REVENUE (CONTRACT VALUE)"
            value={money(m.contract_value, { compact: true })}
            subValue={`${m.wins} won deals`}
            delta={12}
            size="md"
          />
          <KpiCard
            label="CASH COLLECTED"
            value={money(m.cash_collected, { compact: true })}
            subValue="payment plans + full pays"
            delta={-43}
            size="md"
          />
          <KpiCard
            label="CASH RECEIVED"
            value={money(m.cash_received, { compact: true })}
            subValue="cleared in Stripe"
            delta={18}
            size="md"
          />
          <KpiCard
            label="PROFIT"
            value={money(m.profit, { compact: true })}
            subValue={`spend · ${money(m.ad_spend, { compact: true })}`}
            delta={9}
            size="md"
            accent
          />
        </div>
      </section>

      {/* ============================================================ */}
      {/* Secondary KPI strip — acquisition economics                  */}
      {/* ============================================================ */}
      <PromSection eyebrow="ACQUISITION ECONOMICS" headline="What every dollar of ad spend buys you.">
        <div className="grid grid-cols-2 lg:grid-cols-6 gap-4">
          <KpiCard label="REVENUE ROAS" value="3.4×" delta={6} size="sm" />
          <KpiCard label="CASH ROAS" value="1.8×" delta={-12} size="sm" />
          <KpiCard label="TRUE ROAS" value="2.1×" delta={3} size="sm" />
          <KpiCard label="CAC" value={money(m.ad_spend / Math.max(1, m.wins))} delta={-9} size="sm" deltaInvert />
          <KpiCard label="CPL" value="$48" delta={4} size="sm" deltaInvert />
          <KpiCard label="COST PER SHOWED CALL" value="$214" delta={-2} size="sm" deltaInvert />
        </div>
      </PromSection>

      {/* ============================================================ */}
      {/* Daily ROAS sparkline strip                                   */}
      {/* ============================================================ */}
      <PromSection eyebrow="DAILY · LAST 30 DAYS" headline="Where the spend lands.">
        <PromCard className="p-6">
          <div className="flex items-end justify-between mb-4">
            <div className="prom-eyebrow">DAILY CASH ROAS</div>
            <div className="prom-numeric text-sm" style={{ color: 'var(--color-prom-text-2)' }}>
              30-day avg <span style={{ color: 'var(--color-prom-text)' }}>1.84×</span>
            </div>
          </div>
          <Sparkline />
          <div className="mt-3 flex justify-between prom-eyebrow">
            <span>APR 12</span>
            <span>APR 27</span>
            <span>MAY 11</span>
          </div>
        </PromCard>
      </PromSection>

      <div className="h-16" />
    </PromPage>
  )
}

// Deterministic SVG sparkline — same seed so the demo is stable.
function Sparkline() {
  const W = 1080
  const H = 92
  const points: number[] = []
  let prev = 1.8
  for (let i = 0; i < 30; i++) {
    prev = prev + (Math.sin(i / 3) * 0.18) + (i % 7 === 0 ? 0.12 : -0.04)
    prev = Math.max(0.7, Math.min(2.6, prev))
    points.push(prev)
  }
  const target = 1.5
  const min = 0.5
  const max = 2.7
  const xStep = W / (points.length - 1)
  const yFor = (v: number) => H - ((v - min) / (max - min)) * H
  const d = points.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * xStep).toFixed(1)},${yFor(v).toFixed(1)}`).join(' ')
  const areaD = `${d} L${W},${H} L0,${H} Z`
  const targetY = yFor(target)

  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }}>
      <defs>
        <linearGradient id="prom-spark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--color-prom-accent)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--color-prom-accent)" stopOpacity="0" />
        </linearGradient>
      </defs>
      <line
        x1={0} x2={W} y1={targetY} y2={targetY}
        stroke="var(--color-prom-text-3)"
        strokeDasharray="4 6"
        strokeWidth="1"
      />
      <path d={areaD} fill="url(#prom-spark)" />
      <path d={d} stroke="var(--color-prom-accent)" strokeWidth="1.6" fill="none" />
    </svg>
  )
}
