'use client'

import { usePathname, useRouter, useSearchParams } from 'next/navigation'

// Wraps a row in the speed-to-lead table so clicking it toggles the
// ?rep=USER_ID query param. Preserves existing params (start, end)
// via URLSearchParams. Uses router.replace with scroll:false so the
// page stays where it is on toggle.
export function RepLinkPreservingParams({
  userId,
  children,
}: {
  userId: string | null
  children: React.ReactNode
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()

  function onClick() {
    const sp = new URLSearchParams(params.toString())
    if (userId === null) sp.delete('rep')
    else sp.set('rep', userId)
    // Switching reps (or collapsing) resets the see-more state on
    // both drill lists so a new rep doesn't inherit the old toggle.
    sp.delete('showAllSpeed')
    sp.delete('showAllTriage')
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
