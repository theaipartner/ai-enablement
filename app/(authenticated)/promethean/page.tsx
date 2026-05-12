import {
  PromPage,
  PromPageHeader,
  PromBylineStrip,
  PromSection,
  StripPanel,
  StripCol,
  LeverageCard,
  DeltaPill,
  PromDropdownStub,
  LiveDot,
  money,
} from '@/components/promethean/primitives'
import {
  getOverviewMetrics,
  getCloserStats,
  PERIOD_LABEL,
  SYNC_LABEL,
} from '@/lib/mock-data'

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
        title={
          <>
            Every dollar,
            <br />
            <em
              className="italic"
              style={{ color: 'var(--color-prom-text-2)' }}
            >
              tracked.
            </em>
          </>
        }
        deck={
          <>
            A live cut of every lever that moves cash this month — from
            acquisition economics down to the dollar collected.
          </>
        }
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-border-strong)' }}>|</span>
            <span>SYNCED · {SYNC_LABEL}</span>
          </>
        }
        trailing={
          <div className="flex items-center gap-2">
            <PromDropdownStub label="All countries" />
            <PromDropdownStub label="Last 30 days" />
          </div>
        }
      />

      <PromBylineStrip>
        <span
          className="flex items-center gap-2"
          style={{ color: 'var(--color-prom-accent)' }}
        >
          <LiveDot />
          THIS MONTH · LIVE
        </span>
        <span style={{ color: 'var(--color-prom-border-strong)' }}>|</span>
        <span>{PERIOD_LABEL}</span>
        <span style={{ color: 'var(--color-prom-border-strong)' }}>|</span>
        <span>SYNCED · {SYNC_LABEL}</span>
      </PromBylineStrip>

      {/* ============================================================ */}
      {/* I — Where we stand                                            */}
      {/* ============================================================ */}
      <PromSection
        index="I"
        eyebrow="MONTHLY PACE"
        headline="Where we stand, where we're headed."
      >
        <StripPanel cols="1fr 1fr 1.4fr">
          <StripCol padding="32px 32px 32px 0">
            <div className="prom-eyebrow">MONTHLY PACE</div>
            <div
              className="prom-deck"
              style={{ fontSize: 19, marginTop: 14, marginBottom: 20 }}
            >
              Set a target to unlock pace tracking.
            </div>
            <div
              style={{
                background: 'var(--color-prom-bg-elev)',
                borderLeft: '2px solid var(--color-prom-border-strong)',
                padding: '10px 12px',
                fontSize: 12,
                color: 'var(--color-prom-text-2)',
                lineHeight: 1.55,
              }}
            >
              <span
                className="prom-eyebrow"
                style={{ color: 'var(--color-prom-accent)', marginRight: 8 }}
              >
                CONFIG HINT
              </span>
              Add a{' '}
              <code className="prom-numeric" style={{ color: 'var(--color-prom-text)' }}>
                Settings
              </code>{' '}
              tab with row:{' '}
              <code className="prom-numeric" style={{ color: 'var(--color-prom-text)' }}>
                monthly_cash_target
              </code>{' '}
              ·{' '}
              <code className="prom-numeric" style={{ color: 'var(--color-prom-text)' }}>
                150000
              </code>
              .
            </div>
          </StripCol>

          <StripCol padding="32px">
            <div className="prom-eyebrow">MTD CASH COLLECTED</div>
            <div
              className="prom-numeric-serif"
              style={{ fontSize: 64, lineHeight: 1, marginTop: 14 }}
            >
              {money(m.cash_collected, { compact: true })}
            </div>
            <div
              className="flex items-center justify-between"
              style={{
                marginTop: 22,
                paddingTop: 14,
                borderTop: '1px dotted var(--color-prom-border-strong)',
              }}
            >
              <span className="prom-eyebrow">VS LAST MONTH</span>
              <DeltaPill value={18} />
            </div>
          </StripCol>

          <StripCol padding="32px 0 32px 32px">
            <div className="prom-eyebrow">LIVE PIPELINE</div>
            <div
              className="prom-numeric-serif"
              style={{
                fontSize: 64,
                lineHeight: 1,
                marginTop: 14,
                color: 'var(--color-prom-accent)',
              }}
            >
              {money(m.pipeline.projected_cash, { compact: true })}
            </div>
            <div
              className="prom-deck"
              style={{ fontSize: 14.5, marginTop: 10, maxWidth: 380 }}
            >
              Expected cash from {m.pipeline.active} active follow-ups, based on
              a historical 0.8% recovery rate.
            </div>
            <div
              className="grid grid-cols-3 gap-3"
              style={{
                marginTop: 18,
                paddingTop: 14,
                borderTop: '1px dotted var(--color-prom-border-strong)',
              }}
            >
              <div>
                <div className="prom-eyebrow">ACTIVE</div>
                <div
                  className="prom-numeric-serif"
                  style={{ fontSize: 22, lineHeight: 1, marginTop: 6 }}
                >
                  {m.pipeline.active}
                </div>
              </div>
              <div>
                <div className="prom-eyebrow">OVERDUE</div>
                <div
                  className="prom-numeric-serif"
                  style={{
                    fontSize: 22,
                    lineHeight: 1,
                    marginTop: 6,
                    color: 'var(--color-prom-neg)',
                  }}
                >
                  {m.pipeline.overdue}
                </div>
              </div>
              <div>
                <div className="prom-eyebrow">AVG WHEN WON</div>
                <div
                  className="prom-numeric-serif"
                  style={{ fontSize: 22, lineHeight: 1, marginTop: 6 }}
                >
                  {money(m.pipeline.avgWhenWon, { compact: true })}
                </div>
              </div>
            </div>
          </StripCol>
        </StripPanel>
      </PromSection>

      {/* ============================================================ */}
      {/* II — Leverage                                                 */}
      {/* ============================================================ */}
      <PromSection
        index="II"
        eyebrow="LEVERAGE"
        headline="If you fixed one thing."
        deck="Each card halves the gap to the team-best on that lever and projects the cash impact. Sequencing matters — start with #1."
      >
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          <LeverageCard
            rank={1}
            metricLabel="CLOSE RATE"
            cashDelta="+$40.2K"
            cashSub="projected cash · +7 wins"
            fromValue="22.3%"
            toValue="25.6%"
            comparison={`halfway to ${topCloser?.name ?? 'Sebastian Brown'}'s 29.0%`}
            coachingQuestion={`Have ${topCloser?.name ?? 'Sebastian Brown'} run a tactic clinic — what objections do they handle that the rest don't?`}
            lift="+14.9% LIFT ON THIS LEVER"
          />
          <LeverageCard
            rank={2}
            metricLabel="BOOKED CALLS"
            cashDelta="+$27.0K"
            cashSub="projected cash · +4.8 wins"
            fromValue="5.2%"
            toValue="6.2%"
            comparison="halfway to James Whitford's 7.3% booking rate"
            coachingQuestion="Where in the dial → booked sequence does the team lose the most? Speed-to-lead under 5 min, or framing on the live convo?"
            lift="+10.2% LIFT ON THIS LEVER"
          />
          <LeverageCard
            rank={3}
            metricLabel="CASH AOV"
            cashDelta="+$18.1K"
            cashSub="projected cash · 0 extra wins"
            fromValue="$8.4K"
            toValue="$9.8K"
            comparison="halfway to Aiden Rodriguez's $11.2K cash AOV"
            coachingQuestion="Why does Aiden Rodriguez collect more per deal — payment plans, qualifying for full-pay, or pricing tier presented?"
            lift="+6.4% LIFT ON THIS LEVER"
          />
        </div>
      </PromSection>

      {/* ============================================================ */}
      {/* III — Money                                                   */}
      {/* ============================================================ */}
      <PromSection
        index="III"
        eyebrow="MONEY"
        headline="The numbers that pay the bills."
      >
        <StripPanel cols="repeat(4, 1fr)">
          <MoneyStripCol
            label="REVENUE (CONTRACT VALUE)"
            value={money(m.contract_value, { compact: true })}
            sub={`${m.wins} won deals`}
            delta={12}
          />
          <MoneyStripCol
            label="CASH COLLECTED"
            value={money(m.cash_collected, { compact: true })}
            sub="payment plans + full pays"
            delta={-43}
          />
          <MoneyStripCol
            label="CASH RECEIVED"
            value={money(m.cash_received, { compact: true })}
            sub="cleared in Stripe"
            delta={18}
          />
          <MoneyStripCol
            label="PROFIT"
            value={money(m.profit, { compact: true })}
            sub={`spend · ${money(m.ad_spend, { compact: true })}`}
            delta={9}
          />
        </StripPanel>
      </PromSection>

      {/* ============================================================ */}
      {/* IV — Acquisition economics                                    */}
      {/* ============================================================ */}
      <PromSection
        index="IV"
        eyebrow="ACQUISITION ECONOMICS"
        headline="What every dollar of ad spend buys you."
      >
        <StripPanel cols="repeat(6, 1fr)">
          <AcquisitionStripCol label="REVENUE ROAS" value="3.4×" delta={6} />
          <AcquisitionStripCol label="CASH ROAS" value="1.8×" delta={-12} />
          <AcquisitionStripCol label="TRUE ROAS" value="2.1×" delta={3} />
          <AcquisitionStripCol
            label="CAC"
            value={money(m.ad_spend / Math.max(1, m.wins))}
            delta={-9}
            deltaInvert
          />
          <AcquisitionStripCol label="CPL" value="$48" delta={4} deltaInvert />
          <AcquisitionStripCol
            label="COST PER SHOWED CALL"
            value="$214"
            delta={-2}
            deltaInvert
          />
        </StripPanel>
      </PromSection>

      {/* ============================================================ */}
      {/* V — Daily ROAS chart                                          */}
      {/* ============================================================ */}
      <PromSection
        index="V"
        eyebrow="DAILY · LAST 30 DAYS"
        headline="Where the spend lands."
      >
        <div className="prom-strip" style={{ padding: '28px 0 18px' }}>
          <div
            className="flex items-center justify-between"
            style={{ marginBottom: 18, paddingLeft: 32, paddingRight: 32 }}
          >
            <div className="prom-eyebrow">DAILY CASH ROAS</div>
            <div
              className="prom-numeric"
              style={{ fontSize: 12, color: 'var(--color-prom-text-2)' }}
            >
              30-day avg{' '}
              <span style={{ color: 'var(--color-prom-text)' }}>1.84×</span>
            </div>
          </div>
          <div style={{ paddingLeft: 32, paddingRight: 32 }}>
            <Sparkline />
            <div
              className="mt-3 flex justify-between prom-eyebrow"
              style={{ fontSize: 10.5 }}
            >
              <span>APR 12</span>
              <span>APR 27</span>
              <span>MAY 11</span>
            </div>
          </div>
        </div>
      </PromSection>

      <div style={{ height: 96 }} />
    </PromPage>
  )
}

