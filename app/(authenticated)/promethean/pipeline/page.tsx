import {
  PromPage,
  PromPageHeader,
  PromTable,
  PromTHead,
  PromTH,
  PromTR,
  PromTD,
  Pill,
  PromDropdownStub,
  AvatarCircle,
  money,
} from '@/components/promethean/primitives'
import {
  LEADS,
  setterById,
  closerById,
  PERIOD_LABEL,
  SYNC_LABEL,
} from '@/lib/mock-data'

const STATUS_TONE: Record<string, 'pos' | 'neg' | 'warn' | 'neutral' | 'accent'> = {
  new: 'neutral',
  contacted: 'neutral',
  qualified: 'accent',
  booked: 'warn',
  showed: 'warn',
  pitched: 'warn',
  won: 'pos',
  lost: 'neg',
}

export const metadata = { title: 'Pipeline — Promethean' }

export default function PrometheanPipelinePage({
  searchParams,
}: {
  searchParams?: { filter?: string }
}) {
  const filter = searchParams?.filter
  const overdueLeads = LEADS.filter((l) => l.is_overdue).length
  let rows = LEADS
  if (filter === 'overdue') rows = rows.filter((l) => l.is_overdue)
  if (filter === 'active') rows = rows.filter((l) =>
    ['contacted', 'qualified', 'booked', 'showed', 'pitched'].includes(l.status),
  )

  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · PIPELINE"
        title="Every deal, in motion."
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
        trailing={
          <div className="flex items-center gap-2">
            <PromDropdownStub label="All setters" />
            <PromDropdownStub label="All countries" />
            <PromDropdownStub label="Last 30 days" />
          </div>
        }
      />

      <div className="mt-8 flex items-center gap-2">
        <FilterChip label="All" count={LEADS.length} active={!filter} href="/promethean/pipeline" />
        <FilterChip
          label="Active"
          count={LEADS.filter((l) => ['contacted', 'qualified', 'booked', 'showed', 'pitched'].includes(l.status)).length}
          active={filter === 'active'}
          href="/promethean/pipeline?filter=active"
        />
        <FilterChip
          label="Overdue"
          count={overdueLeads}
          tone="neg"
          active={filter === 'overdue'}
          href="/promethean/pipeline?filter=overdue"
        />
      </div>

      <div className="mt-6">
        <PromTable>
          <PromTHead>
            <tr>
              <PromTH>Lead</PromTH>
              <PromTH>Status</PromTH>
              <PromTH>Setter</PromTH>
              <PromTH>Closer</PromTH>
              <PromTH>Country</PromTH>
              <PromTH align="right">Contract</PromTH>
              <PromTH align="right">Cash</PromTH>
              <PromTH>Last activity</PromTH>
            </tr>
          </PromTHead>
          <tbody>
            {rows.slice(0, 30).map((l) => {
              const setter = setterById(l.setter_id)
              const closer = closerById(l.closer_id)
              return (
                <PromTR key={l.id}>
                  <PromTD>
                    <div className="font-medium">{l.name}</div>
                    <div className="text-xs" style={{ color: 'var(--color-prom-text-3)' }}>
                      {l.source}
                    </div>
                  </PromTD>
                  <PromTD>
                    <Pill tone={STATUS_TONE[l.status]}>{l.status}</Pill>
                    {l.is_overdue ? (
                      <Pill tone="neg" className="ml-1.5">
                        overdue
                      </Pill>
                    ) : null}
                  </PromTD>
                  <PromTD>
                    {setter ? (
                      <span className="inline-flex items-center gap-2">
                        <AvatarCircle initials={setter.avatar_initials} />
                        <span className="text-xs">{setter.name}</span>
                      </span>
                    ) : (
                      <span style={{ color: 'var(--color-prom-text-3)' }}>—</span>
                    )}
                  </PromTD>
                  <PromTD>
                    {closer ? (
                      <span className="inline-flex items-center gap-2">
                        <AvatarCircle initials={closer.avatar_initials} />
                        <span className="text-xs">{closer.name}</span>
                      </span>
                    ) : (
                      <span style={{ color: 'var(--color-prom-text-3)' }}>—</span>
                    )}
                  </PromTD>
                  <PromTD className="prom-numeric">{l.country}</PromTD>
                  <PromTD align="right" className="prom-numeric">
                    {l.contract_value ? money(l.contract_value) : '—'}
                  </PromTD>
                  <PromTD align="right" className="prom-numeric">
                    {l.cash_collected ? money(l.cash_collected) : '—'}
                  </PromTD>
                  <PromTD>
                    <span className="text-xs" style={{ color: 'var(--color-prom-text-2)' }}>
                      {new Date(l.last_activity_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </PromTD>
                </PromTR>
              )
            })}
          </tbody>
        </PromTable>
      </div>
    </PromPage>
  )
}

function FilterChip({
  label,
  count,
  active,
  tone,
  href,
}: {
  label: string
  count: number
  active?: boolean
  tone?: 'neg'
  href: string
}) {
  const color = active ? 'var(--color-prom-text)' : 'var(--color-prom-text-2)'
  const bg = active ? 'rgba(212, 225, 87, 0.10)' : 'var(--color-prom-bg-elev)'
  const borderColor = active ? 'var(--color-prom-accent-dim)' : 'var(--color-prom-border)'
  return (
    <a
      href={href}
      className="inline-flex items-center gap-2 rounded-full px-3.5 py-1.5 text-xs"
      style={{ background: bg, color, border: `1px solid ${borderColor}` }}
    >
      <span>{label}</span>
      <span className="prom-numeric" style={{ color: tone === 'neg' ? 'var(--color-prom-neg)' : 'var(--color-prom-text-3)' }}>
        {count}
      </span>
    </a>
  )
}
