import type { TodayCard } from '@/lib/db/sales-dashboard-mocks'
import { formatMetricValue, isHigherBetter } from '@/lib/db/sales-dashboard-shared'

// Pulse · today snapshot — 4 numbers for the current day vs the same
// day last week. Reads as "what's happening right now."

export function TodaySnapshot({ cards }: { cards: TodayCard[] }) {
  return (
    <section
      aria-label="Today"
      style={{
        marginTop: 18,
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 1,
        background: 'var(--color-geg-border)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      {cards.map((c) => (
        <TodayCardView key={c.id} card={c} />
      ))}
    </section>
  )
}

function TodayCardView({ card }: { card: TodayCard }) {
  const today = formatMetricValue(card.today, card.format)
  const last = formatMetricValue(card.lastWeekSameDay, card.format)
  const delta = card.lastWeekSameDay === 0 ? 0 : (card.today - card.lastWeekSameDay) / card.lastWeekSameDay
  const higherBetter = isHigherBetter(card.label)
  const isPositive = delta >= 0
  const isGood = isPositive === higherBetter
  const deltaColor = delta === 0
    ? 'var(--color-geg-text-faint)'
    : isGood
      ? 'var(--color-geg-pos)'
      : 'var(--color-geg-neg)'
  const arrow = delta === 0 ? '·' : isPositive ? '▲' : '▼'
  return (
    <div
      style={{
        padding: '18px 20px',
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
        {card.label}
      </div>
      <div
        className="geg-numeric-serif"
        style={{
          fontSize: 32,
          lineHeight: '36px',
          letterSpacing: '-0.025em',
          color: 'var(--color-geg-text)',
        }}
      >
        {today}
      </div>
      <div
        style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 2 }}
      >
        <span
          className="geg-mono"
          style={{
            fontSize: 11,
            color: deltaColor,
            letterSpacing: '0.04em',
            fontWeight: 500,
          }}
        >
          {arrow} {Math.abs(delta * 100).toFixed(0)}%
        </span>
        <span
          className="geg-serif"
          style={{ fontSize: 12, color: 'var(--color-geg-text-3)', fontStyle: 'italic' }}
        >
          vs {last} same day last week
        </span>
      </div>
    </div>
  )
}
