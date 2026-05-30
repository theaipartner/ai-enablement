'use client'

import { useRouter } from 'next/navigation'
import { useState } from 'react'

// Search box for the /leads page. Navigates to ?q=… (server reads it and
// renders matching leads). Empty submit / clear returns to the roster.
export function LeadSearch({ initial }: { initial: string }) {
  const router = useRouter()
  const [value, setValue] = useState(initial)

  const go = (q: string) => {
    const trimmed = q.trim()
    router.push(trimmed ? `/sales-dashboard/leads?q=${encodeURIComponent(trimmed)}` : '/sales-dashboard/leads')
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        go(value)
      }}
      style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 18 }}
    >
      <input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search leads by name…"
        className="geg-mono"
        style={{
          flex: 1,
          maxWidth: 420,
          fontSize: 12,
          letterSpacing: '0.02em',
          padding: '8px 12px',
          borderRadius: 6,
          border: '1px solid var(--color-geg-border)',
          background: 'var(--color-geg-bg-elev)',
          color: 'var(--color-geg-text)',
          outline: 'none',
        }}
      />
      <button
        type="submit"
        className="geg-mono"
        style={{
          fontSize: 11,
          letterSpacing: '0.06em',
          padding: '8px 14px',
          borderRadius: 6,
          border: '1px solid var(--color-geg-border)',
          background: 'var(--color-geg-bg-elev)',
          color: 'var(--color-geg-text-2)',
          cursor: 'pointer',
        }}
      >
        Search
      </button>
      {initial ? (
        <button
          type="button"
          onClick={() => {
            setValue('')
            go('')
          }}
          className="geg-mono"
          style={{ fontSize: 11, letterSpacing: '0.06em', padding: '8px 10px', border: 'none', background: 'none', color: 'var(--color-geg-text-faint)', cursor: 'pointer' }}
        >
          clear
        </button>
      ) : null}
    </form>
  )
}
