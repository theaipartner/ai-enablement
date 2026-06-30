import { redirect } from 'next/navigation'
import { HeaderBand } from '@/components/gregory/header-band'
import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'
import { getAllOutboundCampaigns, getMatchFieldSuggestions } from '@/lib/db/outbound-campaigns'
import { CampaignManager } from './_components/campaign-manager'

// Sales Dashboard — Outbound Campaigns. ADMIN-only within Sales (the segment
// layout admits any sales-area user; this re-checks admin tier and redirects
// reps back).
//
// Add an outbound campaign by giving it a name + a custom-field NAME and exact
// VALUE: any lead carrying that pair — in Close OR GHL — belongs to the campaign.
// Campaigns are independent (a lead in two counts in both). On Add it appears in
// the Outbound page's campaign dropdown and its funnel populates. The two
// finished legacy pools (Revival, Jacob) are shown read-only.
//
// Docs: docs/schema/outbound_campaigns.md; docs/sales/surfaces.md § Outbound.
export const dynamic = 'force-dynamic'

export default async function OutboundCampaignsPage() {
  if (process.env.NEXT_PUBLIC_DISABLE_AUTH !== 'true') {
    const access = await getCurrentUserAccessTier()
    if (!access || !tierAtLeast(access.tier, 'admin')) redirect('/sales-dashboard')
  }
  const [campaigns, fieldSuggestions] = await Promise.all([
    getAllOutboundCampaigns(),
    getMatchFieldSuggestions(),
  ])

  return (
    <>
      <HeaderBand eyebrow="SALES · ADMIN" title="Outbound Campaigns" />
      <p
        style={{
          color: 'var(--color-geg-text-2)',
          fontSize: 13.5,
          maxWidth: 760,
          margin: '8px 0 28px',
          lineHeight: 1.5,
        }}
      >
        Add an outbound campaign by giving it a name plus a <strong>custom-field name</strong>{' '}
        and the exact <strong>value</strong> a lead must carry. Any lead with that
        field&rsquo;s value — whether it lives in <strong>Close or GHL</strong> — is counted
        in the campaign, from the start date onward. Campaigns are independent: a lead in two
        campaigns is counted in both. On <strong>Add</strong> it appears in the Outbound
        page&rsquo;s dropdown. The two finished campaigns (Revival, Jacob) are locked.
        <br />
        <strong>Type the field name exactly</strong> as it appears in Close/GHL — it&rsquo;s a
        case-sensitive match, so a typo means zero leads. The field box suggests names we
        already know, but you can type a brand-new one. A field you <em>just created in GHL</em>{' '}
        won&rsquo;t match instantly — it matches <strong>on its own within ~15&ndash;30&nbsp;min</strong>{' '}
        once the sync mirrors the new field (no action needed). <strong>Re-tag</strong> just
        applies it immediately instead of waiting — also handy after you change a field/value.
      </p>
      <CampaignManager campaigns={campaigns} fieldSuggestions={fieldSuggestions} />
    </>
  )
}
