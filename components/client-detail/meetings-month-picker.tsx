'use client'

import { useState } from 'react'
import type { MeetingMonth } from '@/lib/db/client-meetings'

// Client-page meetings widget. Shows the selected month's meeting count
// (Google Calendar, via client_meetings) with a small dropdown to flip
// through prior months. Defaults to the current month. Visual language
// mirrors the `Stat` component in the client detail page (mono eyebrow +
// serif numeral) with the month <select> as the eyebrow control.
export function MeetingsMonthPicker({ months }: { months: MeetingMonth[] }) {
  const [selected, setSelected] = useState(months[0]?.month ?? '')
  const current =
    months.find((m) => m.month === selected) ?? months[0] ?? null

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        borderLeft: '1px solid var(--color-geg-accent-border)',
        paddingLeft: 16,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span
          className="geg-mono"
          style={{
            fontSize: 10,
            fontWeight: 500,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-faint)',
          }}
        >
          Meetings
        </span>
        {months.length > 0 ? (
          <select
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            aria-label="Select month"
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.04em',
              color: 'var(--color-geg-text-2)',
              background: 'transparent',
              border: '1px solid var(--color-geg-accent-border)',
              borderRadius: 4,
              padding: '1px 4px',
              cursor: 'pointer',
            }}
          >
            {months.map((m) => (
              <option key={m.month} value={m.month}>
                {m.label}
              </option>
            ))}
          </select>
        ) : null}
      </div>
      <span
        className="geg-serif"
        style={{
          fontWeight: 500,
          fontSize: 28,
          lineHeight: 1,
          letterSpacing: '-0.01em',
          color: 'var(--color-geg-text)',
          fontVariantNumeric: 'tabular-nums',
          marginTop: 2,
        }}
      >
        {current?.count ?? 0}
      </span>
    </div>
  )
}
