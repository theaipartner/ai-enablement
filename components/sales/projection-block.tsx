'use client'

import { useEffect, useMemo, useState } from 'react'
import {
  compactUsd,
  type MoneyFlow,
} from '@/lib/db/sales-dashboard-shared'

// Revenue · Projection block.
//
// Monthly assumptions Nabeel sets at the start of the month: how many
// units of each offer he expects to close, the cash-up-front % per
// offer, an ad-spend target, an expense target. We compute projected
// New Cash + Projected Profit from those and render an actual-vs-pace
// chart that uses MTD daily cash from real (or mock) data.
//
// Persistence: localStorage for now. When this lands real, the
// assumptions move to a Supabase row keyed by tenant + month.

const STORAGE_KEY = 'revenue-projection:v1'
const TODAY_DAY = 18
const DAYS_IN_MONTH = 31

export type Offer = {
  id: string
  label: string
  price: number
  defaultUpfrontPct: number
}

export type ProjectionAssumptions = {
  offers: Record<string, { units: number; upfrontPct: number }>
  adSpendTarget: number
  expenseTarget: number
}

function defaultAssumptions(offers: Offer[]): ProjectionAssumptions {
  return {
    offers: Object.fromEntries(
      offers.map((o) => [
        o.id,
        { units: 8, upfrontPct: o.defaultUpfrontPct },
      ]),
    ),
    adSpendTarget: 65_000,
    expenseTarget: 95_000,
  }
}

export function ProjectionBlock({
  offers,
  mtd,
  actualCashSoFar,
  actualProfitSoFar,
}: {
  offers: Offer[]
  mtd: { dayOfMonth: number; daysInMonth: number; points: { day: number; actual: number }[] }
  actualCashSoFar: number
  actualProfitSoFar: number
}) {
  const [assumptions, setAssumptions] = useState<ProjectionAssumptions>(() => defaultAssumptions(offers))
  const [loaded, setLoaded] = useState(false)

  // Hydrate from localStorage after mount to avoid SSR mismatch.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as ProjectionAssumptions
        // Merge with defaults in case offers list grew.
        const base = defaultAssumptions(offers)
        setAssumptions({
          ...base,
          ...parsed,
          offers: { ...base.offers, ...(parsed.offers ?? {}) },
        })
      }
    } catch {
      // ignore parse errors — fall back to defaults
    }
    setLoaded(true)
  }, [offers])

  function persist(next: ProjectionAssumptions) {
    setAssumptions(next)
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
    } catch {
      // ignore quota / privacy mode
    }
  }

  const computed = useMemo(() => {
    let projectedFullContract = 0
    let projectedNewCash = 0
    for (const offer of offers) {
      const a = assumptions.offers[offer.id]
      if (!a) continue
      projectedFullContract += offer.price * a.units
      projectedNewCash += offer.price * a.units * a.upfrontPct
    }
    const projectedProfit = projectedNewCash - assumptions.adSpendTarget - assumptions.expenseTarget
    return { projectedFullContract, projectedNewCash, projectedProfit }
  }, [assumptions, offers])

  return (
    <section
      aria-label="Monthly projection"
      style={{
        marginTop: 28,
        padding: '24px 26px 24px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
      }}
    >
      <Header />
      <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1.4fr', gap: 28, marginTop: 18 }}>
        <AssumptionsForm
          offers={offers}
          assumptions={assumptions}
          onChange={persist}
          loaded={loaded}
        />
        <RightColumn
          computed={computed}
          mtd={mtd}
          actualCashSoFar={actualCashSoFar}
          actualProfitSoFar={actualProfitSoFar}
        />
      </div>
    </section>
  )
}

function Header() {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 14 }}>
      <span
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
        }}
      >
        PROJECTION
      </span>
      <span
        className="geg-serif"
        style={{ fontSize: 17, color: 'var(--color-geg-text)', letterSpacing: '-0.01em' }}
      >
        Where this month should land — set assumptions, see the pace.
      </span>
    </div>
  )
}

// --- Form ---------------------------------------------------------------

