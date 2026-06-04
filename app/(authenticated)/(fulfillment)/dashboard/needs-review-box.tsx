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
import type { NeedsReviewClient } from '@/lib/db/fulfillment-dashboard'
import {
  dashboardArchiveNeedsReviewAction,
  dashboardClearNeedsReviewAction,
  dashboardMergeNeedsReviewAction,
} from './actions'

// Dashboard "Needs Review" box. Scrollable list of auto-created
// (needs_review-tagged) clients with three per-row dispositions:
// clear the tag, merge into a real client, or delete (soft-archive).
// Mirrors the visual language of the existing dashboard stat boxes
// (elevated card, eyebrow + serif title, mono labels).

export function NeedsReviewBox({
  clients,
  candidates,
}: {
  clients: NeedsReviewClient[]
  candidates: CandidateClient[]
}) {
  return (
    <section style={{ marginTop: 28 }}>
      <div
        style={{
          padding: '22px 26px 24px',
          background: 'var(--color-geg-bg-elev)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 10,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'baseline',
            justifyContent: 'space-between',
            marginBottom: 14,
          }}
        >
          <div>
            <div
              className="geg-mono"
              style={{
                fontSize: 10,
                letterSpacing: '0.18em',
                textTransform: 'uppercase',
                color: 'var(--color-geg-text-3)',
              }}
            >
              NEEDS REVIEW
            </div>
            <div
              className="geg-serif"
              style={{
                marginTop: 6,
                fontSize: 22,
                color: 'var(--color-geg-text)',
                letterSpacing: '-0.012em',
              }}
            >
              Auto-created clients.
            </div>
          </div>
          <div
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-faint)',
            }}
          >
            {clients.length} {clients.length === 1 ? 'client' : 'clients'}
          </div>
        </div>

        {clients.length === 0 ? (
          <div
            style={{
              padding: '8px 0 4px',
              fontSize: 13,
              color: 'var(--color-geg-text-3)',
              fontStyle: 'italic',
            }}
          >
            Nothing to review. Every auto-created client has been resolved.
          </div>
        ) : (
          <div
            style={{
              maxHeight: 300,
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {clients.map((c) => (
              <NeedsReviewRow key={c.id} client={c} candidates={candidates} />
            ))}
          </div>
        )}
      </div>
    </section>
  )
}

function NeedsReviewRow({
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
  const targetClient =
    mergeCandidates.find((c) => c.id === targetId) ?? null
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
        <Button
          variant="outline"
          size="sm"
          onClick={clearTag}
          disabled={isPending}
        >
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
          {error ? (
            <p className="text-sm text-rose-700">Error: {error}</p>
          ) : null}
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
          {error ? (
            <p className="text-sm text-rose-700">Error: {error}</p>
          ) : null}
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
