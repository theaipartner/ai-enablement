'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { setActionItemStatusAction } from './action-item-actions'
import { sendActionItemsToSlackAction } from './actions'

// Clients redesign · § 2 · Action items box.
//
// Soft-mark-done checkbox per item; "Send to Slack" button at the
// bottom matches the Confirm chrome on /calls/[id]. The Slack send is
// a placeholder for now — wiring it through the Slack adapter is
// follow-up work.

export type ActionItemRow = {
  id: string
  description: string
  status: 'open' | 'done' | string
  call_id: string
  call_title: string | null
  call_started_at: string | null
}

function formatDate(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

// Send-to-Slack lifecycle for the bottom button. 'gone' state hides the
// button after a successful send (per spec § Decision 7); the only way
// back is a page reload, which is intentional — sending is the
// "I'm done for now" gesture.
type SendState = 'idle' | 'sending' | 'sent' | 'failed' | 'gone'

export function ActionItemsList({
  clientId,
  items,
  slackChannelId,
}: {
  clientId: string
  items: ActionItemRow[]
  slackChannelId: string | null
}) {
  const router = useRouter()
  const [, startTransition] = useTransition()
  // Optimistic checkbox state per id; flushed on server-action settle.
  const [optimistic, setOptimistic] = useState<Record<string, 'open' | 'done'>>({})
  const [error, setError] = useState<string | null>(null)
  const [sendState, setSendState] = useState<SendState>('idle')
  const [sendError, setSendError] = useState<string | null>(null)

  function getStatus(item: ActionItemRow): 'open' | 'done' {
    if (optimistic[item.id]) return optimistic[item.id]
    return item.status === 'done' ? 'done' : 'open'
  }

  async function toggle(item: ActionItemRow) {
    const next: 'open' | 'done' = getStatus(item) === 'done' ? 'open' : 'done'
    setOptimistic((prev) => ({ ...prev, [item.id]: next }))
    setError(null)
    const result = await setActionItemStatusAction(clientId, item.id, next)
    if (!result.success) {
      setError(result.error)
      // Roll back the optimistic state on error.
      setOptimistic((prev) => {
        const cp = { ...prev }
        delete cp[item.id]
        return cp
      })
      return
    }
    startTransition(() => router.refresh())
  }

  if (items.length === 0) {
    return (
      <div
        style={{
          color: 'var(--color-geg-text-2)',
          fontSize: 13,
          fontStyle: 'italic',
        }}
      >
        No open action items.
      </div>
    )
  }

  return (
    <>
      <ul
        style={{
          listStyle: 'none',
          margin: 0,
          padding: 0,
        }}
      >
        {items.map((item) => {
          const isDone = getStatus(item) === 'done'
          return (
            <li
              key={item.id}
              style={{
                display: 'grid',
                gridTemplateColumns: '22px 1fr',
                gap: 12,
                padding: '10px 0',
                borderBottom: '1px solid rgba(160, 136, 80, 0.15)',
                alignItems: 'flex-start',
                fontSize: 13,
                lineHeight: 1.45,
              }}
            >
              <button
                type="button"
                onClick={() => toggle(item)}
                aria-label={isDone ? 'Mark incomplete' : 'Mark complete'}
                className={
                  'geg-checkbox' + (isDone ? ' geg-checkbox--checked' : '')
                }
              >
                {isDone ? '✓' : ''}
              </button>
              <div>
                <span
                  style={{
                    color: isDone
                      ? 'var(--color-geg-text-faint)'
                      : 'var(--color-geg-text)',
                    textDecoration: isDone ? 'line-through' : 'none',
                  }}
                >
                  {item.description}
                </span>
                {item.call_id ? (
                  <span
                    className="geg-mono"
                    style={{
                      display: 'block',
                      fontSize: 11,
                      color: 'var(--color-geg-text-faint)',
                      marginTop: 4,
                      letterSpacing: '0.02em',
                    }}
                  >
                    ↳{' '}
                    <Link
                      href={`/calls/${item.call_id}`}
                      className="geg-link"
                      style={{
                        color: 'var(--color-geg-text-2)',
                        textDecoration: 'none',
                        borderBottom: '1px solid transparent',
                      }}
                    >
                      {item.call_title ?? 'Call'}
                      {item.call_started_at
                        ? ` · ${formatDate(item.call_started_at)}`
                        : ''}
                    </Link>
                  </span>
                ) : null}
              </div>
            </li>
          )
        })}
      </ul>
      {renderSendButton({
        clientId,
        slackChannelId,
        sendState,
        setSendState,
        setSendError,
      })}
      {error ? (
        <p
          style={{
            marginTop: 8,
            fontSize: 12,
            color: 'var(--color-geg-neg)',
          }}
        >
          {error}
        </p>
      ) : null}
      {sendError ? (
        <p
          style={{
            marginTop: 8,
            fontSize: 12,
            color: 'var(--color-geg-neg)',
          }}
        >
          {sendError}
        </p>
      ) : null}
    </>
  )
}

function renderSendButton({
  clientId,
  slackChannelId,
  sendState,
  setSendState,
  setSendError,
}: {
  clientId: string
  slackChannelId: string | null
  sendState: SendState
  setSendState: (s: SendState) => void
  setSendError: (s: string | null) => void
}) {
  if (sendState === 'gone') return null

  const disabled =
    slackChannelId === null ||
    sendState === 'sending' ||
    sendState === 'sent' ||
    sendState === 'failed'

  let label: string
  let extraStyle: React.CSSProperties = {}
  if (sendState === 'sending') {
    label = 'Sending…'
  } else if (sendState === 'sent') {
    label = 'Sent ✓'
    extraStyle = { background: 'var(--color-geg-accent-fill)' }
  } else if (sendState === 'failed') {
    label = 'Failed — try again'
    extraStyle = {
      borderColor: 'var(--color-geg-neg)',
      color: 'var(--color-geg-neg)',
    }
  } else {
    label = 'Send to Slack →'
  }

  return (
    <button
      type="button"
      disabled={disabled}
      title={
        slackChannelId === null
          ? 'No Slack channel mapped for this client.'
          : undefined
      }
      onClick={async () => {
        setSendError(null)
        setSendState('sending')
        const result = await sendActionItemsToSlackAction(clientId)
        if (result.success) {
          setSendState('sent')
          // Spec § Decision 7: ~3s "Sent ✓" flash, then the button hides.
          setTimeout(() => setSendState('gone'), 3000)
          return
        }
        setSendError(result.error)
        setSendState('failed')
        // ~5s failed-state, then return to idle so a retry click works.
        setTimeout(() => setSendState('idle'), 5000)
      }}
      className="geg-confirm-btn"
      style={{
        marginTop: 14,
        alignSelf: 'flex-start',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity:
          slackChannelId === null
            ? 0.5
            : sendState === 'sending'
              ? 0.7
              : 1,
        ...extraStyle,
      }}
    >
      {label}
    </button>
  )
}
