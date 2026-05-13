import {
  getEllaRunsList,
  getEllaSummaryStats,
  listChannelsWithEllaRuns,
  type EllaRunsListFilters,
} from '@/lib/db/ella-runs'
import { HeaderBand } from '@/components/gregory/header-band'
import { EllaRunsFilterBar } from './filter-bar'
import { EllaRunsSummaryBand } from './summary-band'
import { EllaRunsTable } from './runs-table'
import Link from 'next/link'

// Part 2 redesign — composes Part 1 primitives (HeaderBand).
// Speaker-role and anomaly URL params are no longer parsed: the data
// layer still accepts them on EllaRunsListFilters, but the UI doesn't
// surface them, so bookmarked filtered URLs stop displaying their
// active filter (acceptable per spec; bookmarked filters are rare for
// an internal audit dashboard).

const DEFAULT_PAGE_SIZE = 100

function readFilters(
  searchParams: Record<string, string | string[] | undefined>,
): EllaRunsListFilters {
  const get = (key: string): string | undefined => {
    const v = searchParams[key]
    return Array.isArray(v) ? v[0] : v
  }
  const list = (key: string): string[] => {
    const v = get(key)
    return v ? v.split(',').filter(Boolean) : []
  }

  return {
    from: get('from'),
    to: get('to'),
    channels: list('channel'),
    statuses: list('status'),
  }
}

function readLimit(
  searchParams: Record<string, string | string[] | undefined>,
): number {
  const raw = Array.isArray(searchParams.limit)
    ? searchParams.limit[0]
    : searchParams.limit
  if (!raw) return DEFAULT_PAGE_SIZE
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return DEFAULT_PAGE_SIZE
  // Cap at 10k just to prevent a runaway URL param. Realistically the
  // largest reasonable value here is in the low thousands at current
  // run volumes.
  return Math.min(parsed, 10_000)
}

export default async function EllaRunsPage({
  searchParams,
}: {
  searchParams: Record<string, string | string[] | undefined>
}) {
  const filters = readFilters(searchParams)
  const limit = readLimit(searchParams)
  const [{ rows, total }, stats, channelOptions] = await Promise.all([
    getEllaRunsList(filters, { limit }),
    getEllaSummaryStats(),
    listChannelsWithEllaRuns(),
  ])

  const channelDropdownOptions = channelOptions
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => ({ value: c.slack_channel_id, label: c.name }))

  // Build the "Load 100 more" href: preserve all current URL params
  // and increment ?limit by DEFAULT_PAGE_SIZE. URL-state preferred over
  // local state so the deeper view is shareable.
  const nextLimit = limit + DEFAULT_PAGE_SIZE
  const loadMoreParams = new URLSearchParams()
  for (const [k, v] of Object.entries(searchParams)) {
    if (k === 'limit') continue
    if (Array.isArray(v)) {
      if (v[0] !== undefined) loadMoreParams.set(k, v[0])
    } else if (v !== undefined) {
      loadMoreParams.set(k, v)
    }
  }
  loadMoreParams.set('limit', String(nextLimit))
  const loadMoreHref = `/ella/runs?${loadMoreParams.toString()}`
  const showLoadMore = rows.length >= limit && rows.length < total

  return (
    <div style={{ padding: '32px 48px 28px' }}>
      <HeaderBand
        eyebrow="ELLA · AUDIT"
        title="Run history."
        actions={
          <span
            className="geg-mono"
            style={{
              fontSize: 11,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-2)',
            }}
          >
            <b style={{ color: 'var(--color-geg-text)', fontWeight: 500 }}>
              {total.toLocaleString()}
            </b>{' '}
            {total === 1 ? 'RUN' : 'RUNS'}
          </span>
        }
      />

      <div style={{ marginTop: 24 }}>
        <EllaRunsSummaryBand stats={stats} />
        <EllaRunsFilterBar channelOptions={channelDropdownOptions} />
        <EllaRunsTable rows={rows} />
      </div>

      {showLoadMore ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            marginTop: 24,
          }}
        >
          <Link
            href={loadMoreHref}
            className="geg-mono"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '10px 18px',
              border: '1px solid var(--color-geg-accent-border)',
              borderRadius: 6,
              fontSize: 11,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-accent)',
              background: 'var(--color-geg-accent-fill)',
              textDecoration: 'none',
            }}
          >
            Load 100 more
            <span
              style={{
                color: 'var(--color-geg-text-faint)',
                letterSpacing: '0.02em',
                textTransform: 'none',
              }}
            >
              ({rows.length} of {total})
            </span>
          </Link>
        </div>
      ) : rows.length > 0 && rows.length >= total ? (
        <div
          className="geg-mono"
          style={{
            textAlign: 'center',
            marginTop: 24,
            fontSize: 11,
            letterSpacing: '0.02em',
            color: 'var(--color-geg-text-faint)',
          }}
        >
          End of results — {total} runs.
        </div>
      ) : null}
    </div>
  )
}
