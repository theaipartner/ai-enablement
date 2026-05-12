import {
  PromPage,
  PromPageHeader,
  PromCard,
  PromSection,
  PromTable,
  PromTHead,
  PromTH,
  PromTR,
  PromTD,
  Pill,
  PreviewBadge,
  PromDropdownStub,
} from '@/components/promethean/primitives'
import { QC_REVIEWS, setterById, leadById, PERIOD_LABEL, SYNC_LABEL } from '@/lib/mock-data'

export const metadata = { title: 'Setter QC — Promethean' }

const GRADE_TONE: Record<string, 'pos' | 'neg' | 'warn'> = {
  green: 'pos',
  yellow: 'warn',
  red: 'neg',
}

export default function PrometheanSetterQcPage() {
  const reviews = [...QC_REVIEWS].sort((a, b) => b.call_at.localeCompare(a.call_at))

  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · SETTER QC"
        title="AI-graded conversations."
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
            <PromDropdownStub label="All grades" />
            <PreviewBadge />
          </div>
        }
      />

      <PromSection eyebrow="AI ANALYSIS" headline="Alpha sales frameworks, per call.">
        <PromCard
          className="p-5 mb-6"
          style={{ background: 'rgba(212, 225, 87, 0.04)', borderColor: 'var(--color-prom-accent-dim)' } as React.CSSProperties}
        >
          <div className="text-sm" style={{ color: 'var(--color-prom-text-2)', lineHeight: '1.55' }}>
            Don&apos;t use AI grades as the last word — use them as a sieve to find which calls need
            your personal review. The grading layer is inbound triage on setter quality, not a
            replacement for coaching judgment.
          </div>
        </PromCard>

        <PromTable>
          <PromTHead>
            <tr>
              <PromTH>When</PromTH>
              <PromTH>Setter</PromTH>
              <PromTH>Lead</PromTH>
              <PromTH>Duration</PromTH>
              <PromTH>Grade</PromTH>
              <PromTH>Summary</PromTH>
              <PromTH align="right">Action</PromTH>
            </tr>
          </PromTHead>
          <tbody>
            {reviews.map((r) => {
              const setter = setterById(r.setter_id)
              const lead = leadById(r.lead_id)
              return (
                <PromTR key={r.id}>
                  <PromTD>
                    <span className="text-xs prom-numeric" style={{ color: 'var(--color-prom-text-2)' }}>
                      {new Date(r.call_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                    </span>
                  </PromTD>
                  <PromTD>{setter?.name ?? '—'}</PromTD>
                  <PromTD>{lead?.name ?? '—'}</PromTD>
                  <PromTD className="prom-numeric">{Math.round(r.duration_seconds / 60)}m</PromTD>
                  <PromTD><Pill tone={GRADE_TONE[r.grade]}>{r.grade}</Pill></PromTD>
                  <PromTD>
                    <span className="text-xs" style={{ color: 'var(--color-prom-text-2)' }}>
                      {r.summary}
                    </span>
                  </PromTD>
                  <PromTD align="right">
                    <button
                      className="text-[11px] prom-eyebrow px-3 py-1 rounded-full"
                      style={{
                        color: 'var(--color-prom-accent)',
                        background: 'transparent',
                        border: '1px solid var(--color-prom-accent-dim)',
                      }}
                    >
                      ✦ GRADE
                    </button>
                  </PromTD>
                </PromTR>
              )
            })}
          </tbody>
        </PromTable>
      </PromSection>
    </PromPage>
  )
}
