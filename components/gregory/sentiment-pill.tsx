// Gregory Redesign Part 2 — Calls redesign primitive.
//
// Visual-only rendering of the sentiment tier surfaced from
// `documents.metadata.sentiment_tier` on call_review rows. The data is
// `green` | `yellow` | `red` (matches the classifier output and the
// jsonb field); the user-visible labels are POSITIVE / MIXED / NEGATIVE
// per Design's "label decision" callout. The structural prop stays
// tier so the data shape and UI copy can evolve independently.
//
// § 1.9 redundant encoding: color + dot + uppercase label so the
// distinction reads under monochrome / colorblind / low-contrast
// conditions. aria-label carries the same label for screen readers.
//
// Null / undefined tier → renders nothing. Pages handle the loading
// state (skeleton, absent slot) — the primitive doesn't placeholder.
//
// Tokens consumed: --color-geg-pos / --color-geg-pos-fill /
// --color-geg-pos-border (and warn/neg analogues). These tokens are
// DECOUPLED from --color-geg-accent so the green tier stays literal
// green if the accent ever swaps off gold.

export type SentimentTier = 'green' | 'yellow' | 'red'

export type SentimentPillProps = {
  tier?: SentimentTier | null
  // Optional className passthrough — used by the call-detail header to
  // bump the size slightly without losing the inline layout.
  className?: string
}

const TIER_STYLES: Record<
  SentimentTier,
  { color: string; bg: string; border: string; label: string }
> = {
  green: {
    color: 'var(--color-geg-pos)',
    bg: 'var(--color-geg-pos-fill)',
    border: 'var(--color-geg-pos-border)',
    label: 'Positive',
  },
  yellow: {
    color: 'var(--color-geg-warn)',
    bg: 'var(--color-geg-warn-fill)',
    border: 'var(--color-geg-warn-border)',
    label: 'Mixed',
  },
  red: {
    color: 'var(--color-geg-neg)',
    bg: 'var(--color-geg-neg-fill)',
    border: 'var(--color-geg-neg-border)',
    label: 'Negative',
  },
}

export function SentimentPill({ tier, className }: SentimentPillProps) {
  if (!tier) return null
  const style = TIER_STYLES[tier]
  if (!style) return null
  return (
    <span
      role="status"
      aria-label={`Sentiment: ${style.label}`}
      className={
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-[3px] text-[10px] font-medium uppercase' +
        (className ? ` ${className}` : '')
      }
      style={{
        color: style.color,
        background: style.bg,
        borderColor: style.border,
        letterSpacing: '0.12em',
        fontFamily:
          'var(--font-geg-mono, "JetBrains Mono", ui-monospace, monospace)',
      }}
    >
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: 999,
          background: style.color,
          flexShrink: 0,
        }}
      />
      {style.label}
    </span>
  )
}
