import { HeaderBand } from '@/components/gregory/header-band'
import { RevivalCalledSection } from '@/components/sales/revival-called'
import { RevivalFunnelSection } from '@/components/sales/revival-funnel'
import { getRevivalCalled, getRevivalFunnel } from '@/lib/db/funnel-revival'
import { PersonPill } from '../../header-pills'

// Sales Dashboard — Revival (a sub-page under Funnel).
//
// The DC re-engagement campaign's own funnel: every revival-tagged lead through
// responded → connected → booked → showed → closed, with a cash row. Revival
// leads are excluded from every other funnel/roster (they're SMS auto-creates,
// not real opt-ins), so this is the only surface that counts them. All-time —
// per-lead activity is anchored to the revival-campaign start (see
// lib/db/funnel-revival.ts), there is no date window.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export default async function RevivalFunnelPage() {
  const [funnel, called] = await Promise.all([getRevivalFunnel(), getRevivalCalled()])

  return (
    <div>
      <HeaderBand
        eyebrow="SALES · FUNNEL"
        title="Revival."
        actions={<PersonPill label="EST · Nabeel" />}
      />

      <div
        className="geg-mono"
        style={{ marginTop: 14, fontSize: 10, letterSpacing: '0.04em', color: 'var(--color-geg-text-2)', lineHeight: 1.7 }}
      >
        The DC re-engagement SMS campaign. Every lead tagged <b>DC Revival Lead</b> in Close, from the
        re-engagement outreach through to the sale. These leads are excluded from every other funnel —
        this is the only place they&apos;re counted.
      </div>

      <RevivalFunnelSection funnel={funnel} />

      <RevivalCalledSection called={called} />

      <div
        className="geg-mono"
        style={{ marginTop: 14, fontSize: 9, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)', lineHeight: 1.8 }}
      >
        <b>Called</b> = the setter placed an outbound dial <i>after</i> the lead&apos;s first reply (their own
        call decision — no reply-text guessing) · <b>Connected</b> here = a ≥90s dial after the reply ·
        <b>Speed to dial</b> = first reply → first dial; the &gt;30m buckets fade to flag slow follow-up.
      </div>

      <div
        className="geg-mono"
        style={{ marginTop: 16, fontSize: 9, letterSpacing: '0.06em', color: 'var(--color-geg-text-faint)', lineHeight: 1.8 }}
      >
        Connected = a ≥90s call or a triage/confirmation form that reached the lead · Booked = a DC or
        HT booking · Showed = a closer-report show · Closed = a DC close <b>with an explicit plan</b>
        (a &ldquo;DC Closed&rdquo; form with no plan is counted as a show, not a close) · Cash = $300 per
        Digital College plan unit. Activity is counted from each lead&apos;s revival start (created date,
        floored at the Jun 3 blast launch) so pre-existing leads&apos; old activity isn&apos;t counted.
      </div>
    </div>
  )
}
