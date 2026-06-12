'use client'

import { useRouter, usePathname } from 'next/navigation'
import type { ChangeEvent } from 'react'

// Ad filter for the Funnel page. Selecting an ad re-scopes the whole HT funnel
// (and the rosters its stages link to) to that ad's leads. "All ads" clears it.
// URL-param driven (?ad=<ad_id>), preserving the window; persisted by
// PersistPageState (filters={['ad']}).

export type AdOption = { adId: string; adName: string; count: number }

export function AdFilter({
  options,
  selected,
  startEtDate,
  endEtDate,
}: {
  options: AdOption[]
  selected: string | null
  startEtDate: string
  endEtDate: string
}) {
  const router = useRouter()
  const pathname = usePathname()

  function onChange(e: ChangeEvent<HTMLSelectElement>) {
    const ad = e.target.value
    const p = new URLSearchParams()
    p.set('start', startEtDate)
    p.set('end', endEtDate)
    if (ad) p.set('ad', ad)
    router.push(`${pathname}?${p.toString()}`)
  }

  return (
    <select
      value={selected ?? ''}
      onChange={onChange}
      className="geg-mono"
      aria-label="Filter funnel by ad"
      style={{
        fontSize: 11,
        letterSpacing: '0.04em',
        color: 'var(--color-geg-text-2)',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 6,
        padding: '6px 10px',
        maxWidth: 280,
      }}
    >
      <option value="">All ads</option>
      {options.map((o) => (
        <option key={o.adId} value={o.adId}>
          {o.adName} ({o.count})
        </option>
      ))}
    </select>
  )
}
