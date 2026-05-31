'use client'

import { useEffect, useRef } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'

// Persist sales-dashboard filter + window state so it survives ALL navigation —
// sidebar clicks (bare hrefs), reloads, and the back-link chains that drop
// params (Drake 2026-05-31). Two scopes:
//
//   - WINDOW (start/end): GLOBAL — one key shared across the whole site, so the
//     date range you set on one page carries to every other windowed page.
//   - FILTERS: PER PAGE — keyed by pathname, so each page restores its own
//     filter selections (leads type/stage, people drill, landing vsl, …).
//
// Mechanism: the URL stays the source of truth (deep links, funnel drill-through,
// and shared links all keep working). This component only RESTORES from storage
// when a page lands with a bare URL, and PERSISTS whatever the URL currently
// carries on every change. Explicit URL params always win over stored state.
//
// Mount once per page with the keys that page owns:
//   <PersistPageState window filters={['view', 'type', 'stage']} />

const WIN_KEY = 'sd:win'
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

  // Restore once on mount, only for state the URL doesn't already carry.
  useEffect(() => {
    if (didRestore.current) return
    didRestore.current = true
    const sp = new URLSearchParams(params.toString())
    let changed = false

    if (persistWindow && !sp.has('start') && !sp.has('end')) {
      try {
        const raw = localStorage.getItem(WIN_KEY)
        if (raw) {
          const w = JSON.parse(raw) as { start?: string; end?: string }
          if (w?.start && w?.end) {
            sp.set('start', w.start)
            sp.set('end', w.end)
            changed = true
          }
        }
      } catch {
        /* storage unavailable / malformed — skip restore */
      }
    }

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
      try {
        localStorage.setItem(WIN_KEY, JSON.stringify({ start: sp.get('start'), end: sp.get('end') }))
      } catch {
        /* skip */
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
