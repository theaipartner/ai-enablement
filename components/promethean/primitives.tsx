// Promethean V0 shared design primitives. Every surface composes from
// these — keeps visual treatment consistent and gives integrations a
// stable refactor target.

import React from 'react'

// ---------------------------------------------------------------------------
// Layout — page shell with consistent gutter
// ---------------------------------------------------------------------------
export function PromPage({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`px-10 py-8 max-w-[1280px] ${className}`}>{children}</div>
}

export function PromSection({
  eyebrow,
  headline,
  trailing,
  children,
}: {
  eyebrow?: string
  headline?: string
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section className="mt-10">
      {(eyebrow || headline) && (
        <div className="flex items-end justify-between mb-5">
          <div>
            {eyebrow ? <div className="prom-eyebrow">{eyebrow}</div> : null}
            {headline ? (
              <h2 className="prom-serif mt-1" style={{ fontSize: 34, lineHeight: '38px' }}>
                {headline}
              </h2>
            ) : null}
          </div>
          {trailing ? <div>{trailing}</div> : null}
        </div>
      )}
      {children}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Page header — eyebrow + serif name + meta strip
// ---------------------------------------------------------------------------
export function PromPageHeader({
  eyebrow,
  title,
  meta,
  trailing,
}: {
  eyebrow?: string
  title: string
  meta?: React.ReactNode
  trailing?: React.ReactNode
}) {
  return (
    <header className="flex items-start justify-between gap-6">
      <div>
        {eyebrow ? <div className="prom-eyebrow">{eyebrow}</div> : null}
        <h1
          className="prom-serif mt-2"
          style={{ fontSize: 54, lineHeight: '58px', maxWidth: '14ch' }}
        >
          {title}
        </h1>
        {meta ? (
          <div className="prom-eyebrow mt-4 flex flex-wrap items-center gap-x-3 gap-y-1">
            {meta}
          </div>
        ) : null}
      </div>
      {trailing ? <div className="shrink-0">{trailing}</div> : null}
    </header>
  )
}

// ---------------------------------------------------------------------------
// Card primitive
// ---------------------------------------------------------------------------
export function PromCard({
  children,
  className = '',
  elev = 1,
  ...rest
}: React.HTMLAttributes<HTMLDivElement> & { elev?: 1 | 2 }) {
  const bg = elev === 2 ? 'var(--color-prom-bg-elev-2)' : 'var(--color-prom-bg-elev)'
  return (
    <div
      className={`rounded-xl border ${className}`}
      style={{
        background: bg,
        borderColor: 'var(--color-prom-border)',
      }}
      {...rest}
    >
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Delta pill — ▲ +12% / ▼ −43% in tinted bg
// ---------------------------------------------------------------------------
export function DeltaPill({
  value,
  invert = false,
}: {
  value: number // percentage like 12 or -43
  invert?: boolean // for metrics where down = good
}) {
  const positive = invert ? value < 0 : value > 0
  const negative = invert ? value > 0 : value < 0
  const neutral = value === 0
  const color = positive
    ? 'var(--color-prom-pos)'
    : negative
    ? 'var(--color-prom-neg)'
    : 'var(--color-prom-text-2)'
  const bg = positive
    ? 'var(--color-prom-accent-dim)'
    : negative
    ? 'var(--color-prom-neg-dim)'
    : 'rgba(255,255,255,0.06)'
  const arrow = positive ? '▲' : negative ? '▼' : '—'
  const abs = Math.abs(value).toFixed(0)
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] prom-numeric"
      style={{ color, background: bg }}
    >
      <span style={{ fontSize: 9 }}>{arrow}</span>
      {!neutral ? `${abs}%` : 'flat'}
    </span>
  )
}

// ---------------------------------------------------------------------------
// KPI card — small-caps label, large numeric, optional delta pill
// ---------------------------------------------------------------------------
export function KpiCard({
  label,
  value,
  subValue,
  delta,
  deltaInvert,
  size = 'md',
  accent = false,
}: {
  label: string
  value: string
  subValue?: string
  delta?: number
  deltaInvert?: boolean
  size?: 'sm' | 'md' | 'lg'
  accent?: boolean
}) {
  const numSize = size === 'lg' ? 48 : size === 'sm' ? 28 : 36
  return (
    <PromCard className="p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="prom-eyebrow">{label}</div>
        {delta !== undefined ? <DeltaPill value={delta} invert={deltaInvert} /> : null}
      </div>
      <div
        className="prom-numeric mt-3 font-semibold"
        style={{
          fontSize: numSize,
          lineHeight: `${numSize + 4}px`,
          color: accent ? 'var(--color-prom-accent)' : 'var(--color-prom-text)',
        }}
      >
        {value}
      </div>
      {subValue ? (
        <div className="mt-1 text-xs" style={{ color: 'var(--color-prom-text-3)' }}>
          {subValue}
        </div>
      ) : null}
    </PromCard>
  )
}

// ---------------------------------------------------------------------------
// Generic pill (status / sentiment / triage)
// ---------------------------------------------------------------------------
export type PillTone = 'pos' | 'neg' | 'warn' | 'neutral' | 'accent'

const TONE_STYLES: Record<PillTone, { color: string; bg: string }> = {
  pos: { color: 'var(--color-prom-pos)', bg: 'var(--color-prom-accent-dim)' },
  neg: { color: 'var(--color-prom-neg)', bg: 'var(--color-prom-neg-dim)' },
  warn: { color: 'var(--color-prom-warn)', bg: 'var(--color-prom-warn-dim)' },
  neutral: { color: 'var(--color-prom-text-2)', bg: 'rgba(255,255,255,0.06)' },
  accent: { color: 'var(--color-prom-accent)', bg: 'var(--color-prom-accent-dim)' },
}

export function Pill({
  tone = 'neutral',
  children,
  className = '',
}: {
  tone?: PillTone
  children: React.ReactNode
  className?: string
}) {
  const s = TONE_STYLES[tone]
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium ${className}`}
      style={{ color: s.color, background: s.bg }}
    >
      {children}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Preview badge — for mock LLM features
// ---------------------------------------------------------------------------
export function PreviewBadge() {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] tracking-widest uppercase"
      style={{
        color: 'var(--color-prom-accent)',
        border: '1px solid var(--color-prom-accent-dim)',
        background: 'transparent',
      }}
      title="Demo-only. Live AI features land in V1."
    >
      ◆ Preview
    </span>
  )
}

// ---------------------------------------------------------------------------
// Leverage card — Promethean's flagship "if you fixed one thing" surface
// ---------------------------------------------------------------------------
export function LeverageCard({
  rank,
  metricLabel,
  cashDelta,
  cashSub,
  current,
  target,
  comparison,
  coachingQuestion,
  lift,
}: {
  rank: number
  metricLabel: string
  cashDelta: string
  cashSub: string
  current: number // 0..1
  target: number // 0..1
  comparison: string
  coachingQuestion: string
  lift: string
}) {
  const pct = Math.min(100, Math.max(0, (current / target) * 100))
  return (
    <PromCard className="p-6 flex flex-col h-full">
      <div className="flex items-center justify-between">
        <div className="prom-eyebrow">{metricLabel}</div>
        <div className="prom-eyebrow">#{rank} LEVER</div>
      </div>
      <div
        className="prom-numeric mt-4 font-semibold"
        style={{ fontSize: 44, lineHeight: '46px', color: 'var(--color-prom-accent)' }}
      >
        {cashDelta}
      </div>
      <div className="mt-1 text-xs" style={{ color: 'var(--color-prom-text-2)' }}>
        {cashSub}
      </div>

      {/* progress bar */}
      <div className="mt-5">
        <div
          className="h-[3px] w-full rounded-full overflow-hidden"
          style={{ background: 'rgba(255,255,255,0.06)' }}
        >
          <div
            className="h-full"
            style={{
              width: `${pct}%`,
              background: 'var(--color-prom-accent)',
            }}
          />
        </div>
        <div className="mt-2 text-xs" style={{ color: 'var(--color-prom-text-2)' }}>
          {comparison}
        </div>
      </div>

      {/* coaching */}
      <div
        className="mt-5 pt-5 text-sm"
        style={{
          borderTop: '1px solid var(--color-prom-border)',
          color: 'var(--color-prom-text)',
          lineHeight: '1.5',
        }}
      >
        {coachingQuestion}
      </div>

      <div className="mt-auto pt-4 flex justify-end">
        <div
          className="prom-eyebrow"
          style={{ color: 'var(--color-prom-accent)' }}
        >
          {lift}
        </div>
      </div>
    </PromCard>
  )
}

// ---------------------------------------------------------------------------
// Dropdown trigger (visual only — V0 doesn't open a real menu)
// ---------------------------------------------------------------------------
export function PromDropdownStub({
  label,
  className = '',
}: {
  label: string
  className?: string
}) {
  return (
    <button
      type="button"
      className={`inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs ${className}`}
      style={{
        background: 'var(--color-prom-bg-elev)',
        color: 'var(--color-prom-text)',
        border: '1px solid var(--color-prom-border)',
      }}
    >
      <span>{label}</span>
      <span style={{ color: 'var(--color-prom-text-3)', fontSize: 9 }}>▾</span>
    </button>
  )
}

// ---------------------------------------------------------------------------
// Table primitives — bare-bones, dark editorial
// ---------------------------------------------------------------------------
export function PromTable({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="rounded-xl border overflow-hidden"
      style={{
        background: 'var(--color-prom-bg-elev)',
        borderColor: 'var(--color-prom-border)',
      }}
    >
      <table className="w-full text-sm">{children}</table>
    </div>
  )
}

export function PromTHead({ children }: { children: React.ReactNode }) {
  return (
    <thead
      className="prom-eyebrow"
      style={{
        background: 'transparent',
        borderBottom: '1px solid var(--color-prom-border)',
      }}
    >
      {children}
    </thead>
  )
}

export function PromTH({
  children,
  align = 'left',
  className = '',
}: {
  children: React.ReactNode
  align?: 'left' | 'right' | 'center'
  className?: string
}) {
  return (
    <th
      className={`px-4 py-3 text-${align} font-semibold ${className}`}
      style={{ color: 'var(--color-prom-text-3)', fontWeight: 600 }}
    >
      {children}
    </th>
  )
}

export function PromTR({
  children,
  hover = true,
}: {
  children: React.ReactNode
  hover?: boolean
}) {
  return (
    <tr
      className={hover ? 'transition-colors hover:bg-white/[0.025]' : ''}
      style={{ borderTop: '1px solid var(--color-prom-border)' }}
    >
      {children}
    </tr>
  )
}

export function PromTD({
  children,
  align = 'left',
  className = '',
  style,
}: {
  children: React.ReactNode
  align?: 'left' | 'right' | 'center'
  className?: string
  style?: React.CSSProperties
}) {
  return (
    <td
      className={`px-4 py-3 text-${align} ${className}`}
      style={{ color: 'var(--color-prom-text)', ...style }}
    >
      {children}
    </td>
  )
}

// ---------------------------------------------------------------------------
// Avatar — initials in a circle
// ---------------------------------------------------------------------------
export function AvatarCircle({
  initials,
  size = 24,
}: {
  initials: string
  size?: number
}) {
  return (
    <span
      className="inline-flex items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        background: 'rgba(212, 225, 87, 0.10)',
        color: 'var(--color-prom-text)',
        fontSize: Math.max(9, size * 0.36),
        border: '1px solid var(--color-prom-border)',
      }}
    >
      {initials}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Empty state — serif headline + small-caps CTA
// ---------------------------------------------------------------------------
export function EmptyState({
  title,
  cta,
}: {
  title: string
  cta?: string
}) {
  return (
    <div className="py-16 text-center">
      <h3 className="prom-serif" style={{ fontSize: 28, color: 'var(--color-prom-text-2)' }}>
        {title}
      </h3>
      {cta ? <div className="prom-eyebrow mt-3">{cta}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Live status dot
// ---------------------------------------------------------------------------
export function LiveDot() {
  return (
    <span
      className="inline-block rounded-full prom-pulse"
      style={{
        width: 7,
        height: 7,
        background: 'var(--color-prom-accent)',
        boxShadow: '0 0 8px var(--color-prom-accent-dim)',
      }}
    />
  )
}

// ---------------------------------------------------------------------------
// Money / number formatters
// ---------------------------------------------------------------------------
export function money(v: number, opts: { compact?: boolean } = {}): string {
  if (opts.compact && Math.abs(v) >= 1000) {
    if (Math.abs(v) >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
    return `$${(v / 1000).toFixed(1)}K`
  }
  return `$${Math.round(v).toLocaleString('en-US')}`
}

export function pct(v: number, decimals = 1): string {
  return `${(v * 100).toFixed(decimals)}%`
}

export function intish(v: number): string {
  return Math.round(v).toLocaleString('en-US')
}
