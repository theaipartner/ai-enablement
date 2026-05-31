import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import { FunnelStack } from '@/components/sales/funnel-stack'
import { getLeadsForRange } from '@/lib/db/leads'
import { getLeadsFunnel } from '@/lib/db/leads-funnel'
import { getSpeedToLeadCohort } from '@/lib/db/funnel-appointment-setting'
import { resolveFunnelRange } from '@/lib/db/funnel-stages'
import { parseEtDateString, todayEtDate } from '@/lib/db/funnel-window'
import { PersonPill } from '../header-pills'
import { DateRangePicker } from './landing-pages/date-range-picker'

// Sales Dashboard — Funnel (the top-of-funnel overview).
//
// The stacked Total / Direct / Setter-led / Reactivation funnel over the
// window's cohort. Each stage node links to the Leads roster pre-filtered to
// that funnel's (type, stage); the Total adspend node links to the Ads page;
// a link near the top goes to the Landing Pages page. Those two links replace
// the old funnel-stage sub-bars in the sidebar.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export default async function SalesDashboardFunnelPage({
  searchParams,
}: {
  searchParams?: { start?: string | string[]; end?: string | string[] }
}) {
  const start = parseEtDateString(searchParams?.start)
  const end = parseEtDateString(searchParams?.end)
  const range = resolveFunnelRange(start ?? undefined, end ?? undefined)
  const todayEt = todayEtDate()

  // Same cohort spine as the Leads roster, so the funnel and the rosters it
  // links to can't drift.
  const cohort = await getSpeedToLeadCohort(range)
  const rows = await getLeadsForRange(range, cohort)
  const funnel = await getLeadsFunnel(rows, range)

  const lpHref = `/sales-dashboard/funnel/landing-pages?start=${range.startEtDate}&end=${range.endEtDate}`

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · FUNNEL"
        title="Funnel."
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <Link
              href={lpHref}
              className="geg-mono"
              style={{
                fontSize: 11,
                letterSpacing: '0.06em',
                color: 'var(--color-geg-text-2)',
                textDecoration: 'none',
                border: '1px solid var(--color-geg-border)',
                borderRadius: 6,
                padding: '6px 12px',
                background: 'var(--color-geg-bg-elev)',
              }}
            >
              Landing pages →
            </Link>
            <DateRangePicker startEtDate={range.startEtDate} endEtDate={range.endEtDate} todayEt={todayEt} />
            <PersonPill label="EST · Nabeel" />
          </div>
        }
      />

      {(() => {
        const clean = funnel.warnings.length === 0
        const color = clean ? 'var(--color-geg-pos)' : 'var(--color-geg-neg)'
        return (
          <div
            style={{
              marginTop: 14,
              padding: '12px 16px',
              border: `1px solid ${color}`,
              borderRadius: 8,
              background: `color-mix(in srgb, ${color} 8%, transparent)`,
            }}
          >
            <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.12em', textTransform: 'uppercase', color, marginBottom: clean ? 0 : 6 }}>
              {clean
                ? '✓ Funnel integrity · all checks pass'
                : `⚠ Funnel integrity — ${funnel.warnings.length} issue${funnel.warnings.length === 1 ? '' : 's'}`}
            </div>
            {funnel.warnings.map((msg, i) => (
              <div key={i} className="geg-mono" style={{ fontSize: 10, color: 'var(--color-geg-text-2)', lineHeight: 1.6 }}>
                · {msg}
              </div>
            ))}
          </div>
        )
      })()}

      <FunnelStack funnel={funnel} range={range} />

      <div
        className="geg-mono"
        style={{ marginTop: 20, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', textAlign: 'center' }}
      >
        Click any stage to open the matching leads · adspend opens the ads page
      </div>
    </div>
  )
}
