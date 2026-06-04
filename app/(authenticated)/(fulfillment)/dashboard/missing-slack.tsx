'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useState, useTransition } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { MissingSlackClient } from '@/lib/db/fulfillment-dashboard'
import {
  dashboardLinkSlackChannelAction,
  dashboardSetSlackUserIdAction,
} from './actions'
import { FlagTaskPill } from './flag-task-pill'

// Missing Slack IDs section. Active clients lacking a slack_user_id and/or a
// mapped channel, with inline inputs to add either id to their profile —
// replacing the manual curl. On success the row re-fetches and drops off (or
// moves to No Ella / Ghost once complete).
export function MissingSlackList({ clients }: { clients: MissingSlackClient[] }) {
  if (clients.length === 0) {
    return (
      <div
        style={{
          padding: '4px 0',
          fontSize: 13,
          color: 'var(--color-geg-text-3)',
          fontStyle: 'italic',
        }}
      >
        Every active client has a Slack user ID and channel.
      </div>
    )
  }
  return (
    <div style={{ maxHeight: 320, overflowY: 'auto' }}>
      {clients.map((c) => (
        <MissingSlackRow key={c.client_id} client={c} />
      ))}
    </div>
  )
}

function MissingSlackRow({ client }: { client: MissingSlackClient }) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [userVal, setUserVal] = useState('')
  const [chanVal, setChanVal] = useState('')
  const [error, setError] = useState<string | null>(null)

  function addUser() {
    if (!userVal.trim()) return
    setError(null)
    startTransition(async () => {
      const r = await dashboardSetSlackUserIdAction(client.client_id, userVal)
      if (r.success) router.refresh()
      else setError(r.error)
    })
  }

  function addChannel() {
    if (!chanVal.trim()) return
    setError(null)
    startTransition(async () => {
      const r = await dashboardLinkSlackChannelAction(client.client_id, chanVal)
      if (r.success) router.refresh()
      else setError(r.error)
    })
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '12px 2px',
        borderBottom: '1px solid var(--color-geg-border)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Link
          href={`/clients/${client.client_id}`}
          style={{
            fontSize: 14,
            color: 'var(--color-geg-text)',
            textDecoration: 'underline',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {client.full_name}
        </Link>
        {client.missing_user ? <FlagTaskPill label="No user" tone="warn" /> : null}
        {client.missing_channel ? (
          <FlagTaskPill label="No channel" tone="warn" />
        ) : null}
      </div>

      {client.missing_user ? (
        <AddRow
          placeholder="Slack user ID (U…)"
          value={userVal}
          onChange={setUserVal}
          onSubmit={addUser}
          disabled={isPending}
        />
      ) : null}
      {client.missing_channel ? (
        <AddRow
          placeholder="Slack channel ID (C…)"
          value={chanVal}
          onChange={setChanVal}
          onSubmit={addChannel}
          disabled={isPending}
        />
      ) : null}

      {error ? <p className="text-sm text-rose-700">Error: {error}</p> : null}
    </div>
  )
}

function AddRow({
  placeholder,
  value,
  onChange,
  onSubmit,
  disabled,
}: {
  placeholder: string
  value: string
  onChange: (v: string) => void
  onSubmit: () => void
  disabled: boolean
}) {
  return (
    <div style={{ display: 'flex', gap: 6 }}>
      <Input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') onSubmit()
        }}
        placeholder={placeholder}
        autoComplete="off"
        className="h-8 text-sm"
      />
      <Button
        variant="outline"
        size="sm"
        onClick={onSubmit}
        disabled={disabled || !value.trim()}
      >
        Add
      </Button>
    </div>
  )
}
