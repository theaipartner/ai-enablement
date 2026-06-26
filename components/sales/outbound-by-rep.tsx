import type { OutboundRepRow } from '@/lib/db/funnel-revival'

// Per-rep Outbound breakdown — sits under the funnel on the Outbound page. One
// combined row per rep across Dials / Connections / Closes / Cash, bridging the
// rep's Close calls and Airtable closer reports via team_members (migration
// 0104). ACTIVITY-scoped: it reflects what each rep did in the selected calendar
// window, NOT the cohort funnel above (which scopes by lead entry date). Only
// reps who actually closed are shown.

const ACCENT = '#d08770' // coral

function fmtCash(n: number): string {
  return `$${n.toLocaleString('en-US')}`
}

function Cell({ value, strong = false, muted = false }: { value: string; strong?: boolean; muted?: boolean }) {
  return (
    <td
      className="geg-numeric-serif"
      style={{
        padding: '9px 14px',
        textAlign: 'right',
        fontSize: 14,
        whiteSpace: 'nowrap',
        color: muted ? 'var(--color-geg-text-faint)' : strong ? 'var(--color-geg-text)' : 'var(--color-geg-text-2)',
        fontWeight: strong ? 600 : 400,
      }}
    >
      {value}
    </td>
  )
}

function HeadCell({ label, first = false }: { label: string; first?: boolean }) {
  return (
    <th
      className="geg-mono"
      style={{
        padding: '8px 14px',
        textAlign: first ? 'left' : 'right',
        fontSize: 9.5,
        letterSpacing: '0.07em',
        textTransform: 'uppercase',
        color: 'var(--color-geg-text-faint)',
        fontWeight: 500,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </th>
  )
}

export function OutboundByRepSection({ rows }: { rows: OutboundRepRow[] }) {
  const totals = rows.reduce(
    (a, r) => ({
      dials: a.dials + r.dials,
      connections: a.connections + r.connections,
      closes: a.closes + r.closes,
      cash: a.cash + r.cash,
    }),
    { dials: 0, connections: 0, closes: 0, cash: 0 },
  )

  return (
    <div style={{ marginTop: 14, border: '1px solid var(--color-geg-border)', borderRadius: 8, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: 'var(--color-geg-bg-elev)', borderBottom: '1px solid var(--color-geg-border)' }}>
        <span style={{ width: 8, height: 8, borderRadius: '50%', background: ACCENT }} />
        <span className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text)' }}>
          By rep
        </span>
        <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
          · activity in the selected dates
        </span>
      </div>

      {rows.length === 0 ? (
        <div className="geg-mono" style={{ padding: '16px 14px', background: 'var(--color-geg-bg)', fontSize: 11, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)' }}>
          No closes in the selected dates.
        </div>
      ) : (
        <div style={{ background: 'var(--color-geg-bg)', overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--color-geg-border)' }}>
                <HeadCell label="Rep" first />
                <HeadCell label="Dials" />
                <HeadCell label="Connections" />
                <HeadCell label="Closes" />
                <HeadCell label="Cash" />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.rep} style={{ borderBottom: '1px solid var(--color-geg-border)' }}>
                  <td className="geg-mono" style={{ padding: '9px 14px', fontSize: 12, letterSpacing: '0.02em', color: 'var(--color-geg-text)', whiteSpace: 'nowrap' }}>
                    {r.rep}
                  </td>
                  <Cell value={r.dials.toLocaleString('en-US')} />
                  <Cell value={r.connections.toLocaleString('en-US')} />
                  <Cell value={r.closes.toLocaleString('en-US')} strong />
                  <Cell value={fmtCash(r.cash)} strong />
                </tr>
              ))}
              {/* totals */}
              <tr style={{ background: 'var(--color-geg-bg-elev)' }}>
                <td className="geg-mono" style={{ padding: '9px 14px', fontSize: 9.5, letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', whiteSpace: 'nowrap' }}>
                  Total
                </td>
                <Cell value={totals.dials.toLocaleString('en-US')} muted />
                <Cell value={totals.connections.toLocaleString('en-US')} muted />
                <Cell value={totals.closes.toLocaleString('en-US')} strong />
                <Cell value={fmtCash(totals.cash)} strong />
              </tr>
            </tbody>
          </table>
        </div>
      )}

      {/* footnote */}
      <div className="geg-mono" style={{ padding: '9px 14px', background: 'var(--color-geg-bg-elev)', borderTop: '1px solid var(--color-geg-border)', fontSize: 9, letterSpacing: '0.05em', color: 'var(--color-geg-text-faint)', lineHeight: 1.7 }}>
        Activity-scoped, not cohort-scoped: what each rep did in the selected dates, regardless of when the
        lead entered. <b>Dials</b> = outbound calls · <b>Connections</b> = calls ≥90s · <b>Closes</b> = DC
        closes with a plan · <b>Cash</b> = $300 per plan unit. Only reps who closed are listed.
      </div>
    </div>
  )
}
