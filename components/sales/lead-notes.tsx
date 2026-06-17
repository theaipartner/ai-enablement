'use client'

import { useState, useTransition } from 'react'
import { saveLeadNote } from '@/app/(authenticated)/sales-dashboard/leads/[close_id]/actions'

// Free-text scratchpad note on the per-lead page. One editable note per lead:
// type into the textarea, hit Save, it overwrites the prior text (lead_notes,
// migration 0090). Shows who last saved it and when. Any logged-in team member
// can edit — it's a shared note, not per-user.

function formatEt(iso: string | null): string | null {
  if (!iso) return null
  try {
    return new Date(iso).toLocaleString('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    })
  } catch {
    return null
  }
}

export function LeadNotes({
  closeId,
  initialNote,
  initialUpdatedAt,
  initialUpdatedBy,
}: {
  closeId: string
  initialNote: string
  initialUpdatedAt: string | null
  initialUpdatedBy: string | null
}) {
  const [text, setText] = useState(initialNote)
  const [savedText, setSavedText] = useState(initialNote)
  const [updatedAt, setUpdatedAt] = useState(initialUpdatedAt)
  const [updatedBy, setUpdatedBy] = useState(initialUpdatedBy)
  const [error, setError] = useState<string | null>(null)
  const [justSaved, setJustSaved] = useState(false)
  const [pending, startTransition] = useTransition()

  const dirty = text !== savedText

  function onSave() {
    setError(null)
    setJustSaved(false)
    startTransition(async () => {
      const res = await saveLeadNote(closeId, text)
      if (res.ok) {
        setSavedText(text)
        setUpdatedAt(res.updatedAt)
        setUpdatedBy(res.updatedBy)
        setJustSaved(true)
      } else {
        setError(res.error)
      }
    })
  }

  const lastEdited = formatEt(updatedAt)

  return (
    <div style={{ marginTop: 12 }}>
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value)
          setJustSaved(false)
        }}
        placeholder="Type a note about this lead…"
        rows={4}
        className="geg-mono"
        style={{
          width: '100%',
          resize: 'vertical',
          fontSize: 12,
          lineHeight: 1.5,
          color: 'var(--color-geg-text)',
          background: 'var(--color-geg-bg-elev)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 8,
          padding: '10px 12px',
          boxSizing: 'border-box',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
        <button
          type="button"
          onClick={onSave}
          disabled={!dirty || pending}
          className="geg-mono"
          style={{
            fontSize: 11,
            letterSpacing: '0.06em',
            textTransform: 'uppercase',
            color: dirty && !pending ? 'var(--color-geg-bg)' : 'var(--color-geg-text-faint)',
            background: dirty && !pending ? 'var(--color-geg-accent)' : 'var(--color-geg-bg-elev)',
            border: '1px solid var(--color-geg-border)',
            borderRadius: 6,
            padding: '6px 14px',
            cursor: dirty && !pending ? 'pointer' : 'default',
          }}
        >
          {pending ? 'Saving…' : dirty ? 'Save' : 'Saved'}
        </button>
        <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)' }}>
          {error
            ? `Couldn't save (${error})`
            : justSaved
              ? 'Saved.'
              : lastEdited
                ? `Last edited ${updatedBy ? `by ${updatedBy} ` : ''}· ${lastEdited} ET`
                : 'No note yet.'}
        </span>
      </div>
    </div>
  )
}
