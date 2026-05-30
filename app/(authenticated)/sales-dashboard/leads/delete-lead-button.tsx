'use client'

import { useTransition } from 'react'
import { hideTestLead } from './actions'

// Creator-only "hide fake lead" ×. Soft-hides the Close lead (the server
// action re-checks creator tier). Confirms first to guard misclicks;
// revalidatePath in the action refreshes the page.
export function DeleteLeadButton({ closeId }: { closeId: string }) {
  const [pending, startTransition] = useTransition()
  const onClick = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (!window.confirm('Hide this lead as fake/mistaken? It drops out of the Leads page and the Appointment Setting lead list. (Soft-hide — reversible in the database.)')) {
      return
    }
    startTransition(async () => {
      const res = await hideTestLead(closeId)
      if (!res.ok) window.alert(`Could not hide this lead: ${res.error}`)
    })
  }
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={pending}
      title="Hide this lead (creator only)"
      aria-label="Hide this lead"
      className="geg-mono"
      style={{
        cursor: pending ? 'default' : 'pointer',
        border: '1px solid var(--color-geg-border)',
        background: 'var(--color-geg-bg-elev)',
        color: 'var(--color-geg-text-faint)',
        borderRadius: 4,
        width: 18,
        height: 18,
        lineHeight: '14px',
        fontSize: 12,
        padding: 0,
        opacity: pending ? 0.5 : 1,
      }}
    >
      {pending ? '·' : '×'}
    </button>
  )
}
