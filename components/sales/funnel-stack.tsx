import Link from 'next/link'
import type { LeadsFunnel, LeadFilterType, FunnelStage } from '@/lib/db/leads-funnel'
import type { FunnelCash, CashCollected } from '@/lib/db/funnel-cash'

// Exact dollar amount with cents + thousands separators ($10,823.47). Used for
// the funnel's Adspend node — Nabeel wants the precise spend, not a compact
// abbreviation (10.8K). Everything else keeps compactUsd.
const fullUsd = (value: number): string =>
  value.toLocaleString('en-US', { style: 'currency', currency: 'USD' })

// Stacked funnel — Total on top, then Direct / Setter-led / Reactivation, each a
// full-width horizontal funnel. Lives on the Funnel (Pulse) page; every stage
// node links to the Leads roster pre-filtered to that funnel's (type, stage),
// preserving the window. The Total box's adspend node links to the Ads page.
// Counts come from getLeadsFunnel and share the reachedStage predicate with the
// roster filter, so a bar's count equals the roster it opens.

type Range = { startEtDate: string; endEtDate: string }

type AdFilter = { ad?: string | null; campaign?: string | null; adset?: string | null }

function leadsHref(range: Range, type: LeadFilterType | null, stage: FunnelStage | null, filter?: AdFilter): string {
  const p = new URLSearchParams()
  p.set('start', range.startEtDate)
  p.set('end', range.endEtDate)
  if (type) p.set('type', type)
  if (stage) p.set('stage', stage)
  if (filter?.campaign) p.set('campaign', filter.campaign)
  if (filter?.adset) p.set('adset', filter.adset)
  if (filter?.ad) p.set('ad', filter.ad)
  return `/sales-dashboard/leads?${p.toString()}`
}

function adsHref(range: Range): string {
  const p = new URLSearchParams({ start: range.startEtDate, end: range.endEtDate })
  return `/sales-dashboard/funnel/ads?${p.toString()}`
}

