// Small task-type pill shown on each flag row so multiple task kinds can
// coexist within one notification section (e.g. "Needs review" vs other
// client-flag tasks coming later). Pure presentational; safe in both server
// and client components.

type Tone = 'info' | 'neg' | 'warn' | 'neutral'

const TONE: Record<Tone, { bg: string; border: string; color: string }> = {
  info: {
    bg: 'var(--color-geg-accent-fill)',
    border: 'var(--color-geg-accent-border)',
    color: 'var(--color-geg-accent)',
  },
  neg: {
    bg: 'var(--color-geg-neg-fill)',
    border: 'var(--color-geg-neg-border)',
    color: 'var(--color-geg-neg)',
  },
  warn: {
    bg: 'var(--color-geg-warn-fill)',
    border: 'var(--color-geg-warn-border)',
    color: 'var(--color-geg-warn)',
  },
  neutral: {
    bg: 'var(--color-geg-bg-elev)',
    border: 'var(--color-geg-border)',
    color: 'var(--color-geg-text-2)',
  },
}

export function FlagTaskPill({ label, tone }: { label: string; tone: Tone }) {
  const t = TONE[tone]
  return (
    <span
      className="geg-mono"
      style={{
        display: 'inline-block',
        padding: '3px 8px',
        background: t.bg,
        border: `1px solid ${t.border}`,
        color: t.color,
        borderRadius: 4,
        fontSize: 10,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        whiteSpace: 'nowrap',
        flexShrink: 0,
      }}
    >
      {label}
    </span>
  )
}
