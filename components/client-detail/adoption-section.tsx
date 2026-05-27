'use client'

// Section 6 — Adoption & Programs.
//
// Two enum fields, two three-state booleans, two boolean toggles
// (M5.6: accountability_enabled, nps_enabled — cascade-owned for
// negative-status transitions), plus the Upsells list (read-only).
// Enums and booleans edit via the generic EditableField → updateClientField
// path with type-narrowing in the Server Action.
//
// The two M5.6 toggles ride on a small custom BooleanToggleField — they
// need an active+off warning hint that EditableField doesn't support
// (the warning depends on a sibling field, status, which the generic
// EditableField doesn't see). The hint surfaces the case where a client
// was previously in a negative status (cascade flipped accountability
// or NPS off) and has since reactivated to active without the CSM
// flipping the toggles back on — an easy-to-miss footgun.

import { useState, useTransition } from 'react'
import type { ClientDetail } from '@/lib/db/clients'
import { TRUSTPILOT_OPTIONS } from '@/lib/client-vocab'
import { cn } from '@/lib/utils'
import { Section, Subsection } from './section'
import { EditableField } from './editable-field'
import { updateClientField } from '@/app/(authenticated)/(fulfillment)/clients/[id]/actions'

const GHL_OPTIONS = [
  { value: 'never_adopted', label: 'Never adopted' },
  { value: 'affiliate', label: 'Affiliate' },
  { value: 'saas', label: 'SaaS' },
  { value: 'inactive', label: 'Inactive' },
]

type Upsell = ClientDetail['upsells'][number]

function formatDollars(value: number | string | null): string | null {
  if (value === null || value === undefined || value === '') return null
  const n = typeof value === 'string' ? parseFloat(value) : value
  if (Number.isNaN(n)) return null
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

// Two-state toggle with the M5.6 active+off warning hint. When the
// client is currently active AND this toggle is off, render an amber
// border + ⚠ icon + title-tooltip so the CSM notices that the cascade
// previously turned this off (during a paused/ghost stretch) and has
// not been turned back on after reactivation. Same amber palette as
// the needs_review pill (pills.tsx) — reusing rather than introducing
// a new warning-color convention.
function BooleanToggleField({
  label,
  value,
  warn,
  warnTooltip,
  onSave,
}: {
  label: string
  value: boolean
  warn: boolean
  warnTooltip: string
  onSave: (
    next: boolean,
  ) => Promise<{ success: true } | { success: false; error: string }>
}) {
  const [committed, setCommitted] = useState(value)
  const [error, setError] = useState<string | undefined>()
  const [isPending, startTransition] = useTransition()

  function toggle() {
    const next = !committed
    setError(undefined)
    setCommitted(next)
    startTransition(async () => {
      const result = await onSave(next)
      if (!result.success) {
        setCommitted(!next)
        setError(result.error)
      }
    })
  }

  return (
    <div className="space-y-1">
      <div className="text-sm font-medium text-muted-foreground">{label}</div>
      <button
        type="button"
        onClick={toggle}
        disabled={isPending}
        title={warn ? warnTooltip : undefined}
        aria-pressed={committed}
        className={cn(
          'inline-flex h-7 items-center gap-2 rounded-full border px-3 text-xs font-medium transition-colors',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          isPending && 'opacity-60 cursor-progress',
          committed
            ? 'bg-emerald-100 text-emerald-900 border-emerald-200'
            : warn
              ? 'bg-amber-100 text-amber-900 border-amber-300'
              : 'bg-zinc-100 text-zinc-700 border-zinc-200',
        )}
      >
        {warn ? <span aria-hidden>⚠</span> : null}
        <span>{committed ? 'On' : 'Off'}</span>
      </button>
      {error ? (
        <p className="text-xs text-rose-700">{error}</p>
      ) : null}
    </div>
  )
}

function UpsellsList({ upsells }: { upsells: Upsell[] }) {
  if (upsells.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">No upsells recorded.</p>
    )
  }
  return (
    <ul className="space-y-2">
      {upsells.map((upsell) => {
        const amount = formatDollars(upsell.amount)
        const soldAt = upsell.sold_at
          ? new Date(upsell.sold_at).toLocaleDateString()
          : null
        return (
          <li key={upsell.id} className="flex items-baseline gap-3 text-sm">
            <span className="text-muted-foreground tabular-nums w-28 shrink-0">
              {soldAt ?? '—'}
            </span>
            <span className="flex-1">
              {upsell.product ?? upsell.notes ?? '(unspecified)'}
            </span>
            <span className="text-sm tabular-nums">{amount ?? '—'}</span>
          </li>
        )
      })}
    </ul>
  )
}

export function AdoptionSection({ client }: { client: ClientDetail }) {
  return (
    <Section title="Adoption & Programs">
      <div className="grid grid-cols-2 gap-4">
        <EditableField
          label="Trustpilot status"
          value={client.trustpilot_status}
          variant="enum"
          options={TRUSTPILOT_OPTIONS}
          onSave={(v) =>
            updateClientField(
              client.id,
              'trustpilot_status',
              v as string | null,
            )
          }
        />
        <EditableField
          label="GHL adoption"
          value={client.ghl_adoption}
          variant="enum"
          options={GHL_OPTIONS}
          onSave={(v) =>
            updateClientField(
              client.id,
              'ghl_adoption',
              v as string | null,
            )
          }
        />
        <EditableField
          label="Sales group candidate"
          value={client.sales_group_candidate}
          variant="three_state_bool"
          onSave={(v) =>
            updateClientField(
              client.id,
              'sales_group_candidate',
              v as boolean | null,
            )
          }
        />
        <EditableField
          label="DFY setting"
          value={client.dfy_setting}
          variant="three_state_bool"
          onSave={(v) =>
            updateClientField(
              client.id,
              'dfy_setting',
              v as boolean | null,
            )
          }
        />
        <BooleanToggleField
          label="Accountability enabled"
          value={client.accountability_enabled}
          warn={
            client.status === 'active' && client.accountability_enabled === false
          }
          warnTooltip="This was auto-disabled when the client was previously in a negative status (paused / ghost / leave / churned). Toggle on if accountability should resume now that the client is active again."
          onSave={(v) =>
            updateClientField(client.id, 'accountability_enabled', v)
          }
        />
        <BooleanToggleField
          label="NPS enabled"
          value={client.nps_enabled}
          warn={client.status === 'active' && client.nps_enabled === false}
          warnTooltip="This was auto-disabled when the client was previously in a negative status (paused / ghost / leave / churned). Toggle on if NPS surveys should resume now that the client is active again."
          onSave={(v) => updateClientField(client.id, 'nps_enabled', v)}
        />
      </div>

      <Subsection title={`Upsells (${client.upsells.length})`}>
        <UpsellsList upsells={client.upsells} />
      </Subsection>
    </Section>
  )
}
