'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

// People · client-side tab strip. Server reads `?role=` from
// searchParams to know which table to render; this component just
// swaps the URL when a tab is clicked.

export type PeopleRole = 'closers' | 'setters' | 'csms'

const TABS: { id: PeopleRole; label: string }[] = [
  { id: 'closers', label: 'Closers' },
  { id: 'setters', label: 'Setters' },
  { id: 'csms', label: 'CSMs' },
]

export function PeopleTabs() {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const current = (params.get('role') ?? 'closers') as PeopleRole

  function go(role: PeopleRole) {
    const sp = new URLSearchParams(params.toString())
    if (role === 'closers') sp.delete('role')
    else sp.set('role', role)
    const qs = sp.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <div
      role="tablist"
      aria-label="People role"
      style={{
        display: 'inline-flex',
        border: '1px solid var(--color-geg-border-strong)',
        borderRadius: 6,
        overflow: 'hidden',
      }}
    >
      {TABS.map((t, i) => {
        const active = t.id === current
        return (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => go(t.id)}
            className="geg-mono"
            style={{
              padding: '7px 14px',
              background: active ? 'var(--color-geg-bg-elev)' : 'transparent',
              color: active ? 'var(--color-geg-text)' : 'var(--color-geg-text-3)',
              borderLeft: i === 0 ? 'none' : '1px solid var(--color-geg-border)',
              fontSize: 11,
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {t.label}
          </button>
        )
      })}
    </div>
  )
}

