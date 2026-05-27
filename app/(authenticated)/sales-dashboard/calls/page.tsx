import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import { listSetterCalls, type SetterCallListRow } from '@/lib/db/setter-calls'
import { PersonPill } from '../header-pills'

// Sales Dashboard · Calls.
//
// Lists every transcribed setter/closer-setter call (close_calls with
// recording >= 90s, since 2026-05-24 horizon). Newest first. Clicking a
// row → /sales-dashboard/calls/[close_id] detail page.
//
// Drake's read of the V1 use case is: he reads transcripts to (a)
// pick 10-20 golden calls for the Sonnet review prompt, and (b) spot-
// check setter performance ad-hoc. Volume is small (<60 rows in the
// first month), so we render flat with no pagination.
//
// HARD ISOLATION FROM CS: this page reads ONLY from setter_call_*
// tables + close_calls (sales mirror). Never from `calls`, `documents`,
// or any Ella-touched surface.

export const dynamic = 'force-dynamic'

const PAGE_SIZE = 50

export default async function SalesDashboardCallsPage({
  searchParams,
}: {
  searchParams?: { setter?: string | string[]; page?: string | string[] }
}) {
  // Optional setter filter via ?setter=user_xxx — deep-linked from the
  // funnel/appointment-setting per-rep table. Strict prefix check
  // rejects bogus values silently (treat them as "show all").
  const setterParamRaw = Array.isArray(searchParams?.setter)
    ? searchParams?.setter[0]
    : searchParams?.setter
  const setterFilter =
    typeof setterParamRaw === 'string' && setterParamRaw.startsWith('user_')
      ? setterParamRaw
      : null

  const pageParamRaw = Array.isArray(searchParams?.page)
    ? searchParams?.page[0]
    : searchParams?.page
  const requestedPage = Number.parseInt(pageParamRaw ?? '1', 10)
  const page = Number.isFinite(requestedPage) && requestedPage > 0 ? requestedPage : 1

  // V1 pagination: fetch all eligible rows, slice in JS. Cheap at
  // current volume (<200 transcripts). Move to DB-level limit/offset
  // when the list grows past ~1000 rows.
  const allRows = await listSetterCalls({
    setterCloseUserId: setterFilter ?? undefined,
  })
  const total = allRows.length
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE))
  // Clamp page to a valid index — direct URL-bar entries of page=99
  // shouldn't blank the table.
  const safePage = Math.min(page, pageCount)
  const start = (safePage - 1) * PAGE_SIZE
  const rows = allRows.slice(start, start + PAGE_SIZE)

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · CALLS"
        title="Calls."
        actions={<PersonPill label="EST · Nabeel" />}
      />

      <p
        style={{
          color: 'var(--color-geg-text-2)',
          fontSize: 13,
          maxWidth: 720,
          marginTop: 18,
        }}
      >
        Every Close call recording over 90 seconds since 2026-05-24, transcribed
        via Deepgram. AI review is coming after the golden-set pass — for now,
        click a row to read the raw diarized transcript.
      </p>

      {setterFilter ? <ActiveFilterPill setterId={setterFilter} /> : null}

      {rows.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <CallsTable rows={rows} />
          <Pagination
            page={safePage}
            pageCount={pageCount}
            total={total}
            start={start}
            shown={rows.length}
            setterFilter={setterFilter}
          />
        </>
      )}
    </div>
  )
}