// Dials live in a bracket beside each funnel's lead amount (not a stage), so the
// funnel reads strictly top-down. Coats: Direct green, Setter-led ("new
// opt-ins") yellow, Reactivation pale blue, Total neutral.
export function FunnelStack({ funnel, cash, range, ad, campaign, adset }: { funnel: LeadsFunnel; cash: FunnelCash; range: Range; ad?: string | null; campaign?: string | null; adset?: string | null }) {
  const { total: t, direct: d, setter: s, reactivation: re } = funnel
  const filter: AdFilter = { ad, campaign, adset }
  const dials = (n: number) => `${n.toLocaleString('en-US')} dials`
  // Closes node bracket. The funnel is HT-only (DC is excluded from the tags),
  // so dc is always 0 today — the bracket only appears if/when a DC branch
  // re-enters the tagged stages. The closes value itself is the HT count.
  const closeSplit = (ht: number, dc: number): string | undefined =>
    dc > 0 ? `${ht} HT / ${dc} DC` : undefined
  return (
    <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
      <StackedFunnelBox
        label="Total"
        tone="neutral"
        type={null}
        range={range}
        filter={filter}
        dcCloses={t.dcCloses}
        cash={cash.total}
        showRoas
        adspend={funnel.adspendUsd}
        adspendHref={adsHref(range)}
        clicks={funnel.uniqueLinkClicks}
        costBase={funnel.adspendUsd}
        stages={[
          { value: t.optIns, caption: 'Opt-ins', accent: true, bracket: dials(t.dials) },
          { value: t.connected, caption: 'Connected', stage: 'connected' },
          // Books intentionally omitted from the Total funnel only — Confirms is
          // the meaningful node here (Drake 2026-06-17). t.books still drives the
          // data/guard and stays on Direct / Setter / Reactivation.
          { value: t.confirms, caption: 'Confirms', stage: 'confirmed' },
          { value: t.shows, caption: 'Shows', stage: 'showed' },
          { value: t.closes, caption: 'Closes', stage: 'closed', bracket: closeSplit(t.closesHt, t.closesDc) },
        ]}
      />
      <StackedFunnelBox
        label="Direct"
        tone="pos"
        type="direct"
        range={range}
        filter={filter}
        dcCloses={d.dcCloses}
        cash={cash.direct}
        costBase={funnel.adspendUsd}
        stages={[
          { value: d.qualifiedOptIns, caption: 'Qual. opt-ins' },
          { value: d.books, caption: 'Booked', accent: true, bracket: dials(d.dials), stage: 'booked' },
          { value: d.connected, caption: 'Connected', stage: 'connected' },
          { value: d.confirms, caption: 'Confirms', stage: 'confirmed' },
          { value: d.shows, caption: 'Shows', stage: 'showed' },
          { value: d.closes, caption: 'Closes', stage: 'closed', bracket: closeSplit(d.closesHt, d.closesDc) },
        ]}
      />
      <StackedFunnelBox
        label="New opt-ins (setter-led)"
        tone="warn"
        type="setter"
        range={range}
        filter={filter}
        dcCloses={s.dcCloses}
        cash={cash.setter}
        costBase={funnel.adspendUsd}
        poolSplit={{ qualified: s.qualified, unqualified: s.unqualified }}
        stages={[
          { value: s.pool, caption: 'Pool', accent: true, bracket: dials(s.dials) },
          { value: s.connected, caption: 'Connected', stage: 'connected' },
          { value: s.books, caption: 'Books', stage: 'booked' },
          { value: s.shows, caption: 'Shows', stage: 'showed' },
          { value: s.closes, caption: 'Closes', stage: 'closed', bracket: closeSplit(s.closesHt, s.closesDc) },
        ]}
      />
      <StackedFunnelBox
        label="Reactivation"
        tone="blue"
        type="reactivation"
        range={range}
        filter={filter}
        dcCloses={re.dcCloses}
        cash={cash.reactivation}
        costBase={funnel.adspendUsd}
        stages={[
          { value: re.pool, caption: 'Pool', accent: true, bracket: dials(re.dials) },
          { value: re.connected, caption: 'Connected', stage: 'connected' },
          { value: re.books, caption: 'Books', stage: 'booked' },
          { value: re.shows, caption: 'Shows', stage: 'showed' },
          { value: re.closes, caption: 'Closes', stage: 'closed', bracket: closeSplit(re.closesHt, re.closesDc) },
        ]}
      />
    </div>
  )
}

type StageDef = { value: number | null; caption: string; accent?: boolean; bracket?: string; stage?: FunnelStage }
type FunnelTone = 'neutral' | 'pos' | 'warn' | 'blue'

const TONE_STYLE: Record<FunnelTone, { background: string; border: string }> = {
  neutral: { background: 'var(--color-geg-bg-elev)', border: 'var(--color-geg-border)' },
  pos: { background: 'var(--color-geg-pos-fill)', border: 'var(--color-geg-pos-border)' },
  warn: { background: 'var(--color-geg-warn-fill)', border: 'var(--color-geg-warn-border)' },
  // No blue token in the palette — pale-blue literal for the reactivation coat.
  blue: { background: 'rgba(125, 168, 224, 0.10)', border: 'rgba(125, 168, 224, 0.45)' },
}

type FNode = { value: number | null; caption: string; usd?: boolean; accent?: boolean; bracket?: string; stage?: FunnelStage; href?: string }

