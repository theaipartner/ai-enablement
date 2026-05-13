'use client'

import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { CandidateClient } from '@/lib/db/merge'

// Calls redesign · § 1 — filter bar.
//
//   - Search input · flex 1, max-width 320, gold focus ring.
//   - Filter by client … · native <select> with the full client list.
//   - Filter by CSM …    · native <select> with active primary CSMs.
//   - All controls participate in the URL state (`q`, `client`, `csm`).
//
// Native <select> beats a custom dropdown here — light, accessible,
// matches the design's caret-only chevron, and the `geg-select` polish
// in globals.css already gives it the editorial-dark treatment.

export function CallsFilterBar({
  clientOptions,
  csmOptions,
}: {
  clientOptions: CandidateClient[]
  csmOptions: Array<{ id: string; full_name: string }>
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const [searchValue, setSearchValue] = useState(searchParams.get('q') ?? '')
  const debounceRef = useRef<NodeJS.Timeout | null>(null)
  const initialMount = useRef(true)

  useEffect(() => {
    if (initialMount.current) {
      initialMount.current = false
      return
    }
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString())
      if (searchValue) params.set('q', searchValue)
      else params.delete('q')
      router.replace(`${pathname}?${params.toString()}`)
    }, 300)
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchValue])

  function applyParam(key: string, value: string) {
    const params = new URLSearchParams(searchParams.toString())
    if (value) params.set(key, value)
    else params.delete(key)
    router.replace(`${pathname}?${params.toString()}`)
  }

  const activeClientId = searchParams.get('client') ?? ''
  const activeCsmId = searchParams.get('csm') ?? ''

  return (
    <div
      className="flex items-center gap-2.5"
      style={{
        padding: '14px 0 18px',
        borderTop: '1px solid var(--color-geg-border)',
      }}
    >
      <input
        type="text"
        placeholder="Search calls…"
        value={searchValue}
        onChange={(e) => setSearchValue(e.target.value)}
        className="geg-filter-input"
      />
      <select
        value={activeClientId}
        onChange={(e) => applyParam('client', e.target.value)}
        className="geg-filter-select"
      >
        <option value="">Filter by client…</option>
        {clientOptions.map((c) => (
          <option key={c.id} value={c.id}>
            {c.full_name}
          </option>
        ))}
      </select>
      <select
        value={activeCsmId}
        onChange={(e) => applyParam('csm', e.target.value)}
        className="geg-filter-select"
      >
        <option value="">Filter by CSM…</option>
        {csmOptions.map((csm) => (
          <option key={csm.id} value={csm.id}>
            {csm.full_name}
          </option>
        ))}
      </select>
    </div>
  )
}
