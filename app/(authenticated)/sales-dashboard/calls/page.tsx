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

export default async function SalesDashboardCallsPage({
  searchParams,
}: {
  searchParams?: { setter?: string | string[] }
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

  const rows = await listSetterCalls({
    setterCloseUserId: setterFilter ?? undefined,
  })

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
        <CallsTable rows={rows} />
      )}
    </div>
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
          gridTemplateColumns: '180px 180px 160px 100px 110px 90px 1fr',
          gap: 0,
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
        <div>Setter</div>
        <div>Prospect</div>
        <div>Duration</div>
        <div>Direction</div>
        <div>Speakers</div>
        <div style={{ textAlign: 'right' }}>Cost</div>
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
        gridTemplateColumns: '180px 180px 160px 100px 110px 90px 1fr',
        gap: 0,
        padding: '14px 20px',
        borderBottom: '1px solid var(--color-geg-border)',
        color: 'var(--color-geg-text)',
        textDecoration: 'none',
        fontSize: 13,
        transition: 'background 80ms ease',
      }}
      // Hover affordance — uses CSS var so the row matches sidebar accent.
      className="setter-call-row"
    >
      <div className="geg-mono" style={{ color: 'var(--color-geg-text-2)', fontSize: 12 }}>
        {when}
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
      <div className="geg-mono" style={{ fontSize: 12, color: 'var(--color-geg-text-3)' }}>
        {row.speaker_count ?? '—'}
      </div>
      <div
        className="geg-mono"
        style={{
          fontSize: 11,
          color: 'var(--color-geg-text-faint)',
          textAlign: 'right',
        }}
      >
        {row.deepgram_cost_usd != null ? `$${row.deepgram_cost_usd.toFixed(4)}` : '—'}
      </div>
    </Link>
  )
}

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds - m * 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}
