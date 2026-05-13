'use client'

import { useState } from 'react'
import { Mrkdwn } from '@/lib/slack/render-mrkdwn'

const TRUNCATE_CHARS = 500

// Slack-styled message block with optional author row + automatic
// 500-char truncate + "Show more"/"Show less" toggle. Used on the Ella
// run detail page for both the Triggering message (author = sender)
// and Ella's response (author = "Ella", gold-tinted name).
//
// Truncation is on the source string (not CSS clamp) so the page
// weight stays low. Mid-syntax cuts (unmatched `*`, half-link) render
// as literal characters per the Mrkdwn renderer's "render unmatched
// as-is" rule.
//
// The dark-translucent shell + author-row chrome matches the design
// handoff's `.slack-msg` treatment exactly.

export function ExpandableMessage({
  text,
  author,
  authorIsElla,
  timeLabel,
}: {
  text: string
  author?: string
  authorIsElla?: boolean
  timeLabel?: string
}) {
  const [expanded, setExpanded] = useState(false)
  const needsTruncate = text.length > TRUNCATE_CHARS

  let shown: string
  if (!needsTruncate || expanded) {
    shown = text
  } else {
    const cut = text.slice(0, TRUNCATE_CHARS)
    const lastSpace = cut.lastIndexOf(' ')
    const boundary =
      lastSpace > TRUNCATE_CHARS * 0.8 ? lastSpace : TRUNCATE_CHARS
    shown = cut.slice(0, boundary) + '…'
  }

  return (
    <>
      <div
        className="geg-slack-msg"
        style={{
          background: 'rgba(0, 0, 0, 0.18)',
          border: '1px solid rgba(255, 255, 255, 0.04)',
          borderRadius: 6,
          padding: '14px 16px',
          fontSize: 14,
          lineHeight: 1.6,
          color: 'var(--color-geg-text)',
        }}
      >
        {author ? (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginBottom: 10,
            }}
          >
            <span
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: authorIsElla
                  ? 'var(--color-geg-accent)'
                  : 'var(--color-geg-text)',
              }}
            >
              {author}
            </span>
            {timeLabel ? (
              <span
                className="geg-mono"
                style={{
                  fontSize: 11,
                  color: 'var(--color-geg-text-faint)',
                  letterSpacing: '0.02em',
                  marginLeft: 'auto',
                }}
              >
                {timeLabel}
              </span>
            ) : null}
          </div>
        ) : null}
        <Mrkdwn text={shown} />
      </div>
      {needsTruncate ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="geg-mono"
          style={{
            display: 'inline-block',
            marginTop: 10,
            fontSize: 11,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-accent)',
            cursor: 'pointer',
            background: 'transparent',
            border: 0,
            padding: 0,
          }}
        >
          {expanded
            ? '← Show less'
            : `Show full message (${text.length - TRUNCATE_CHARS} more chars) →`}
        </button>
      ) : null}
    </>
  )
}
