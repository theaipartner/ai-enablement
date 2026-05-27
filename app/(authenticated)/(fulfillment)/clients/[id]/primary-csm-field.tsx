'use client'

import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { changeClientPrimaryCsm } from './actions'

type TeamMemberOption = { id: string; full_name: string }

export function PrimaryCsmField({
  clientId,
  currentTeamMemberId,
  currentTeamMemberName,
  assignedAt,
  options,
}: {
  clientId: string
  currentTeamMemberId: string | null
  currentTeamMemberName: string | null
  assignedAt: string | null
  options: TeamMemberOption[]
}) {
  // The dropdown holds a *staged* selection (not yet committed). Commit
  // happens when the user confirms the dialog. This is a deliberate
  // friction point — changing primary CSM cascades into who Ella
  // escalates to once that wiring exists, and into how Gregory's brain
  // attributes work. Worth the click.
  const [stagedId, setStagedId] = useState<string>(currentTeamMemberId ?? '')
  const [pendingConfirmId, setPendingConfirmId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function handleSelectChange(value: string) {
    setStagedId(value)
    setError(null)
    if (value !== currentTeamMemberId) {
      setPendingConfirmId(value)
    }
  }

  function cancel() {
    setPendingConfirmId(null)
    setStagedId(currentTeamMemberId ?? '')
  }

  function confirm() {
    if (!pendingConfirmId) return
    startTransition(async () => {
      const result = await changeClientPrimaryCsm(clientId, pendingConfirmId)
      if (result.success) {
        setPendingConfirmId(null)
        // Page revalidates server-side; we don't need to update local state.
      } else {
        setError(result.error)
        setStagedId(currentTeamMemberId ?? '')
        setPendingConfirmId(null)
      }
    })
  }

  const stagedName =
    options.find((option) => option.id === pendingConfirmId)?.full_name ??
    'Unassigned'

  return (
    <div className="space-y-1.5">
      <Label htmlFor="primary_csm">Primary CSM</Label>
      <select
        id="primary_csm"
        value={stagedId}
        onChange={(event) => handleSelectChange(event.target.value)}
        disabled={isPending}
        className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
      >
        <option value="">Unassigned</option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.full_name}
          </option>
        ))}
      </select>
      {assignedAt ? (
        <p className="text-xs text-muted-foreground">
          Assigned {new Date(assignedAt).toLocaleDateString()}
        </p>
      ) : null}
      {error ? <p className="text-xs text-rose-700">Error: {error}</p> : null}

      <Dialog
        open={pendingConfirmId !== null}
        onOpenChange={(open) => {
          if (!open) cancel()
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change primary CSM?</DialogTitle>
            <DialogDescription>
              From <strong>{currentTeamMemberName ?? 'Unassigned'}</strong> to{' '}
              <strong>{stagedName}</strong>. This will archive the previous
              assignment.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={cancel} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={confirm} disabled={isPending}>
              {isPending ? 'Changing…' : 'Confirm change'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
