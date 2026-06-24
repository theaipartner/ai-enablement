import { timingSafeEqual } from 'crypto'
import { type NextRequest } from 'next/server'

// Shared bearer-token check for the scoped read-only API routes
// (app/api/*) that are handed to teammates without dashboard access —
// e.g. /api/speed-to-lead (Zain) and /api/clients (Zane). Each route
// guards itself with its OWN env-var key; this helper just does the
// constant-time compare so the routes don't each re-implement it.
//
// timingSafeEqual throws on a length mismatch, so we guard length first
// — a wrong-length token is a normal failure (→ 401), not a 500.
export function bearerOk(req: NextRequest, expected: string): boolean {
  const header = req.headers.get('authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false
  const provided = Buffer.from(header.slice(prefix.length))
  const secret = Buffer.from(expected)
  if (provided.length !== secret.length) return false
  return timingSafeEqual(provided, secret)
}
