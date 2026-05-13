'use client'

import { useState } from 'react'
import { Mrkdwn } from '@/lib/slack/render-mrkdwn'

const TRUNCATE_CHARS = 500

// Truncatable + Slack-mrkdwn-rendered message section used by the Ella
// run detail page for the Triggering message + Ella's response. Picks
// a word boundary near `TRUNCATE_CHARS` when the text is longer than
// the cap; user toggles "Show more" / "Show less" to expand.
//
// Truncation is character-based on the source string, not CSS-based,
// so the page weight stays low on multi-thousand-char messages. The
// mrkdwn renderer then receives the (possibly truncated) string and
// renders accordingly. Mid-syntax cuts (unmatched `*`, etc.) render as
// literal characters per the renderer's "render unmatched as-is" rule.
export function ExpandableMessage({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  const needsTruncate = text.length > TRUNCATE_CHARS

  let shown: string
  if (!needsTruncate || expanded) {
    shown = text
  } else {
    // Pick the nearest preceding word boundary so we don't cut mid-word
    // when possible. Falls back to the hard limit.
    const cut = text.slice(0, TRUNCATE_CHARS)
    const lastSpace = cut.lastIndexOf(' ')
    const boundary = lastSpace > TRUNCATE_CHARS * 0.8 ? lastSpace : TRUNCATE_CHARS
    shown = cut.slice(0, boundary) + '…'
  }

  return (
    <div className="space-y-2 text-sm">
      <div className="rounded bg-zinc-50 p-3 leading-relaxed">
        <Mrkdwn text={shown} />
      </div>
      {needsTruncate ? (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="text-xs text-blue-700 hover:underline"
        >
          {expanded
            ? 'Show less'
            : `Show more (${text.length - TRUNCATE_CHARS} more chars)`}
        </button>
      ) : null}
    </div>
  )
}
