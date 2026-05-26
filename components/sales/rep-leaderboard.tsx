'use client'

import { useState } from 'react'
import {
  type CloserRep,
  type SetterRep,
  type CsmRep,
} from '@/lib/db/sales-dashboard-mocks'
import { formatMetricValue } from '@/lib/db/sales-dashboard-shared'
import { Sparkline } from './sparkline'

type Role = 'closer' | 'setter' | 'csm'

export function RepLeaderboard({
  closers,
  setters,
  csms,
}: {
  closers: CloserRep[]
  setters: SetterRep[]
  csms: CsmRep[]
}) {
  const [role, setRole] = useState<Role>('closer')

  return (
    <div style={{ marginTop: 28 }}>
      <RoleTabs role={role} setRole={setRole} />
      {role === 'closer' ? <CloserTable rows={closers} /> : null}
      {role === 'setter' ? <SetterTable rows={setters} /> : null}
      {role === 'csm' ? <CsmTable rows={csms} /> : null}
    </div>
  )
}

function RoleTabs({ role, setRole }: { role: Role; setRole: (r: Role) => void }) {
  return (
    <div
      role="tablist"
      aria-label="Rep role"
      style={{
        display: 'inline-flex',
        border: '1px solid var(--color-geg-border-strong)',
        borderRadius: 6,
        overflow: 'hidden',
        marginBottom: 18,
      }}
    >
      {(['closer', 'setter', 'csm'] as Role[]).map((r, i) => (
        <button
          key={r}
          type="button"
          role="tab"
          aria-selected={role === r}
          onClick={() => setRole(r)}
          className="geg-mono"
          style={{
            padding: '8px 16px',
            background: role === r ? 'var(--color-geg-bg-elev)' : 'transparent',
            color: role === r ? 'var(--color-geg-text)' : 'var(--color-geg-text-3)',
            borderLeft: i === 0 ? 'none' : '1px solid var(--color-geg-border)',
            fontSize: 11,
            letterSpacing: '0.12em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          {r === 'closer' ? 'Closers' : r === 'setter' ? 'Setters' : 'CSMs'}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Tables — one per role. Same shell, different columns.
// ---------------------------------------------------------------------------

function TableShell({
  headers,
  children,
}: {
  headers: string[]
  children: React.ReactNode
}) {
  return (
    <div
      style={{
        background: 'var(--color-geg-bg-elev)',
        border: '1px solid var(--color-geg-border)',
        borderRadius: 10,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `40px 1.4fr ${headers.slice(2).map(() => '1fr').join(' ')} 110px`,
          gap: 12,
          padding: '12px 22px',
          background: 'var(--color-geg-bg)',
          borderBottom: '1px solid var(--color-geg-border)',
        }}
      >
        {headers.map((h, i) => (
          <span
            key={i}
            className="geg-mono"
            style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--color-geg-text-faint)',
              textAlign: i === 1 ? 'left' : 'right',
            }}
          >
            {h}
          </span>
        ))}
      </div>
      {children}
    </div>
  )
}

function Row({
  children,
  flag,
}: {
  children: React.ReactNode
  flag?: 'top' | 'bottom' | null
}) {
  const flagColor =
    flag === 'top' ? 'var(--color-geg-pos)' : flag === 'bottom' ? 'var(--color-geg-neg)' : 'transparent'
  return (
    <div
      style={{
        display: 'grid',
        // Pulled to inherit parent's gridTemplateColumns via grid `subgrid`
        // would be cleaner but support is uneven; restate here:
        gridTemplateColumns: 'inherit',
        borderBottom: '1px dashed var(--color-geg-border)',
      }}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'inherit',
          gap: 12,
          padding: '14px 22px',
          borderLeft: `3px solid ${flagColor}`,
          alignItems: 'center',
        }}
      >
        {children}
      </div>
    </div>
  )
}

function CloserTable({ rows }: { rows: CloserRep[] }) {
  // Flag top by cash-per-call, bottom by cash-per-call.
  const top = rows[0]?.id
  const bottom = rows[rows.length - 1]?.id
  return (
    <TableShell
      headers={['#', 'Closer', 'Calls', 'Show', 'Close', '$ / Call', 'Cash MTD', 'Trend']}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '40px 1.4fr 1fr 1fr 1fr 1fr 1fr 110px' }}>
        {rows.map((r, i) => (
          <RowInner
            key={r.id}
            flag={r.id === top ? 'top' : r.id === bottom ? 'bottom' : null}
            cells={[
              <Rank n={i + 1} />,
              <Name name={r.name} />,
              <Num value={String(r.callsHandled)} />,
              <Num value={`${Math.round(r.showRate * 100)}%`} />,
              <Num value={`${Math.round(r.closeRate * 100)}%`} />,
              <Num value={formatMetricValue(r.cashPerCall, 'usd')} accent />,
              <Num value={formatMetricValue(r.cashTotal, 'usd')} />,
              <Sparkline data={r.trend} width={90} height={20} stroke="var(--color-geg-text-3)" />,
            ]}
          />
        ))}
      </div>
    </TableShell>
  )
}

