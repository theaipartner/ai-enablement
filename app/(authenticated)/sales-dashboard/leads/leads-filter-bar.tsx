'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { LeadFilterType, FunnelStage } from '@/lib/db/leads-funnel'

// Leads filter bar. Two controls, all URL-driven (so shareable + preserved by
// the per-lead back button, and set by the Funnel page's stage links):
//   - Lead type direct / opt-in / reactivation  (multi-select; 'direct' includes
//               reactivation as a subset, matching the Direct funnel)
//   - Stage     connected → booked → [confirmed] → showed → closed  (single,
//               CUMULATIVE: picking Showed includes Closed. Confirmed only shows
//               when Direct is selected.)
// (The old all/unique View toggle was removed 2026-06-05 — the cohort is now
// unique NEW opt-ins only, so the toggle had nothing to switch.)

const TYPE_OPTS: { id: LeadFilterType; label: string; color: string }[] = [
  { id: 'direct', label: 'Direct', color: 'var(--color-geg-pos)' },
  { id: 'setter', label: 'Opt-in', color: 'var(--color-geg-warn)' },
  { id: 'reactivation', label: 'Reactivation', color: '#7ea8dd' },
]

const STAGE_OPTS: { id: FunnelStage; label: string; directOnly?: boolean }[] = [
  { id: 'connected', label: 'Connected' },
  { id: 'booked', label: 'Booked' },
  { id: 'confirmed', label: 'Confirmed', directOnly: true },
  { id: 'showed', label: 'Showed' },
  { id: 'closed', label: 'Closed' },
]

export function LeadsFilterBar({
  types,
  stage,
}: {
  types: LeadFilterType[]
  stage: FunnelStage | null
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function push(mutate: (sp: URLSearchParams) => void) {
    const sp = new URLSearchParams(params.toString())
    mutate(sp)
    const qs = sp.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  const toggleType = (t: LeadFilterType) =>
    push((sp) => {
      const next = new Set(types)
      if (next.has(t)) next.delete(t)
      else next.add(t)
      if (next.size === 0) sp.delete('type')
      else sp.set('type', Array.from(next).join(','))
      // Confirmed is direct-only — drop it if Direct is no longer selected.
      if (stage === 'confirmed' && !next.has('direct')) sp.delete('stage')
    })

  const toggleStage = (s: FunnelStage) =>
    push((sp) => (stage === s ? sp.delete('stage') : sp.set('stage', s)))

  const showConfirmed = types.includes('direct')

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 18 }}>
      <Group label="Type">
        <div style={{ display: 'inline-flex', gap: 6 }}>
          {TYPE_OPTS.map((o) => (
            <Chip key={o.id} label={o.label} active={types.includes(o.id)} color={o.color} onClick={() => toggleType(o.id)} />
          ))}
        </div>
      </Group>

      <Group label="Reached">
        <div style={{ display: 'inline-flex', gap: 6 }}>
          {STAGE_OPTS.filter((o) => !o.directOnly || showConfirmed).map((o) => (
            <Chip key={o.id} label={o.label} active={stage === o.id} color="var(--color-geg-accent)" onClick={() => toggleStage(o.id)} />
          ))}
        </div>
      </Group>
    </div>
  )
}

function Group({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
        {label}
      </span>
      {children}
    </div>
  )
}

function Chip({ label, active, color, onClick }: { label: string; active: boolean; color: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="geg-mono"
      style={{
        cursor: 'pointer',
        padding: '5px 11px',
        fontSize: 10,
        letterSpacing: '0.06em',
        textTransform: 'uppercase',
        borderRadius: 5,
        border: `1px solid ${active ? color : 'var(--color-geg-border)'}`,
        background: active ? 'color-mix(in srgb, ' + color + ' 12%, transparent)' : 'transparent',
        color: active ? color : 'var(--color-geg-text-3)',
      }}
    >
      {label}
    </button>
  )
}
