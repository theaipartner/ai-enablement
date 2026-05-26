import type { ReactNode } from 'react'

// Drill-down table primitive shared by the Revenue tile sub-routes.
// One header row + N data rows + an optional footer (totals).

export type DrillColumn<T> = {
  key: string
  label: string
  align?: 'left' | 'right'
  width?: string  // CSS grid-template-columns slice
  render: (row: T, index: number) => ReactNode
}

export type DrillTableProps<T> = {
  rows: T[]
  columns: DrillColumn<T>[]
  emptyText?: string
  footer?: ReactNode
}

export function DrillTable<T>({
  rows,
  columns,
  emptyText = 'No records this period.',
  footer,
}: DrillTableProps<T>) {
  const cols = columns.map((c) => c.width ?? 'minmax(0, 1fr)').join(' ')
  return (
    <section
      style={{
        marginTop: 28,
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: cols,
          gap: 14,
          padding: '12px 22px',
          background: 'var(--color-geg-bg)',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        {columns.map((c) => (
          <span
            key={c.key}
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-faint)',
              textAlign: c.align ?? 'right',
            }}
          >
            {c.label}
          </span>
        ))}
      </div>
      {rows.length === 0 ? (
        <div
          className="geg-serif"
          style={{
            padding: '36px 22px',
            color: 'var(--color-geg-text-3)',
            fontStyle: 'italic',
            textAlign: 'center',
          }}
        >
          {emptyText}
        </div>
      ) : (
        rows.map((row, i) => (
          <div
            key={i}
            style={{
              display: 'grid',
              gridTemplateColumns: cols,
              gap: 14,
              padding: '12px 22px',
              borderBottom: '1px dashed var(--color-geg-border)',
              alignItems: 'center',
            }}
          >
            {columns.map((c) => (
              <div
                key={c.key}
                style={{
                  display: 'flex',
                  justifyContent: (c.align ?? 'right') === 'left' ? 'flex-start' : 'flex-end',
                  minWidth: 0,
                }}
              >
                {c.render(row, i)}
              </div>
            ))}
          </div>
        ))
      )}
      {footer}
    </section>
  )
}

// Convenience cell types — keep the per-page render maps short.

export function Cell({
  children,
  align,
}: {
  children: ReactNode
  align?: 'left' | 'right'
}) {
  return (
    <span
      className="geg-serif"
      style={{
        fontSize: 14,
        color: 'var(--color-geg-text)',
        letterSpacing: '-0.002em',
        textAlign: align ?? 'right',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
      }}
    >
      {children}
    </span>
  )
}

export function NumCell({
  children,
  accent,
  tone,
}: {
  children: ReactNode
  accent?: boolean
  tone?: 'pos' | 'neg'
}) {
  const color =
    tone === 'pos'
      ? 'var(--color-geg-pos)'
      : tone === 'neg'
        ? 'var(--color-geg-neg)'
        : accent
          ? 'var(--color-geg-text)'
          : 'var(--color-geg-text-2)'
  return (
    <span
      className="geg-numeric-serif"
      style={{
        fontSize: 14,
        color,
        letterSpacing: '-0.01em',
      }}
    >
      {children}
    </span>
  )
}

export function MutedCell({ children }: { children: ReactNode }) {
  return (
    <span
      className="geg-mono"
      style={{
        fontSize: 11,
        color: 'var(--color-geg-text-faint)',
        letterSpacing: '0.06em',
      }}
    >
      {children}
    </span>
  )
}
