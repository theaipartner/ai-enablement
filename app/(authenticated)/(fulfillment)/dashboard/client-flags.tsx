'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { SearchableClientSelect } from '@/components/searchable-client-select'
import type { CandidateClient } from '@/lib/db/merge'
import type {
  GhostClientFlag,
  NeedsReviewClient,
} from '@/lib/db/fulfillment-dashboard'
import {
  dashboardArchiveNeedsReviewAction,
  dashboardClearNeedsReviewAction,
  dashboardDismissGhostFlagAction,
  dashboardMarkGhostAction,
  dashboardMergeNeedsReviewAction,
} from './actions'
import { FlagTaskPill } from './flag-task-pill'

// Client flags list for the dashboard notification section. Holds multiple
// client-level task kinds, each row tagged with a task-type pill so kinds are
// visually differentiated:
//   - "Needs review" — auto-created clients: clear tag / merge / delete.
//   - "Ghost" — active clients silent in Slack 14+ days: mark ghost / dismiss.
export function ClientFlags({
  needsReview,
  candidates,
  ghosts,
}: {
  needsReview: NeedsReviewClient[]
  candidates: CandidateClient[]
  ghosts: GhostClientFlag[]
}) {
  if (needsReview.length === 0 && ghosts.length === 0) {
    return (
      <div
        style={{
          padding: '4px 0',
          fontSize: 13,
          color: 'var(--color-geg-text-3)',
          fontStyle: 'italic',
        }}
      >
        No client flags. Nothing needs attention right now.
      </div>
    )
  }

  return (
    <div
      style={{
        maxHeight: 300,
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {needsReview.map((c) => (
        <NeedsReviewFlagRow key={`nr:${c.id}`} client={c} candidates={candidates} />
      ))}
      {ghosts.map((g) => (
        <GhostFlagRow key={`ghost:${g.id}`} ghost={g} />
      ))}
    </div>
  )
}

function GhostFlagRow({ ghost }: { ghost: GhostClientFlag }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [markOpen, setMarkOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const silentLabel =
    ghost.days_silent === null
      ? 'no client message on record'
      : `silent ${ghost.days_silent}d`

  function confirmMarkGhost() {
    setError(null)
    startTransition(async () => {
      const r = await dashboardMarkGhostAction(ghost.id)
      if (r.success) {
        setMarkOpen(false)
        router.refresh()
      } else {
        setError(r.error)
      }
    })
  }

  function dismiss() {
    setError(null)
    startTransition(async () => {
      const r = await dashboardDismissGhostFlagAction(ghost.id)
      if (r.success) router.refresh()
      else setError(r.error)
    })
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '12px 2px',
        borderBottom: '1px solid var(--color-geg-border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <FlagTaskPill label="Ghost" tone="warn" />
        <div style={{ minWidth: 0 }}>
          <Link
            href={`/clients/${ghost.id}`}
            style={{
              fontSize: 14,
              color: 'var(--color-geg-text)',
              textDecoration: 'underline',
            }}
          >
            {ghost.full_name}
          </Link>
          <div
            className="geg-mono"
            style={{
              marginTop: 3,
              fontSize: 11,
              color: 'var(--color-geg-text-faint)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {silentLabel}
            {ghost.last_client_message_at
              ? ` · last reply ${formatGhostDate(ghost.last_client_message_at)}`
              : ''}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setError(null)
            setMarkOpen(true)
          }}
          disabled={isPending}
        >
          Mark ghost
        </Button>
        <Button variant="outline" size="sm" onClick={dismiss} disabled={isPending}>
          Remove notification
        </Button>
      </div>

      {/* Mark-ghost confirm dialog */}
      <Dialog
        open={markOpen}
        onOpenChange={(next) => {
          setMarkOpen(next)
          if (!next) setError(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mark {ghost.full_name} as ghost?</DialogTitle>
            <DialogDescription>
              Sets the client&apos;s status to ghost. This reassigns them to
              the chasing queue and disables accountability + NPS (the standard
              status cascade). Reversible by changing their status back.
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-rose-700">Error: {error}</p> : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMarkOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button onClick={confirmMarkGhost} disabled={isPending}>
              {isPending ? 'Marking…' : 'Mark ghost'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function formatGhostDate(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
  }).format(new Date(iso))
}

function NeedsReviewFlagRow({
  client,
  candidates,
}: {
  client: NeedsReviewClient
  candidates: CandidateClient[]
}) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [mergeOpen, setMergeOpen] = useState(false)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const mergeCandidates = candidates.filter((c) => c.id !== client.id)
  const targetClient = mergeCandidates.find((c) => c.id === targetId) ?? null
  const context =
    client.auto_created_from_call_title ?? client.auto_create_reason ?? null

  function clearTag() {
    setError(null)
    startTransition(async () => {
      const r = await dashboardClearNeedsReviewAction(client.id)
      if (r.success) router.refresh()
      else setError(r.error)
    })
  }

  function confirmMerge() {
    if (!targetId) return
    setError(null)
    startTransition(async () => {
      const r = await dashboardMergeNeedsReviewAction(client.id, targetId)
      if (r.success) {
        setMergeOpen(false)
        setTargetId(null)
        router.refresh()
      } else {
        setError(r.error)
      }
    })
  }

  function confirmDelete() {
    setError(null)
    startTransition(async () => {
      const r = await dashboardArchiveNeedsReviewAction(client.id)
      if (r.success) {
        setDeleteOpen(false)
        router.refresh()
      } else {
        setError(r.error)
      }
    })
  }

  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '12px 2px',
        borderBottom: '1px solid var(--color-geg-border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
        <FlagTaskPill label="Needs review" tone="info" />
        <div style={{ minWidth: 0 }}>
          <Link
            href={`/clients/${client.id}`}
            style={{
              fontSize: 14,
              color: 'var(--color-geg-text)',
              textDecoration: 'underline',
            }}
          >
            {client.full_name}
          </Link>
          <div
            className="geg-mono"
            style={{
              marginTop: 3,
              fontSize: 11,
              color: 'var(--color-geg-text-faint)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {client.email || '(no email)'}
            {context ? ` · ${context}` : ''}
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <Button variant="outline" size="sm" onClick={clearTag} disabled={isPending}>
          Reviewed
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setError(null)
            setMergeOpen(true)
          }}
          disabled={isPending}
        >
          Merge…
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setError(null)
            setDeleteOpen(true)
          }}
          disabled={isPending}
        >
          Delete
        </Button>
      </div>

      {/* Merge dialog */}
      <Dialog
        open={mergeOpen}
        onOpenChange={(next) => {
          setMergeOpen(next)
          if (!next) {
            setTargetId(null)
            setError(null)
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Merge {client.full_name} into another client</DialogTitle>
            <DialogDescription>
              This reattributes all of {client.full_name}&apos;s calls,
              participants, and transcripts to the chosen client, then archives{' '}
              {client.full_name}. Reversible only by manual SQL.
            </DialogDescription>
          </DialogHeader>
          <SearchableClientSelect
            candidates={mergeCandidates}
            value={targetId}
            onChange={setTargetId}
          />
          {error ? <p className="text-sm text-rose-700">Error: {error}</p> : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setMergeOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button onClick={confirmMerge} disabled={!targetId || isPending}>
              {isPending
                ? 'Merging…'
                : targetClient
                  ? `Merge into ${targetClient.full_name}`
                  : 'Confirm merge'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete (archive) confirm dialog */}
      <Dialog
        open={deleteOpen}
        onOpenChange={(next) => {
          setDeleteOpen(next)
          if (!next) setError(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Delete {client.full_name}?</DialogTitle>
            <DialogDescription>
              Archives this auto-created client so it no longer appears in any
              client list. Its calls stay in the database. Reversible by
              clearing archived_at in SQL.
            </DialogDescription>
          </DialogHeader>
          {error ? <p className="text-sm text-rose-700">Error: {error}</p> : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button onClick={confirmDelete} disabled={isPending}>
              {isPending ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
