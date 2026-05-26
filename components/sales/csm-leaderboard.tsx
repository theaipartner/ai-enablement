// People · CSMs leaderboard.
//
// Structure-only: the intended columns are visible but the data is
// pending — no backend cash mirror, no client-sentiment classifier,
// no TrustPilot ingest yet. Renders a clean empty-state per Gregory
// convention rather than mock numbers (would mislead more than help).

export function CsmLeaderboard() {
  const columns = [
    'CSM',
    'Backend cash',
    'Sentiment',
    'Calls held',
    'TrustPilots',
    'Book of clients',
  ]
  return (
    <section
      aria-label="CSM leaderboard"
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
          gridTemplateColumns: '1.4fr 1fr 1fr 100px 1fr 110px',
          gap: 12,
          padding: '12px 22px',
          background: 'var(--color-geg-bg)',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        {columns.map((label, i) => (
          <span
            key={label}
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-faint)',
              textAlign: i === 0 ? 'left' : 'right',
            }}
          >
            {label}
          </span>
        ))}
      </div>
      <EmptyState />
    </section>
  )
}

function EmptyState() {
  return (
    <div
      style={{
        padding: '44px 28px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
        alignItems: 'center',
        textAlign: 'center',
      }}
    >
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-warn)',
        }}
      >
        AWAITING UPSTREAM DATA
      </div>
      <div
        className="geg-serif"
        style={{
          fontSize: 15,
          color: 'var(--color-geg-text-2)',
          letterSpacing: '-0.005em',
          maxWidth: 560,
          lineHeight: 1.55,
        }}
      >
        CSM metrics need backend revenue attribution (renewals / upsells / masterminds
        joined to a CSM-owner field), call-transcript sentiment classification, a
        TrustPilot ingest, and a client-roster mirror. None of those are wired yet —
        rather than fake numbers, the table waits.
      </div>
      <div
        className="geg-serif"
        style={{
          fontSize: 13,
          color: 'var(--color-geg-text-3)',
          fontStyle: 'italic',
          maxWidth: 560,
        }}
      >
        Once those land, this view fills with one row per CSM ranked by backend cash
        + book-of-clients health. Click-through opens their client book.
      </div>
    </div>
  )
}
