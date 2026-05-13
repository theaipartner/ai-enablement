import Link from 'next/link'
import type { EllaRunsListRow } from '@/lib/db/ella-runs'
import { CellWhen, RolePill, RunStatusPill } from './pills'

// Editorial Ella audit list — matches the Calls + Clients table chrome.
// Native <table> picks up the theme-scoped gold-divider tbody td rules
// from app/globals.css; per-cell padding + typography is inline so the
// rhythm matches the design handoff exactly.
//
// Columns: When (2-line rel + abs) · Channel (#name + client_name) ·
// Who Ella responded to (name + role pill) · Status (pill) ·
// Output (2-line clamp · mentions in gold) · Tokens · Cost (right-aligned).

function fmtCost(c: number | null): string {
  if (c == null) return '—'
  return `$${c.toFixed(4)}`
}

function fmtTokens(inTok: number | null, outTok: number | null): string {
  if (inTok == null && outTok == null) return '—'
  return `${(inTok ?? 0).toLocaleString()} / ${(outTok ?? 0).toLocaleString()}`
}

const TH_STYLE: React.CSSProperties = {
  textAlign: 'left',
  fontSize: 10,
  fontWeight: 500,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--color-geg-text-faint)',
  padding: '12px 14px',
  whiteSpace: 'nowrap',
  borderBottom: '1px solid var(--color-geg-accent-border)',
}

const TD_STYLE: React.CSSProperties = {
  padding: '14px 14px',
  fontSize: 13,
  verticalAlign: 'middle',
}

export function EllaRunsTable({ rows }: { rows: EllaRunsListRow[] }) {
  if (rows.length === 0) {
    return (
      <div
        className="p-12 text-center text-sm"
        style={{
          color: 'var(--color-geg-text-2)',
          border: '1px solid var(--color-geg-border)',
          borderRadius: 8,
        }}
      >
        No Ella runs match the current filters.
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
        tableLayout: 'fixed',
      }}
    >
      <colgroup>
        <col style={{ width: 110 }} />
        <col style={{ width: 200 }} />
        <col style={{ width: 220 }} />
        <col style={{ width: 130 }} />
        <col />
        <col style={{ width: 150 }} />
      </colgroup>
      <thead>
        <tr>
          <th className="geg-mono" style={TH_STYLE}>
            When
          </th>
          <th className="geg-mono" style={TH_STYLE}>
            Channel
          </th>
          <th className="geg-mono" style={TH_STYLE}>
            Who Ella responded to
          </th>
          <th className="geg-mono" style={TH_STYLE}>
            Status
          </th>
          <th className="geg-mono" style={TH_STYLE}>
            Output
          </th>
          <th
            className="geg-mono"
            style={{ ...TH_STYLE, textAlign: 'right' }}
          >
            Tokens · Cost
          </th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const output = r.escalation_body ?? r.output_text
          const isMutedOutput = !output
          return (
            <tr
              key={r.id}
              style={{ cursor: 'pointer', transition: 'background 80ms ease' }}
            >
              <td style={TD_STYLE}>
                <Link
                  href={`/ella/runs/${r.id}`}
                  style={{
                    display: 'block',
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                >
                  <CellWhen iso={r.started_at} />
                </Link>
              </td>
              <td style={TD_STYLE}>
                <Link
                  href={`/ella/runs/${r.id}`}
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    lineHeight: 1.3,
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                >
                  <span
                    style={{
                      color: 'var(--color-geg-text)',
                      fontWeight: 500,
                    }}
                  >
                    #{r.channel_name ?? '?'}
                  </span>
                  {r.channel_client_name ? (
                    <span
                      className="geg-mono"
                      style={{
                        fontSize: 11,
                        color: 'var(--color-geg-text-faint)',
                        letterSpacing: '0.02em',
                      }}
                    >
                      {r.channel_client_name}
                    </span>
                  ) : null}
                </Link>
              </td>
              <td style={TD_STYLE}>
                <Link
                  href={`/ella/runs/${r.id}`}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                >
                  {r.real_author_name ? (
                    <span style={{ color: 'var(--color-geg-text)' }}>
                      {r.real_author_name}
                    </span>
                  ) : (
                    <span
                      style={{
                        color: 'var(--color-geg-text-faint)',
                        fontStyle: 'italic',
                      }}
                    >
                      unresolved
                    </span>
                  )}
                  <RolePill role={r.real_author_role} />
                </Link>
              </td>
              <td style={TD_STYLE}>
                <Link
                  href={`/ella/runs/${r.id}`}
                  style={{
                    display: 'block',
                    textDecoration: 'none',
                    color: 'inherit',
                  }}
                >
                  <RunStatusPill status={r.status} />
                </Link>
              </td>
              <td style={TD_STYLE}>
                <Link
                  href={`/ella/runs/${r.id}`}
                  style={{
                    display: '-webkit-box',
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: 'vertical',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    fontSize: 13,
                    lineHeight: 1.45,
                    color: isMutedOutput
                      ? 'var(--color-geg-text-faint)'
                      : 'var(--color-geg-text)',
                    fontStyle: isMutedOutput ? 'italic' : 'normal',
                    textDecoration: 'none',
                  }}
                >
                  {output ?? '—'}
                </Link>
              </td>
              <td style={{ ...TD_STYLE, textAlign: 'right' }}>
                <Link
                  href={`/ella/runs/${r.id}`}
                  className="geg-mono"
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 2,
                    lineHeight: 1.3,
                    textDecoration: 'none',
                    color: 'inherit',
                    alignItems: 'flex-end',
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      color: 'var(--color-geg-text-2)',
                      letterSpacing: '0.02em',
                    }}
                  >
                    {fmtTokens(r.llm_input_tokens, r.llm_output_tokens)}
                  </span>
                  <span
                    style={{
                      fontSize: 12,
                      color: 'var(--color-geg-text)',
                      letterSpacing: '0.02em',
                      fontVariantNumeric: 'tabular-nums',
                    }}
                  >
                    {fmtCost(r.llm_cost_usd)}
                  </span>
                </Link>
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
