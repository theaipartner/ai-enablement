import { SectionBlock } from '../section-block'
import {
  getExpenseCategories,
  type ExpenseCategory,
} from '@/lib/db/sales-dashboard-mocks'
import { formatMetricValue, type Window } from '@/lib/db/sales-dashboard-shared'

// BUSINESS COSTS — decision: where to cut, what's choking margin,
// who's over-projection. Each category shows actual vs projection +
// the top items inside.

export function BusinessCostsSection({ window }: { window: Window }) {
  const cats = getExpenseCategories(window)
  const totalActual = cats.reduce((s, c) => s + c.actual, 0)
  const totalProj = cats.reduce((s, c) => s + c.projection, 0)
  const totalDelta = totalActual - totalProj
  const overUnder = totalDelta > 0 ? 'over' : 'under'

  return (
    <>
      <SectionBlock
        eyebrow="HEAD METRICS"
        title="Spend vs projection · this month."
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 1,
            background: 'var(--color-geg-border)',
            border: '1px solid var(--color-geg-border)',
            borderRadius: 8,
            overflow: 'hidden',
          }}
        >
          <HeadCell label="Total actual" value={formatMetricValue(totalActual, 'usd')} accent />
          <HeadCell label="Total projection" value={formatMetricValue(totalProj, 'usd')} />
          <HeadCell
            label={`Variance (${overUnder})`}
            value={`${totalDelta > 0 ? '+' : '−'}${formatMetricValue(Math.abs(totalDelta), 'usd')}`}
            tone={totalDelta > 0 ? 'warn' : 'pos'}
          />
        </div>
      </SectionBlock>

      <SectionBlock
        eyebrow="BY CATEGORY"
        title="Actual vs projection — color = over (warn) or under (good)."
      >
        <CategoryGrid cats={cats} />
      </SectionBlock>
    </>
  )
}

function HeadCell({
  label,
  value,
  accent,
  tone,
}: {
  label: string
  value: string
  accent?: boolean
  tone?: 'pos' | 'warn' | 'neg'
}) {
  const valColor =
    tone === 'pos' ? 'var(--color-geg-pos)'
      : tone === 'warn' ? 'var(--color-geg-warn)'
        : tone === 'neg' ? 'var(--color-geg-neg)'
          : 'var(--color-geg-text)'
  return (
    <div style={{ padding: '20px 22px 18px', background: 'var(--color-geg-bg-elev)' }}>
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
          fontSize: accent ? 36 : 30,
          lineHeight: '36px',
          letterSpacing: '-0.025em',
          color: valColor,
          marginTop: 6,
        }}
      >
        {value}
      </div>
    </div>
  )
}

function CategoryGrid({ cats }: { cats: ExpenseCategory[] }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
      {cats.map((c) => (
        <CategoryCard key={c.id} cat={c} />
      ))}
    </div>
  )
}

function CategoryCard({ cat }: { cat: ExpenseCategory }) {
  const variance = cat.actual - cat.projection
  const over = variance > 0
  const variancePct = cat.projection > 0 ? Math.abs(variance) / cat.projection : 0
  const fillPct = Math.min(100, (cat.actual / cat.projection) * 100)
  const fillColor = over ? 'var(--color-geg-warn)' : 'var(--color-geg-pos)'

  return (
    <div
      style={{
        padding: '18px 20px 16px',
        background: 'var(--color-geg-bg)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 8,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <span
          className="geg-serif"
          style={{ fontSize: 16, color: 'var(--color-geg-text)', letterSpacing: '-0.005em' }}
        >
          {cat.label}
        </span>
        <span
          className="geg-mono"
          style={{
            fontSize: 11,
            color: fillColor,
            letterSpacing: '0.04em',
            fontWeight: 500,
          }}
        >
          {over ? '▲' : '▼'} {Math.round(variancePct * 100)}%
        </span>
      </div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 6 }}>
        <span
          className="geg-numeric-serif"
          style={{ fontSize: 24, color: 'var(--color-geg-text)', letterSpacing: '-0.02em' }}
        >
          {formatMetricValue(cat.actual, 'usd')}
        </span>
        <span
          className="geg-mono"
          style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.06em' }}
        >
          / {formatMetricValue(cat.projection, 'usd')} PROJ
        </span>
      </div>
      <div
        style={{
          marginTop: 12,
          height: 6,
          borderRadius: 3,
          background: 'var(--color-geg-bg-elev)',
          border: '1px solid var(--color-geg-border)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            bottom: 0,
            width: `${fillPct}%`,
            background: fillColor,
            opacity: 0.7,
          }}
        />
      </div>
      <div
        style={{
          marginTop: 14,
          paddingTop: 12,
          borderTop: '1px dashed var(--color-geg-border)',
        }}
      >
        <div
          className="geg-mono"
          style={{
            fontSize: 9.5,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-faint)',
            marginBottom: 6,
          }}
        >
          TOP ITEMS
        </div>
        {cat.topItems.map((item, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '4px 0',
              fontSize: 13,
            }}
          >
            <span
              className="geg-serif"
              style={{ color: 'var(--color-geg-text-2)', letterSpacing: '-0.002em' }}
            >
              {item.label}
            </span>
            <span
              className="geg-numeric-serif"
              style={{ color: 'var(--color-geg-text-3)' }}
            >
              {formatMetricValue(item.amount, 'usd')}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
