'use client'

// Section 3 — Financials.
//
// Three numeric_money fields + one text note. Display formatter
// shows $X,XXX.XX while the editor accepts loose input ($1,234,
// "1234.56", etc.) and the Server Action's narrowing strips $ and
// commas before persisting. Arrears uses the numeric_nonneg field
// type at the data layer (rejects negatives at the boundary).

import type { ClientDetail } from '@/lib/db/clients'
import { Section } from './section'
import { EditableField } from './editable-field'
import { updateClientField } from '@/app/(authenticated)/(fulfillment)/clients/[id]/actions'

function formatDollars(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  const n = typeof value === 'string' ? parseFloat(value) : (value as number)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })
}

export function FinancialsSection({ client }: { client: ClientDetail }) {
  return (
    <Section title="Financials" defaultOpen={false}>
      <div className="grid grid-cols-2 gap-4">
        <EditableField
          label="Contracted revenue"
          value={client.contracted_revenue}
          variant="numeric_money"
          displayValue={formatDollars}
          onSave={(v) =>
            updateClientField(
              client.id,
              'contracted_revenue',
              v as number | null,
            )
          }
        />
        <EditableField
          label="Upfront cash collected"
          value={client.upfront_cash_collected}
          variant="numeric_money"
          displayValue={formatDollars}
          onSave={(v) =>
            updateClientField(
              client.id,
              'upfront_cash_collected',
              v as number | null,
            )
          }
        />

        <EditableField
          label="Arrears"
          value={client.arrears}
          variant="numeric_money"
          displayValue={formatDollars}
          onSave={(v) =>
            updateClientField(client.id, 'arrears', v as number | null)
          }
        />
        <EditableField
          label="Arrears note"
          value={client.arrears_note}
          variant="text"
          onSave={(v) =>
            updateClientField(client.id, 'arrears_note', v as string | null)
          }
        />
      </div>
    </Section>
  )
}
