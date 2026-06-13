'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

// Persist sales-dashboard filter + window state so it survives ALL navigation —
// sidebar clicks (bare hrefs), reloads, and the back-link chains that drop
// params (Drake 2026-05-31). Two scopes:
//
//   - WINDOW (start/end): GLOBAL — written to a server-readable COOKIE
//     (sd_win), so the first server render of any bare navigation already uses
//     the saved window (resolveSalesWindow, lib/db/sales-window-cookie.ts). No
//     client re-navigation: the window restore that used to fire a second full
//     render on every bare navigation is gone.
//   - FILTERS: PER PAGE — keyed by pathname in localStorage, restored client-
//     side (leads type/stage/ad, landing vsl, …). These still re-navigate when
//     a saved filter needs re-applying on a bare URL.
//
// Mechanism: the URL stays the source of truth (deep links, funnel drill-through,
// and shared links all keep working). Explicit URL params always win.
//
// Mount once per page with the keys that page owns:
//   <PersistPageState window filters={['view', 'type', 'stage']} />

const WIN_COOKIE = 'sd_win'
// ~180 days; refreshed on every window change.
const WIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 180
const filtersKeyFor = (path: string) => `sd:filters:${path}`

export function PersistPageState({
  window: persistWindow = false,
  filters = [],
}: {
  // Persist + restore the global start/end date window.
  window?: boolean
  // Per-page filter param names to persist + restore.
  filters?: string[]
}) {
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const didRestore = useRef(false)
  const filtersJoined = filters.join(',')

  // Restore once on mount — FILTERS ONLY. The window is resolved server-side
  // from the sd_win cookie, so it never needs a client re-navigation here.
  useEffect(() => {
    if (didRestore.current) return
    didRestore.current = true
    const sp = new URLSearchParams(params.toString())
    let changed = false

    // Only restore filters when the URL carries NONE of them — if the user (or a
    // drill-through link) set any filter explicitly, that intent wins entirely.
    const keys = filtersJoined ? filtersJoined.split(',') : []
    if (keys.length > 0 && !keys.some((k) => sp.has(k))) {
      try {
        const raw = localStorage.getItem(filtersKeyFor(pathname))
        if (raw) {
          const f = JSON.parse(raw) as Record<string, string>
          for (const k of keys) {
            if (f?.[k] != null && f[k] !== '') {
              sp.set(k, f[k])
              changed = true
            }
          }
        }
      } catch {
        /* skip */
      }
    }

    if (changed) router.replace(`${pathname}?${sp.toString()}`, { scroll: false })
    // Mount-only restore — deliberately no deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Persist whatever the URL currently carries, on every change.
  useEffect(() => {
    const sp = new URLSearchParams(params.toString())
    if (persistWindow && sp.has('start') && sp.has('end')) {
      // Window → server-readable cookie, so the next bare navigation renders the
      // saved window on the first server pass (no client re-navigation).
      const start = sp.get('start')
      const end = sp.get('end')
      if (start && end) {
        document.cookie = `${WIN_COOKIE}=${start}~${end}; path=/; max-age=${WIN_COOKIE_MAX_AGE}; SameSite=Lax`
      }
    }
    const keys = filtersJoined ? filtersJoined.split(',') : []
    if (keys.length > 0) {
      const f: Record<string, string> = {}
      for (const k of keys) {
        const v = sp.get(k)
        if (v != null) f[k] = v
      }
      try {
        localStorage.setItem(filtersKeyFor(pathname), JSON.stringify(f))
      } catch {
        /* skip */
      }
    }
  }, [params, pathname, persistWindow, filtersJoined])

  return null
}
