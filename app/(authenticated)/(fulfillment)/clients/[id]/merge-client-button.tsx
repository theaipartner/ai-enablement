'use client'

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
import { mergeClientAction } from './actions'

// "Merge into…" button for the Clients detail page. Renders only
// for clients tagged needs_review (the page entry handles the gate).
// On confirm, calls the mergeClientAction Server Action; on success
// the source is archived, so we redirect to the target's detail page
// rather than letting the user land back on a now-404'd source page.
export function MergeClientButton({
  sourceId,
  sourceFullName,
  candidates,
}: {
  sourceId: string
  sourceFullName: string
  candidates: CandidateClient[]
}) {
  const [open, setOpen] = useState(false)
  const [targetId, setTargetId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const router = useRouter()

  function reset() {
    setTargetId(null)
    setError(null)
  }

  function handleOpenChange(next: boolean) {
    if (!next) {
      setOpen(false)
      reset()
    } else {
      setOpen(true)
    }
  }

  function confirm() {
    if (!targetId) return
    setError(null)
    startTransition(async () => {
      const result = await mergeClientAction(sourceId, targetId)
      if (result.success) {
        setOpen(false)
        reset()
        router.push(`/clients/${targetId}`)
      } else {
        setError(result.error)
      }
    })
  }

  const targetClient =
    candidates.find((candidate) => candidate.id === targetId) ?? null

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="ml-1"
      >
        Merge into…
      </Button>
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              Merge {sourceFullName} into another client
            </DialogTitle>
            <DialogDescription>
              This will reattribute all of {sourceFullName}&apos;s calls,
              participants, and transcripts to the chosen client, then
              archive {sourceFullName}. This action is reversible only by
              manual SQL.
            </DialogDescription>
          </DialogHeader>
          <SearchableClientSelect
            candidates={candidates}
            value={targetId}
            onChange={setTargetId}
          />
          {error ? (
            <p className="text-sm text-rose-700">Error: {error}</p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => handleOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button onClick={confirm} disabled={!targetId || isPending}>
              {isPending
                ? 'Merging…'
                : targetClient
                  ? `Merge into ${targetClient.full_name}`
                  : 'Confirm merge'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
