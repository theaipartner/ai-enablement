'use client'

import { useCallback } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { MultiSelectDropdown } from '@/app/(authenticated)/clients/multi-select-dropdown'

// Anomaly flag identifiers mirrored from lib/db/ella-runs.ts. Inlined
// here because that module is `server-only` and the filter bar is a
// client component.
type AnomalyFlag = 'A' | 'B_prime' | 'C' | 'D' | 'E'

const ANOMALY_FLAG_LABEL: Record<AnomalyFlag, string> = {
  A: 'ESCALATE leak',
  B_prime: 'Real-author mismatch',
  C: 'Error',
  D: 'Length outlier',
  E: 'Bare mention',
}

const STATUS_OPTIONS = [
  { value: 'success', label: 'success' },
  { value: 'escalated', label: 'escalated' },
  { value: 'error', label: 'error' },
  { value: 'skipped', label: 'skipped' },
] as const

const ROLE_OPTIONS = [
  { value: 'client', label: 'client' },
  { value: 'advisor', label: 'advisor' },
  { value: 'unresolvable', label: 'unresolvable' },
  { value: 'unknown', label: 'unknown (pre-Batch-1.5)' },
] as const

const ANOMALY_OPTIONS: ReadonlyArray<{ value: AnomalyFlag; label: string }> = [
  { value: 'A', label: `A · ${ANOMALY_FLAG_LABEL.A}` },
  { value: 'B_prime', label: `B' · ${ANOMALY_FLAG_LABEL.B_prime}` },
  { value: 'C', label: `C · ${ANOMALY_FLAG_LABEL.C}` },
  { value: 'D', label: `D · ${ANOMALY_FLAG_LABEL.D}` },
  { value: 'E', label: `E · ${ANOMALY_FLAG_LABEL.E}` },
]

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
  const roles = parseList('role')
  const statuses = parseList('status')
  const anomalies = parseList('anomaly')
  const anomalyOnly = searchParams.get('anomalies_only') === '1'

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border bg-zinc-50/50 p-3">
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

      <MultiSelectDropdown
        label="Channel"
        options={channelOptions}
        selected={channels}
        onChange={(next) => setMulti('channel', next)}
      />
      <MultiSelectDropdown
        label="Speaker role"
        options={ROLE_OPTIONS}
        selected={roles}
        onChange={(next) => setMulti('role', next)}
      />
      <MultiSelectDropdown
        label="Status"
        options={STATUS_OPTIONS}
        selected={statuses}
        onChange={(next) => setMulti('status', next)}
      />
      <MultiSelectDropdown
        label="Anomaly flags"
        options={ANOMALY_OPTIONS}
        selected={anomalies}
        onChange={(next) => setMulti('anomaly', next)}
      />

      <label className="ml-auto flex items-center gap-1.5 text-sm">
        <input
          type="checkbox"
          checked={anomalyOnly}
          onChange={(e) =>
            setSingle('anomalies_only', e.target.checked ? '1' : null)
          }
        />
        <span>Show anomalies only</span>
      </label>
    </div>
  )
}
