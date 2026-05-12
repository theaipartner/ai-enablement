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

// Two-column section header: small-caps slug + 2px rule on the left, big
// serif title + optional italic deck on the right. Children render below
// with 36px gap. Sections sit 88px apart for the broadsheet rhythm.
export function PromSection({
  eyebrow,
  headline,
  deck,
  index,
  trailing,
  children,
}: {
  eyebrow?: string
  headline?: string
  deck?: React.ReactNode
  index?: string
  trailing?: React.ReactNode
  children: React.ReactNode
}) {
  const hasHeader = eyebrow || headline || index || deck || trailing
  return (
    <section style={{ marginTop: 88 }}>
      {hasHeader && (
        <div
          className="grid"
          style={{ gridTemplateColumns: '180px 1fr', gap: 24, marginBottom: 36 }}
        >
          <div>
            {eyebrow ? <SectionSlug index={index} label={eyebrow} /> : null}
          </div>
          <div className="flex items-start justify-between gap-6">
            <div style={{ maxWidth: 880 }}>
              {headline ? (
                <h2 className="prom-section-title">{headline}</h2>
              ) : null}
              {deck ? (
                <div
                  className="prom-deck"
                  style={{ fontSize: 15.5, marginTop: 12, maxWidth: 620 }}
                >
                  {deck}
                </div>
              ) : null}
            </div>
            {trailing ? <div className="shrink-0">{trailing}</div> : null}
          </div>
        </div>
      )}
      {children}
    </section>
  )
}

// Tiny slug helper — small-caps left-margin label sitting above a 2px rule.
export function SectionSlug({ index, label }: { index?: string; label: string }) {
  return (
    <div className="prom-section-slug">
      {index ? `${index} · ` : ''}
      {label}
    </div>
  )
}

// Bordered hairline strip with internal column dividers — replaces stacked
// PromCards in the Money / Acquisition / "Where we stand" sections.
export function StripPanel({
  children,
  cols,
  className = '',
}: {
  children: React.ReactNode
  cols: string
  className?: string
}) {
  return (
    <div
      className={`prom-strip grid ${className}`}
      style={{ gridTemplateColumns: cols }}
    >
      {children}
    </div>
  )
}