function Pagination({
  page,
  pageCount,
  total,
  start,
  shown,
  setterFilter,
}: {
  page: number
  pageCount: number
  total: number
  start: number
  shown: number
  setterFilter: string | null
}) {
  const buildHref = (nextPage: number) => {
    const params = new URLSearchParams()
    if (setterFilter) params.set('setter', setterFilter)
    if (nextPage > 1) params.set('page', String(nextPage))
    const qs = params.toString()
    return qs ? `/sales-dashboard/calls?${qs}` : '/sales-dashboard/calls'
  }
  const hasPrev = page > 1
  const hasNext = page < pageCount
  return (
    <div
      style={{
        marginTop: 16,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
      }}
    >
      <span
        className="geg-mono"
        style={{
          fontSize: 11,
          color: 'var(--color-geg-text-3)',
          letterSpacing: '0.08em',
        }}
      >
        Showing {start + 1}–{start + shown} of {total}
      </span>
      <div style={{ display: 'flex', gap: 8 }}>
        <PageButton href={buildHref(page - 1)} disabled={!hasPrev}>
          ← Previous
        </PageButton>
        <PageButton href={buildHref(page + 1)} disabled={!hasNext}>
          See next {Math.min(PAGE_SIZE, total - start - shown)} →
        </PageButton>
      </div>
    </div>
  )
}

function PageButton({
  href,
  disabled,
  children,
}: {
  href: string
  disabled: boolean
  children: React.ReactNode
}) {
  const style: React.CSSProperties = {
    padding: '6px 12px',
    fontSize: 11,
    letterSpacing: '0.08em',
    borderRadius: 6,
    border: '1px solid var(--color-geg-border)',
    color: disabled ? 'var(--color-geg-text-faint)' : 'var(--color-geg-text)',
    background: disabled ? 'transparent' : 'var(--color-geg-bg-elev)',
    textDecoration: 'none',
    fontFamily: 'var(--font-geg-mono, "JetBrains Mono", ui-monospace, monospace)',
    pointerEvents: disabled ? 'none' : undefined,
    opacity: disabled ? 0.55 : 1,
  }
  if (disabled) {
    return <span style={style}>{children}</span>
  }
  return (
    <Link href={href} style={style}>
      {children}
    </Link>
  )
}

function ActiveFilterPill({ setterId }: { setterId: string }) {
  return (
    <div
      className="geg-mono"
      style={{
        marginTop: 14,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        background: 'var(--color-geg-accent-fill)',
        border: '1px solid var(--color-geg-accent)',
        borderRadius: 6,
        fontSize: 10,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-accent)',
      }}
    >
      <span>FILTERED · {setterId.slice(0, 13)}…</span>
      <Link
        href="/sales-dashboard/calls"
        style={{ color: 'var(--color-geg-accent)', textDecoration: 'none' }}
      >
        clear ✕
      </Link>
    </div>
  )
}

function EmptyState() {
  return (
    <section
      style={{
        marginTop: 36,
        padding: '40px 24px',
        background: 'var(--color-geg-bg-elev)',
        border: '1px dashed var(--color-geg-border)',
        borderRadius: 10,
        textAlign: 'center',
        color: 'var(--color-geg-text-3)',
        fontSize: 13,
      }}
    >
      No transcripts yet. The cron sweeper picks up new Close recordings every 15 minutes.
    </section>
  )
}

// Column template — kept in one place so header + rows stay in sync.
const CALLS_GRID =
  '150px 70px 60px 1fr 1fr 80px 70px 1fr'
//  when    score  dq    setter  prospect  dur    dir    sentiment

function CallsTable({ rows }: { rows: SetterCallListRow[] }) {
  return (
    <section
      style={{
        marginTop: 24,
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: CALLS_GRID,
          gap: 12,
          padding: '14px 20px',
          borderBottom: '1px solid var(--color-geg-border)',
          background: 'var(--color-geg-bg)',
          fontSize: 10,
          letterSpacing: '0.16em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
          fontFamily: 'var(--font-prom-sans), Inter, system-ui, sans-serif',
        }}
      >
        <div>When</div>
        <div>Score</div>
        <div>DQ</div>
        <div>Setter</div>
        <div>Prospect</div>
        <div>Duration</div>
        <div>Direction</div>
        <div>Sentiment</div>
      </div>
      {rows.map((row) => (
        <CallRow key={row.close_call_id} row={row} />
      ))}
    </section>
  )
}

