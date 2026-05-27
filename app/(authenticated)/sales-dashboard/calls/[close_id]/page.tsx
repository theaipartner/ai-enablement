import Link from 'next/link'
import { notFound } from 'next/navigation'
import { HeaderBand } from '@/components/gregory/header-band'
import {
  getSetterCallById,
  type SetterCallDetail,
  type SetterCallWord,
} from '@/lib/db/setter-calls'
import { PersonPill } from '../../header-pills'

// Sales Dashboard · Calls · Detail.
//
// Renders the diarized transcript + call metadata. Speakers come from
// Deepgram's diarize=true output: integer speaker labels (0, 1) that
// we render as alternating "Speaker 1 / Speaker 2" blocks. The setter
// IS one of those two — we don't (yet) auto-resolve which integer
// maps to setter vs prospect; the conventional reading is "whoever
// opens the call is the setter" but Deepgram doesn't guarantee that
// and one Connor smoke had spk0 opening with "Hello?" before the
// prospect joined.
//
// The AI Review block is a placeholder until setter_call_reviews
// lands. When that table is built (deferred until Drake picks a
// golden set), this page wires in the structured fields.

export const dynamic = 'force-dynamic'

export default async function SetterCallDetailPage({
  params,
}: {
  params: { close_id: string }
}) {
  // Next.js URL-encodes acti_* ids transparently; decode just in case.
  const id = decodeURIComponent(params.close_id)
  const detail = await getSetterCallById(id)
  if (!detail) notFound()

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · CALLS · DETAIL"
        title={detail.prospect_name ?? 'Unknown prospect'}
        actions={<PersonPill label="EST · Nabeel" />}
      />

      <BackLink />

      <div
        style={{
          marginTop: 24,
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) 320px',
          gap: 24,
          alignItems: 'start',
        }}
      >
        <TranscriptBlock detail={detail} />
        <MetaSidebar detail={detail} />
      </div>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      href="/sales-dashboard/calls"
      className="geg-mono"
      style={{
        marginTop: 14,
        display: 'inline-block',
        fontSize: 11,
        letterSpacing: '0.12em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-3)',
        textDecoration: 'none',
      }}
    >
      ← Back to calls
    </Link>
  )
}

// ----------------------------------------------------------------------
// Transcript — group consecutive words by speaker
// ----------------------------------------------------------------------

type Segment = {
  speaker: number | null
  start: number
  end: number
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
      // Flush + start new segment
      if (cur) segments.push(cur)
      cur = { speaker: spk, start: w.start, end: w.end, text: token }
    } else {
      cur.end = w.end
      // Space-join except for the punctuation glue case (Deepgram
      // tokenizes punctuation onto the previous word already).
      cur.text += token ? ` ${token}` : ''
    }
  }
  if (cur) segments.push(cur)
  return segments
}

function TranscriptBlock({ detail }: { detail: SetterCallDetail }) {
  const segments = groupBySpeaker(detail.words)

  return (
    <section
      style={{
        padding: '24px 28px 28px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
      }}
    >
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
          marginBottom: 14,
        }}
      >
        Transcript · {segments.length} turns · {detail.speaker_count ?? '?'} speakers
      </div>

      {segments.length === 0 ? (
        <p style={{ color: 'var(--color-geg-text-faint)', fontSize: 13 }}>
          No diarized words available. The raw transcript:
          <br />
          <br />
          <span style={{ color: 'var(--color-geg-text-2)' }}>{detail.transcript_text}</span>
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {segments.map((seg, i) => (
            <SpeakerTurn key={i} segment={seg} />
          ))}
        </div>
      )}

      <ReviewPlaceholder />
    </section>
  )
}

function SpeakerTurn({ segment }: { segment: Segment }) {
  const label =
    segment.speaker === null
      ? 'Speaker ?'
      : `Speaker ${segment.speaker + 1}`
  // Alternate the accent color subtly by parity. Speaker 1 = accent,
  // Speaker 2 = neutral. Three+ speakers (rare) cycle through both.
  const accent = segment.speaker !== null && segment.speaker % 2 === 0
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '90px 1fr', gap: 16 }}>
      <div>
        <div
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.14em',
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
            marginTop: 4,
          }}
        >
          {formatTimestamp(segment.start)}
        </div>
      </div>
      <div
        style={{
          fontSize: 14,
          lineHeight: 1.55,
          color: 'var(--color-geg-text)',
        }}
      >
        {segment.text}
      </div>
    </div>
  )
}

