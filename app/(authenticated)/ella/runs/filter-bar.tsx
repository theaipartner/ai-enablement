'use client'

// Ella runs filter bar — Part 2 redesign.
//
// Removed from V1: Speaker-role multi-select, Anomaly-flag multi-select,
// "Show anomalies only" toggle. Their server-side filter inputs are
// retained in `lib/db/ella-runs.ts` (intentional; future alert work may
// consume them) but the UI no longer exposes them.
//
// Channel filter swapped from MultiSelectDropdown to an inline
// hand-rolled searchable combobox — needed for the post-2.3 channel
// fleet (100+ channels make a non-searchable dropdown unworkable).
// Path B per spec § Channel filter: a hand-rolled wrapper rather than
// shadcn's Command primitive, because adding `cmdk` would cross the
// "never install major dep without asking" working norm. The visual is
// less polished than Command but the UX (type to filter, click to
// toggle) is the same.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { ChevronDownIcon } from 'lucide-react'
import { MultiSelectDropdown } from '@/app/(authenticated)/clients/multi-select-dropdown'

const STATUS_OPTIONS = [
  { value: 'success', label: 'success' },
  { value: 'escalated', label: 'escalated' },
  { value: 'error', label: 'error' },
  { value: 'skipped', label: 'skipped' },
] as const

export function EllaRunsFilterBar({
  channelOptions,
}: {
  channelOptions: ReadonlyArray<{ readonly value: string; readonly label: string }>
}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()

  const setMulti = useCallback(
    (key: string, values: string[]) => {
      const next = new URLSearchParams(searchParams.toString())
      if (values.length === 0) next.delete(key)
      else next.set(key, values.join(','))
      router.push(`${pathname}?${next.toString()}`)
    },
    [router, pathname, searchParams],
  )

  const setSingle = useCallback(
    (key: string, value: string | null) => {
      const next = new URLSearchParams(searchParams.toString())
      if (!value) next.delete(key)
      else next.set(key, value)
      router.push(`${pathname}?${next.toString()}`)
    },
    [router, pathname, searchParams],
  )

  const parseList = (key: string): string[] => {
    const v = searchParams.get(key)
    return v ? v.split(',').filter(Boolean) : []
  }

  const from = searchParams.get('from') ?? ''
  const to = searchParams.get('to') ?? ''
  const channels = parseList('channel')
  const statuses = parseList('status')

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-white p-3">
      <label className="flex items-center gap-1 text-sm">
        <span className="text-muted-foreground">From</span>
        <input
          type="date"
          value={from}
          onChange={(e) => setSingle('from', e.target.value || null)}
          className="h-8 rounded-md border bg-white px-2 text-sm"
        />
      </label>
      <label className="flex items-center gap-1 text-sm">
        <span className="text-muted-foreground">To</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setSingle('to', e.target.value || null)}
          className="h-8 rounded-md border bg-white px-2 text-sm"
        />
      </label>

      <SearchableMultiSelect
        label="Channel"
        options={channelOptions}
        selected={channels}
        onChange={(next) => setMulti('channel', next)}
        searchPlaceholder="Search channels…"
      />
      <MultiSelectDropdown
        label="Status"
        options={STATUS_OPTIONS}
        selected={statuses}
        onChange={(next) => setMulti('status', next)}
      />
    </div>
  )
}

// Hand-rolled searchable multi-select. Click trigger → opens a panel
// with a search input at top + a filtered checkbox list below.
// Click-outside dismisses; Escape closes. Toggling checkboxes keeps the
// panel open so users can select multiple channels without re-opening.
function SearchableMultiSelect({
  label,
  options,
  selected,
  onChange,
  searchPlaceholder = 'Search…',
}: {
  label: string
  options: ReadonlyArray<{ readonly value: string; readonly label: string }>
  selected: string[]
  onChange: (next: string[]) => void
  searchPlaceholder?: string
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)

  // Click-outside dismiss + Escape close.
  useEffect(() => {
    if (!open) return
    function onMouseDown(e: MouseEvent) {
      const t = e.target as Node
      if (panelRef.current?.contains(t)) return
      if (triggerRef.current?.contains(t)) return
      setOpen(false)
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  // Auto-focus the search input on open.
  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  const filteredOptions = useMemo(() => {
    if (!query.trim()) return options
    const q = query.toLowerCase()
    return options.filter((o) => o.label.toLowerCase().includes(q))
  }, [options, query])

  function toggle(value: string) {
    if (selected.includes(value)) {
      onChange(selected.filter((v) => v !== value))
    } else {
      onChange([...selected, value])
    }
  }

  let triggerText: string
  if (selected.length === 0) {
    triggerText = label
  } else if (selected.length === 1) {
    const o = options.find((opt) => opt.value === selected[0])
    triggerText = `${label}: ${o?.label ?? selected[0]}`
  } else {
    triggerText = `${label}: ${selected.length} selected`
  }

  return (
    <div className="relative inline-block">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-8 items-center gap-1.5 rounded-md border bg-transparent px-2 text-sm transition-colors hover:bg-muted/50"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{triggerText}</span>
        <ChevronDownIcon className="h-3.5 w-3.5 opacity-60" />
      </button>
      {open ? (
        <div
          ref={panelRef}
          className="absolute left-0 top-9 z-50 w-[300px] rounded-md border bg-popover p-2 text-popover-foreground shadow-md"
          role="listbox"
        >
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={searchPlaceholder}
            className="w-full rounded-sm border bg-background px-2 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />
          <div className="mt-1.5 max-h-72 overflow-y-auto">
            {filteredOptions.length === 0 ? (
              <div className="px-2 py-2 text-xs text-muted-foreground">
                No matches.
              </div>
            ) : (
              filteredOptions.map((o) => {
                const checked = selected.includes(o.value)
                return (
                  <label
                    key={o.value}
                    className="flex cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(o.value)}
                      className="h-3.5 w-3.5"
                    />
                    <span>{o.label}</span>
                  </label>
                )
              })
            )}
          </div>
          {selected.length > 0 ? (
            <button
              type="button"
              onClick={() => onChange([])}
              className="mt-1 w-full rounded-sm px-2 py-1 text-left text-xs text-muted-foreground hover:bg-accent"
            >
              Clear selection
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