// Money strip cell — 44px serif numeric, italic deck sub, delta pill row.
function MoneyStripCol({
  label,
  value,
  sub,
  delta,
}: {
  label: string
  value: string
  sub: string
  delta: number
}) {
  return (
    <StripCol padding="28px">
      <div
        className="flex items-start justify-between gap-2"
        style={{ marginBottom: 22 }}
      >
        <div className="prom-eyebrow">{label}</div>
        <DeltaPill value={delta} />
      </div>
      <div
        className="prom-numeric-serif"
        style={{
          fontSize: 44,
          lineHeight: 1,
          marginBottom: 14,
          color: 'var(--color-prom-text)',
        }}
      >
        {value}
      </div>
      <div
        className="prom-deck"
        style={{ fontSize: 13, color: 'var(--color-prom-text-3)' }}
      >
        {sub}
      </div>
    </StripCol>
  )
}

// Acquisition strip cell — 38px serif numeric, delta pill below.
function AcquisitionStripCol({
  label,
  value,
  delta,
  deltaInvert,
}: {
  label: string
  value: string
  delta: number
  deltaInvert?: boolean
}) {
  return (
    <StripCol padding="26px 22px">
      <div className="prom-eyebrow" style={{ minHeight: 28 }}>
        {label}
      </div>
      <div
        className="prom-numeric-serif"
        style={{ fontSize: 38, lineHeight: 1, marginTop: 16, marginBottom: 14 }}
      >
        {value}
      </div>
      <DeltaPill value={delta} invert={deltaInvert} />
    </StripCol>
  )
}

