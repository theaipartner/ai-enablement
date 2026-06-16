import { timingSafeEqual } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { getSpeedToLeadCohort } from '@/lib/db/funnel-appointment-setting'
import { dateRangeFromExplicit, parseEtDateString, todayEtDate } from '@/lib/db/funnel-window'

// Read-only speed-to-lead API for Zain.
//
//   GET /api/speed-to-lead[?date=YYYY-MM-DD]
//   Authorization: Bearer <SPEED_TO_LEAD_API_KEY>
//
// Returns the average speed-to-lead for one ET day (defaults to today),
// counting only business-hours time (10am–10pm ET) so overnight waits
// don't count. Cohort = leads who opted in that ET day; reuses
// getSpeedToLeadCohort so the numbers match the dashboard's Leads page.
//
// Scoped on purpose: this is a single, narrow read surface guarded by
// its own bearer key (rotate by changing the env var) — NOT a Supabase
// credential. The key only unlocks this endpoint.
//
// Runbook: docs/runbooks/speed_to_lead_api.md.

export const dynamic = 'force-dynamic'

function bearerOk(req: NextRequest, expected: string): boolean {
  const header = req.headers.get('authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false
  const provided = Buffer.from(header.slice(prefix.length))
  const secret = Buffer.from(expected)
  // timingSafeEqual throws on length mismatch — guard first so a wrong
  // length is a normal 401, not a 500.
  if (provided.length !== secret.length) return false
  return timingSafeEqual(provided, secret)
}

function toMinutes(sec: number | null): number | null {
  return sec == null ? null : Math.round(sec / 60)
}

export async function GET(req: NextRequest) {
  const expected = process.env.SPEED_TO_LEAD_API_KEY
  if (!expected) {
    // Missing env var is our deploy bug, not the caller's — fail loud.
    return NextResponse.json({ error: 'server_misconfigured' }, { status: 500 })
  }
  if (!bearerOk(req, expected)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  // ?date=YYYY-MM-DD (ET). Invalid or absent → today (ET).
  const dateParam = req.nextUrl.searchParams.get('date') ?? undefined
  const etDate = parseEtDateString(dateParam) ?? todayEtDate()
  const range = dateRangeFromExplicit(etDate, etDate)

  const cohort = await getSpeedToLeadCohort(range)

  return NextResponse.json({
    date: etDate,
    timezone: 'America/New_York',
    // Overall average speed-to-lead (opt-in → first outbound call) for
    // the day's cohort, counting ONLY business-hours time (10am–10pm ET):
    // overnight waits don't count, so a 1am opt-in dialled at noon is 2h.
    // Every called lead included (24h outlier cap per lead). null when no
    // called leads. Replaced the old wall-clock avg + <3h subset (Drake
    // 2026-06-16); the averageSpeedToLeadUnder3h field is gone.
    averageSpeedToLead: {
      seconds: cohort.avgSpeedToLeadSec,
      minutes: toMinutes(cohort.avgSpeedToLeadSec),
    },
    // Context so the average is interpretable.
    cohortSize: cohort.cohortSize,
    leadsCalled: cohort.leadsCalled,
  })
}
