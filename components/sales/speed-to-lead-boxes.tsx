import type { SpeedToLeadCohortResult } from '@/lib/db/funnel-appointment-setting'

// Speed-to-Lead metric boxes — the four top-line stats from the
// appointment-setting page's Speed-to-Lead section, WITHOUT the per-lead
// drill list. Scoped to whatever range the caller fetched the cohort for.
//
// Ported so the leads page can show these against its own date range. An
// optional `filter` slot renders a fifth cell (the per-rep caller filter)
// when a caller-companion list is present; the leads page omits it.
//
// "Connected" = first call to the lead landed over 90s (the same
// engagement proxy used elsewhere; relabeled away from ">90s" so
// non-engineers don't have to decode the unit).

export function SpeedToLeadBoxes({
  cohort,
  activeCaller,
  filter,
  connectedLeads,
}: {
  cohort: SpeedToLeadCohortResult
  activeCaller?: string | null
  filter?: React.ReactNode
  // Broad form-OR-call connected count (matches the funnel's Connected). When
  // provided it overrides the cohort's dial-only count so "connected" is one
  // number everywhere; the rate becomes reached / cohort.
  connectedLeads?: number
}) {
  const reached = connectedLeads ?? cohort.leadsConnected
  const reachedRate =
    connectedLeads !== undefined
      ? cohort.cohortSize > 0
        ? reached / cohort.cohortSize
        : null
      : cohort.connectedRate
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: filter ? 'repeat(4, minmax(0, 1fr)) auto' : 'repeat(4, minmax(0, 1fr))',
        gap: 1,
        background: 'var(--color-geg-border)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        overflow: 'hidden',
        alignItems: 'stretch',
      }}
    >
      <StatCell
        label="Avg speed to lead (< 3h)"
        value={cohort.avgSpeedToLeadSecUnder3h !== null ? formatDuration(cohort.avgSpeedToLeadSecUnder3h) : '—'}
        subtext={
          <>
            <div>
              {`${cohort.leadsCalled} leads called${activeCaller ? ' (filtered)' : ''}`}
            </div>
            {cohort.avgSpeedToLeadSec !== null ? (
              <div
                title={`All-time avg includes every called lead in the cohort, with a 24h outlier cap on individual contributions. ${cohort.leadsCalled - cohort.leadsUnder3h} leads were first-called more than 3 hours after creation.`}
              >
                All-time STL: {formatDuration(cohort.avgSpeedToLeadSec)}{' '}
                <span style={{ color: 'var(--color-geg-text-faint)' }}>
                  · {cohort.leadsCalled - cohort.leadsUnder3h} outside 3h
                </span>
              </div>
            ) : null}
          </>
        }
      />
      <StatCell
        label="Avg intensity"
        value={cohort.avgIntensity !== null ? `${cohort.avgIntensity.toFixed(1)}×` : '—'}
        subtext={`mean dials per called lead`}
      />
      <StatCell
        label="Connected rate"
        value={reachedRate !== null ? `${(reachedRate * 100).toFixed(0)}%` : '—'}
        subtext={
          connectedLeads !== undefined
            ? `${reached} / ${cohort.cohortSize} leads reached (call or form)`
            : `${cohort.leadsConnected} / ${cohort.leadsCalled} leads reached (any dial)`
        }
      />
      <StatCell
        label="Cohort size"
        value={cohort.cohortSize.toString()}
        subtext={activeCaller ? 'leads matching filter' : 'leads in window'}
      />
      {filter ? (
        <div style={{ padding: '16px 18px 14px', background: 'var(--color-geg-bg-elev)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {filter}
        </div>
      ) : null}
    </div>
  )
}

function StatCell({
  label,
  value,
  subtext,
}: {
  label: string
  value: string
  // ReactNode (not string) so callers can render multiple lines.
  subtext?: React.ReactNode
}) {
  return (
    <div style={{ padding: '16px 18px 14px', background: 'var(--color-geg-bg-elev)' }}>
      <div
        className="geg-mono"
        style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          textTransform: 'uppercase',
          color: 'var(--color-geg-text-3)',
          marginBottom: 8,
        }}
      >
        {label}
      </div>
      <div
        className="geg-numeric-serif"
        style={{
          fontSize: 28,
          lineHeight: '32px',
          letterSpacing: '-0.02em',
          color: 'var(--color-geg-text)',
        }}
      >
        {value}
      </div>
      {subtext ? (
        <div
          className="geg-mono"
          style={{
            fontSize: 10,
            letterSpacing: '0.08em',
            color: 'var(--color-geg-text-faint)',
            marginTop: 6,
          }}
        >
          {subtext}
        </div>
      ) : null}
    </div>
  )
}

function formatDuration(sec: number): string {
  if (sec < 60) return `${Math.round(sec)}s`
  if (sec < 3600) {
    const m = Math.floor(sec / 60)
    const s = Math.round(sec - m * 60)
    return `${m}m ${s.toString().padStart(2, '0')}s`
  }
  const h = Math.floor(sec / 3600)
  const m = Math.round((sec - h * 3600) / 60)
  return `${h}h ${m}m`
}