function ReviewPlaceholder() {
  return (
    <div
      style={{
        marginTop: 32,
        padding: '18px 20px',
        border: '1px dashed var(--color-geg-border)',
        borderRadius: 8,
        color: 'var(--color-geg-text-3)',
        fontSize: 12,
      }}
    >
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-faint)',
          marginBottom: 6,
        }}
      >
        AI Review — coming soon
      </div>
      Sentiment · setter strengths / weaknesses · lead score · DQ flag will appear here
      once the review prompt is tuned against the golden set.
    </div>
  )
}

// ----------------------------------------------------------------------
// Sidebar — call metadata
// ----------------------------------------------------------------------

function MetaSidebar({ detail }: { detail: SetterCallDetail }) {
  const date = new Date(detail.activity_at)
  const whenLong = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  })
  const expiresAt = detail.recording_expires_at
    ? new Date(detail.recording_expires_at)
    : null
  const isPlayable = expiresAt ? expiresAt > new Date() : false

  return (
    <aside
      style={{
        padding: '20px 22px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
      }}
    >
      <MetaRow label="Setter" value={detail.setter_name ?? '—'} sub={detail.setter_role ?? undefined} />
      <MetaRow label="Prospect" value={detail.prospect_name ?? '—'} />
      <MetaRow label="When" value={whenLong} />
      <MetaRow label="Direction" value={detail.direction ?? '—'} />
      <MetaRow label="Duration" value={formatDurationLong(detail.duration_s)} />
      <MetaRow
        label="Transcription"
        value={`${detail.model} · ${detail.confidence != null ? (detail.confidence * 100).toFixed(1) + '%' : '—'} confidence`}
        sub={`request ${detail.deepgram_request_id.slice(0, 8)}…`}
      />
      <MetaRow
        label="Cost"
        value={detail.deepgram_cost_usd != null ? `$${detail.deepgram_cost_usd.toFixed(4)}` : '—'}
      />

      {/* Close playback — only useful within the 30-day window. */}
      <div
        style={{
          marginTop: 4,
          padding: '12px 14px',
          background: 'var(--color-geg-bg)',
          borderRadius: 6,
          fontSize: 12,
        }}
      >
        <div
          className="geg-mono"
          style={{
            fontSize: 9,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            color: 'var(--color-geg-text-faint)',
            marginBottom: 6,
          }}
        >
          Audio
        </div>
        {isPlayable ? (
          <a
            href={detail.close_app_url}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              color: 'var(--color-geg-accent)',
              textDecoration: 'none',
              fontSize: 12,
            }}
          >
            Open in Close →
          </a>
        ) : (
          <span style={{ color: 'var(--color-geg-text-faint)' }}>
            Recording expired{expiresAt ? ` ${formatRelative(expiresAt)}` : ''}
          </span>
        )}
      </div>
    </aside>
  )
}

function MetaRow({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div>
      <div
        className="geg-mono"
        style={{
          fontSize: 9,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-faint)',
          marginBottom: 4,
        }}
      >
        {label}
      </div>
      <div style={{ fontSize: 13, color: 'var(--color-geg-text)' }}>{value}</div>
      {sub ? (
        <div
          className="geg-mono"
          style={{ fontSize: 10, color: 'var(--color-geg-text-faint)', marginTop: 2 }}
        >
          {sub}
        </div>
      ) : null}
    </div>
  )
}

// ----------------------------------------------------------------------
// Formatters
// ----------------------------------------------------------------------

function formatDurationLong(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds - m * 60)
  return `${m}m ${s}s`
}

function formatTimestamp(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds - m * 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

function formatRelative(date: Date): string {
  const now = new Date()
  const diffMs = date.getTime() - now.getTime()
  const diffDays = Math.round(diffMs / 86400000)
  if (diffDays < 0) return `${Math.abs(diffDays)}d ago`
  if (diffDays === 0) return 'today'
  return `in ${diffDays}d`
}