export function StripCol({
  children,
  className = '',
  padding = '32px',
}: {
  children: React.ReactNode
  className?: string
  padding?: string
}) {
  return (
    <div className={`prom-strip-col ${className}`} style={{ padding }}>
      {children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Page header — eyebrow + serif name + meta strip
// ---------------------------------------------------------------------------
// Refined: 86px display H1 via .prom-display, optional italic editorial
// "deck" to the right of the title, and a byline strip below the H1 with
// hairline rules above + below. The top-row (eyebrow + meta + trailing)
// sits above its own divider so the masthead reads like print.
export function PromPageHeader({
  eyebrow,
  title,
  deck,
  meta,
  trailing,
}: {
  eyebrow?: string
  title: React.ReactNode
  deck?: React.ReactNode
  meta?: React.ReactNode
  trailing?: React.ReactNode
}) {
  return (
    <header>
      {/* Top row — eyebrow + meta on the left, trailing controls on the right.
          Sits above a hairline rule with editorial breathing room below. */}
      {(eyebrow || meta || trailing) && (
        <div
          className="flex flex-wrap items-center justify-between gap-y-2"
          style={{
            paddingBottom: 18,
            marginBottom: 56,
            borderBottom: '1px solid var(--color-prom-border-strong)',
          }}
        >
          <div className="prom-eyebrow flex flex-wrap items-center gap-x-3 gap-y-1">
            {eyebrow ? <span>{eyebrow}</span> : null}
            {eyebrow && meta ? (
              <span style={{ color: 'var(--color-prom-border-strong)' }}>|</span>
            ) : null}
            {meta}
          </div>
          {trailing ? <div className="shrink-0">{trailing}</div> : null}
        </div>
      )}

      {/* Title row — 86px display + optional italic deck on the right. */}
      <div className="flex items-start justify-between gap-10">
        <h1 className="prom-display" style={{ fontSize: 86, maxWidth: 920 }}>
          {title}
        </h1>
        {deck ? (
          <div
            className="prom-deck shrink-0"
            style={{ fontSize: 18, lineHeight: 1.45, maxWidth: 460, paddingTop: 8 }}
          >
            {deck}
          </div>
        ) : null}
      </div>
    </header>
  )
}

// Optional byline strip — used directly after PromPageHeader for the
// "● THIS MONTH · LIVE | period | SYNCED 9:36 AM" row with rules above
// and below. Keeps the masthead composable; pages opt in.
export function PromBylineStrip({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="flex items-center gap-4 prom-eyebrow"
      style={{
        marginTop: 36,
        paddingTop: 20,
        paddingBottom: 36,
        borderTop: '1px solid var(--color-prom-border-strong)',
        borderBottom: '1px solid var(--color-prom-border-strong)',
      }}
    >
      {children}
    </div>
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
// Refined: 54px serif accent number, no progress bar, italic curly-quoted
// coaching pullquote. `current`/`target` kept optional for back-compat
// but unused — the comparison sentence alone carries the meaning.
export function LeverageCard({
  rank,
  metricLabel,
  cashDelta,
  cashSub,
  current: _current,
  target: _target,
  comparison,
  coachingQuestion,
  lift,
  fromValue,
  toValue,
}: {
  rank: number
  metricLabel: string
  cashDelta: string
  cashSub: string
  current?: number
  target?: number
  comparison: string
  coachingQuestion: string
  lift: string
  fromValue?: string
  toValue?: string
}) {
  void _current
  void _target
  return (
    <div
      className="flex flex-col h-full rounded-xl"
      style={{
        background: 'var(--color-prom-bg-elev)',
        border: '1px solid var(--color-prom-border-strong)',
        padding: '30px 28px 28px',
      }}
    >
      {/* Eyebrow row with hairline divider below */}
      <div
        className="flex items-center justify-between"
        style={{
          paddingBottom: 18,
          borderBottom: '1px solid var(--color-prom-border-strong)',
        }}
      >
        <div className="prom-eyebrow">{metricLabel}</div>
        <div
          className="prom-eyebrow"
          style={{
            color: rank === 1 ? 'var(--color-prom-accent)' : 'var(--color-prom-text-3)',
          }}
        >
          #{rank} LEVER
        </div>
      </div>

      {/* 54px serif cash delta */}
      <div
        className="prom-numeric-serif prom-display"
        style={{
          fontSize: 54,
          lineHeight: 1,
          color: 'var(--color-prom-accent)',
          marginTop: 22,
        }}
      >
        {cashDelta}
      </div>
      <div
        className="prom-deck"
        style={{ fontSize: 13.5, marginTop: 8, marginBottom: 24 }}
      >
        {cashSub}
      </div>

      {/* current → target line in tabular Inter */}
      {fromValue && toValue ? (
        <div
          className="prom-numeric"
          style={{ fontSize: 18, marginBottom: 6 }}
        >
          <span style={{ color: 'var(--color-prom-text)' }}>{fromValue}</span>
          <span style={{ color: 'var(--color-prom-text-3)', margin: '0 8px' }}>→</span>
          <span style={{ color: 'var(--color-prom-accent)' }}>{toValue}</span>
        </div>
      ) : null}

      {/* comparison sentence */}
      <div
        style={{
          fontSize: 12.5,
          color: 'var(--color-prom-text-3)',
          lineHeight: 1.5,
        }}
      >
        {comparison}
      </div>

      {/* Coaching pullquote, italic, dotted top border */}
      <div
        className="prom-deck"
        style={{
          fontSize: 14.5,
          color: 'var(--color-prom-text-2)',
          lineHeight: 1.5,
          marginTop: 20,
          paddingTop: 20,
          borderTop: '1px dotted var(--color-prom-border-strong)',
        }}
      >
        &ldquo;{coachingQuestion}&rdquo;
      </div>

      {/* Lift footer */}
      <div className="mt-auto" style={{ paddingTop: 18 }}>
        <div
          className="prom-eyebrow"
          style={{
            color: 'var(--color-prom-pos)',
            letterSpacing: '0.16em',
          }}
        >
          {lift}
        </div>
      </div>
    </div>
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
