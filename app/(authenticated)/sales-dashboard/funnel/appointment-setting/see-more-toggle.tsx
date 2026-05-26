'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

// Toggles a single URL param (?paramKey=1) on/off. Preserves all
// other params (date range, selected rep, etc.). Soft navigation
// keeps scroll position. Used to expand/collapse drill-down lists
// on the appointment-setting page.
export function SeeMoreToggle({
  paramKey,
  isExpanded,
  label,
}: {
  paramKey: string
  isExpanded: boolean
  label: string
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function onClick() {
    const sp = new URLSearchParams(params.toString())
    if (isExpanded) sp.delete(paramKey)
    else sp.set(paramKey, '1')
    const qs = sp.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <button
      type="button"
      onClick={onClick}
      className="geg-mono"
      style={{
        background: 'none',
        border: 'none',
        padding: '4px 0',
        fontSize: 10,
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-accent)',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {label}
    </button>
  )
}
