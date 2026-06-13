import { timingSafeEqual } from 'crypto'
import { NextResponse, type NextRequest } from 'next/server'

import { resolveFunnelRange } from '@/lib/db/funnel-stages'
import { parseEtDateString } from '@/lib/db/funnel-window'
import {
  getCallActivityMetricsLive,
  getCallActivityMetricsRpc,
  type CallActivityRepRow,
} from '@/lib/db/funnel-appointment-setting'

// TEMPORARY diff harness for the Talent rep-activity SQL cut-over (delete after
// verification). Runs V1 (full close_calls scan) and V2 (sales_rep_call_activity
// RPC) over the same window and diffs every per-rep field.
//
//   GET /api/diag/rep-activity-diff?start=YYYY-MM-DD&end=YYYY-MM-DD
//   Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
//
// PASS = consumedFieldDiffs empty AND no rep present in only one side.

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Fields the /people per-rep table renders → MUST be byte-identical V1 vs V2.
const CONSUMED: (keyof CallActivityRepRow)[] = [
  'userId', 'name', 'totalCalls', 'totalConnected', 'htBookings', 'dcBookings',
  'dcCloses', 'followUps', 'confirmedBooks', 'confirmedNewTime', 'downsellsOnCall',
  'dqs', 'missing',
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

type Side = Awaited<ReturnType<typeof getCallActivityMetricsLive>>

function diffList(
  label: string,
  a: CallActivityRepRow[],
  b: CallActivityRepRow[],
  fieldDiffs: Record<string, number>,
  samples: Array<{ list: string; userId: string | null; field: string; v1: unknown; v2: unknown }>,
): { onlyV1: string[]; onlyV2: string[] } {
  const ab = new Map(a.map((r) => [r.userId ?? '∅', r]))
  const bb = new Map(b.map((r) => [r.userId ?? '∅', r]))
  const ids = Array.from(new Set<string>(Array.from(ab.keys()).concat(Array.from(bb.keys()))))
  const onlyV1: string[] = []
  const onlyV2: string[] = []
  for (const id of ids) {
    const x = ab.get(id)
    const y = bb.get(id)
    if (!x) { onlyV2.push(id); continue }
    if (!y) { onlyV1.push(id); continue }
    for (const k of Object.keys(x) as (keyof CallActivityRepRow)[]) {
      if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) {
        const key = `${label}.${k as string}`
        fieldDiffs[key] = (fieldDiffs[key] ?? 0) + 1
        if (samples.length < 60) samples.push({ list: label, userId: id, field: k as string, v1: x[k], v2: y[k] })
      }
    }
  }
  return { onlyV1, onlyV2 }
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

  const [v1, v2]: [Side, Side] = await Promise.all([
    getCallActivityMetricsLive(range),
    getCallActivityMetricsRpc(range),
  ])

  const fieldDiffs: Record<string, number> = {}
  const samples: Array<{ list: string; userId: string | null; field: string; v1: unknown; v2: unknown }> = []
  const s = diffList('setters', v1.setters, v2.setters, fieldDiffs, samples)
  const c = diffList('closers', v1.closers, v2.closers, fieldDiffs, samples)
  // Aggregates + total forms.
  for (const [label, x, y] of [
    ['settersAggregate', v1.settersAggregate, v2.settersAggregate],
    ['closersAggregate', v1.closersAggregate, v2.closersAggregate],
  ] as const) {
    for (const k of Object.keys(x) as (keyof CallActivityRepRow)[]) {
      if (JSON.stringify(x[k]) !== JSON.stringify(y[k])) {
        fieldDiffs[`${label}.${k as string}`] = 1
        if (samples.length < 60) samples.push({ list: label, userId: null, field: k as string, v1: x[k], v2: y[k] })
      }
    }
  }
  if (v1.totalFormsInWindow !== v2.totalFormsInWindow) fieldDiffs['totalFormsInWindow'] = 1

  const consumedFieldDiffs = Object.fromEntries(
    Object.entries(fieldDiffs).filter(([k]) => CONSUMED.some((f) => k.endsWith(`.${f as string}`))),
  )
  const onlyV1 = [...s.onlyV1, ...c.onlyV1]
  const onlyV2 = [...s.onlyV2, ...c.onlyV2]

  return NextResponse.json({
    window: { start: range.startEtDate, end: range.endEtDate },
    pass: Object.keys(consumedFieldDiffs).length === 0 && onlyV1.length === 0 && onlyV2.length === 0,
    counts: {
      v1Setters: v1.setters.length, v2Setters: v2.setters.length,
      v1Closers: v1.closers.length, v2Closers: v2.closers.length,
    },
    consumedFieldDiffs,
    allFieldDiffs: fieldDiffs,
    onlyV1, onlyV2,
    samples,
  })
}
