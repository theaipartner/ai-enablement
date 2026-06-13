import { timingSafeEqual } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { resolveFunnelRange } from '@/lib/db/funnel-stages'
import { parseEtDateString } from '@/lib/db/funnel-window'
import { getSpeedToLeadCohort } from '@/lib/db/funnel-appointment-setting'
import { getLeadsForRangeLive, getLeadsForRangeTags, type LeadRow } from '@/lib/db/leads'

// TEMPORARY diff harness for the roster-from-tags cut-over (delete after
// verification). Runs V1 (live derivation) and V2 (tag-sourced) over the SAME
// cohort + window and reports a field-by-field diff.
//
//   GET /api/diag/roster-diff?start=YYYY-MM-DD&end=YYYY-MM-DD
//   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
//
// PASS criteria: `consumedFieldDiffs` is empty (the fields the funnel/roster/
// pages actually read are identical). `closeTimeChanges` is the expected,
// approved dial-cap convergence (a few old-format closes). Other entries in
// `allFieldDiffs` are non-consumed fields (dead reachedStage fallback) and are
// informational only.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Fields the funnel boxes, roster filter, roster display, or pages actually read.
// These MUST be byte-identical V1 vs V2.
const CONSUMED: (keyof LeadRow)[] = [
  'leadType', 'statusWord', 'latestStageWord', 'connectedEffective',
  'tagBecameDirect', 'tagReactivatedAt', 'tagPrimaryHits', 'tagReactiveHits',
  'qualified', 'adId', 'adName', 'optInAt', 'prospectName',
]

function bearerOk(req: NextRequest, expected: string): boolean {
  const header = req.headers.get('authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false
  const provided = Buffer.from(header.slice(prefix.length))
  const secret = Buffer.from(expected)
  if (provided.length !== secret.length) return false
  return timingSafeEqual(provided, secret)
}

export async function GET(req: NextRequest) {
  const expected = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!expected) return NextResponse.json({ error: 'server_misconfigured' }, { status: 500 })
  if (!bearerOk(req, expected)) return NextResponse.json({ error: 'unauthorized' }, { status: 401 })

  const sp = req.nextUrl.searchParams
  const range = resolveFunnelRange(
    parseEtDateString(sp.get('start') ?? undefined) ?? undefined,
    parseEtDateString(sp.get('end') ?? undefined) ?? undefined,
  )

  // Share ONE cohort fetch so both paths see the identical membership.
  const cohort = await getSpeedToLeadCohort(range)
  const [v1, v2] = await Promise.all([
    getLeadsForRangeLive(range, cohort),
    getLeadsForRangeTags(range, cohort),
  ])

  const v1by = new Map(v1.map((r) => [r.leadId, r]))
  const v2by = new Map(v2.map((r) => [r.leadId, r]))
  const allIds = Array.from(new Set<string>(Array.from(v1by.keys()).concat(Array.from(v2by.keys()))))

  const fieldDiffs: Record<string, number> = {}
  const samples: Array<{ leadId: string; field: string; v1: unknown; v2: unknown }> = []
  const onlyV1: string[] = []
  const onlyV2: string[] = []
  let closeTimeChanges = 0

  for (const id of allIds) {
    const a = v1by.get(id)
    const b = v2by.get(id)
    if (!a) { onlyV2.push(id); continue }
    if (!b) { onlyV1.push(id); continue }
    for (const k of Object.keys(a) as (keyof LeadRow)[]) {
      if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
        fieldDiffs[k as string] = (fieldDiffs[k as string] ?? 0) + 1
        if (k === 'closeTimeIso') closeTimeChanges++
        if (samples.length < 60) samples.push({ leadId: id, field: k as string, v1: a[k], v2: b[k] })
      }
    }
  }

  const consumedFieldDiffs = Object.fromEntries(
    CONSUMED.filter((k) => fieldDiffs[k as string]).map((k) => [k, fieldDiffs[k as string]]),
  )

  return NextResponse.json({
    window: { start: range.startEtDate, end: range.endEtDate },
    pass: Object.keys(consumedFieldDiffs).length === 0 && onlyV1.length === 0 && onlyV2.length === 0,
    counts: { v1: v1.length, v2: v2.length, onlyV1: onlyV1.length, onlyV2: onlyV2.length },
    consumedFieldDiffs,
    closeTimeChanges,
    allFieldDiffs: fieldDiffs,
    onlyV1: onlyV1.slice(0, 25),
    onlyV2: onlyV2.slice(0, 25),
    samples,
  })
}