function AssumptionsForm({
  offers,
  assumptions,
  onChange,
  loaded,
}: {
  offers: Offer[]
  assumptions: ProjectionAssumptions
  onChange: (next: ProjectionAssumptions) => void
  loaded: boolean
}) {
  function patchOffer(id: string, patch: Partial<{ units: number; upfrontPct: number }>) {
    const next = {
      ...assumptions,
      offers: { ...assumptions.offers, [id]: { ...assumptions.offers[id], ...patch } },
    }
    onChange(next)
  }
  function patchAdSpend(v: number) {
    onChange({ ...assumptions, adSpendTarget: v })
  }
  function patchExpense(v: number) {
    onChange({ ...assumptions, expenseTarget: v })
  }
  return (
    <div>
      <SubHead label="OFFERS" />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.6fr 60px 60px 100px',
          gap: 8,
          padding: '6px 0 8px',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        <ColH label="Offer" align="left" />
        <ColH label="Units" />
        <ColH label="Upfront" />
        <ColH label="Cash" />
      </div>
      {offers.map((offer) => {
        const a = assumptions.offers[offer.id] ?? { units: 0, upfrontPct: offer.defaultUpfrontPct }
        const expectedCash = offer.price * a.units * a.upfrontPct
        return (
          <div
            key={offer.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1.6fr 60px 60px 100px',
              gap: 8,
              padding: '10px 0',
              borderBottom: '1px dashed var(--color-geg-border)',
              alignItems: 'center',
            }}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              <span
                className="geg-serif"
                style={{
                  fontSize: 13.5,
                  color: 'var(--color-geg-text)',
                  letterSpacing: '-0.002em',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
              >
                {offer.label}
              </span>
              <span
                className="geg-mono"
                style={{
                  fontSize: 10,
                  color: 'var(--color-geg-text-faint)',
                  letterSpacing: '0.06em',
                }}
              >
                {compactUsd(offer.price)} STICKER
              </span>
            </div>
            <NumberInput
              value={a.units}
              onChange={(n) => patchOffer(offer.id, { units: n })}
              suffix=""
              loaded={loaded}
            />
            <NumberInput
              value={Math.round(a.upfrontPct * 100)}
              onChange={(n) => patchOffer(offer.id, { upfrontPct: Math.max(0, Math.min(100, n)) / 100 })}
              suffix="%"
              loaded={loaded}
            />
            <span
              className="geg-numeric-serif"
              style={{
                fontSize: 14,
                color: 'var(--color-geg-text-2)',
                letterSpacing: '-0.01em',
                textAlign: 'right',
              }}
            >
              {compactUsd(expectedCash)}
            </span>
          </div>
        )
      })}

      <div style={{ marginTop: 18 }}>
        <SubHead label="TARGETS" />
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.6fr 1fr',
            gap: 14,
            padding: '10px 0',
            borderBottom: '1px dashed var(--color-geg-border)',
            alignItems: 'center',
          }}
        >
          <span
            className="geg-serif"
            style={{ fontSize: 13.5, color: 'var(--color-geg-text)', letterSpacing: '-0.002em' }}
          >
            Ad spend target
          </span>
          <DollarInput value={assumptions.adSpendTarget} onChange={patchAdSpend} loaded={loaded} />
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1.6fr 1fr',
            gap: 14,
            padding: '10px 0',
            alignItems: 'center',
          }}
        >
          <span
            className="geg-serif"
            style={{ fontSize: 13.5, color: 'var(--color-geg-text)', letterSpacing: '-0.002em' }}
          >
            Other expense target
          </span>
          <DollarInput value={assumptions.expenseTarget} onChange={patchExpense} loaded={loaded} />
        </div>
      </div>
    </div>
  )
}

function NumberInput({
  value,
  onChange,
  suffix,
  loaded,
}: {
  value: number
  onChange: (n: number) => void
  suffix: string
  loaded: boolean
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 2,
        padding: '4px 8px',
        background: 'var(--color-geg-bg)',
        border: '1px solid var(--color-geg-border-strong)',
        borderRadius: 4,
      }}
    >
      <input
        type="text"
        value={loaded ? draft : ''}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft.replace(/[^0-9.]/g, ''))
          if (Number.isFinite(n)) onChange(n)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        }}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--color-geg-text)',
          fontFamily: 'var(--font-geg-mono), monospace',
          fontSize: 13,
          width: suffix ? 28 : 36,
          outline: 'none',
          textAlign: 'right',
        }}
      />
      {suffix ? (
        <span
          className="geg-mono"
          style={{ fontSize: 11, color: 'var(--color-geg-text-faint)' }}
        >
          {suffix}
        </span>
      ) : null}
    </span>
  )
}

