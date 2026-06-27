'use client'

import { useRouter } from 'next/navigation'
import { useTransition, type ChangeEvent } from 'react'

// Campaign dropdown for the Outbound page. Options: "All" (default — aggregates
// every campaign's pool) + one per registry row (Revival, Jacob, …). Selecting
// one sets ?campaign=<key> (or clears it for All) and re-renders the funnel for
// that pool. Switching resets the date window to the selected campaign's default.
const selectStyle = {
  fontSize: 11,
  letterSpacing: '0.06em',
  textTransform: 'uppercase',
  color: 'var(--color-geg-text)',
  background: 'var(--color-geg-bg-elev)',
  border: '1px solid var(--color-geg-border-strong)',
  borderRadius: 6,
  padding: '6px 12px',
  cursor: 'pointer',
  fontWeight: 600,
} as const

export function OutboundCampaignSwitcher({
  campaigns,
  active,
}: {
  campaigns: Array<{ key: string; label: string }>
  active: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function onChange(e: ChangeEvent<HTMLSelectElement>) {
    const key = e.target.value
    const href =
      key === 'all'
        ? '/sales-dashboard/outbound'
        : `/sales-dashboard/outbound?campaign=${encodeURIComponent(key)}`
    startTransition(() => router.push(href))
  }

  return (
    <select
      value={active}
      onChange={onChange}
      className="geg-mono"
      aria-label="Outbound campaign"
      style={{ ...selectStyle, opacity: pending ? 0.6 : 1 }}
    >
      <option value="all">All campaigns</option>
      {campaigns.map((c) => (
        <option key={c.key} value={c.key}>
          {c.label}
        </option>
      ))}
    </select>
  )
}
