import Link from 'next/link'
import {
  MissingSlackChannelPill,
  MissingSlackUserPill,
  NpsStandingPill,
} from './pills'
import {
  EditableCsmStandingCell,
  EditableJourneyStageCell,
  EditablePrimaryCsmCell,
  EditableStatusCell,
  EditableTrustpilotCell,
} from './editable-cell'
import type { ClientsListRow } from '@/lib/db/clients'

// Clients redesign · § 1 — list table per the redesign mock.
//
// Visual rules:
//   - No outer box; rows separated by gold-border hairlines (the
//     globals.css `tbody td { border-bottom }` rule handles paint).
//   - Header: mono caps, gold-border bottom, " ↓" / " ↑" glyph in gold
//     on the active sort column.
//   - Cells: pills via GegPill, mono dates / counts, gradient health bar.
//
// Per Drake's caveat, ALL nine existing columns are preserved (Full
// name / Status / Journey stage / Primary CSM / CSM Standing / NPS
// standing / Trustpilot / Health score / Meetings this mo). The mock's
// 7-column reduction is not applied — only the visual language is.

type SortKey =
  | 'full_name'
  | 'status'
  | 'journey_stage'
  | 'primary_csm_name'
  | 'csm_standing'
  | 'nps_standing'
  | 'trustpilot_status'
  | 'latest_health_score'
  | 'meetings_this_month'
  | 'slack'

type ColumnDef = {
  key: SortKey
  label: string
  align?: 'right'
  width?: string
}

const COLUMNS: ColumnDef[] = [
  { key: 'full_name', label: 'Full name' },
  { key: 'status', label: 'Status', width: '120px' },
  { key: 'journey_stage', label: 'Journey stage', width: '170px' },
  { key: 'primary_csm_name', label: 'Primary CSM', width: '140px' },
  { key: 'csm_standing', label: 'CSM standing', width: '120px' },
  { key: 'nps_standing', label: 'NPS standing', width: '120px' },
  { key: 'trustpilot_status', label: 'Trustpilot', width: '110px' },
  { key: 'latest_health_score', label: 'Health', width: '120px' },
  {
    key: 'meetings_this_month',
    label: 'Meetings · mo',
    align: 'right',
    width: '120px',
  },
  // Slack hygiene badges (channel / user). Not sortable in V1 — the
  // SortableHeader still renders a link, but the page's sort whitelist
  // ignores 'slack' so the sort indicator never shows active on this
  // column. Filter chip on the bar handles the narrowing pattern.
  { key: 'slack', label: 'Slack', width: '180px' },
]

