'use client'

import { useEffect, useState } from 'react'
import {
  DEFAULT_MONTHLY_GOAL,
  DEFAULT_MONTHLY_PROJECTION,
  WINDOW_LABELS,
  compactUsd,
  prorateTarget,
  type MoneyFlow,
  type Window,
} from '@/lib/db/sales-dashboard-shared'
import { Sparkline } from './sparkline'

// Pulse · Money flow.
//
// Five-card row: Cash collected · Future cash (AR / contracted) ·
// Refunds · Expenses · Net profit. Values are "since start of period";
// the window switcher above re-anchors them (today / week / month).
//
// The cash-collected card embeds two pace bars vs Nabeel's monthly
// goal + projection, prorated to the selected window. Goal and
// projection are user-entered (GoalEditor below, localStorage).

const STORAGE_GOAL = 'sales-dashboard:monthly-goal'
const STORAGE_PROJECTION = 'sales-dashboard:monthly-projection'

export function MoneyFlow({
  flow,
  window,
}: {
  flow: MoneyFlow
  window: Window
}) {
  const [goal, setGoal] = useState<number>(DEFAULT_MONTHLY_GOAL)
  const [projection, setProjection] = useState<number>(DEFAULT_MONTHLY_PROJECTION)

  // Hydrate from localStorage after mount (avoid SSR mismatch).
  useEffect(() => {
    const g = Number(localStorage.getItem(STORAGE_GOAL))
    const p = Number(localStorage.getItem(STORAGE_PROJECTION))
    if (Number.isFinite(g) && g > 0) setGoal(g)
    if (Number.isFinite(p) && p > 0) setProjection(p)
  }, [])

  function saveGoal(v: number) {
    setGoal(v)
    localStorage.setItem(STORAGE_GOAL, String(v))
  }
  function saveProjection(v: number) {
    setProjection(v)
    localStorage.setItem(STORAGE_PROJECTION, String(v))
  }

  const cashDelta =
    flow.priorCashCollected > 0
      ? (flow.cashCollected - flow.priorCashCollected) / flow.priorCashCollected
      : 0

  return (
    <section
      aria-label="Money flow"
      style={{
        marginTop: 18,
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <Header window={window} goal={goal} projection={projection} onSaveGoal={saveGoal} onSaveProjection={saveProjection} />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.6fr 1fr 1fr 1fr 1.1fr',
          gap: 1,
          background: 'var(--color-geg-border)',
        }}
      >
        <CashCard
          flow={flow}
          window={window}
          goal={goal}
          projection={projection}
          cashDelta={cashDelta}
        />
        <FlowCell label="Future cash" sub="Contracted · will land" value={flow.futureCash} tone="muted" />
        <FlowCell label="Refunds" sub="Out the door" value={flow.refunds} tone="neg" />
        <FlowCell label="Expenses" sub="Total this period" value={flow.expenses} tone="neg" />
        <FlowCell label="Net profit" sub="Cash + future − refunds − expenses" value={flow.netProfit} tone="pos" big />
      </div>
    </section>
  )
}

function Header({
  window,
  goal,
  projection,
  onSaveGoal,
  onSaveProjection,
}: {
  window: Window
  goal: number
  projection: number
  onSaveGoal: (v: number) => void
  onSaveProjection: (v: number) => void
}) {
  return (
    <div
      style={{
        padding: '16px 22px 14px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 18,
        flexWrap: 'wrap',
      }}
    >
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
          MONEY FLOW
        </span>
        <span
          className="geg-serif"
          style={{ fontSize: 17, color: 'var(--color-geg-text)', letterSpacing: '-0.01em' }}
        >
          {WINDOW_LABELS[window]}.
        </span>
      </div>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        <GoalInput label="Monthly goal" value={goal} onSave={onSaveGoal} />
        <GoalInput label="Projection" value={projection} onSave={onSaveProjection} />
      </div>
    </div>
  )
}

function GoalInput({
  label,
  value,
  onSave,
}: {
  label: string
  value: number
  onSave: (v: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(String(value))

  useEffect(() => {
    if (!editing) setDraft(String(value))
  }, [value, editing])

  function commit() {
    const n = Number(draft.replace(/[^0-9.]/g, ''))
    if (Number.isFinite(n) && n > 0) onSave(Math.round(n))
    setEditing(false)
  }

  return (
    <label
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 10px',
        background: 'var(--color-geg-bg)',
        border: '1px solid var(--color-geg-border-strong)',
        borderRadius: 6,
      }}
    >
      <span
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-faint)',
        }}
      >
        {label}
      </span>
      {editing ? (
        <input
          type="text"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') {
              setDraft(String(value))
              setEditing(false)
            }
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
      ) : (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="geg-numeric-serif"
          style={{
            background: 'transparent',
            border: 'none',
            color: 'var(--color-geg-text)',
            fontSize: 14,
            cursor: 'text',
            padding: 0,
            letterSpacing: '-0.01em',
          }}
          title="Click to edit"
        >
          {compactUsd(value)}
        </button>
      )}
    </label>
  )
}

