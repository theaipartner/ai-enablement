'use client'

// Ella runs filter bar — editorial dark redesign.
//
// Two filters today: Channel (searchable multi-select) + Status
// (multi-select). The Triggers filter from the mock is intentionally
// excluded per Drake's direction; the data layer still accepts a
// `triggers` input but the UI doesn't surface it. Speaker-role +
// Anomaly-flag filters from V1 also stay data-layer-only; no UI for
// either today.
//
// Visual: matches the editorial dark treatment of the Calls + Clients
// filter bars — date range as two inline mono inputs separated by an
// arrow, then the two dropdown triggers in matching chrome.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
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
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '14px 0 16px',
        borderTop: '1px solid var(--color-geg-border)',
        flexWrap: 'wrap',
      }}
    >
      <div
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          border: '1px solid var(--color-geg-border-strong)',
          borderRadius: 6,
          padding: '4px 8px 4px 12px',
          fontFamily:
            'var(--font-geg-mono, "JetBrains Mono", ui-monospace, monospace)',
          fontSize: 12,
          color: 'var(--color-geg-text-2)',
          letterSpacing: '0.02em',
        }}
      >
        <input
          type="date"
          value={from}
          onChange={(e) => setSingle('from', e.target.value || null)}
          aria-label="From date"
          style={{
            background: 'transparent',
            border: 0,
            outline: 0,
            color: 'var(--color-geg-text)',
            fontFamily: 'inherit',
            fontSize: 12,
            letterSpacing: '0.02em',
            padding: '4px 0',
            width: 110,
          }}
        />
        <span style={{ color: 'var(--color-geg-text-faint)' }}>→</span>
        <input
          type="date"
          value={to}
          onChange={(e) => setSingle('to', e.target.value || null)}
          aria-label="To date"
          style={{
            background: 'transparent',
            border: 0,
            outline: 0,
            color: 'var(--color-geg-text)',
            fontFamily: 'inherit',
            fontSize: 12,
            letterSpacing: '0.02em',
            padding: '4px 0',
            width: 110,
          }}
        />
      </div>

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

// Hand-rolled searchable multi-select — same shape as before, just
// styled to match the editorial filter chrome.
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
    triggerText = `${label} · any`
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
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          background: 'transparent',
          border: '1px solid var(--color-geg-border-strong)',
          color: 'var(--color-geg-text-2)',
          fontFamily: 'var(--font-sans)',
          fontSize: 13,
          padding: '8px 30px 8px 12px',
          borderRadius: 6,
          cursor: 'pointer',
          backgroundImage:
            "linear-gradient(45deg, transparent 50%, var(--color-geg-text-faint) 50%), linear-gradient(135deg, var(--color-geg-text-faint) 50%, transparent 50%)",
          backgroundPosition:
            'calc(100% - 14px) 50%, calc(100% - 9px) 50%',
          backgroundSize: '5px 5px, 5px 5px',
          backgroundRepeat: 'no-repeat',
          outline: 'none',
        }}
      >
        <span>{triggerText}</span>
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
