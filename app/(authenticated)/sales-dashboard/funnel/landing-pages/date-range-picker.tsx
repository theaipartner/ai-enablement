'use client'

import { DayPicker, type DateRange, type Matcher } from 'react-day-picker'
import 'react-day-picker/style.css'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useCallback, useEffect, useRef, useState } from 'react'

// Calendly-style range picker. One calendar view with click-start +
// click-end selection. Replaces the previous two-`<input type="date">`
// implementation. URL contract is unchanged:
//   ?start=YYYY-MM-DD&end=YYYY-MM-DD
//
// Used by Pulse, LP detail, Ads, Closing, and Appointment Setting.
// The component is a popover anchored to the trigger button; click
// outside or press Escape to dismiss. When both ends of the range
// are picked, the URL updates and the popover auto-closes.

export type DateRangePickerProps = {
  startEtDate: string
  endEtDate: string
  todayEt: string
  // Optional hard floor — used by /appointment-setting where pre-
  // May-24 data is excluded. Days before this are not selectable.
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

  const [open, setOpen] = useState(false)
  const [range, setRange] = useState<DateRange | undefined>(() => ({
    from: parseYmd(startEtDate),
    to: parseYmd(endEtDate),
  }))
  const containerRef = useRef<HTMLDivElement>(null)

  // Keep local state in sync if the URL changes via deep-link or
  // history navigation (e.g. user hits back).
  useEffect(() => {
    setRange({ from: parseYmd(startEtDate), to: parseYmd(endEtDate) })
  }, [startEtDate, endEtDate])

  // Dismiss on outside click + Escape.
  useEffect(() => {
    if (!open) return
    function onDocClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDocClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDocClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const applyRange = useCallback(
    (newStart: string, newEnd: string) => {
      const sp = new URLSearchParams(params.toString())
      sp.set('start', newStart)
      sp.set('end', newEnd)
      const qs = sp.toString()
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
    },
    [params, pathname, router],
  )

  const handleSelect = useCallback(
    (newRange: DateRange | undefined) => {
      setRange(newRange)
      // Apply + close as soon as a complete range is picked. The
      // react-day-picker range model: clicking once sets `from`,
      // clicking again sets `to`; a third click restarts the range.
      // We only commit the URL change when both ends are present.
      if (newRange?.from && newRange?.to) {
        applyRange(formatYmd(newRange.from), formatYmd(newRange.to))
        setOpen(false)
      }
    },
    [applyRange],
  )

  return (
    <div ref={containerRef} style={{ position: 'relative', display: 'inline-block' }}>
      <button
        type="button"
        aria-label="Open date range picker"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="geg-mono"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          background: 'transparent',
          border: '1px solid var(--color-geg-border-strong)',
          borderRadius: 6,
          padding: '5px 12px',
          fontSize: 11,
          letterSpacing: '0.06em',
          color: 'var(--color-geg-text-2)',
          cursor: 'pointer',
          fontFamily: 'inherit',
        }}
      >
        <span>{formatLabel(startEtDate)}</span>
        <span style={{ color: 'var(--color-geg-text-faint)' }}>→</span>
        <span>{formatLabel(endEtDate)}</span>
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
        <span
          style={{
            fontSize: 9,
            color: 'var(--color-geg-text-faint)',
            marginLeft: 2,
          }}
        >
          {open ? '▴' : '▾'}
        </span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Select a date range"
          style={{
            position: 'absolute',
            top: 'calc(100% + 6px)',
            right: 0,
            zIndex: 50,
            background: 'var(--color-geg-bg-elev)',
            border: '1px solid var(--color-geg-border-strong)',
            borderRadius: 8,
            boxShadow: '0 12px 28px rgba(0,0,0,0.35)',
            padding: 6,
          }}
        >
          <DayPicker
            mode="range"
            selected={range}
            onSelect={handleSelect}
            disabled={buildDisabledMatchers(minDate, todayEt)}
            defaultMonth={range?.from ?? parseYmd(endEtDate)}
            showOutsideDays
            className="geg-rdp"
          />
        </div>
      ) : null}
    </div>
  )
}

// ---------------------------------------------------------------------
// Helpers — ET date string ↔ JS Date
// ---------------------------------------------------------------------
//
// We treat the YYYY-MM-DD strings as plain calendar dates. DayPicker
// works in local browser time; we never look at the time component, so
// the local-time conversion is safe — the day label is what matters.

// Build the DayPicker `disabled` prop as an array of Matcher entries.
// We always disable future days (anything after today ET); the
// optional `minDate` disables anything before the page's floor (e.g.
// the May-24 cutoff on the appointment-setting page).
function buildDisabledMatchers(
  minDate: string | undefined,
  todayEt: string,
): Matcher[] {
  const matchers: Matcher[] = []
  const min = parseYmd(minDate)
  if (min) matchers.push({ before: min })
  const today = parseYmd(todayEt)
  if (today) matchers.push({ after: today })
  return matchers
}

function parseYmd(s: string | undefined): Date | undefined {
  if (!s) return undefined
  const [y, m, d] = s.split('-').map((n) => parseInt(n, 10))
  if (!y || !m || !d) return undefined
  return new Date(y, m - 1, d)
}

function formatYmd(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function formatLabel(s: string): string {
  const d = parseYmd(s)
  if (!d) return s
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
}
