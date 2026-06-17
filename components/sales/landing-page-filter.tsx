'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { ChangeEvent } from 'react'

// Landing-page filter for the Funnel page. A SEPARATE control from the
// Campaign → Ad Set → Ad cascade (landing page is an orthogonal axis,
// attributed by Typeform form_id, not part of the ad tree). Selecting a
// landing page is composable with the ad cascade — the funnel scopes to
// the INTERSECTION cohort (leads through this LP AND this ad).
//
// URL-param driven (?lp=<slug>), preserving every other param (window +
// ad cascade); persisted by PersistPageState. The deepest ad selection +
// the landing page both apply.
//
// NOTE: the funnel-box re-scope by landing page activates once the lead
// tagger stamps each lead_cycle with its source form_id (lands with the
// second LP). Until then this drives which LP the "Landing pages →"
// button opens; the boxes don't yet filter by LP.

export type LandingPageOption = { slug: string; label: string }

// Matches the ad-cascade select trigger so the filter row stays uniform.
const selectStyle = {
  fontSize: 11,
  letterSpacing: '0.04em',
  color: 'var(--color-geg-text-2)',
  background: 'var(--color-geg-bg-elev)',
  border: '1px solid var(--color-geg-border)',
  borderRadius: 6,
  padding: '6px 10px',
  width: 160,
} as const

export function LandingPageFilter({
  options,
  selected,
}: {
  options: LandingPageOption[]
  selected: string | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function onChange(e: ChangeEvent<HTMLSelectElement>) {
    const sp = new URLSearchParams(params.toString())
    const value = e.target.value
    if (value) sp.set('lp', value)
    else sp.delete('lp')
    const qs = sp.toString()
    router.push(qs ? `${pathname}?${qs}` : pathname)
  }

  return (
    <select
      value={selected ?? ''}
      onChange={onChange}
      className="geg-mono"
      aria-label="Filter by landing page"
      style={selectStyle}
    >
      <option value="">All landing pages</option>
      {options.map((o) => (
        <option key={o.slug} value={o.slug}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
