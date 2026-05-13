// Pills + badges for the Ella runs audit dashboard.
//
// Part 2 cleanup: AnomalyFlagBadge / AnomalyFlagsRow / FLAG_CLASSES /
// FLAG_SHORT removed — the redesign doesn't surface anomalies in the
// UI (data layer still computes them for future alert-source work).
// ANOMALY_FLAG_LABEL import dropped because nothing in this file uses
// it anymore.

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const ROLE_CLASSES: Record<string, string> = {
  client: 'bg-sky-100 text-sky-900 border-sky-200',
  advisor: 'bg-violet-100 text-violet-900 border-violet-200',
  unresolvable: 'bg-zinc-100 text-zinc-700 border-zinc-200',
  unknown: 'bg-zinc-100 text-zinc-500 border-zinc-200',
}

export function RolePill({ role }: { role: string | null }) {
  const r = role ?? 'unknown'
  const cls = ROLE_CLASSES[r] ?? ROLE_CLASSES.unknown
  return <Badge className={cn('border font-normal', cls)}>{r}</Badge>
}

const STATUS_CLASSES: Record<string, string> = {
  success: 'bg-emerald-100 text-emerald-900 border-emerald-200',
  escalated: 'bg-amber-100 text-amber-900 border-amber-200',
  error: 'bg-rose-100 text-rose-900 border-rose-200',
  skipped: 'bg-zinc-100 text-zinc-700 border-zinc-200',
}

export function RunStatusPill({ status }: { status: string }) {
  const cls = STATUS_CLASSES[status] ?? 'bg-zinc-100 text-zinc-700 border-zinc-200'
  return <Badge className={cn('border', cls)}>{status}</Badge>
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
