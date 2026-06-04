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

// Needs-review and Ghost are now their own dashboard sections (each wrapped in
// a CollapsibleSection), so the per-row task-type pill is dropped — the
// section header carries the type. These two components render just the row
// lists (with their dispositions); the section chrome lives in page.tsx.

const LIST_STYLE: React.CSSProperties = {
  maxHeight: 300,
  overflowY: 'auto',
  display: 'flex',
  flexDirection: 'column',
}

const EMPTY_STYLE: React.CSSProperties = {
  padding: '4px 0',
  fontSize: 13,
  color: 'var(--color-geg-text-3)',
  fontStyle: 'italic',
}

const ROW_STYLE: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 12,
  padding: '11px 2px',
  borderBottom: '1px solid var(--color-geg-border)',
}

// ---------------------------------------------------------------------------
// Needs review
// ---------------------------------------------------------------------------

export function NeedsReviewList({
  clients,
  candidates,
}: {
  clients: NeedsReviewClient[]
  candidates: CandidateClient[]
}) {
  if (clients.length === 0) {
    return <div style={EMPTY_STYLE}>Nothing to review.</div>
  }
  return (
    <div style={LIST_STYLE}>
      {clients.map((c) => (
        <NeedsReviewFlagRow key={c.id} client={c} candidates={candidates} />
      ))}
    </div>
  )
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
    <div style={ROW_STYLE}>
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

// ---------------------------------------------------------------------------
// Ghost
// ---------------------------------------------------------------------------

export function GhostList({ ghosts }: { ghosts: GhostClientFlag[] }) {
  if (ghosts.length === 0) {
    return <div style={EMPTY_STYLE}>No ghost clients.</div>
  }
  return (
    <div style={LIST_STYLE}>
      {ghosts.map((g) => (
        <GhostFlagRow key={g.id} ghost={g} />
      ))}
    </div>
  )
}

function GhostFlagRow({ ghost }: { ghost: GhostClientFlag }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [markOpen, setMarkOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    <div style={ROW_STYLE}>
      <div style={{ minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, minWidth: 0 }}>
          <Link
            href={`/clients/${ghost.id}`}
            style={{
              fontSize: 14,
              color: 'var(--color-geg-text)',
              textDecoration: 'underline',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {ghost.full_name}
          </Link>
          <span
            className="geg-mono"
            style={{
              fontSize: 11,
              color: 'var(--color-geg-warn)',
              flexShrink: 0,
            }}
          >
            {ghost.days_silent === null ? 'no msgs' : `${ghost.days_silent}d`}
          </span>
        </div>
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
          {ghost.last_client_message_at
            ? `last reply ${formatGhostDate(ghost.last_client_message_at)}`
            : 'no client message on record'}
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
              Sets the client&apos;s status to ghost. This reassigns them to the
              chasing queue and disables accountability + NPS (the standard
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
