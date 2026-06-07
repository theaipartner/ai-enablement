'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

// Wraps a row in the speed-to-lead table so clicking it toggles the
// ?rep=USER_ID query param. Preserves existing params (start, end)
// via URLSearchParams. Uses router.replace with scroll:false so the
// page stays where it is on toggle.
export function RepLinkPreservingParams({
  userId,
  fam,
  children,
}: {
  userId: string | null
  // Which table the rep was clicked in. Carried as ?repfam so only that
  // table's drill expands — a dual-role rep (e.g. Aman, Connor) appears in
  // both the Triage (setter) and Confirmation (closer) tables.
  fam?: 'setter' | 'closer'
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function onClick() {
    const sp = new URLSearchParams(params.toString())
    if (userId === null) {
      sp.delete('rep')
      sp.delete('repfam')
    } else {
      sp.set('rep', userId)
      if (fam) sp.set('repfam', fam)
    }
    const qs = sp.toString()
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onClick() }}
      style={{ cursor: 'pointer' }}
    >
      {children}
    </div>
  )
}