function CashCard({
  flow,
  window,
  goal,
  projection,
  cashDelta,
}: {
  flow: MoneyFlow
  window: Window
  goal: number
  projection: number
  cashDelta: number
}) {
  const proratedGoal = prorateTarget(goal, window)
  const proratedProj = prorateTarget(projection, window)
  const goalPct = proratedGoal > 0 ? (flow.cashCollected / proratedGoal) * 100 : 0
  const projPct = proratedProj > 0 ? (flow.cashCollected / proratedProj) * 100 : 0

  return (
    <div
      style={{
        padding: '18px 22px 18px',
        background: 'var(--color-geg-bg-elev)',
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
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
        CASH COLLECTED
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <span
          className="geg-numeric-serif"
          style={{
            fontSize: 38,
            lineHeight: '40px',
            letterSpacing: '-0.025em',
            color: 'var(--color-geg-text)',
          }}
        >
          {compactUsd(flow.cashCollected)}
        </span>
        <DeltaPill pct={cashDelta} />
      </div>
      <ProratedBar label="Goal" pct={goalPct} target={proratedGoal} accent="goal" />
      <ProratedBar label="Projection" pct={projPct} target={proratedProj} accent="proj" />
      {flow.cashSeries.length > 1 ? (
        <Sparkline data={flow.cashSeries} width={220} height={22} stroke="var(--color-geg-text-3)" />
      ) : null}
    </div>
  )
}

function ProratedBar({
  label,
  pct,
  target,
  accent,
}: {
  label: string
  pct: number
  target: number
  accent: 'goal' | 'proj'
}) {
  const fill = accent === 'goal' ? 'var(--color-geg-accent)' : 'var(--color-geg-text-2)'
  const cap = Math.min(100, pct)
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr 60px', gap: 10, alignItems: 'center' }}>
      <span
        className="geg-mono"
        style={{
          fontSize: 9.5,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-faint)',
        }}
      >
        {label}
      </span>
      <div
        style={{
          height: 6,
          borderRadius: 3,
          background: 'var(--color-geg-bg)',
          border: '1px solid var(--color-geg-border)',
          position: 'relative',
          overflow: 'hidden',
        }}
        title={`${compactUsd(target)} prorated`}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: `${cap}%`,
            background: fill,
            opacity: 0.78,
          }}
        />
      </div>
      <span
        className="geg-mono"
        style={{
          fontSize: 11,
          color: pct >= 100 ? 'var(--color-geg-pos)' : 'var(--color-geg-text-3)',
          letterSpacing: '0.04em',
          textAlign: 'right',
          fontWeight: 500,
        }}
      >
        {Math.round(pct)}%
      </span>
    </div>
  )
}

function FlowCell({
  label,
  sub,
  value,
  tone,
  big,
}: {
  label: string
  sub: string
  value: number
  tone: 'pos' | 'neg' | 'muted'
  big?: boolean
}) {
  const valColor =
    tone === 'pos'
      ? 'var(--color-geg-pos)'
      : tone === 'neg'
        ? 'var(--color-geg-text)'
        : 'var(--color-geg-text)'
  return (
    <div
      style={{
        padding: '18px 18px 16px',
        background: 'var(--color-geg-bg-elev)',
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
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
          fontSize: big ? 32 : 26,
          lineHeight: big ? '34px' : '30px',
          letterSpacing: '-0.025em',
          color: valColor,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
      >
        {tone === 'neg' && value > 0 ? '−' : ''}{compactUsd(Math.abs(value))}
      </div>
      <div
        className="geg-serif"
        style={{
          fontSize: 12,
          fontStyle: 'italic',
          color: 'var(--color-geg-text-3)',
          letterSpacing: '-0.002em',
        }}
      >
        {sub}
      </div>
    </div>
  )
}

function DeltaPill({ pct }: { pct: number }) {
  if (pct === 0) {
    return <span className="geg-mono" style={{ fontSize: 11, color: 'var(--color-geg-text-faint)' }}>·</span>
  }
  const pos = pct >= 0
  const color = pos ? 'var(--color-geg-pos)' : 'var(--color-geg-neg)'
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 11,
        color,
        letterSpacing: '0.04em',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {pos ? '▲' : '▼'} {Math.abs(pct * 100).toFixed(1)}%
    </span>
  )
}
