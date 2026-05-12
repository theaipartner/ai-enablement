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
  money,
} from '@/components/promethean/primitives'
import { LEADS, PERIOD_LABEL, SYNC_LABEL } from '@/lib/mock-data'
import Link from 'next/link'

export const metadata = { title: 'Contacts — Promethean' }

export default function PrometheanContactsPage() {
  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · CONTACTS"
        title="Everyone in our universe."
        meta={
          <>
            <span>{LEADS.length} total</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
        trailing={
          <div className="flex items-center gap-2">
            <PromDropdownStub label="All sources" />
            <PromDropdownStub label="All status" />
          </div>
        }
      />

      <div className="mt-8">
        <PromTable>
          <PromTHead>
            <tr>
              <PromTH>Name</PromTH>
              <PromTH>Email</PromTH>
              <PromTH>Country</PromTH>
              <PromTH>Source</PromTH>
              <PromTH>Status</PromTH>
              <PromTH align="right">Contract</PromTH>
              <PromTH>Last activity</PromTH>
            </tr>
          </PromTHead>
          <tbody>
            {LEADS.map((l) => (
              <PromTR key={l.id}>
                <PromTD>
                  <Link
                    href={`/promethean/contacts/${l.id}`}
                    className="font-medium hover:underline"
                  >
                    {l.name}
                  </Link>
                </PromTD>
                <PromTD>
                  <span className="text-xs prom-numeric" style={{ color: 'var(--color-prom-text-2)' }}>
                    {l.email}
                  </span>
                </PromTD>
                <PromTD className="prom-numeric">{l.country}</PromTD>
                <PromTD className="text-xs" >{l.source}</PromTD>
                <PromTD>
                  <Pill tone="neutral">{l.status}</Pill>
                </PromTD>
                <PromTD align="right" className="prom-numeric">
                  {l.contract_value ? money(l.contract_value) : '—'}
                </PromTD>
                <PromTD>
                  <span className="text-xs prom-numeric" style={{ color: 'var(--color-prom-text-2)' }}>
                    {new Date(l.last_activity_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  </span>
                </PromTD>
              </PromTR>
            ))}
          </tbody>
        </PromTable>
      </div>
    </PromPage>
  )
}