function CallRow({ row }: { row: SetterCallListRow }) {
  const date = new Date(row.activity_at)
  const when = date.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  })

  return (
    <Link
      href={`/sales-dashboard/calls/${encodeURIComponent(row.close_call_id)}`}
      style={{
        display: 'grid',
        gridTemplateColumns: CALLS_GRID,
        gap: 12,
        padding: '14px 20px',
        borderBottom: '1px solid var(--color-geg-border)',
        color: 'var(--color-geg-text)',
        textDecoration: 'none',
        fontSize: 13,
        transition: 'background 80ms ease',
        alignItems: 'center',
      }}
      className="setter-call-row"
    >
      <div className="geg-mono" style={{ color: 'var(--color-geg-text-2)', fontSize: 12 }}>
        {when}
      </div>
      <div>
        {row.review ? (
          <ScoreChip score={row.review.lead_score} />
        ) : (
          <span style={{ color: 'var(--color-geg-text-faint)', fontSize: 11 }}>—</span>
        )}
      </div>
      <div>
        {row.review?.should_be_dqd ? (
          <DqChip />
        ) : (
          <span style={{ color: 'var(--color-geg-text-faint)', fontSize: 11 }}>·</span>
        )}
      </div>
      <div>
        {row.setter_name ?? <span style={{ color: 'var(--color-geg-text-faint)' }}>Unknown user</span>}
        {row.setter_role ? (
          <span
            className="geg-mono"
            style={{
              marginLeft: 6,
              fontSize: 9,
              color: 'var(--color-geg-text-faint)',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
            }}
          >
            {row.setter_role}
          </span>
        ) : null}
      </div>
      <div style={{ color: 'var(--color-geg-text-2)' }}>
        {row.prospect_name ?? <span style={{ color: 'var(--color-geg-text-faint)' }}>—</span>}
      </div>
      <div className="geg-mono" style={{ fontSize: 12 }}>{formatDuration(row.duration_s)}</div>
      <div
        className="geg-mono"
        style={{
          fontSize: 11,
          color: 'var(--color-geg-text-3)',
          letterSpacing: '0.08em',
        }}
      >
        {row.direction ?? '—'}
      </div>
      <div
        style={{
          fontSize: 12,
          lineHeight: 1.4,
          color: 'var(--color-geg-text-2)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}
        title={row.review?.sentiment ?? undefined}
      >
        {row.review?.sentiment ?? (
          <span
            style={{
              color: 'var(--color-geg-text-faint)',
              fontStyle: 'italic',
              fontSize: 11,
            }}
          >
            Review pending
          </span>
        )}
      </div>
    </Link>
  )
}

function ScoreChip({ score }: { score: number }) {
  // 0-3 red, 4-6 neutral, 7-10 green — same color contract as the
  // detail page ScorePill.
  const tone =
    score <= 3
      ? { color: 'var(--color-geg-neg)', bg: 'var(--color-geg-neg-fill)', border: 'var(--color-geg-neg-border)' }
      : score <= 6
        ? { color: 'var(--color-geg-text-2)', bg: 'var(--color-geg-bg)', border: 'var(--color-geg-border)' }
        : { color: 'var(--color-geg-pos)', bg: 'var(--color-geg-pos-fill)', border: 'var(--color-geg-pos-border)' }
  return (
    <span
      className="geg-mono"
      title={`Lead score ${score}/10`}
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 4,
        border: `1px solid ${tone.border}`,
        background: tone.bg,
        color: tone.color,
        fontSize: 12,
        fontWeight: 500,
        letterSpacing: '0.04em',
        minWidth: 24,
        textAlign: 'center',
      }}
    >
      {score}
    </span>
  )
}

function DqChip() {
  return (
    <span
      className="geg-mono"
      title="Setter call review flagged this lead for DQ — verify before acting"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '2px 6px',
        borderRadius: 4,
        border: '1px solid var(--color-geg-neg-border)',
        background: 'var(--color-geg-neg-fill)',
        color: 'var(--color-geg-neg)',
        fontSize: 9,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        fontWeight: 500,
      }}
    >
      DQ
    </span>
  )
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds - m * 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
