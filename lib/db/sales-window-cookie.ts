import 'server-only'

import { cookies } from 'next/headers'
import { parseEtDateString } from './funnel-window'

// Persisted sales date window, mirrored into a cookie by PersistPageState
// (client) so the FIRST server render can use the saved window instead of the
// page default. This eliminates the client re-navigation that previously fired
// on every bare navigation (sidebar click) — the page used to render once with
// the default window, then `router.replace` the saved window and render AGAIN.
//
// Cookie format: "YYYY-MM-DD~YYYY-MM-DD" (both ET calendar dates).
export const SALES_WINDOW_COOKIE = 'sd_win'

// The window a sales page should render. Precedence:
//   1. Explicit URL start/end (deep link, funnel drill-through, the date
//      picker) — always wins so shared links and drill-throughs are exact.
//   2. The saved cookie — the user's last-used window.
//   3. null / null — the caller applies its own default (typically today).
export function resolveSalesWindow(searchParams?: {
  start?: string | string[]
  end?: string | string[]
}): { start: string | null; end: string | null } {
  const urlStart = parseEtDateString(searchParams?.start)
  const urlEnd = parseEtDateString(searchParams?.end)
  if (urlStart || urlEnd) return { start: urlStart, end: urlEnd }
  try {
    const raw = cookies().get(SALES_WINDOW_COOKIE)?.value
    if (raw) {
      const [cs, ce] = raw.split('~')
      return { start: parseEtDateString(cs), end: parseEtDateString(ce) }
    }
  } catch {
    /* cookies() unavailable (e.g. static context) — fall through to default */
  }
  return { start: null, end: null }
}