function DollarInput({
  value,
  onChange,
  loaded,
}: {
  value: number
  onChange: (n: number) => void
  loaded: boolean
}) {
  const [draft, setDraft] = useState(String(value))
  useEffect(() => { setDraft(String(value)) }, [value])
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '5px 10px',
        background: 'var(--color-geg-bg)',
        border: '1px solid var(--color-geg-border-strong)',
        borderRadius: 4,
        justifySelf: 'end',
      }}
    >
      <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)' }}>
        $
      </span>
      <input
        type="text"
        value={loaded ? draft : ''}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          const n = Number(draft.replace(/[^0-9.]/g, ''))
          if (Number.isFinite(n)) onChange(n)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur()
        }}
        style={{
          background: 'transparent',
          border: 'none',
          color: 'var(--color-geg-text)',
          fontFamily: 'var(--font-geg-mono), monospace',
          fontSize: 13,
          width: 80,
          outline: 'none',
          textAlign: 'right',
        }}
      />
    </span>
  )
}

// --- Right column: computed projection + chart -------------------------

function RightColumn({
  computed,
  mtd,
  actualCashSoFar,
  actualProfitSoFar,
}: {
  computed: { projectedFullContract: number; projectedNewCash: number; projectedProfit: number }
  mtd: { dayOfMonth: number; daysInMonth: number; points: { day: number; actual: number }[] }
  actualCashSoFar: number
  actualProfitSoFar: number
}) {
  void actualProfitSoFar
  const projectedDailyCashPace = computed.projectedNewCash / mtd.daysInMonth
  const expectedSoFar = projectedDailyCashPace * mtd.dayOfMonth
  const paceGap = actualCashSoFar - expectedSoFar
  const onPace = paceGap >= 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 1,
          background: 'var(--color-geg-border)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <ComputedCell label="Projected new cash" value={computed.projectedNewCash} accent />
        <ComputedCell label="Projected profit" value={computed.projectedProfit} accent />
        <ComputedCell label="Projected contracted" value={computed.projectedFullContract} muted />
      </div>

      <PaceLine
        actualCashSoFar={actualCashSoFar}
        expectedSoFar={expectedSoFar}
        paceGap={paceGap}
        onPace={onPace}
      />

      <Chart
        mtd={mtd}
        projectedDailyCashPace={projectedDailyCashPace}
        projectedNewCash={computed.projectedNewCash}
      />
    </div>
  )
}

function ComputedCell({
  label,
  value,
  accent,
  muted,
}: {
  label: string
  value: number
  accent?: boolean
  muted?: boolean
}) {
  return (
    <div
      style={{
        padding: '16px 18px 14px',
        background: 'var(--color-geg-bg-elev)',
      }}
    >
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
        }}
      >
        {label}
      </div>
      <div
        className="geg-numeric-serif"
        style={{
          fontSize: 26,
          lineHeight: '30px',
          letterSpacing: '-0.025em',
          color: muted ? 'var(--color-geg-text-2)' : 'var(--color-geg-text)',
          marginTop: 6,
        }}
      >
        {accent && value < 0 ? '−' : ''}{compactUsd(Math.abs(value))}
      </div>
    </div>
  )
}

function PaceLine({
  actualCashSoFar,
  expectedSoFar,
  paceGap,
  onPace,
}: {
  actualCashSoFar: number
  expectedSoFar: number
  paceGap: number
  onPace: boolean
}) {
  const color = onPace ? 'var(--color-geg-pos)' : 'var(--color-geg-warn)'
  return (
    <div
      style={{
        padding: '12px 16px',
        background: 'var(--color-geg-bg)',
        border: `1px solid ${onPace ? 'var(--color-geg-border)' : 'var(--color-geg-warn)'}`,
        borderRadius: 8,
        display: 'grid',
        gridTemplateColumns: '1fr 1fr 1fr',
        gap: 14,
      }}
    >
      <Stat label="Cash so far" value={compactUsd(actualCashSoFar)} />
      <Stat label="Expected by today" value={compactUsd(expectedSoFar)} />
      <Stat
        label={onPace ? 'Ahead of pace' : 'Behind pace'}
        value={`${onPace ? '+' : '−'}${compactUsd(Math.abs(paceGap))}`}
        tone={color}
      />
    </div>
  )
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div
        className="geg-mono"
        style={{
          fontSize: 9.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-faint)',
        }}
      >
        {label}
      </div>
      <div
        className="geg-numeric-serif"
        style={{
          fontSize: 18,
          lineHeight: '22px',
          letterSpacing: '-0.015em',
          color: tone ?? 'var(--color-geg-text)',
          marginTop: 4,
        }}
      >
        {value}
      </div>
    </div>
  )
}