function StackedFunnelBox({
  label,
  tone = 'neutral',
  type,
  range,
  filter,
  adspend,
  adspendHref,
  clicks,
  costBase,
  poolSplit,
  dcCloses,
  cash,
  showRoas,
  stages,
}: {
  label: string
  tone?: FunnelTone
  type: LeadFilterType | null
  range: Range
  filter?: AdFilter
  adspend?: number | null
  adspendHref?: string
  clicks?: number | null
  costBase?: number | null
  poolSplit?: { qualified: number; unqualified: number }
  dcCloses?: number
  cash?: CashCollected
  showRoas?: boolean
  stages: StageDef[]
}) {
  // Ordered node list: adspend (if present) → unique link clicks (if present) →
  // stages. Each gap shows the conversion % (this/prev); each count node shows
  // cost-per-unit (total adspend / count) in small font under the number.
  const nodes: FNode[] = []
  if (adspend !== undefined) nodes.push({ value: adspend ?? null, caption: 'Adspend', usd: true, href: adspendHref })
  if (clicks !== undefined) nodes.push({ value: clicks ?? null, caption: 'Link clicks' })
  for (const s of stages) {
    nodes.push({ value: s.value, caption: s.caption, accent: s.accent, bracket: s.bracket, stage: s.stage, href: leadsHref(range, type, s.stage ?? null, filter) })
  }

  const costPer = (n: FNode): number | null =>
    !n.usd && costBase != null && n.value != null && n.value > 0 ? costBase / n.value : null
  // Conversion from prev → cur, only between two count nodes (skip across $).
  const conv = (p: FNode, c: FNode): number | null =>
    !p.usd && !c.usd && p.value != null && p.value > 0 && c.value != null ? (c.value / p.value) * 100 : null

  const cells: React.ReactNode[] = []
  nodes.forEach((n, i) => {
    if (i > 0) cells.push(<Chevron key={`ch${i}`} conversion={conv(nodes[i - 1], n)} />)
    cells.push(
      <FunnelNode key={n.caption} value={n.value} caption={n.caption} accent={n.accent}
        bracket={n.bracket} usd={n.usd} href={n.href} costPerUnit={costPer(n)} />,
    )
  })
  const cols = cells.map((_, i) => (i % 2 === 0 ? '1fr' : 'auto')).join(' ')
  const toneStyle = TONE_STYLE[tone]

  return (
    <div style={{ padding: '14px 16px', background: toneStyle.background, border: `1px solid ${toneStyle.border}`, borderRadius: 8, height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
        <BoxLabel>{label}</BoxLabel>
        {poolSplit ? (
          <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)' }}>
            {poolSplit.qualified.toLocaleString('en-US')} qual · {poolSplit.unqualified.toLocaleString('en-US')} unqual
          </span>
        ) : null}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: cols, alignItems: 'center', gap: 4, marginTop: 12 }}>
        {cells}
      </div>
      {dcCloses && dcCloses > 0 ? (
        <div className="geg-mono" style={{ marginTop: 8, fontSize: 11, letterSpacing: '0.06em', color: 'var(--color-geg-text-dim)' }}>
          ⌐ Digital College · {dcCloses.toLocaleString('en-US')} closed
        </div>
      ) : null}
      {cash ? <CashStrip cash={cash} showRoas={showRoas} /> : null}
    </div>
  )
}

// Cash-collected strip at the foot of a funnel box — the cash that funnel's
// closes produced, split HT / DC / Total (upfront = money actually collected).
// ROAS (and the adspend it divides by) only renders on the Total box: window
// adspend acquires the whole new-lead cohort, so a per-sub-funnel ROAS would
// divide the same spend repeatedly. Cohort-scoped by construction (Drake 2026-06-15).
function CashStrip({ cash, showRoas }: { cash: CashCollected; showRoas?: boolean }) {
  const usd = (n: number) => '$' + Math.round(n).toLocaleString('en-US')
  const roasStr = (r: number | null) => (r != null ? r.toFixed(2) + '×' : '—')
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: 16,
        marginTop: 10,
        paddingTop: 10,
        borderTop: '1px solid var(--color-geg-border)',
      }}
    >
      <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
        Cash collected
      </span>
      <CashItem label="HT" value={usd(cash.htUpfrontUsd)} />
      <CashItem label="DC" value={usd(cash.dcUsd)} />
      <CashItem label="Total" value={usd(cash.upfrontTotalUsd)} strong />
      {showRoas ? <CashItem label="ROAS" value={roasStr(cash.upfrontRoas)} strong accent /> : null}
      {showRoas && cash.adspendUsd != null ? (
        <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.06em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>
          · {usd(cash.adspendUsd)} adspend
        </span>
      ) : null}
    </div>
  )
}

