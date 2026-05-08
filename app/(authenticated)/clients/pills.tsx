// Small server-renderable pill helpers for the Clients table.
// Status / journey-stage / tags / needs-review treatments live here so
// the table and detail page render them identically.

import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'

const STATUS_CLASSES: Record<string, string> = {
  active: 'bg-emerald-100 text-emerald-900 border-emerald-200',
  paused: 'bg-amber-100 text-amber-900 border-amber-200',
  ghost: 'bg-zinc-100 text-zinc-700 border-zinc-200',
  leave: 'bg-slate-200 text-slate-800 border-slate-300',
  churned: 'bg-rose-100 text-rose-900 border-rose-200',
}

export function StatusPill({ status }: { status: string }) {
  const cls = STATUS_CLASSES[status] ?? 'bg-zinc-100 text-zinc-700 border-zinc-200'
  return <Badge className={cn('border', cls)}>{status}</Badge>
}

export function JourneyStagePill({ stage }: { stage: string | null }) {
  if (!stage) return <span className="text-muted-foreground">—</span>
  return (
    <Badge variant="outline" className="font-normal">
      {stage}
    </Badge>
  )
}

const NEEDS_REVIEW_CLASSES =
  'bg-amber-100 text-amber-900 border-amber-200 font-medium'

export function TagsList({ tags }: { tags: string[] }) {
  if (!tags.length) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => {
        const isReview = tag === 'needs_review'
        return (
          <Badge
            key={tag}
            className={cn(
              'border font-normal',
              isReview
                ? NEEDS_REVIEW_CLASSES
                : 'bg-zinc-100 text-zinc-700 border-zinc-200',
            )}
          >
            {tag}
          </Badge>
        )
      })}
    </div>
  )
}

// Standalone pill rendered alongside Status / Journey on the detail
// page header for clients carrying the needs_review tag. The list view
// already surfaces this via TagsList; the detail header gives it a
// second, more prominent rendering since reviewers will land here from
// the "Auto-created (needs review)" filter chip.
export function NeedsReviewPill() {
  return (
    <Badge className={cn('border', NEEDS_REVIEW_CLASSES)}>
      needs review
    </Badge>
  )
}

// Clients list V2 column swap (2026-05-08). Shape + palette mirrors
// StatusPill above so the row reads as a coherent strip of pills.
// Labels MUST match lib/client-vocab.ts NPS_STANDING_OPTIONS labels
// — filter dropdown and table cell render identical strings for the
// same data.

const NPS_STANDING_CLASSES: Record<string, string> = {
  promoter: 'bg-emerald-100 text-emerald-900 border-emerald-200',
  neutral: 'bg-amber-100 text-amber-900 border-amber-200',
  at_risk: 'bg-rose-100 text-rose-900 border-rose-200',
}

const NPS_STANDING_LABELS: Record<string, string> = {
  promoter: 'Promoter',
  neutral: 'Neutral',
  at_risk: 'At Risk',
}

export function NpsStandingPill({ standing }: { standing: string | null }) {
  if (!standing) return <span className="text-muted-foreground">—</span>
  const cls =
    NPS_STANDING_CLASSES[standing] ??
    'bg-zinc-100 text-zinc-700 border-zinc-200'
  const label = NPS_STANDING_LABELS[standing] ?? standing
  return <Badge className={cn('border', cls)}>{label}</Badge>
}

// Trustpilot pill — distinct sky/blue treatment on 'asked' so the four
// states are visually distinguishable at a glance (Given=emerald,
// Declined=rose, Ask=amber, Asked=sky). Labels match
// lib/client-vocab.ts TRUSTPILOT_OPTIONS labels exactly.

const TRUSTPILOT_CLASSES: Record<string, string> = {
  yes: 'bg-emerald-100 text-emerald-900 border-emerald-200',
  no: 'bg-rose-100 text-rose-900 border-rose-200',
  ask: 'bg-amber-100 text-amber-900 border-amber-200',
  asked: 'bg-sky-100 text-sky-900 border-sky-200',
}

const TRUSTPILOT_LABELS: Record<string, string> = {
  yes: 'Yes',
  no: 'No',
  ask: 'Ask',
  asked: 'Asked',
}

export function TrustpilotPill({ status }: { status: string | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>
  const cls =
    TRUSTPILOT_CLASSES[status] ?? 'bg-zinc-100 text-zinc-700 border-zinc-200'
  const label = TRUSTPILOT_LABELS[status] ?? status
  return <Badge className={cn('border', cls)}>{label}</Badge>
}
