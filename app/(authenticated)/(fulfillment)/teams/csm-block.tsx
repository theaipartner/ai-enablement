'use client'

import { useState } from 'react'
import { GegPill } from '@/components/gregory/geg-pill'
import type { TeamsCsmBlock } from '@/lib/db/teams'

// Per-CSM expandable card. Server fetches the data + passes it down;
// this component just owns the open/closed state. Click anywhere on
// the header row to toggle.

const ESTLOCALE = 'America/New_York'

function formatMeetingTime(iso: string): string {
  // "Mon 2:00 PM" — short day + time in EST. Single Intl format call.
  return new Intl.DateTimeFormat('en-US', {
    timeZone: ESTLOCALE,
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso))
}

export function CsmBlock({ block }: { block: TeamsCsmBlock }) {
  const [open, setOpen] = useState(false)
  const meetingCount = block.meetings.length

  return (
    <div
      style={{
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 8,
        marginBottom: 12,
        overflow: 'hidden',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center justify-between w-full text-left"
        style={{
          padding: '16px 20px',
          background: 'transparent',
          borderBottom: open ? '1px solid var(--color-geg-border)' : 'none',
          cursor: 'pointer',
          color: 'var(--color-geg-text)',
        }}
      >
        <div className="flex items-center gap-3">
          <span
            className="geg-serif"
            style={{ fontSize: 20, color: 'var(--color-geg-text)' }}
          >
            {block.team_member.full_name}
          </span>
          {block.calendar_api_denied ? (
            <GegPill tier="warn" label="API access denied" />
          ) : null}
        </div>
        <div className="flex items-center gap-4">
          <span
            className="geg-mono"
            style={{
              fontSize: 11,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-3)',
            }}
          >
            {meetingCount} {meetingCount === 1 ? 'MEETING' : 'MEETINGS'}
          </span>
          <span
            aria-hidden="true"
            style={{
              color: 'var(--color-geg-text-3)',
              fontSize: 14,
              width: 14,
              textAlign: 'center',
            }}
          >
            {open ? '▾' : '▸'}
          </span>
        </div>
      </button>

      {open ? (
        <div style={{ padding: '12px 20px 18px' }}>
          {meetingCount === 0 ? (
            <div
              className="geg-mono"
              style={{
                fontSize: 12,
                color: 'var(--color-geg-text-3)',
                padding: '8px 0',
              }}
            >
              (no meetings this week)
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'separate', borderSpacing: 0 }}>
              <thead>
                <tr>
                  {['When', 'Title', 'Client', 'Fathom'].map((h) => (
                    <th
                      key={h}
                      className="geg-mono"
                      style={{
                        fontSize: 10,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        color: 'var(--color-geg-text-3)',
                        textAlign: 'left',
                        padding: '6px 12px 6px 0',
                        fontWeight: 500,
                      }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.meetings.map((m) => (
                  <tr
                    key={m.google_event_id}
                    style={{ borderTop: '1px solid var(--color-geg-border)' }}
                  >
                    <td
                      className="geg-mono"
                      style={{
                        fontSize: 12,
                        color: 'var(--color-geg-text-2)',
                        padding: '10px 12px 10px 0',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {formatMeetingTime(m.start_time)}
                    </td>
                    <td
                      style={{
                        fontSize: 14,
                        color: 'var(--color-geg-text)',
                        padding: '10px 12px 10px 0',
                      }}
                    >
                      {m.title || '(untitled)'}
                    </td>
                    <td
                      style={{
                        fontSize: 14,
                        color: m.matched_call?.client_name
                          ? 'var(--color-geg-text)'
                          : 'var(--color-geg-text-3)',
                        padding: '10px 12px 10px 0',
                      }}
                    >
                      {m.matched_call?.client_name ?? '—'}
                    </td>
                    <td
                      style={{
                        padding: '10px 0 10px 0',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {m.matched_call ? (
                        <span
                          className="flex items-center gap-2"
                          style={{ color: 'var(--color-geg-pos)' }}
                        >
                          <span aria-hidden="true">✓</span>
                          {m.matched_call.minutes_late !== null &&
                          m.matched_call.minutes_late >= 2 ? (
                            <GegPill
                              tier="warn"
                              label={`started ${m.matched_call.minutes_late}m late`}
                            />
                          ) : null}
                        </span>
                      ) : (
                        <span
                          className="geg-mono"
                          style={{
                            fontSize: 11,
                            color: 'var(--color-geg-text-3)',
                          }}
                        >
                          (no Fathom match)
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : null}
    </div>
  )
}
