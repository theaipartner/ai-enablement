import {
  PromPage,
  PromPageHeader,
  PromCard,
  PromSection,
  KpiCard,
  PreviewBadge,
} from '@/components/promethean/primitives'
import { PERIOD_LABEL, SYNC_LABEL } from '@/lib/mock-data'

export const metadata = { title: 'Cohort Retention — Promethean' }

// Deterministic cohort retention grid — same shape as a typical
// month-over-month cohort heatmap.
function buildCohorts() {
  const cohorts: { label: string; values: (number | null)[]; size: number }[] = []
  const labels = ['Nov', 'Dec', 'Jan', 'Feb', 'Mar', 'Apr', 'May']
  const baseRetention = [1.0, 0.78, 0.61, 0.52, 0.46, 0.41, 0.38]
  for (let i = 0; i < labels.length; i++) {
    const size = 12 + i * 3 + (i % 2 === 0 ? 2 : -1)
    const values: (number | null)[] = []
    for (let j = 0; j < labels.length; j++) {
      if (j < i) {
        values.push(null)
        continue
      }
      const drift = (i % 3) * 0.02 - (j % 2) * 0.015
      values.push(Math.max(0.1, baseRetention[j - i] + drift))
    }
    cohorts.push({ label: labels[i], values, size })
  }
  return cohorts
}

export default function PrometheanCohortRetentionPage() {
  const cohorts = buildCohorts()
  const months = ['M0', 'M1', 'M2', 'M3', 'M4', 'M5', 'M6']

  return (
    <PromPage>
      <PromPageHeader
        eyebrow="HELIOS · COHORT RETENTION"
        title="Who stays, who drifts."
        meta={
          <>
            <span>{PERIOD_LABEL}</span>
            <span style={{ color: 'var(--color-prom-text-3)' }}>·</span>
            <span>SYNCED {SYNC_LABEL}</span>
          </>
        }
        trailing={<PreviewBadge />}
      />

      <PromSection eyebrow="HEADLINE METRICS">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-5">
          <KpiCard label="M1 RETENTION" value="78%" delta={4} accent />
          <KpiCard label="M3 RETENTION" value="52%" delta={-3} />
          <KpiCard label="M6 RETENTION" value="38%" delta={1} />
          <KpiCard label="AVG LIFETIME" value="4.6mo" delta={2} />
        </div>
      </PromSection>

      <PromSection eyebrow="COHORT GRID" headline="By acquisition month.">
        <PromCard className="p-6 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr>
                <th className="px-3 py-2 text-left prom-eyebrow">COHORT</th>
                <th className="px-3 py-2 text-right prom-eyebrow">SIZE</th>
                {months.map((m) => (
                  <th key={m} className="px-3 py-2 text-center prom-eyebrow">{m}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {cohorts.map((c) => (
                <tr key={c.label}>
                  <td
                    className="px-3 py-2 prom-eyebrow"
                    style={{ borderTop: '1px solid var(--color-prom-border)' }}
                  >
                    {c.label}
                  </td>
                  <td
                    className="px-3 py-2 text-right prom-numeric"
                    style={{
                      borderTop: '1px solid var(--color-prom-border)',
                      color: 'var(--color-prom-text-2)',
                    }}
                  >
                    {c.size}
                  </td>
                  {c.values.map((v, i) => (
                    <td
                      key={i}
                      className="px-3 py-2 text-center prom-numeric"
                      style={{
                        borderTop: '1px solid var(--color-prom-border)',
                        background: v === null ? 'transparent' : `rgba(212, 225, 87, ${0.04 + v * 0.22})`,
                        color: v === null ? 'var(--color-prom-text-3)' : 'var(--color-prom-text)',
                      }}
                    >
                      {v === null ? '—' : `${Math.round(v * 100)}%`}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </PromCard>
      </PromSection>
    </PromPage>
  )
}
