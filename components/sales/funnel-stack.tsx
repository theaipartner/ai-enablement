import Link from 'next/link'
import { compactUsd } from '@/lib/db/sales-dashboard-shared'
import type { LeadsFunnel, LeadFilterType, FunnelStage } from '@/lib/db/leads-funnel'

// Stacked funnel — Total on top, then Direct / Setter-led / Reactivation, each a
// full-width horizontal funnel. Lives on the Funnel (Pulse) page; every stage
// node links to the Leads roster pre-filtered to that funnel's (type, stage),
// preserving the window. The Total box's adspend node links to the Ads page.
// Counts come from getLeadsFunnel and share the reachedStage predicate with the
// roster filter, so a bar's count equals the roster it opens.

type Range = { startEtDate: string; endEtDate: string }

function leadsHref(range: Range, type: LeadFilterType | null, stage: FunnelStage | null): string {
  const p = new URLSearchParams()
  p.set('start', range.startEtDate)
  p.set('end', range.endEtDate)
  if (type) p.set('type', type)
  if (stage) p.set('stage', stage)
  return `/sales-dashboard/leads?${p.toString()}`
}

function adsHref(range: Range): string {
  const p = new URLSearchParams({ start: range.startEtDate, end: range.endEtDate })
  return `/sales-dashboard/funnel/ads?${p.toString()}`
}

// Dials live in a bracket beside each funnel's lead amount (not a stage), so the
// funnel reads strictly top-down. Coats: Direct green, Setter-led ("new
// opt-ins") yellow, Reactivation pale blue, Total neutral.
export function FunnelStack({ funnel, range }: { funnel: LeadsFunnel; range: Range }) {
  const { total: t, direct: d, setter: s, reactivation: re } = funnel
  const dials = (n: number) => `${n.toLocaleString('en-US')} dials`
  // Closes node bracket — split high-ticket vs Digital College so each is
  // visible. Shown only when there are closes.
  const closeSplit = (ht: number, dc: number): string | undefined =>
    ht + dc > 0 ? `${ht} HT / ${dc} DC` : undefined
  return (
    <div style={{ display: 'grid', gap: 12, marginTop: 14 }}>
      <StackedFunnelBox
        label="Total"
        sublabel="Every opt-in in the window"
        tone="neutral"
        type={null}
        range={range}
        adspend={funnel.adspendUsd}
        adspendHref={adsHref(range)}
        stages={[
          { value: t.optIns, caption: 'Opt-ins', accent: true, bracket: dials(t.dials) },
          { value: t.connected, caption: 'Connected', stage: 'connected' },
          { value: t.books, caption: 'Books', stage: 'booked' },
          { value: t.shows, caption: 'Shows', stage: 'showed' },
          { value: t.closes, caption: 'Closes', stage: 'closed', bracket: closeSplit(t.closesHt, t.closesDc) },
        ]}
      />
      <StackedFunnelBox
        label="Direct"
        sublabel="Booked a strategy call after opt-in (includes reactivations)"
        tone="pos"
        type="direct"
        range={range}
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
        sublabel="Never booked a strategy call"
        tone="warn"
        type="setter"
        range={range}
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
        sublabel="Direct leads that lost their strat spot · activity counted after the handover"
        tone="blue"
        type="reactivation"
        range={range}
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

function StackedFunnelBox({
  label,
  sublabel,
  tone = 'neutral',
  type,
  range,
  adspend,
  adspendHref,
  poolSplit,
  stages,
}: {
  label: string
  sublabel: string
  tone?: FunnelTone
  type: LeadFilterType | null
  range: Range
  adspend?: number | null
  adspendHref?: string
  poolSplit?: { qualified: number; unqualified: number }
  stages: StageDef[]
}) {
  // Optional adspend node, then the stages — every node chevron-separated, so
  // cells alternate node/chevron/node and the grid columns alternate 1fr/auto.
  const cells: React.ReactNode[] = []
  if (adspend !== undefined) {
    cells.push(
      <FunnelNode
        key="adspend"
        value={adspend ?? null}
        caption="Adspend"
        usd
        href={adspendHref}
      />,
    )
    cells.push(<Chevron key="ch-adspend" />)
  }
  stages.forEach((s, i) => {
    if (i > 0) cells.push(<Chevron key={`ch${i}`} />)
    cells.push(
      <FunnelNode
        key={s.caption}
        value={s.value}
        caption={s.caption}
        accent={s.accent}
        bracket={s.bracket}
        href={leadsHref(range, type, s.stage ?? null)}
      />,
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
      <SubLine>{sublabel}</SubLine>
    </div>
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
}: {
  value: number | null
  caption: string
  accent?: boolean
  bracket?: string
  usd?: boolean
  href?: string
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
        {pending ? '—' : usd ? compactUsd(value) : value.toLocaleString('en-US')}
        {bracket ? (
          <span className="geg-mono" style={{ fontSize: 9, fontWeight: 400, letterSpacing: '0.04em', color: 'var(--color-geg-text-faint)', marginLeft: 4 }}>
            ({bracket})
          </span>
        ) : null}
      </div>
      <div className="geg-mono" style={{ fontSize: 8.5, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--color-geg-text-faint)', marginTop: 2 }}>
        {caption}
      </div>
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

function Chevron() {
  return <span className="geg-mono" style={{ fontSize: 12, color: 'var(--color-geg-text-faint)', textAlign: 'center' }}>›</span>
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

function SubLine({ children }: { children: React.ReactNode }) {
  return (
    <div className="geg-mono" style={{ marginTop: 6, fontSize: 9.5, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)' }}>
      {children}
    </div>
  )
}
