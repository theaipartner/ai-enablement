// Gregory Redesign Part 1 — foundation primitive.
//
// Visual-only rendering of the sentiment tier surfaced from
// `documents.metadata.sentiment_tier` on call_summary rows. Part 2
// pipeline work populates the metadata; this primitive consumes it.
//
// Decision 7: sentiment lives in documents.metadata, never queried at
// scale, only rendered. Decision: no migration, no new column.
//
// § 1.9 redundant encoding: color is paired with a text label so
// color-blind users get the meaning either way. The pill also carries
// an aria-label for screen readers.
//
// Null / undefined tier → renders nothing. Pages handle loading state
// upstream (skeleton or absent slot) — the primitive doesn't paint a
// placeholder.
//
// Conventions: docs/gregory-conventions.md § Sentiment data flow.
// Slot owner: any call-summary-adjacent surface (calls list,
//   call detail header, recent-calls list on /clients/[id]).
// Tokens consumed: --color-geg-accent-dim (green tier),
//   --color-geg-accent-strong (green text), --color-geg-warn-dim,
//   --color-geg-warn (yellow), --color-geg-neg-dim, --color-geg-neg (red).

export type SentimentTier = 'green' | 'yellow' | 'red'

export type SentimentPillProps = {
  tier?: SentimentTier | null
}

const TIER_STYLES: Record<
  SentimentTier,
  { bg: string; fg: string; label: string }
> = {
  green: {
    bg: 'var(--color-geg-accent-dim)',
    fg: 'var(--color-geg-accent-strong)',
    label: 'Green',
  },
  yellow: {
    bg: 'var(--color-geg-warn-dim)',
    fg: 'var(--color-geg-warn)',
    label: 'Yellow',
  },
  red: {
    bg: 'var(--color-geg-neg-dim)',
    fg: 'var(--color-geg-neg)',
    label: 'Red',
  },
}

export function SentimentPill({ tier }: SentimentPillProps) {
  if (!tier) return null
  const style = TIER_STYLES[tier]
  if (!style) return null
  return (
    <span
      role="status"
      aria-label={`Sentiment: ${style.label}`}
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium"
      style={{ background: style.bg, color: style.fg }}
    >
      {/* Color dot — decorative, screen-readers skip via aria-hidden. */}
      <span
        aria-hidden="true"
        style={{
          display: 'inline-block',
          width: 6,
          height: 6,
          borderRadius: 999,
          background: style.fg,
        }}
      />
      {style.label}
    </span>
  )
}
