'use client'

// Inline "Add NPS score" form for Section 2 (Lifecycle & Standing).
// Hidden by default; clicking the toggle button reveals a small inline
// form (score 0-10 + optional feedback). Submits via the
// addNpsScoreAction Server Action which calls the
// insert_nps_submission RPC. Collapses back to the toggle button after
// a successful save.

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { addNpsScoreAction } from '@/app/(authenticated)/(fulfillment)/clients/[id]/actions'

export function NpsEntryForm({ clientId }: { clientId: string }) {
  const [open, setOpen] = useState(false)
  const [score, setScore] = useState('')
  const [feedback, setFeedback] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function reset() {
    setScore('')
    setFeedback('')
    setError(null)
  }

  function submit() {
    const n = Number.parseInt(score.trim(), 10)
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 10) {
      setError('Score must be an integer 0-10.')
      return
    }
    setError(null)
    startTransition(async () => {
      const result = await addNpsScoreAction(
        clientId,
        n,
        feedback.trim() === '' ? null : feedback,
      )
      if (result.success) {
        reset()
        setOpen(false)
      } else {
        setError(result.error)
      }
    })
  }

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        className="text-xs"
      >
        + Add NPS score
      </Button>
    )
  }

  return (
    <div className="rounded-md border bg-muted/20 p-3 space-y-2">
      <div className="grid grid-cols-[80px_1fr] gap-2 items-start">
        <div>
          <Label htmlFor="nps-score" className="text-xs">
            Score
          </Label>
          <Input
            id="nps-score"
            type="number"
            min={0}
            max={10}
            step={1}
            value={score}
            onChange={(e) => setScore(e.target.value)}
            disabled={isPending}
            className="h-9 mt-1"
          />
        </div>
        <div>
          <Label htmlFor="nps-feedback" className="text-xs">
            Feedback (optional)
          </Label>
          <Textarea
            id="nps-feedback"
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            disabled={isPending}
            rows={2}
            className="text-sm mt-1"
            placeholder="What did they say?"
          />
        </div>
      </div>
      {error ? <p className="text-xs text-rose-700">{error}</p> : null}
      <div className="flex gap-2 justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => {
            reset()
            setOpen(false)
          }}
          disabled={isPending}
        >
          Cancel
        </Button>
        <Button
          type="button"
          size="sm"
          onClick={submit}
          disabled={isPending}
        >
          {isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  )
}
