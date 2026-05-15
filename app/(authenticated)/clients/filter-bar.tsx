'use client'

// M5.5 — comprehensive filter bar.
//
// 9 dropdowns in a single flex row: 5 active multi-selects (Status,
// Primary CSM, CSM Standing, NPS Standing, Trustpilot), 1 single-value
// toggle (Needs review), and 3 disabled placeholders that signal the
// next slice of work to Scott during onboarding (Accountability, NPS
// toggle, Country). All built on MultiSelectDropdown.
//
// URL state model:
//   - Each multi-select's checked values are comma-separated in its
//     URL param: ?status=active,ghost. Filter semantics are
//     OR-within-dropdown, AND-across-dropdowns.
//   - Status is special: the dropdown is pre-checked with
//     ['active','paused','ghost'] when the param is absent. Writing
//     that exact set back to the URL would be redundant noise, so
//     `setStatus` collapses the default-set case to a clean URL via
//     set equality (order-independent). The explicit-empty sentinel
//     `?status=` means "user has unchecked everything — show all
//     statuses including churned/leave."
//   - All other multi-selects use the simple "absent or empty = no
//     filter" semantics. No sentinel required.
//   - Search input remains debounced (300ms); writes/deletes ?q=.
//   - Sort + dir are orthogonal (preserved by writeParams).
//
// Clear filters button visibility: searchValue OR any non-default
// filter state. For status, "non-default" means "param present in URL"
// (we never write the default set verbatim, so any presence is
// non-default). Search is included directly so the button doesn't lag
// during the debounce window.

