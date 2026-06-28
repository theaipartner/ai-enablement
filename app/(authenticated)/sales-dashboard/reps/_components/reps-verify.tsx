'use client'

import { useState, useTransition } from 'react'

import {
  defaultSalesRoleFromJobTitle,
  type CloseUserOption,
  type RepCandidate,
  type SalesRole,
} from '@/lib/db/sales-rep-verify-shared'
import {
  saveRepDraft,
  completeRep,
  deleteRepCandidate,
  type RepDraftInput,
} from '../actions'

// The verify cards. One card per Airtable rep awaiting verification. Each card
// holds editable fields (name, role, Close ID, email, Calendly) plus a Close-user
// picker that fills Close ID + email in one pick. Three actions: Save (draft),
// Complete (write team_members), Delete (dismiss).

const ROLE_OPTIONS: { value: SalesRole; label: string }[] = [
  { value: 'setter', label: 'Setter' },
  { value: 'closer', label: 'Closer' },
  { value: 'dc_closer', label: 'DC Closer' },
]

type CardState = {
  fullName: string
  salesRole: SalesRole | ''
  email: string
  closeUserId: string
  calendlyEventTypeUri: string
}

function initialState(c: RepCandidate): CardState {
  return {
    fullName: c.draft?.fullName ?? c.fullName ?? '',
    salesRole:
      c.draft?.salesRole ?? defaultSalesRoleFromJobTitle(c.jobTitle) ?? '',
    email: c.draft?.email ?? '',
    closeUserId: c.draft?.closeUserId ?? '',
    calendlyEventTypeUri: c.draft?.calendlyEventTypeUri ?? '',
  }
}

export function RepsVerify({
  candidates,
  closeUsers,
}: {
  candidates: RepCandidate[]
  closeUsers: CloseUserOption[]
}) {
  if (candidates.length === 0) {
    return (
      <div
        style={{
          border: '1px dashed var(--color-geg-border)',
          borderRadius: 8,
          padding: '40px 24px',
          textAlign: 'center',
          color: 'var(--color-geg-text-faint)',
          fontSize: 13.5,
        }}
      >
        No new reps to verify. New Airtable reps appear here within ~30 minutes.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {candidates.map((c) => (
        <RepCard key={c.airtableRecordId} candidate={c} closeUsers={closeUsers} />
      ))}
    </div>
  )
}

function RepCard({
  candidate,
  closeUsers,
}: {
  candidate: RepCandidate
  closeUsers: CloseUserOption[]
}) {
  const [state, setState] = useState<CardState>(() => initialState(candidate))
  const [pending, startTransition] = useTransition()
  const [msg, setMsg] = useState<string | null>(null)

  const set = (patch: Partial<CardState>) =>
    setState((prev) => ({ ...prev, ...patch }))

  // Picking a Close user fills both Close ID and email in one go.
  const onPickCloseUser = (closeUserId: string) => {
    const u = closeUsers.find((x) => x.closeUserId === closeUserId)
    set({
      closeUserId,
      email: u?.email ?? state.email,
    })
  }

  const toInput = (): RepDraftInput => ({
    airtableRecordId: candidate.airtableRecordId,
    fullName: state.fullName || null,
    salesRole: (state.salesRole || null) as SalesRole | null,
    email: state.email || null,
    closeUserId: state.closeUserId || null,
    calendlyEventTypeUri: state.calendlyEventTypeUri || null,
  })

  const run = (
    fn: () => Promise<{ ok: true } | { ok: false; error: string }>,
    okMsg: string,
  ) => {
    setMsg(null)
    startTransition(async () => {
      const res = await fn()
      if (!res.ok) setMsg(`Error: ${res.error}`)
      else setMsg(okMsg)
    })
  }

  const onSave = () => run(() => saveRepDraft(toInput()), 'Saved — left open.')
  const onComplete = () => {
    // Mirror the server-side required-field checks for a friendly inline message.
    if (!state.fullName.trim()) return setMsg('Error: full name is required.')
    if (!state.salesRole) return setMsg('Error: pick a sales role.')
    if (!state.email.trim()) return setMsg('Error: email is required.')
    if (!state.closeUserId.trim()) return setMsg('Error: Close ID is required.')
    run(() => completeRep(toInput()), 'Completed.')
  }
  const onDelete = () => {
    if (
      !window.confirm(
        'Delete this candidate? It will be dismissed (treated as a test/junk record) and stop appearing here.',
      )
    )
      return
    run(() => deleteRepCandidate(candidate.airtableRecordId), 'Deleted.')
  }

  return (
    <div
      style={{
        border: '1px solid var(--color-geg-border)',
        background: 'var(--color-geg-bg-elev)',
        borderRadius: 8,
        padding: '18px 20px',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          justifyContent: 'space-between',
          gap: 12,
          marginBottom: 16,
        }}
      >
        <div>
          <div
            className="geg-serif"
            style={{ fontSize: 18, color: 'var(--color-geg-text)' }}
          >
            {candidate.fullName ?? '(unnamed)'}
          </div>
          <div
            className="geg-mono"
            style={{
              fontSize: 11,
              color: 'var(--color-geg-text-faint)',
              marginTop: 3,
            }}
          >
            {candidate.jobTitle ?? 'no job title'} ·{' '}
            {candidate.airtableRecordId}
            {candidate.airtableCreatedAt
              ? ` · added ${candidate.airtableCreatedAt.slice(0, 10)}`
              : ''}
          </div>
        </div>
        {candidate.status === 'draft' ? (
          <span
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.08em',
              color: 'var(--color-geg-accent)',
              border: '1px solid var(--color-geg-border)',
              borderRadius: 4,
              padding: '2px 6px',
            }}
          >
            DRAFT
          </span>
        ) : null}
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
          gap: 14,
        }}
      >
        <Field label="Full name">
          <input
            style={inputStyle}
            value={state.fullName}
            onChange={(e) => set({ fullName: e.target.value })}
            placeholder="Full name"
          />
        </Field>

        <Field label="Sales role">
          <select
            style={inputStyle}
            value={state.salesRole}
            onChange={(e) => set({ salesRole: e.target.value as SalesRole | '' })}
          >
            <option value="">— pick —</option>
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Close user (picker)">
          <select
            style={inputStyle}
            value={state.closeUserId}
            onChange={(e) => onPickCloseUser(e.target.value)}
          >
            <option value="">— pick from Close —</option>
            {closeUsers.map((u) => (
              <option key={u.closeUserId} value={u.closeUserId}>
                {u.fullName ?? u.email ?? u.closeUserId}
                {u.email ? ` · ${u.email}` : ''}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Close ID">
          <input
            style={inputStyle}
            value={state.closeUserId}
            onChange={(e) => set({ closeUserId: e.target.value })}
            placeholder="user_..."
            className="geg-mono"
          />
        </Field>

        <Field label="Email">
          <input
            style={inputStyle}
            value={state.email}
            onChange={(e) => set({ email: e.target.value })}
            placeholder="rep@theaipartner.io"
            type="email"
          />
        </Field>

        <Field label="Calendly event-type URI (optional)">
          <input
            style={inputStyle}
            value={state.calendlyEventTypeUri}
            onChange={(e) => set({ calendlyEventTypeUri: e.target.value })}
            placeholder="https://api.calendly.com/event_types/..."
            className="geg-mono"
          />
        </Field>
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: 18,
        }}
      >
        <button
          type="button"
          onClick={onComplete}
          disabled={pending}
          style={primaryBtn(pending)}
        >
          Complete
        </button>
        <button
          type="button"
          onClick={onSave}
          disabled={pending}
          style={secondaryBtn(pending)}
        >
          Save
        </button>
        <button
          type="button"
          onClick={onDelete}
          disabled={pending}
          style={dangerBtn(pending)}
        >
          Delete
        </button>
        {msg ? (
          <span
            className="geg-mono"
            style={{
              fontSize: 11.5,
              color: msg.startsWith('Error')
                ? 'var(--color-geg-danger, #c0392b)'
                : 'var(--color-geg-text-2)',
            }}
          >
            {msg}
          </span>
        ) : null}
      </div>
    </div>
  )
}