function SetterTable({ rows }: { rows: SetterRep[] }) {
  const top = rows[0]?.id
  const bottom = rows[rows.length - 1]?.id
  return (
    <TableShell
      headers={['#', 'Setter', 'Triages', 'Booked rate', 'DQ rate', 'Avg time to dial', 'Trend']}
    >
      <div style={{ display: 'grid', gridTemplateColumns: '40px 1.4fr 1fr 1fr 1fr 1fr 110px' }}>
        {rows.map((r, i) => (
          <RowInner
            key={r.id}
            flag={r.id === top ? 'top' : r.id === bottom ? 'bottom' : null}
            cells={[
              <Rank n={i + 1} />,
              <Name name={r.name} />,
              <Num value={String(r.triages)} />,
              <Num value={`${Math.round(r.bookedRate * 100)}%`} accent />,
              <Num value={`${Math.round(r.dqRate * 100)}%`} />,
              <Num value={`${r.avgTimeToDial}m`} />,
              <Sparkline data={r.trend} width={90} height={20} stroke="var(--color-geg-text-3)" />,
            ]}
          />
        ))}
      </div>
    </TableShell>
  )
}

function CsmTable({ rows }: { rows: CsmRep[] }) {
  const top = rows[0]?.id
  const bottom = rows[rows.length - 1]?.id
  return (
    <TableShell headers={['#', 'CSM', 'Retention', 'NPS', 'Calls held', 'Trend']}>
      <div style={{ display: 'grid', gridTemplateColumns: '40px 1.4fr 1fr 1fr 1fr 110px' }}>
        {rows.map((r, i) => (
          <RowInner
            key={r.id}
            flag={r.id === top ? 'top' : r.id === bottom ? 'bottom' : null}
            cells={[
              <Rank n={i + 1} />,
              <Name name={r.name} />,
              <Num value={`${Math.round(r.retention * 100)}%`} accent />,
              <Num value={String(r.nps)} />,
              <Num value={String(r.callsHeld)} />,
              <Sparkline data={r.trend} width={90} height={20} stroke="var(--color-geg-text-3)" />,
            ]}
          />
        ))}
      </div>
    </TableShell>
  )
}

function RowInner({
  flag,
  cells,
}: {
  flag: 'top' | 'bottom' | null
  cells: React.ReactNode[]
}) {
  const flagColor =
    flag === 'top' ? 'var(--color-geg-pos)' : flag === 'bottom' ? 'var(--color-geg-neg)' : 'transparent'
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'subgrid',
        gridColumn: '1 / -1',
        gap: 12,
        padding: '14px 22px',
        borderLeft: `3px solid ${flagColor}`,
        borderBottom: '1px dashed var(--color-geg-border)',
        alignItems: 'center',
      }}
    >
      {cells.map((c, i) => (
        <div key={i} style={{ display: 'flex', justifyContent: i === 1 ? 'flex-start' : 'flex-end' }}>
          {c}
        </div>
      ))}
    </div>
  )
}

function Rank({ n }: { n: number }) {
  return (
    <span
      className="geg-mono"
      style={{ fontSize: 11, color: 'var(--color-geg-text-faint)', letterSpacing: '0.06em' }}
    >
      #{n}
    </span>
  )
}

function Name({ name }: { name: string }) {
  return (
    <span
      className="geg-serif"
      style={{ fontSize: 15, color: 'var(--color-geg-text)', letterSpacing: '-0.005em' }}
    >
      {name}
    </span>
  )
}

function Num({ value, accent }: { value: string; accent?: boolean }) {
  return (
    <span
      className="geg-numeric-serif"
      style={{
        fontSize: 15,
        color: accent ? 'var(--color-geg-text)' : 'var(--color-geg-text-2)',
        letterSpacing: '-0.01em',
        fontWeight: accent ? 500 : 400,
      }}
    >
      {value}
    </span>
  )
}

// Suppress unused-warning for RowShell (kept for reference)
void Row
