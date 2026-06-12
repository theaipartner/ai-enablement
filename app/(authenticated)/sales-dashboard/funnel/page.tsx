import Link from 'next/link'
import { HeaderBand } from '@/components/gregory/header-band'
import { FunnelStack } from '@/components/sales/funnel-stack'
import { DcFunnelSection } from '@/components/sales/dc-funnel'
import { CashCollectedBar } from '@/components/sales/cash-collected'
import { getLeadsForRange, type LeadRow } from '@/lib/db/leads'
import { getLeadsFunnel } from '@/lib/db/leads-funnel'
import { getDcFunnel } from '@/lib/db/funnel-dc'
import { getCashCollected } from '@/lib/db/funnel-cash'
import { getSpeedToLeadCohort } from '@/lib/db/funnel-appointment-setting'
import { resolveFunnelRange } from '@/lib/db/funnel-stages'
import { parseEtDateString, todayEtDate } from '@/lib/db/funnel-window'
import { PersonPill } from '../header-pills'
import { DateRangePicker } from './landing-pages/date-range-picker'
import { PersistPageState } from '@/components/sales/persist-page-state'
import { AdFilter, type AdOption } from '@/components/sales/ad-filter'

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
  searchParams?: { start?: string | string[]; end?: string | string[]; ad?: string | string[] }
}) {
  const start = parseEtDateString(searchParams?.start)
  const end = parseEtDateString(searchParams?.end)
  const range = resolveFunnelRange(start ?? undefined, end ?? undefined)
  const todayEt = todayEtDate()
  const ad = (Array.isArray(searchParams?.ad) ? searchParams?.ad[0] : searchParams?.ad)?.trim() || null

  // Cohort → roster rows fetched CONCURRENTLY with the Digital College funnel
  // (independent). The ad filter then narrows the rows in-memory and the HT
  // funnel re-scopes for free — getLeadsFunnel counts only the leads passed in,
  // so filtering the rows filters every box + the rosters they link to. Cash
  // needs both funnels, so it follows.
  const [allRows, dcFunnel] = await Promise.all([
    (async () => {
      // Same cohort spine as the Leads roster, so the funnel and the rosters it
      // links to can't drift.
      const cohort = await getSpeedToLeadCohort(range)
      return getLeadsForRange(range, cohort)
    })(),
    // Digital College funnel — tag-driven, unique leads only, same window as HT.
    getDcFunnel(range),
  ])
  const adOptions = buildAdOptions(allRows)
  const rows = ad ? allRows.filter((r) => r.adId === ad) : allRows
  const funnel = await getLeadsFunnel(rows, range, { adFiltered: !!ad })
  // Cash collected — funnel-wide (HT + DC) summary with ROAS, its own section.
  const cash = await getCashCollected(range, dcFunnel, funnel.adspendUsd)

  const lpHref = `/sales-dashboard/funnel/landing-pages?start=${range.startEtDate}&end=${range.endEtDate}`

  return (
    <div>
      <PersistPageState window filters={['ad']} />
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
            <AdFilter options={adOptions} selected={ad} startEtDate={range.startEtDate} endEtDate={range.endEtDate} />
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

      <FunnelStack funnel={funnel} range={range} ad={ad} />

      <DcFunnelSection dc={dcFunnel} />

      <CashCollectedBar cash={cash} />

      <div
        className="geg-mono"
        style={{ marginTop: 20, fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', textAlign: 'center' }}
      >
        Click any stage to open the matching leads · adspend opens the ads page
      </div>
    </div>
  )
}

// Distinct source ads across the cohort's rows, with per-ad lead counts, for the
// funnel's ad filter dropdown. Sorted by volume (most leads first); leads with no
// ad_id (organic/direct) are omitted.
function buildAdOptions(rows: LeadRow[]): AdOption[] {
  const m = new Map<string, { adName: string; count: number }>()
  for (const r of rows) {
    if (!r.adId) continue
    const e = m.get(r.adId)
    if (e) e.count += 1
    else m.set(r.adId, { adName: r.adName ?? r.adId, count: 1 })
  }
  return Array.from(m.entries())
    .map(([adId, v]) => ({ adId, adName: v.adName, count: v.count }))
    .sort((a, b) => b.count - a.count)
}
