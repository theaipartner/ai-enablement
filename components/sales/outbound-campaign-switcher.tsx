'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'

// Segmented switcher for the Outbound page's campaign pools (Revival, Jacob, …).
// Each option is a registry row (outbound_campaigns); selecting one sets
// ?campaign=<key> and re-renders the funnel for that pool.
export function OutboundCampaignSwitcher({
  campaigns,
  active,
}: {
  campaigns: Array<{ key: string; label: string }>
  active: string
}) {
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  if (campaigns.length < 2) return null

  return (
    <div
      style={{
        display: 'inline-flex',
        gap: 2,
        padding: 3,
        borderRadius: 8,
        border: '1px solid var(--color-geg-border)',
        background: 'var(--color-geg-bg-elev)',
        opacity: pending ? 0.6 : 1,
      }}
    >
      {campaigns.map((c) => {
        const isActive = c.key === active
        return (
          <button
            key={c.key}
            type="button"
            onClick={() =>
              startTransition(() =>
                router.push(`/sales-dashboard/outbound?campaign=${encodeURIComponent(c.key)}`),
              )
            }
            className="geg-mono"
            style={{
              cursor: 'pointer',
              fontSize: 11,
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              padding: '6px 14px',
              borderRadius: 6,
              border: 'none',
              background: isActive ? 'var(--color-geg-accent-fill)' : 'transparent',
              color: isActive ? 'var(--color-geg-text)' : 'var(--color-geg-text-3)',
              fontWeight: isActive ? 600 : 400,
            }}
          >
            {c.label}
          </button>
        )
      })}
    </div>
  )
}
