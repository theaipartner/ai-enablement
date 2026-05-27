'use client'

import { useState } from 'react'
import type { SetterCallWord } from '@/lib/db/setter-calls'

// Collapsible diarized-transcript section. Mirrors the /calls/[id]
// CS-side pattern — collapsed by default, "Show transcript" toggle,
// scrollable when expanded. The diarized words array drives a
// speaker-grouped layout; falls back to raw transcript text if the
// words are missing.

export function TranscriptSection({
  transcriptText,
  words,
  speakerCount,
}: {
  transcriptText: string
  words: SetterCallWord[]
  speakerCount: number | null
}) {
  const [expanded, setExpanded] = useState(false)

  if (!transcriptText && words.length === 0) {
    return null
  }

  const segments = groupBySpeaker(words)

  return (
    <section
      style={{
        marginTop: 24,
        padding: '16px 20px 18px',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        background: 'var(--color-geg-bg-elev)',
      }}
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="geg-mono"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          background: 'transparent',
          border: 'none',
          padding: 0,
          color: 'var(--color-geg-text)',
          fontSize: 11,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          cursor: 'pointer',
        }}
      >
        <span style={{ fontSize: 12, color: 'var(--color-geg-accent)' }}>
          {expanded ? '▾' : '▸'}
        </span>
        {expanded ? 'Hide transcript' : 'Show transcript'}
        <span
          style={{
            color: 'var(--color-geg-text-faint)',
            letterSpacing: '0.08em',
            fontSize: 10,
          }}
        >
          {segments.length} turns · {speakerCount ?? '?'} speakers
        </span>
      </button>

      {expanded ? (
        <div
          style={{
            marginTop: 14,
            maxHeight: 480,
            overflowY: 'auto',
            paddingRight: 8,
            background: 'var(--color-geg-bg)',
            border: '1px solid var(--color-geg-border)',
            borderRadius: 6,
            padding: '14px 16px',
          }}
        >
          {segments.length === 0 ? (
            <pre
              style={{
                margin: 0,
                whiteSpace: 'pre-wrap',
                fontSize: 12,
                lineHeight: 1.55,
                color: 'var(--color-geg-text-2)',
                fontFamily: 'inherit',
              }}
            >
              {transcriptText}
            </pre>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              {segments.map((seg, i) => (
                <SpeakerTurn key={i} segment={seg} />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </section>
  )
}

type Segment = {
  speaker: number | null
  start: number
  text: string
}

function groupBySpeaker(words: SetterCallWord[]): Segment[] {
  if (words.length === 0) return []
  const segments: Segment[] = []
  let cur: Segment | null = null
  for (const w of words) {
    const spk = typeof w.speaker === 'number' ? w.speaker : null
    const token = w.punctuated_word ?? w.word ?? ''
    if (!cur || cur.speaker !== spk) {
      if (cur) segments.push(cur)
      cur = { speaker: spk, start: w.start, text: token }
    } else {
      cur.text += token ? ` ${token}` : ''
    }
  }
  if (cur) segments.push(cur)
  return segments
}

function SpeakerTurn({ segment }: { segment: Segment }) {
  const label = segment.speaker === null ? 'Spk ?' : `Spk ${segment.speaker + 1}`
  const accent = segment.speaker !== null && segment.speaker % 2 === 0
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr', gap: 12 }}>
      <div>
        <div
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            color: accent ? 'var(--color-geg-accent)' : 'var(--color-geg-text-3)',
            fontWeight: 500,
          }}
        >
          {label}
        </div>
        <div
          className="geg-mono"
          style={{
            fontSize: 10,
            color: 'var(--color-geg-text-faint)',
            marginTop: 2,
          }}
        >
          {formatTs(segment.start)}
        </div>
      </div>
      <div
        style={{
          fontSize: 13,
          lineHeight: 1.55,
          color: 'var(--color-geg-text)',
        }}
      >
        {segment.text}
      </div>
    </div>
  )
}

function formatTs(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds - m * 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
