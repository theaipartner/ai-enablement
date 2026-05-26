'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

// Native <select> styled to match the dashboard. Sets/clears the
// ?speedCaller=user_id URL param. Preserves all other params.
export function CallerFilter({
  callers,
  currentCallerId,
}: {
  callers: Array<{ userId: string; name: string | null; leadCount: number }>
  currentCallerId: string | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function onChange(value: string) {
    const sp = new URLSearchParams(params.toString())
    if (!value) sp.delete('speedCaller')
    else sp.set('speedCaller', value)
    // Reset see-more state when filter changes — the filtered set
    // may be small enough to need no see-more, and starting fresh
    // is clearer than inheriting the prior toggle.
    sp.delete('showAllSpeed')
    const qs = sp.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <span
      className="geg-mono"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        border: '1px solid var(--color-geg-border-strong)',
        borderRadius: 6,
        padding: '4px 10px',
        fontSize: 11,
        letterSpacing: '0.06em',
        color: 'var(--color-geg-text-2)',
      }}
    >
      <span style={{ color: 'var(--color-geg-text-faint)', fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase' }}>
        Caller
      </span>
      <select
        value={currentCallerId ?? ''}
        onChange={(e) => onChange(e.target.value)}
        style={{
          background: 'transparent',
          border: 'none',
          outline: 'none',
          color: 'var(--color-geg-text)',
          fontFamily: 'inherit',
          fontSize: 'inherit',
          letterSpacing: 'inherit',
          padding: 0,
          cursor: 'pointer',
          colorScheme: 'dark',
        }}
      >
        <option value="">All callers</option>
        {callers.map((c) => (
          <option key={c.userId} value={c.userId}>
            {c.name ?? c.userId.slice(0, 13) + '…'} ({c.leadCount})
          </option>
        ))}
      </select>
    </span>
  )
}
