'use client'

import { useState } from 'react'
import type { MonthTotalRow } from '@/lib/db/cost-hub'

// Client Component for the History view on /cost-hub. The page passes
// pre-loaded `recentMonths` (last 12 completed months) — clicking
// "History" toggles visibility; clicking a month row toggles per-row
// breakdown.

function formatUsd(n: number): string {
  return `$${n.toFixed(2)}`
}

export function HistoryView({ recentMonths }: { recentMonths: MonthTotalRow[] }) {
  const [open, setOpen] = useState(false)
  const [expandedMonth, setExpandedMonth] = useState<string | null>(null)

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="geg-mono"
        style={{
          padding: '8px 16px',
          background: 'transparent',
          border: '1px solid var(--color-geg-accent-border)',
          color: 'var(--color-geg-text-2)',
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.16em',
          borderRadius: 4,
          cursor: 'pointer',
        }}
      >
        {open ? 'Hide history' : 'History'}
      </button>
      {open ? (
        <div style={{ marginTop: 16 }}>
          {recentMonths.length === 0 ? (
            <p
              className="geg-mono"
              style={{
                fontSize: 12,
                color: 'var(--color-geg-text-3)',
                fontStyle: 'italic',
              }}
            >
              No historical data available.
            </p>
          ) : (
            recentMonths.map((row) => (
              <MonthRow
                key={row.month}
                row={row}
                expanded={expandedMonth === row.month}
                onToggle={() =>
                  setExpandedMonth(
                    expandedMonth === row.month ? null : row.month,
                  )
                }
              />
            ))
          )}
        </div>
      ) : null}
    </div>
  )
}

function MonthRow({
  row,
  expanded,
  onToggle,
}: {
  row: MonthTotalRow
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div>
      <button
        onClick={onToggle}
        style={{
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '12px 0',
          background: 'transparent',
          border: 'none',
          borderBottom: '1px solid var(--color-geg-border)',
          color: 'var(--color-geg-text)',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ fontSize: 14 }}>
          {expanded ? '▾' : '▸'} {row.monthLabel}
        </span>
        <span
          className="geg-mono"
          style={{ fontSize: 14, color: 'var(--color-geg-text)' }}
        >
          {formatUsd(row.total)}
        </span>
      </button>
      {expanded ? (
        <div
          style={{
            padding: '12px 16px 16px',
            background: 'rgba(160, 136, 80, 0.04)',
            borderBottom: '1px solid var(--color-geg-border)',
          }}
        >
          <BreakdownRow label="Anthropic spend" amount={row.breakdown.anthropic} />
          <div style={{ paddingLeft: 16, marginBottom: 8 }}>
            <BreakdownSub label="Ella Sonnet" amount={row.breakdown.perBucket.ella_sonnet} />
            <BreakdownSub label="Ella Haiku" amount={row.breakdown.perBucket.ella_haiku} />
            <BreakdownSub label="Call review Sonnet" amount={row.breakdown.perBucket.call_review_sonnet} />
            <BreakdownSub label="Call review Haiku" amount={row.breakdown.perBucket.call_review_haiku} />
            <BreakdownSub label="Gregory brain Sonnet" amount={row.breakdown.perBucket.gregory_brain_sonnet} />
          </div>
          <BreakdownRow label="Monthly subscriptions" amount={row.breakdown.subscriptions} />
          <BreakdownRow label="One-off extras" amount={row.breakdown.extras} />
        </div>
      ) : null}
    </div>
  )
}

function BreakdownRow({ label, amount }: { label: string; amount: number }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '4px 0',
      }}
    >
      <span style={{ fontSize: 13, color: 'var(--color-geg-text-2)' }}>{label}</span>
      <span
        className="geg-mono"
        style={{ fontSize: 13, color: 'var(--color-geg-text)' }}
      >
        {formatUsd(amount)}
      </span>
    </div>
  )
}

function BreakdownSub({ label, amount }: { label: string; amount: number }) {
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        padding: '2px 0',
      }}
    >
      <span style={{ fontSize: 12, color: 'var(--color-geg-text-3)' }}>· {label}</span>
      <span
        className="geg-mono"
        style={{ fontSize: 12, color: 'var(--color-geg-text-2)' }}
      >
        {formatUsd(amount)}
      </span>
    </div>
  )
}
