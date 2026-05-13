// Pills + relative-time helpers for the Ella runs audit dashboard.
//
// Switched from shadcn Badge to GegPill (editorial-dark theme) so both
// surfaces match the Calls + Clients pages. Roles map: client→pos,
// advisor→warn, unresolvable→muted, unknown→muted, system/ella→muted.
// Statuses map: success→pos, escalated→warn, error→neg, skipped→muted.
// Trigger-type pills (used on the detail page header) map to gold.

import { GegPill } from '@/components/gregory/geg-pill'

type Tier = 'pos' | 'warn' | 'neg' | 'muted' | 'gold'

const ROLE_TIER: Record<string, Tier> = {
  client: 'pos',
  advisor: 'warn',
  unresolvable: 'muted',
  unknown: 'muted',
  ella: 'muted',
  system: 'muted',
}

const ROLE_LABEL: Record<string, string> = {
  client: 'Client',
  advisor: 'Advisor',
  unresolvable: 'Unknown',
  unknown: 'Unknown',
  ella: 'System',
  system: 'System',
}

export function RolePill({ role }: { role: string | null }) {
  const r = role ?? 'unknown'
  const tier = ROLE_TIER[r] ?? 'muted'
  const label = ROLE_LABEL[r] ?? r
  return <GegPill tier={tier} label={label} />
}

const STATUS_TIER: Record<string, Tier> = {
  success: 'pos',
  escalated: 'warn',
  error: 'neg',
  skipped: 'muted',
}

const STATUS_LABEL: Record<string, string> = {
  success: 'Success',
  escalated: 'Escalated',
  error: 'Error',
  skipped: 'Skipped',
}

export function RunStatusPill({ status }: { status: string }) {
  const tier = STATUS_TIER[status] ?? 'muted'
  const label = STATUS_LABEL[status] ?? status
  return <GegPill tier={tier} label={label} />
}

// Trigger-type pill — gold accent for the detail page header.
const TRIGGER_LABEL: Record<string, string> = {
  slack_mention: '@-mention',
  app_mention: '@-mention',
  bare_mention: 'Bare @',
  passive_substantive: 'Passive response',
  passive_general_inquiry: 'Passive opener',
  passive_monitor: 'Passive monitor',
}

export function TriggerTypePill({ triggerType }: { triggerType: string }) {
  const label = TRIGGER_LABEL[triggerType] ?? triggerType.replace(/_/g, ' ')
  return <GegPill tier="gold" label={label} />
}

// Relative timestamp helper — short for recent, falls back to absolute date.
export function RelativeTime({ iso }: { iso: string }) {
  const now = new Date()
  const then = new Date(iso)
  const diffMs = now.getTime() - then.getTime()
  const diffMin = Math.floor(diffMs / 60_000)
  if (diffMin < 1) return <span title={iso}>just now</span>
  if (diffMin < 60) return <span title={iso}>{diffMin}m ago</span>
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return <span title={iso}>{diffHr}h ago</span>
  const diffDay = Math.floor(diffHr / 24)
  if (diffDay < 7) return <span title={iso}>{diffDay}d ago</span>
  return <span title={iso}>{then.toLocaleDateString()}</span>
}

// Two-line When cell — relative on top, absolute time of day below.
// Matches the mock's `.cell-when` two-line layout exactly.
export function CellWhen({ iso }: { iso: string }) {
  const then = new Date(iso)
  const now = new Date()
  const diffMs = now.getTime() - then.getTime()
  const diffMin = Math.floor(diffMs / 60_000)

  let rel: string
  if (diffMin < 1) rel = 'just now'
  else if (diffMin < 60) rel = `${diffMin} min ago`
  else {
    const diffHr = Math.floor(diffMin / 60)
    if (diffHr < 24) rel = `${diffHr} hr ago`
    else {
      const diffDay = Math.floor(diffHr / 24)
      if (diffDay < 7) rel = `${diffDay}d ago`
      else rel = then.toLocaleDateString()
    }
  }

  const abs = then.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
  })

  return (
    <span
      title={iso}
      className="geg-mono"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        lineHeight: 1.3,
        fontSize: 12,
        letterSpacing: '0.02em',
      }}
    >
      <span style={{ color: 'var(--color-geg-text)' }}>{rel}</span>
      <span
        style={{
          fontSize: 11,
          color: 'var(--color-geg-text-faint)',
        }}
      >
        {abs}
      </span>
    </span>
  )
}