function Field({
  label,
  children,
}: {
  label: string
  children: React.ReactNode
}) {
  return (
    <label style={{ display: 'block' }}>
      <span
        className="geg-mono"
        style={{
          display: 'block',
          fontSize: 10,
          letterSpacing: '0.07em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-faint)',
          marginBottom: 5,
        }}
      >
        {label}
      </span>
      {children}
    </label>
  )
}

const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '7px 9px',
  fontSize: 13,
  borderRadius: 5,
  border: '1px solid var(--color-geg-border)',
  background: 'var(--color-geg-bg)',
  color: 'var(--color-geg-text)',
}

function baseBtn(pending: boolean): React.CSSProperties {
  return {
    fontSize: 12.5,
    padding: '7px 16px',
    borderRadius: 5,
    cursor: pending ? 'default' : 'pointer',
    opacity: pending ? 0.55 : 1,
    border: '1px solid var(--color-geg-border)',
    fontFamily: 'var(--font-prom-sans), Inter, system-ui, sans-serif',
  }
}

function primaryBtn(pending: boolean): React.CSSProperties {
  return {
    ...baseBtn(pending),
    background: 'var(--color-geg-accent)',
    borderColor: 'var(--color-geg-accent)',
    color: '#fff',
    fontWeight: 600,
  }
}

function secondaryBtn(pending: boolean): React.CSSProperties {
  return {
    ...baseBtn(pending),
    background: 'var(--color-geg-bg-elev)',
    color: 'var(--color-geg-text)',
  }
}

function dangerBtn(pending: boolean): React.CSSProperties {
  return {
    ...baseBtn(pending),
    background: 'transparent',
    color: 'var(--color-geg-text-faint)',
  }
}
