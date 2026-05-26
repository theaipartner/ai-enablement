'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useState } from 'react'

// Calendar date-range picker for the LP detail page. URL contract:
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD
// Two HTML date inputs only — no preset buttons. The 1d/7d/30d
// presets were dropped because every common range is two clicks
// away on the calendar and the presets cluttered the affordance.

export type DateRangePickerProps = {
  startEtDate: string
  endEtDate: string
  todayEt: string
  // Optional hard floor — used by the appointment-setting page where
  // pre-May-24 data is excluded. The native <input type="date"> will
  // grey out earlier dates.
  minDate?: string
}

export function DateRangePicker({
  startEtDate,
  endEtDate,
  todayEt,
  minDate,
}: DateRangePickerProps) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [start, setStart] = useState(startEtDate)
  const [end, setEnd] = useState(endEtDate)

  function applyRange(newStart: string, newEnd: string) {
    const sp = new URLSearchParams(params.toString())
    sp.set('start', newStart)
    sp.set('end', newEnd)
    const qs = sp.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <span
      role="group"
      aria-label="Date range"
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
      <input
        type="date"
        value={start}
        min={minDate}
        max={end}
        onChange={(e) => {
          setStart(e.target.value)
          applyRange(e.target.value, end)
        }}
        style={inputStyle}
      />
      <span style={{ color: 'var(--color-geg-text-faint)' }}>→</span>
      <input
        type="date"
        value={end}
        min={minDate ?? start}
        max={todayEt}
        onChange={(e) => {
          setEnd(e.target.value)
          applyRange(start, e.target.value)
        }}
        style={inputStyle}
      />
      <span
        style={{
          fontSize: 10,
          letterSpacing: '0.1em',
          color: 'var(--color-geg-text-faint)',
          marginLeft: 4,
        }}
      >
        ET
      </span>
    </span>
  )
}

const inputStyle: React.CSSProperties = {
  background: 'transparent',
  border: 'none',
  outline: 'none',
  color: 'var(--color-geg-text-2)',
  fontFamily: 'inherit',
  fontSize: 'inherit',
  letterSpacing: 'inherit',
  padding: 0,
  cursor: 'pointer',
  colorScheme: 'dark',
}
