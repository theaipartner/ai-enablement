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
import { removeNeedsReviewTagAction } from './actions'

// "Mark as reviewed" button for /clients/[id]. Renders next to the
// Merge button when the client has `needs_review` in metadata.tags.
// Clears just that one tag (and writes an audit timestamp in
// metadata.needs_review_cleared_at); leaves the rest of the client
// row untouched.
//
// Spec: docs/specs/auto-created-client-lifecycle.md § Remove-tag button.

export function RemoveNeedsReviewButton({
  clientId,
  clientName,
}: {
  clientId: string
  clientName: string
}) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function confirm() {
    setError(null)
    startTransition(async () => {
      const result = await removeNeedsReviewTagAction(clientId)
      if (result.success) {
        setOpen(false)
        // router.refresh re-renders the page with the freshly-cleared
        // tag; the parent's conditional gate hides this button on the
        // next paint.
        router.refresh()
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setError(null)
          setOpen(true)
        }}
      >
        Mark as reviewed
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (!next) {
            setOpen(false)
            setError(null)
          } else {
            setOpen(true)
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Mark {clientName} as reviewed?</DialogTitle>
            <DialogDescription>
              Removes the <code>needs_review</code> tag from this client. The
              client&apos;s status, primary CSM, and assignments stay unchanged.
              You can re-add the tag manually if needed.
            </DialogDescription>
          </DialogHeader>
          {error ? (
            <p className="text-sm text-rose-700">Error: {error}</p>
          ) : null}
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button onClick={confirm} disabled={isPending}>
              {isPending ? 'Removing…' : 'Yes, mark reviewed'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
