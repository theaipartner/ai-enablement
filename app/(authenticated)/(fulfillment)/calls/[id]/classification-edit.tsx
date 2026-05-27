'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  SearchableClientSelect,
} from '@/components/searchable-client-select'
import type { CandidateClient } from '@/lib/db/merge'
import { cn } from '@/lib/utils'
import { updateCallClassificationAction } from './actions'

const CATEGORY_OPTIONS = [
  { value: 'client', label: 'Client' },
  { value: 'internal', label: 'Internal' },
  { value: 'external', label: 'External' },
  { value: 'unclassified', label: 'Unclassified' },
  { value: 'excluded', label: 'Excluded' },
]

const CALL_TYPE_OPTIONS = [
  { value: '', label: '(Unset)' },
  { value: 'sales', label: 'Sales' },
  { value: 'onboarding', label: 'Onboarding' },
  { value: 'csm_check_in', label: 'CSM check-in' },
  { value: 'coaching', label: 'Coaching' },
  { value: 'team_sync', label: 'Team sync' },
  { value: 'leadership', label: 'Leadership' },
  { value: 'strategy', label: 'Strategy' },
  { value: 'unknown', label: 'Unknown' },
]

const CATEGORY_CLASSES: Record<string, string> = {
  client: 'bg-emerald-100 text-emerald-900 border-emerald-200',
  internal: 'bg-sky-100 text-sky-900 border-sky-200',
  external: 'bg-zinc-100 text-zinc-700 border-zinc-200',
  unclassified: 'bg-amber-100 text-amber-900 border-amber-200',
  excluded: 'bg-rose-100 text-rose-900 border-rose-200',
}

function CategoryPill({ category }: { category: string }) {
  const cls =
    CATEGORY_CLASSES[category] ?? 'bg-zinc-100 text-zinc-700 border-zinc-200'
  return <Badge className={cn('border font-normal', cls)}>{category}</Badge>
}

function ConfidenceBadge({ value }: { value: number | null }) {
  if (value === null) return <span className="text-muted-foreground">—</span>
  const cls =
    value < 0.5
      ? 'text-rose-700'
      : value < 0.7
        ? 'text-amber-700'
        : 'text-emerald-700'
  return (
    <span className={cn('tabular-nums font-medium', cls)}>
      {value.toFixed(2)}
    </span>
  )
}

export type ClassificationEditCall = {
  id: string
  call_category: string
  call_type: string | null
  primary_client_id: string | null
  primary_client: { id: string; full_name: string } | null
  classification_confidence: number | null
  classification_method: string | null
  is_retrievable_by_client_agents: boolean
}

export function ClassificationEdit({
  call,
  clientOptions,
}: {
  call: ClassificationEditCall
  clientOptions: CandidateClient[]
}) {
  const [editing, setEditing] = useState(false)
  const [pendingCategory, setPendingCategory] = useState(call.call_category)
  const [pendingCallType, setPendingCallType] = useState(call.call_type ?? '')
  const [pendingPrimaryClientId, setPendingPrimaryClientId] = useState<
    string | null
  >(call.primary_client_id)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function startEdit() {
    setPendingCategory(call.call_category)
    setPendingCallType(call.call_type ?? '')
    setPendingPrimaryClientId(call.primary_client_id)
    setError(null)
    setEditing(true)
  }

  function cancelEdit() {
    setEditing(false)
    setError(null)
  }

  function save() {
    setError(null)

    // Build a diff of fields that differ from the initial call values.
    // Empty strings on call_type translate to null (server expects
    // null for "unset"). primary_client_id passes null when category
    // is non-client; the function would also auto-clear server-side,
    // but sending the explicit null produces a cleaner audit trail
    // since the user's pending state is the truth.
    const changes: Partial<Record<string, string | null>> = {}

    if (pendingCategory !== call.call_category) {
      changes.call_category = pendingCategory
    }

    const normalizedCallType = pendingCallType === '' ? null : pendingCallType
    if (normalizedCallType !== call.call_type) {
      changes.call_type = normalizedCallType
    }

    // When pending category is non-client, force primary_client_id to
    // null in the diff regardless of what the picker held. The server
    // enforces this too, so this is belt-and-suspenders.
    const effectivePrimary =
      pendingCategory === 'client' ? pendingPrimaryClientId : null
    if (effectivePrimary !== call.primary_client_id) {
      changes.primary_client_id = effectivePrimary
    }

    if (Object.keys(changes).length === 0) {
      setEditing(false)
      return
    }

    startTransition(async () => {
      const result = await updateCallClassificationAction(call.id, changes)
      if (result.success) {
        setEditing(false)
        router.refresh()
      } else {
        setError(result.error)
      }
    })
  }

  if (!editing) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Category</Label>
            <div>
              <CategoryPill category={call.call_category} />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Call type</Label>
            <p className="text-sm">
              {call.call_type ?? <span className="text-muted-foreground">(unset)</span>}
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Primary client</Label>
            <p className="text-sm">
              {call.primary_client ? (
                <Link
                  href={`/clients/${call.primary_client.id}`}
                  className="hover:underline underline-offset-4"
                >
                  {call.primary_client.full_name}
                </Link>
              ) : (
                <span className="text-muted-foreground">—</span>
              )}
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Confidence</Label>
            <p className="text-sm">
              <ConfidenceBadge value={call.classification_confidence} />
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Method</Label>
            <p className="text-sm">
              {call.classification_method ?? <span className="text-muted-foreground">—</span>}
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Retrievable by client agents</Label>
            <p className="text-sm">
              {call.is_retrievable_by_client_agents ? (
                <span className="text-emerald-700">Yes</span>
              ) : (
                <span className="text-muted-foreground">No</span>
              )}
            </p>
          </div>
        </div>
        <div className="pt-1">
          <Button variant="outline" size="sm" onClick={startEdit}>
            Edit classification
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1.5">
          <Label htmlFor="category">Category</Label>
          <select
            id="category"
            value={pendingCategory}
            onChange={(event) => setPendingCategory(event.target.value)}
            disabled={isPending}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {CATEGORY_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="call_type">Call type</Label>
          <select
            id="call_type"
            value={pendingCallType}
            onChange={(event) => setPendingCallType(event.target.value)}
            disabled={isPending}
            className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
          >
            {CALL_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Confidence (read-only)</Label>
          <p className="text-sm">
            <ConfidenceBadge value={call.classification_confidence} />
          </p>
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs text-muted-foreground">Method (read-only)</Label>
          <p className="text-sm text-muted-foreground">
            Will set to <strong>manual</strong> on save.
          </p>
        </div>
      </div>

      {pendingCategory === 'client' ? (
        <div className="space-y-1.5">
          <Label>
            Primary client{' '}
            <span className="text-rose-700">(required when category=client)</span>
          </Label>
          <SearchableClientSelect
            candidates={clientOptions}
            value={pendingPrimaryClientId}
            onChange={setPendingPrimaryClientId}
          />
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Primary client will be auto-cleared when category is not <strong>client</strong>.
        </p>
      )}

      {error ? <p className="text-sm text-rose-700">Error: {error}</p> : null}

      <div className="flex gap-2 pt-2">
        <Button
          onClick={save}
          disabled={
            isPending ||
            (pendingCategory === 'client' && !pendingPrimaryClientId)
          }
        >
          {isPending ? 'Saving…' : 'Save changes'}
        </Button>
        <Button variant="outline" onClick={cancelEdit} disabled={isPending}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
