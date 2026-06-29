import { redirect } from 'next/navigation'
import { HeaderBand } from '@/components/gregory/header-band'
import { getCurrentUserAccessTier, tierAtLeast } from '@/lib/auth/access-tier'
import { getAllLandingPages } from '@/lib/db/landing-pages'
import { getWistiaInventory, getTypeformForms } from '@/lib/db/landing-page-assets'
import { LpManager } from './_components/lp-manager'

// Sales Dashboard — Landing Pages. ADMIN-only within Sales (the segment layout
// admits any sales-area user); re-checks admin tier and redirects reps back.
//
// Add a landing page by pasting its link: we auto-discover the embedded Typeform
// + Wistia videos (confirm screen), pick the qualification question + qualifying
// answers, and save. The LP then appears in the funnel's landing-page dropdown
// and new opt-ins through its form attribute to it automatically. Editing adds a
// form (old forms keep their cycles). Distinct from /funnel/landing-pages, which
// is the per-LP STATS detail page.
//
// Docs: docs/sales/landing-pages.md.
export const dynamic = 'force-dynamic'

export default async function LandingPagesAdminPage() {
  if (process.env.NEXT_PUBLIC_DISABLE_AUTH !== 'true') {
    const access = await getCurrentUserAccessTier()
    if (!access || !tierAtLeast(access.tier, 'admin')) redirect('/sales-dashboard')
  }
  const [landingPages, wistia, typeforms] = await Promise.all([
    getAllLandingPages(),
    getWistiaInventory(),
    getTypeformForms(),
  ])

  return (
    <>
      <HeaderBand eyebrow="SALES · ADMIN" title="Landing Pages" />
      <p
        style={{
          color: 'var(--color-geg-text-2)',
          fontSize: 13.5,
          maxWidth: 760,
          margin: '8px 0 28px',
          lineHeight: 1.5,
        }}
      >
        Register a landing page so its leads are attributed to it and it appears in
        the funnel&rsquo;s landing-page dropdown. Paste the link to auto-fill its
        Typeform and videos, set what answer qualifies a lead, and save. Editing a
        landing page&rsquo;s Typeform <strong>adds</strong> a form — the old
        form&rsquo;s leads stay counted.
      </p>
      <LpManager
        landingPages={landingPages}
        wistia={wistia}
        typeforms={typeforms}
      />
    </>
  )
}
