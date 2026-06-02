import { HeaderBand } from '@/components/gregory/header-band'
import { getLeadTagLog, type TagRunException } from '@/lib/db/lead-tag-log'

// Admin retag-log — EXCEPTION ONLY. Surfaces tagger runs that errored or
// produced an anomaly (a set-once identity tag that changed = bug/drift). A
// clean page (no exceptions) is the expected steady state; the context strip
// shows the tagger is alive + its 24h volume. See shared/lead_tagging.py.

export const dynamic = 'force-dynamic'

function fmtEt(iso: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(iso))
}

export default async function LeadTagLogPage() {
  const { exceptions, lastRunAt, runsLast24h, errorsLast24h } = await getLeadTagLog()

  return (
    <div style={{ padding: '32px 48px 64px', maxWidth: 1280, width: '100%' }}>
      <HeaderBand eyebrow="CEO" title="Lead tag log." />

      {/* Context strip — proves the tagger is alive even when there's nothing to flag. */}
      <div
        style={{
          display: 'flex',
          gap: 28,
          marginTop: 24,
          padding: '14px 20px',
          background: 'var(--color-geg-bg-elev)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 8,
          fontSize: 13,
          color: 'var(--color-geg-text-dim)',
        }}
      >
        <span>Last run: <strong style={{ color: 'var(--color-geg-text)' }}>{lastRunAt ? fmtEt(lastRunAt) : '—'}</strong></span>
        <span>Runs (24h): <strong style={{ color: 'var(--color-geg-text)' }}>{runsLast24h}</strong></span>
        <span>Errors (24h): <strong style={{ color: errorsLast24h ? 'var(--color-geg-neg)' : 'var(--color-geg-text)' }}>{errorsLast24h}</strong></span>
      </div>

      {exceptions.length === 0 ? (
        <div
          style={{
            marginTop: 24,
            padding: '40px 20px',
            textAlign: 'center',
            background: 'var(--color-geg-accent-fill)',
            border: '1px solid var(--color-geg-border)',
            borderRadius: 8,
            color: 'var(--color-geg-text)',
          }}
        >
          ✓ No exceptions — every recent tagger run succeeded with no anomalies.
        </div>
      ) : (
        <div style={{ marginTop: 24, display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="geg-eyebrow" style={{ color: 'var(--color-geg-neg)' }}>
            {exceptions.length} exception{exceptions.length === 1 ? '' : 's'} (errors + anomalies)
          </div>
          {exceptions.map((row) => (
            <ExceptionRow key={row.id} row={row} fmtEt={fmtEt} />
          ))}
        </div>
      )}
    </div>
  )
}

function ExceptionRow({ row, fmtEt }: { row: TagRunException; fmtEt: (iso: string) => string }) {
  const isError = !row.ok
  return (
    <div
      style={{
        padding: '14px 18px',
        background: 'var(--color-geg-bg-elev)',
        border: `1px solid ${isError ? 'var(--color-geg-neg)' : 'var(--color-geg-border)'}`,
        borderRadius: 8,
      }}
    >
      <div style={{ display: 'flex', gap: 14, alignItems: 'baseline', flexWrap: 'wrap' }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
            color: isError ? 'var(--color-geg-neg)' : 'var(--color-geg-accent)',
          }}
        >
          {isError ? 'ERROR' : 'ANOMALY'}
        </span>
        <span style={{ fontSize: 13, color: 'var(--color-geg-text)' }}>{row.trigger}</span>
        <span style={{ fontSize: 12, color: 'var(--color-geg-text-dim)' }}>{fmtEt(row.ran_at)}</span>
        <span style={{ fontSize: 12, color: 'var(--color-geg-text-dim)' }}>
          {row.lead_count ?? 0} lead{row.lead_count === 1 ? '' : 's'}
          {row.duration_ms != null ? ` · ${row.duration_ms}ms` : ''}
        </span>
      </div>

      {isError && row.error && (
        <pre
          style={{
            marginTop: 10,
            fontSize: 12,
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word',
            color: 'var(--color-geg-text-dim)',
            background: 'var(--color-geg-bg)',
            padding: '10px 12px',
            borderRadius: 6,
            maxHeight: 200,
            overflow: 'auto',
          }}
        >
          {row.error}
        </pre>
      )}

      {!isError && row.anomalies && row.anomalies.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {row.anomalies.map((a, i) => (
            <div key={i} style={{ fontSize: 12, color: 'var(--color-geg-text)' }}>
              <code style={{ color: 'var(--color-geg-text-dim)' }}>{a.close_id}</code>{' '}
              <strong>{a.kind}</strong>: {a.detail}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