function SortableHeader({
  column,
  currentSort,
  currentDir,
  baseSearchParams,
}: {
  column: ColumnDef
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

function HealthCell({ score }: { score: number | null }) {
  if (score === null) {
    return <span style={{ color: 'var(--color-geg-text-3)' }}>—</span>
  }
  return (
    <span className="geg-health-cell">
      <span className="geg-health-cell-num">{score}</span>
      <span
        className="geg-health-cell-bar"
        style={{ ['--p' as string]: `${score}%` }}
      />
    </span>
  )
}

export function ClientsTable({
  rows,
  sort,
  dir,
  baseSearchParams,
  csmOptions,
  showSlackColumn,
}: {
  rows: ClientsListRow[]
  sort: SortKey
  dir: 'asc' | 'desc'
  baseSearchParams: URLSearchParams
  csmOptions: ReadonlyArray<{ id: string; full_name: string }>
  // Conditional render: the Slack column only appears when the user
  // has the Needs review or Missing Slack filter active. Drake's
  // preference is the pre-Slack-column visual layout when neither
  // filter is engaged. Detail page (/clients/[id]) still surfaces
  // missing-Slack badges unconditionally — different concern.
  showSlackColumn: boolean
}) {
  // Filter the Slack column out of COLUMNS when neither relevant
  // filter is active. Keeps the rest of the table layout identical
  // to the pre-Slack-column shipping.
  const visibleColumns = showSlackColumn
    ? COLUMNS
    : COLUMNS.filter((c) => c.key !== 'slack')

  if (rows.length === 0) {
    return (
      <div
        className="rounded-md p-12 text-center text-sm"
        style={{
          color: 'var(--color-geg-text-2)',
          border: '1px solid var(--color-geg-border)',
        }}
      >
        No clients match the current filters.
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
          {visibleColumns.map((column) => (
            <th
              key={column.key}
              className="geg-mono"
              style={{
                textAlign: column.align ?? 'left',
                width: column.width,
                padding: '14px 14px',
                fontSize: 10,
                fontWeight: 500,
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--color-geg-text-faint)',
                borderBottom: '1px solid var(--color-geg-accent-border)',
                whiteSpace: 'nowrap',
                cursor: 'pointer',
              }}
            >
              <SortableHeader
                column={column}
                currentSort={sort}
                currentDir={dir}
                baseSearchParams={baseSearchParams}
              />
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {(() => {
          // Encode the current list-page query as `?from=…` on every
          // row link so the detail page's Back button can return the
          // user to the same filtered view (sticky filters, spec § 3).
          // Empty when no params are set — bare /clients{id} link
          // preserves the original visual shape.
          const fromQs = baseSearchParams.toString()
          const fromParam = fromQs
            ? `?from=${encodeURIComponent(`/clients?${fromQs}`)}`
            : ''
          return rows.map((row) => (
          <tr key={row.id}>
            <td
              style={{
                padding: '14px 14px',
                fontSize: 13,
                verticalAlign: 'middle',
              }}
            >
              <Link
                href={`/clients/${row.id}${fromParam}`}
                className="geg-link"
                style={{
                  color: 'var(--color-geg-text)',
                  textDecoration: 'none',
                  borderBottom: '1px solid transparent',
                  fontWeight: 500,
                }}
              >
                {row.full_name}
              </Link>
            </td>
            <td style={{ padding: '14px 14px', verticalAlign: 'middle' }}>
              <EditableStatusCell clientId={row.id} value={row.status} />
            </td>
            <td style={{ padding: '14px 14px', verticalAlign: 'middle' }}>
              <EditableJourneyStageCell
                clientId={row.id}
                value={row.journey_stage}
              />
            </td>
            <td style={{ padding: '14px 14px', verticalAlign: 'middle' }}>
              <EditablePrimaryCsmCell
                clientId={row.id}
                value={row.primary_csm_id}
                options={csmOptions}
              />
            </td>
            <td style={{ padding: '14px 14px', verticalAlign: 'middle' }}>
              <EditableCsmStandingCell
                clientId={row.id}
                value={row.csm_standing}
              />
            </td>
            <td style={{ padding: '14px 14px', verticalAlign: 'middle' }}>
              <NpsStandingPill standing={row.nps_standing} />
            </td>
            <td style={{ padding: '14px 14px', verticalAlign: 'middle' }}>
              <EditableTrustpilotCell
                clientId={row.id}
                value={row.trustpilot_status}
              />
            </td>
            <td style={{ padding: '14px 14px', verticalAlign: 'middle' }}>
              <HealthCell score={row.latest_health_score} />
            </td>
            <td
              className="geg-mono"
              style={{
                padding: '14px 14px',
                fontSize: 12,
                color: 'var(--color-geg-text)',
                letterSpacing: '0.02em',
                textAlign: 'right',
                whiteSpace: 'nowrap',
                verticalAlign: 'middle',
              }}
            >
              {row.meetings_this_month}
            </td>
            {showSlackColumn ? (
              <td style={{ padding: '14px 14px', verticalAlign: 'middle' }}>
                {!row.slack_channel_id || !row.slack_user_id ? (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 4,
                      alignItems: 'flex-start',
                    }}
                  >
                    {!row.slack_channel_id ? <MissingSlackChannelPill /> : null}
                    {!row.slack_user_id ? <MissingSlackUserPill /> : null}
                  </div>
                ) : (
                  <span style={{ color: 'var(--color-geg-text-3)' }}>—</span>
                )}
              </td>
            ) : null}
          </tr>
        ))
        })()}
      </tbody>
    </table>
  )
}
