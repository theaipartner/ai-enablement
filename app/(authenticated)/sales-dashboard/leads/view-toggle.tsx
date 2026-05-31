'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

// All ↔ Unique toggle for the leads page. "All" = every opt-in in the window
// (new + re-opt-in); "Unique" = new opt-ins only (re-opt-ins removed). Re-scopes
// every funnel box AND the roster — the server reads `?view=` and recomputes.
// Replaces the old click-the-Leads-box affordance with an explicit switch.

export type LeadsView = 'all' | 'unique'

const OPTS: { id: LeadsView; label: string }[] = [
  { id: 'all', label: 'All opt-ins' },
  { id: 'unique', label: 'New only' },
]

export function ViewToggle({ current }: { current: LeadsView }) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function go(view: LeadsView) {
    const sp = new URLSearchParams(params.toString())
    if (view === 'all') sp.delete('view')
    else sp.set('view', view)
    const qs = sp.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
        Counting
      </span>
      <div
        role="tablist"
        aria-label="Lead counting mode"
        style={{ display: 'inline-flex', border: '1px solid var(--color-geg-border-strong)', borderRadius: 6, overflow: 'hidden' }}
      >
        {OPTS.map((o) => {
          const active = o.id === current
          return (
            <button
              key={o.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => go(o.id)}
              className="geg-mono"
              style={{
                border: 'none',
                cursor: 'pointer',
                padding: '6px 12px',
                fontSize: 10,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                background: active ? 'var(--color-geg-accent-fill)' : 'transparent',
                color: active ? 'var(--color-geg-accent)' : 'var(--color-geg-text-3)',
              }}
            >
              {o.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
