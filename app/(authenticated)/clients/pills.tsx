// Vocab → editorial pill mappings for the Clients surfaces.
//
// All pills share the GegPill primitive; this file's job is the
// (vocab string → tier + label) lookup. Centralized so the Clients
// list table and detail page render identical pills for the same data.
//
// Tier mappings come from the Clients Redesign mock § 2 — see the
// "Pill tier mappings" handoff table. Status:
//   active=pos, paused/ghost=warn, leave=muted, churned=neg
// CSM standing:
//   happy/content=pos, at_risk=warn, problem=neg
// NPS standing:
//   promoter=pos, neutral=warn, at_risk=neg
// Trustpilot:
//   yes=pos, ask=warn, asked=gold, no=neg (no spec — kept readable)
//
// Journey stage stays as a muted pill — the labels are long and don't
// carry a sentiment, so the muted treatment matches the mock's intent
// (filter-only, neutral visual).

import { GegPill, type GegPillTier } from '@/components/gregory/geg-pill'
import { JOURNEY_STAGE_LABEL } from '@/lib/client-vocab'

// ----- Status -------------------------------------------------------------

const STATUS_TIER: Record<string, GegPillTier> = {
  active: 'pos',
  paused: 'warn',
  ghost: 'warn',
  leave: 'muted',
  churned: 'neg',
}
const STATUS_LABEL: Record<string, string> = {
  active: 'Active',
  paused: 'Paused',
  ghost: 'Ghost',
  leave: 'Leave',
  churned: 'Churned',
}

export function StatusPill({ status }: { status: string }) {
  const tier = STATUS_TIER[status] ?? 'muted'
  const label = STATUS_LABEL[status] ?? status
  return <GegPill tier={tier} label={label} />
}

// ----- CSM standing -------------------------------------------------------

const CSM_STANDING_TIER: Record<string, GegPillTier> = {
  happy: 'pos',
  content: 'pos',
  at_risk: 'warn',
  problem: 'neg',
}
const CSM_STANDING_LABEL: Record<string, string> = {
  happy: 'Happy',
  content: 'Content',
  at_risk: 'At risk',
  problem: 'Problem',
}

export function CsmStandingPill({ standing }: { standing: string | null }) {
  if (!standing) return <span className="text-muted-foreground">—</span>
  const tier = CSM_STANDING_TIER[standing] ?? 'muted'
  const label = CSM_STANDING_LABEL[standing] ?? standing
  return <GegPill tier={tier} label={label} />
}

// ----- NPS standing -------------------------------------------------------

const NPS_STANDING_TIER: Record<string, GegPillTier> = {
  promoter: 'pos',
  neutral: 'warn',
  at_risk: 'neg',
}
const NPS_STANDING_LABEL: Record<string, string> = {
  promoter: 'Promoter',
  neutral: 'Neutral',
  at_risk: 'At Risk',
}

export function NpsStandingPill({ standing }: { standing: string | null }) {
  if (!standing) return <span className="text-muted-foreground">—</span>
  const tier = NPS_STANDING_TIER[standing] ?? 'muted'
  const label = NPS_STANDING_LABEL[standing] ?? standing
  return <GegPill tier={tier} label={label} />
}

// ----- Trustpilot ---------------------------------------------------------

const TRUSTPILOT_TIER: Record<string, GegPillTier> = {
  yes: 'pos',
  ask: 'warn',
  asked: 'gold',
  no: 'neg',
}
const TRUSTPILOT_LABEL: Record<string, string> = {
  yes: 'Yes',
  no: 'No',
  ask: 'Ask',
  asked: 'Asked',
}

export function TrustpilotPill({ status }: { status: string | null }) {
  if (!status) return <span className="text-muted-foreground">—</span>
  const tier = TRUSTPILOT_TIER[status] ?? 'muted'
  const label = TRUSTPILOT_LABEL[status] ?? status
  return <GegPill tier={tier} label={label} />
}

// ----- Journey stage ------------------------------------------------------

export function JourneyStagePill({ stage }: { stage: string | null }) {
  if (!stage) return <span className="text-muted-foreground">—</span>
  const label = JOURNEY_STAGE_LABEL[stage] ?? stage
  return <GegPill tier="muted" label={label} />
}

// ----- Needs-review (legacy — kept for detail page header) ----------------

export function NeedsReviewPill() {
  return <GegPill tier="warn" label="Needs review" />
}

// ----- Missing-Slack badges ----------------------------------------------
//
// Two distinct warn pills surfaced on /clients and /clients/[id] when a
// client lacks `slack_channel_id` or `slack_user_id`. Computed read-time;
// no stored state. Independent of `needs_review` — a legacy client with
// broken Slack data shows missing-Slack but not needs_review.
// Spec: docs/specs/auto-created-client-lifecycle.md § Missing-Slack badges.

export function MissingSlackChannelPill() {
  return <GegPill tier="warn" label="Missing Slack channel" />
}

export function MissingSlackUserPill() {
  return <GegPill tier="warn" label="Missing Slack user" />
}

// ----- Tags list ----------------------------------------------------------

export function TagsList({ tags }: { tags: string[] }) {
  if (!tags.length) return <span className="text-muted-foreground">—</span>
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => {
        const isReview = tag === 'needs_review'
        return (
          <GegPill
            key={tag}
            tier={isReview ? 'warn' : 'muted'}
            label={tag}
          />
        )
      })}
    </div>
  )
}