// Deterministic SVG sparkline. Visual chrome refined per the broadsheet
// spec: dashed average line + label, terminal accent dot, thinner stroke.
function Sparkline() {
  const W = 1080
  const H = 92
  const points: number[] = []
  let prev = 1.8
  for (let i = 0; i < 30; i++) {
    prev = prev + Math.sin(i / 3) * 0.18 + (i % 7 === 0 ? 0.12 : -0.04)
    prev = Math.max(0.7, Math.min(2.6, prev))
    points.push(prev)
  }
  const target = 1.5
  const avg = 1.84
  const min = 0.5
  const max = 2.7
  const xStep = W / (points.length - 1)
  const yFor = (v: number) => H - ((v - min) / (max - min)) * H
  const d = points
    .map(
      (v, i) =>
        `${i === 0 ? 'M' : 'L'}${(i * xStep).toFixed(1)},${yFor(v).toFixed(1)}`,
    )
    .join(' ')
  const areaD = `${d} L${W},${H} L0,${H} Z`
  const targetY = yFor(target)
  const avgY = yFor(avg)
  const terminalX = (points.length - 1) * xStep
  const terminalY = yFor(points[points.length - 1])

  return (
    <svg
      width="100%"
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      style={{ height: H, overflow: 'visible' }}
    >
      <defs>
        <linearGradient id="prom-spark" x1="0" y1="0" x2="0" y2="1">
          <stop
            offset="0%"
            stopColor="var(--color-prom-accent)"
            stopOpacity="0.28"
          />
          <stop
            offset="100%"
            stopColor="var(--color-prom-accent)"
            stopOpacity="0"
          />
        </linearGradient>
      </defs>
      {/* Target reference line */}
      <line
        x1={0}
        x2={W}
        y1={targetY}
        y2={targetY}
        stroke="var(--color-prom-text-3)"
        strokeDasharray="4 6"
        strokeWidth="1"
      />
      {/* Average line + tiny label */}
      <line
        x1={0}
        x2={W}
        y1={avgY}
        y2={avgY}
        stroke="var(--color-prom-text-3)"
        strokeDasharray="2 4"
        strokeWidth="1"
      />
      <text
        x={W - 4}
        y={avgY - 6}
        textAnchor="end"
        fontFamily="var(--font-prom-serif, 'Instrument Serif', Georgia, serif)"
        fontSize={10}
        fill="var(--color-prom-text-3)"
      >
        avg 1.84×
      </text>
      <path d={areaD} fill="url(#prom-spark)" />
      <path d={d} stroke="var(--color-prom-accent)" strokeWidth="1.5" fill="none" />
      <circle
        cx={terminalX}
        cy={terminalY}
        r={3.5}
        fill="var(--color-prom-accent)"
      />
    </svg>
  )
}