import { useEffect, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import {
  CSM_STANDING_OPTIONS,
  NPS_STANDING_OPTIONS,
  STATUS_OPTIONS,
  TRUSTPILOT_OPTIONS,
} from '@/lib/client-vocab'
import { MultiSelectDropdown } from './multi-select-dropdown'

const STATUS_DEFAULT_SELECTED: readonly string[] = ['active', 'paused', 'ghost']

const NEEDS_REVIEW_OPTIONS = [
  { value: '1', label: 'Auto-created — needs review' },
] as const

// Missing Slack filter — toggle on to narrow to clients with null
// slack_user_id OR null slack_channel_id. Both badges feed off the
// same nullable fields; the filter is single-toggle, not per-badge,
// because the actionable data-hygiene question is "do any of these
// have broken Slack identity?" — not "which one is broken?"
const MISSING_SLACK_OPTIONS = [
  { value: '1', label: 'Missing Slack channel or user' },
] as const

// M5.7 — Accountability / NPS toggle dropdowns. Same OR-within multi-select
// shape as the other filters even though there are only two values; users can
// pick On, Off, or both. Mapping 'on'|'off' → boolean happens in the data
// layer, not here.
const TOGGLE_OPTIONS = [
  { value: 'on', label: 'On' },
  { value: 'off', label: 'Off' },
] as const

function parseMulti(raw: string | null): string[] {
  if (raw === null || raw === '') return []
  return raw.split(',').filter(Boolean)
}

// Status sentinel parsing: absent → pre-check the default trio; explicit
// empty → no checks (no filter); else parse comma-separated. Mirror in
// readFilters on the page so the server-side default matches the
// client-side UI.
function readStatusSelection(raw: string | null): string[] {
  if (raw === null) return [...STATUS_DEFAULT_SELECTED]
  if (raw === '') return []
  return raw.split(',').filter(Boolean)
}

// Set equality, not array equality — so re-checking the default trio in
// any click order collapses back to a clean URL.
function isStatusDefault(values: string[]): boolean {
  if (values.length !== STATUS_DEFAULT_SELECTED.length) return false
  const set = new Set(values)
  return STATUS_DEFAULT_SELECTED.every((v) => set.has(v))
}

export function FilterBar({
  primaryCsmOptions,
  countryOptions,
}: {
  primaryCsmOptions: Array<{ id: string; label: string }>
  countryOptions: string[]
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

  const statusSelected = readStatusSelection(searchParams.get('status'))
  const primaryCsmSelected = parseMulti(searchParams.get('primary_csm'))
  const csmStandingSelected = parseMulti(searchParams.get('csm_standing'))
  const npsStandingSelected = parseMulti(searchParams.get('nps_standing'))
  const trustpilotSelected = parseMulti(searchParams.get('trustpilot'))
  const countrySelected = parseMulti(searchParams.get('country'))
  const accountabilitySelected = parseMulti(searchParams.get('accountability'))
  const npsToggleSelected = parseMulti(searchParams.get('nps_toggle'))
  const needsReviewSelected =
    searchParams.get('needs_review') === '1' ? ['1'] : []
  const missingSlackSelected =
    searchParams.get('missing_slack') === '1' ? ['1'] : []

  const primaryCsmDropdownOptions = primaryCsmOptions.map((o) => ({
    value: o.id,
    label: o.label,
  }))

  const countryDropdownOptions = countryOptions.map((c) => ({
    value: c,
    label: c,
  }))

  function writeParams(updater: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString())
    updater(params)
    const queryString = params.toString()
    router.replace(queryString ? `${pathname}?${queryString}` : pathname)
  }

  function setStatus(values: string[]) {
    writeParams((params) => {
      if (values.length === 0) {
        // Explicit-empty sentinel: user unchecked everything. Don't
        // collapse to "absent" (which would re-apply the default trio).
        params.set('status', '')
      } else if (isStatusDefault(values)) {
        params.delete('status')
      } else {
        params.set('status', values.join(','))
      }
    })
  }

  function setMulti(key: string, values: string[]) {
    writeParams((params) => {
      if (values.length === 0) params.delete(key)
      else params.set(key, values.join(','))
    })
  }

  function setNeedsReview(values: string[]) {
    writeParams((params) => {
      if (values.includes('1')) params.set('needs_review', '1')
      else params.delete('needs_review')
    })
  }

  function setMissingSlack(values: string[]) {
    writeParams((params) => {
      if (values.includes('1')) params.set('missing_slack', '1')
      else params.delete('missing_slack')
    })
  }

  function clearAll() {
    // Preserve sort/dir AND the active search query — spec § Piece 3:
    // "preserve search since search is a different concern from
    // filters." Drop everything else (status back to default means
    // absent param, not the explicit-empty sentinel — so clear brings
    // the user back to the natural default state). The search-state
    // mirror in `searchValue` stays untouched, so the input keeps its
    // value while the rest of the filter chips empty out.
    const sort = searchParams.get('sort')
    const dir = searchParams.get('dir')
    const q = searchParams.get('q')
    const next = new URLSearchParams()
    if (sort) next.set('sort', sort)
    if (dir) next.set('dir', dir)
    if (q) next.set('q', q)
    const queryString = next.toString()
    router.replace(queryString ? `${pathname}?${queryString}` : pathname)
  }

  const hasAnyFilter =
    searchValue.length > 0 ||
    // Status is non-default when the param is present at all (the
    // setStatus collapse above guarantees we never write the default
    // trio verbatim — so any presence indicates explicit divergence).
    searchParams.has('status') ||
    primaryCsmSelected.length > 0 ||
    csmStandingSelected.length > 0 ||
    npsStandingSelected.length > 0 ||
    trustpilotSelected.length > 0 ||
    countrySelected.length > 0 ||
    accountabilitySelected.length > 0 ||
    npsToggleSelected.length > 0 ||
    needsReviewSelected.length > 0 ||
    missingSlackSelected.length > 0

  return (
    <div
      className="flex flex-wrap items-center gap-2.5"
      style={{
        padding: '14px 0 18px',
        borderTop: '1px solid var(--color-geg-border)',
      }}
    >
      <input
        type="text"
        placeholder="Search by name or email…"
        value={searchValue}
        onChange={(event) => setSearchValue(event.target.value)}
        className="geg-filter-input"
      />
      {hasAnyFilter ? (
        <Button
          variant="outline"
          size="sm"
          onClick={clearAll}
          className="geg-mono"
          style={{
            fontSize: 11,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            background: 'transparent',
            color: 'var(--color-geg-text-2)',
            borderColor: 'var(--color-geg-border-strong)',
          }}
        >
          Clear filters
        </Button>
      ) : null}
      <div className="flex flex-wrap items-center gap-2.5">
        <MultiSelectDropdown
          label="Status"
          options={STATUS_OPTIONS}
          selected={statusSelected}
          onChange={setStatus}
        />
        <MultiSelectDropdown
          label="Primary CSM"
          options={primaryCsmDropdownOptions}
          selected={primaryCsmSelected}
          onChange={(values) => setMulti('primary_csm', values)}
        />
        <MultiSelectDropdown
          label="CSM Standing"
          options={CSM_STANDING_OPTIONS}
          selected={csmStandingSelected}
          onChange={(values) => setMulti('csm_standing', values)}
        />
        <MultiSelectDropdown
          label="NPS Standing"
          options={NPS_STANDING_OPTIONS}
          selected={npsStandingSelected}
          onChange={(values) => setMulti('nps_standing', values)}
        />
        <MultiSelectDropdown
          label="Trustpilot"
          options={TRUSTPILOT_OPTIONS}
          selected={trustpilotSelected}
          onChange={(values) => setMulti('trustpilot', values)}
        />
        <MultiSelectDropdown
          label="Needs review"
          options={NEEDS_REVIEW_OPTIONS}
          selected={needsReviewSelected}
          onChange={setNeedsReview}
          mode="toggle"
        />
        <MultiSelectDropdown
          label="Missing Slack"
          options={MISSING_SLACK_OPTIONS}
          selected={missingSlackSelected}
          onChange={setMissingSlack}
          mode="toggle"
        />
        <MultiSelectDropdown
          label="Accountability"
          options={TOGGLE_OPTIONS}
          selected={accountabilitySelected}
          onChange={(values) => setMulti('accountability', values)}
        />
        <MultiSelectDropdown
          label="NPS toggle"
          options={TOGGLE_OPTIONS}
          selected={npsToggleSelected}
          onChange={(values) => setMulti('nps_toggle', values)}
        />
        <MultiSelectDropdown
          label="Country"
          options={countryDropdownOptions}
          selected={countrySelected}
          onChange={(values) => setMulti('country', values)}
        />
      </div>
    </div>
  )
}
