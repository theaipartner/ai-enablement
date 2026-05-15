import Link from 'next/link'
import { SentimentPill } from '@/components/gregory/sentiment-pill'
import type { CallsListRow } from '@/lib/db/calls'

// Calls redesign · § 1 — table per Design's call list mock.
//
//   - No outer box: the <table> sits flush on the page surface; row
//     dividers (1px gold-border at 0.40 alpha) carry the visual rhythm.
//   - Columns: Date · Title · Primary client · CSM · Sentiment · Duration
//     (right-aligned). Category column removed — list is pre-filtered to
//     category='client' at the data layer.
//   - Sort header glyph: " ↓" or " ↑" in gold once a column is active.

type SortKey =
  | 'started_at'
  | 'title'
  | 'primary_client_name'
  | 'csm_team_member_name'
  | 'duration_seconds'

type ColumnDef =
  | {
      kind: 'sort'
      key: SortKey
      label: string
      align?: 'right'
      width?: string
    }
  | {
      kind: 'static'
      label: string
      width?: string
    }

const COLUMNS: ColumnDef[] = [
  { kind: 'sort', key: 'started_at', label: 'Date', width: '96px' },
  { kind: 'sort', key: 'title', label: 'Title' },
  {
    kind: 'sort',
    key: 'primary_client_name',
    label: 'Primary client',
    width: '180px',
  },
  {
    kind: 'sort',
    key: 'csm_team_member_name',
    label: 'CSM',
    width: '140px',
  },
  { kind: 'static', label: 'Sentiment', width: '130px' },
  {
    kind: 'sort',
    key: 'duration_seconds',
    label: 'Duration',
    align: 'right',
    width: '90px',
  },
]

function SortableHeader({
  column,
  currentSort,
  currentDir,
  baseSearchParams,
}: {
  column: Extract<ColumnDef, { kind: 'sort' }>
  currentSort: string
  currentDir: 'asc' | 'desc'
  baseSearchParams: URLSearchParams
}) {
  const params = new URLSearchParams(baseSearchParams)
  const nextDir =
    currentSort === column.key && currentDir === 'desc' ? 'asc' : 'desc'
  params.set('sort', column.key)
  params.set('dir', nextDir)
  const href = `?${params.toString()}`
  const active = currentSort === column.key
  const glyph = active ? (currentDir === 'desc' ? ' ↓' : ' ↑') : ''
  return (
    <Link
      href={href}
      style={{
        color: active ? 'var(--color-geg-accent)' : undefined,
        textDecoration: 'none',
      }}
    >
      {column.label}
      {glyph}
    </Link>
  )
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return '—'
  const mm = Math.floor(seconds / 60)
  const ss = seconds % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
}

export function CallsTable({
  rows,
  sort,
  dir,
  baseSearchParams,
}: {
  rows: CallsListRow[]
  sort: SortKey
  dir: 'asc' | 'desc'
  baseSearchParams: URLSearchParams
}) {
  if (rows.length === 0) {
    return (
      <div
        className="rounded-md p-12 text-center text-sm"
        style={{
          color: 'var(--color-geg-text-2)',
          border: '1px solid var(--color-geg-border)',
        }}
      >
        No calls match the current filters.
      </div>
    )
  }
  return (
    <table
      className="w-full"
      style={{
        borderCollapse: 'separate',
        borderSpacing: 0,
        marginTop: 4,
      }}
    >
      <thead>
        <tr>
          {COLUMNS.map((column, idx) => (
            <th
              key={column.kind === 'sort' ? column.key : `static-${idx}`}
              className="geg-mono"
              style={{
                textAlign:
                  column.kind === 'sort' && column.align ? column.align : 'left',
                width: column.width,
                padding: '14px 16px',
                fontSize: 10,
                fontWeight: 500,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--color-geg-text-faint)',
                borderBottom: '1px solid var(--color-geg-accent-border)',
                whiteSpace: 'nowrap',
                cursor: column.kind === 'sort' ? 'pointer' : 'default',
              }}
            >
              {column.kind === 'sort' ? (
                <SortableHeader
                  column={column}
                  currentSort={sort}
                  currentDir={dir}
                  baseSearchParams={baseSearchParams}
                />
              ) : (
                column.label
              )}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(() => {
          // Sticky filters: encode the current list-page query string
          // as `?from=…` on the title link so the detail page's Back
          // button returns the user to the same filtered/sorted view.
          // Empty string when no params are set, so default visits
          // get a clean `/calls/{id}` link.
          const fromQs = baseSearchParams.toString()
          const fromParam = fromQs
            ? `?from=${encodeURIComponent(`/calls?${fromQs}`)}`
            : ''
          return rows.map((row) => (
          <tr
            key={row.id}
            style={{ transition: 'background 80ms ease' }}
          >
            <td
              className="geg-mono"
              style={{
                padding: '14px 16px',
                fontSize: 12,
                color: 'var(--color-geg-text-2)',
                whiteSpace: 'nowrap',
                letterSpacing: '0.02em',
                verticalAlign: 'middle',
              }}
            >
              {formatDate(row.started_at)}
            </td>
            <td
              style={{
                padding: '14px 16px',
                fontSize: 13,
                color: 'var(--color-geg-text)',
                verticalAlign: 'middle',
              }}
            >
              <Link
                href={`/calls/${row.id}${fromParam}`}
                className="geg-link"
                style={{
                  color: 'var(--color-geg-text)',
                  textDecoration: 'none',
                  borderBottom: '1px solid transparent',
                }}
              >
                {row.title ?? 'Untitled call'}
              </Link>
            </td>
            <td
              style={{
                padding: '14px 16px',
                fontSize: 13,
                color: 'var(--color-geg-text-2)',
                verticalAlign: 'middle',
              }}
            >
              {row.primary_client_id && row.primary_client_name ? (
                <Link
                  href={`/clients/${row.primary_client_id}`}
                  className="geg-link"
                  style={{
                    color: 'var(--color-geg-text-2)',
                    textDecoration: 'none',
                  }}
                >
                  {row.primary_client_name}
                </Link>
              ) : (
                <span style={{ color: 'var(--color-geg-text-3)' }}>—</span>
              )}
            </td>
            <td
              style={{
                padding: '14px 16px',
                fontSize: 13,
                color: 'var(--color-geg-text-2)',
                verticalAlign: 'middle',
              }}
            >
              {row.csm_team_member_name ?? (
                <span style={{ color: 'var(--color-geg-text-3)' }}>—</span>
              )}
            </td>
            <td
              style={{ padding: '14px 16px', verticalAlign: 'middle' }}
            >
              <SentimentPill tier={row.sentiment_tier} />
            </td>
            <td
              className="geg-mono"
              style={{
                padding: '14px 16px',
                fontSize: 12,
                color: 'var(--color-geg-text-2)',
                letterSpacing: '0.02em',
                textAlign: 'right',
                whiteSpace: 'nowrap',
                verticalAlign: 'middle',
              }}
            >
              {formatDuration(row.duration_seconds)}
            </td>
          </tr>
        ))
        })()}
      </tbody>
    </table>
  )
}