function CashItem({ label, value, strong, accent }: { label: string; value: string; strong?: boolean; accent?: boolean }) {
  const zero = value === '$0' || value === '—'
  return (
    <span style={{ display: 'inline-flex', alignItems: 'baseline', gap: 5 }}>
      <span className="geg-mono" style={{ fontSize: 9, letterSpacing: '0.08em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)' }}>{label}</span>
      <span
        className="geg-numeric-serif"
        style={{ fontSize: strong ? 15 : 13, color: zero ? 'var(--color-geg-text-faint)' : accent ? 'var(--color-geg-accent)' : strong ? 'var(--color-geg-text)' : 'var(--color-geg-text-dim)' }}
      >
        {value}
      </span>
    </span>
  )
}

// A single funnel node — number + caption. When `href` is set the whole node is
// a Link to the pre-filtered roster (or the Ads page for adspend).
function FunnelNode({
  value,
  caption,
  accent,
  bracket,
  usd,
  href,
  costPerUnit,
}: {
  value: number | null
  caption: string
  accent?: boolean
  bracket?: string
  usd?: boolean
  href?: string
  costPerUnit?: number | null
}) {
  const pending = value === null
  const valueColor = pending
    ? 'var(--color-geg-text-faint)'
    : usd
      ? 'var(--color-geg-warn)'
      : accent
        ? 'var(--color-geg-accent)'
        : 'var(--color-geg-text)'
  const inner = (
    <>
      <div
        className="geg-numeric-serif"
        style={{ fontSize: 22, letterSpacing: '-0.02em', color: valueColor }}
        title={pending ? 'Not wired yet' : undefined}
      >
        {pending ? '—' : usd ? fullUsd(value) : value.toLocaleString('en-US')}
      </div>
      {bracket ? (
        <div className="geg-mono" style={{ fontSize: 10, fontWeight: 400, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)', marginTop: 1 }}>
          ({bracket})
        </div>
      ) : null}
      <div className="geg-mono" style={{ fontSize: 10, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', marginTop: 2 }}>
        {caption}
      </div>
      {costPerUnit != null ? (
        <div className="geg-mono" style={{ fontSize: 11, letterSpacing: '0.02em', color: 'var(--color-geg-text)', marginTop: 2 }}>
          {fullUsd(costPerUnit)}/ea
        </div>
      ) : null}
    </>
  )
  if (href) {
    return (
      <Link href={href} style={{ textAlign: 'center', minWidth: 0, textDecoration: 'none', color: 'inherit', display: 'block', borderRadius: 6 }}>
        {inner}
      </Link>
    )
  }
  return <div style={{ textAlign: 'center', minWidth: 0 }}>{inner}</div>
}

function Chevron({ conversion }: { conversion?: number | null }) {
  return (
    <span className="geg-mono" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', color: 'var(--color-geg-text-faint)' }}>
      <span style={{ fontSize: 12 }}>›</span>
      {conversion != null ? (
        <span style={{ fontSize: 11, letterSpacing: '0.02em', marginTop: 1, color: 'var(--color-geg-text)' }}>{Math.round(conversion)}%</span>
      ) : null}
    </span>
  )
}

function BoxLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="geg-mono"
      style={{ fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase', color: 'var(--color-geg-text-3)', display: 'flex', alignItems: 'center', gap: 8 }}
    >
      {children}
    </div>
  )
}

