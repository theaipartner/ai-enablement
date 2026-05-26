'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import {
  WINDOW_OPTIONS,
  WINDOW_SHORT_LABELS,
  parseWindow,
  type Window,
} from '@/lib/db/sales-dashboard-shared'

// Three-pill switcher for the dashboard time window (1D / 7D / 30D).
// Updates ?window= and lets the server re-render with the new window.
// Drops back to default ('7d') by omitting the param entirely so URLs
// stay clean.
export function WindowSwitcher() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const current: Window = parseWindow(params.get('window') ?? undefined)

  function setWindow(next: Window) {
    const sp = new URLSearchParams(params.toString())
    if (next === '7d') sp.delete('window')
    else sp.set('window', next)
    const qs = sp.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <span
      role="group"
      aria-label="Time window"
      className="geg-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'stretch',
        border: '1px solid var(--color-geg-border-strong)',
        borderRadius: 6,
        overflow: 'hidden',
        fontSize: 11,
        letterSpacing: '0.1em',
      }}
    >
      {WINDOW_OPTIONS.map((opt, i) => {
        const active = opt === current
        return (
          <button
            key={opt}
            type="button"
            onClick={() => setWindow(opt)}
            aria-pressed={active}
            style={{
              padding: '6px 12px',
              background: active ? 'var(--color-geg-bg-elev)' : 'transparent',
              color: active ? 'var(--color-geg-text)' : 'var(--color-geg-text-3)',
              borderLeft: i === 0 ? 'none' : '1px solid var(--color-geg-border)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 'inherit',
              letterSpacing: 'inherit',
              textTransform: 'uppercase',
              transition: 'background 120ms, color 120ms',
            }}
          >
            {WINDOW_SHORT_LABELS[opt]}
          </button>
        )
      })}
    </span>
  )
}