// --- Chart -------------------------------------------------------------

const CHART_W = 540
const CHART_H = 220
const PAD_L = 56
const PAD_R = 12
const PAD_T = 14
const PAD_B = 28

function Chart({
  mtd,
  projectedDailyCashPace,
  projectedNewCash,
}: {
  mtd: { dayOfMonth: number; daysInMonth: number; points: { day: number; actual: number }[] }
  projectedDailyCashPace: number
  projectedNewCash: number
}) {
  // Build cumulative actual + projected lines.
  const days = mtd.daysInMonth
  let runningActual = 0
  const actualCum: { day: number; v: number | null }[] = []
  for (let d = 1; d <= days; d++) {
    if (d <= mtd.dayOfMonth) {
      const p = mtd.points[d - 1]
      runningActual += p ? p.actual : 0
      actualCum.push({ day: d, v: runningActual })
    } else {
      actualCum.push({ day: d, v: null })
    }
  }
  const projectedCum: { day: number; v: number }[] = []
  for (let d = 1; d <= days; d++) {
    projectedCum.push({ day: d, v: projectedDailyCashPace * d })
  }
  const yMax = Math.max(projectedNewCash, runningActual) * 1.1 || 1
  const innerW = CHART_W - PAD_L - PAD_R
  const innerH = CHART_H - PAD_T - PAD_B
  const xFor = (d: number) => PAD_L + ((d - 1) / (days - 1)) * innerW
  const yFor = (v: number) => PAD_T + (1 - v / yMax) * innerH

  const projPath = projectedCum.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(p.day)} ${yFor(p.v)}`).join(' ')
  const actualPts = actualCum.filter((p) => p.v !== null)
  const actualPath = actualPts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xFor(p.day)} ${yFor(p.v as number)}`).join(' ')

  const yTicks = 4
  const yTickValues = Array.from({ length: yTicks + 1 }, (_, i) => (yMax / yTicks) * i)

  return (
    <svg width="100%" viewBox={`0 0 ${CHART_W} ${CHART_H}`} role="img" aria-label="Actual vs projected pace">
      {yTickValues.map((v, i) => (
        <g key={i}>
          <line
            x1={PAD_L}
            x2={CHART_W - PAD_R}
            y1={yFor(v)}
            y2={yFor(v)}
            stroke="var(--color-geg-border)"
            strokeDasharray={i === 0 ? '' : '2 4'}
          />
          <text
            x={PAD_L - 8}
            y={yFor(v) + 4}
            textAnchor="end"
            fontSize="10"
            fontFamily="var(--font-geg-mono), monospace"
            fill="var(--color-geg-text-faint)"
          >
            {compactUsd(v)}
          </text>
        </g>
      ))}
      {[1, 5, 10, 15, 20, 25, days].map((d) => (
        <text
          key={d}
          x={xFor(d)}
          y={CHART_H - PAD_B + 16}
          textAnchor="middle"
          fontSize="10"
          fontFamily="var(--font-geg-mono), monospace"
          fill="var(--color-geg-text-faint)"
        >
          {d}
        </text>
      ))}

      {/* Projected pace */}
      <path d={projPath} stroke="var(--color-geg-text-3)" strokeWidth={1.5} fill="none" strokeDasharray="3 4" />
      {/* Actual cumulative */}
      <path
        d={actualPath}
        stroke={runningActual >= projectedDailyCashPace * mtd.dayOfMonth ? 'var(--color-geg-pos)' : 'var(--color-geg-warn)'}
        strokeWidth={2}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* Today dot */}
      <circle
        cx={xFor(mtd.dayOfMonth)}
        cy={yFor(runningActual)}
        r={4}
        fill={runningActual >= projectedDailyCashPace * mtd.dayOfMonth ? 'var(--color-geg-pos)' : 'var(--color-geg-warn)'}
      />
    </svg>
  )
}

// --- Small components --------------------------------------------------

function SubHead({ label }: { label: string }) {
  return (
    <div
      className="geg-mono"
      style={{
        fontSize: 10,
        letterSpacing: '0.18em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-faint)',
        marginBottom: 4,
      }}
    >
      {label}
    </div>
  )
}

function ColH({ label, align }: { label: string; align?: 'left' | 'right' }) {
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 9.5,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-faint)',
        textAlign: align ?? 'right',
      }}
    >
      {label}
    </span>
  )
}

// Silence unused-warning for Moneyflow type (kept importable from this
// component if a future caller needs it).
void (null as unknown as MoneyFlow)
