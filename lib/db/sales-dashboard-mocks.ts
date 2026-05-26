import 'server-only'

// Mock data shapes for the rebuilt Pulse / Trajectory / People views.
// Off the catalog grid — these are decision-driven views the video
// model demands. All deterministic by id+key so reloads stay stable.
// When real data lands, each block below maps to a real fetcher.
//
// Off by default — controlled by SALES_DASHBOARD_MOCK=true env var, the
// same gate as fetchSalesDashboardData.

import type { Window } from './sales-dashboard-shared'
import { WINDOW_DAYS } from './sales-dashboard-shared'

function hashId(id: string): number {
  let h = 2166136261
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return Math.abs(h)
}

function rand(seed: string): number {
  return (hashId(seed) % 10000) / 10000
}

// ---------------------------------------------------------------------------
// Month-to-date pacing — the band at the top of Pulse + the chart on
// Trajectory.
// ---------------------------------------------------------------------------

export type Pacing = {
  monthTarget: number
  mtdActual: number
  mtdExpected: number     // where pace says we should be today
  daysInMonth: number
  dayOfMonth: number
  dailyPaceRequired: number
  projectedEom: number
  // Cumulative daily series for the chart — actual + expected for each
  // day from day 1 to day-of-month. Actual after today is null.
  series: { day: number; actual: number | null; expected: number }[]
}

export function getPacing(): Pacing {
  const monthTarget = 611_000
  // Anchor day 18 of a 31-day month so the chart has enough texture and
  // shows both actual + expected without being trivial.
  const daysInMonth = 31
  const dayOfMonth = 18
  const dailyPaceRequired = monthTarget / daysInMonth
  const series: Pacing['series'] = []
  let actualCumulative = 0
  for (let d = 1; d <= daysInMonth; d++) {
    const expected = dailyPaceRequired * d
    if (d <= dayOfMonth) {
      // Daily actual with light noise + slight underpace bias.
      const jitter = 0.6 + rand(`pacing:${d}`) * 0.9 // 0.6..1.5 of daily pace
      const dayActual = dailyPaceRequired * jitter * 0.92 // underpace bias
      actualCumulative += dayActual
      series.push({ day: d, actual: actualCumulative, expected })
    } else {
      series.push({ day: d, actual: null, expected })
    }
  }
  const mtdActual = actualCumulative
  const mtdExpected = dailyPaceRequired * dayOfMonth
  // Project EOM by extrapolating current run-rate over remaining days.
  const runRate = mtdActual / dayOfMonth
  const projectedEom = runRate * daysInMonth
  return {
    monthTarget,
    mtdActual,
    mtdExpected,
    daysInMonth,
    dayOfMonth,
    dailyPaceRequired,
    projectedEom,
    series,
  }
}

// ---------------------------------------------------------------------------
// Money flow — five-card block at the top of Pulse. Cash collected,
// account-receivable (future cash), refunds, expenses, net profit. Each
// number is "since start of period" — current totals for the selected
// window. Mock values are picked per-window directly (not extrapolated)
// to keep them realistic at each scale.
// ---------------------------------------------------------------------------

// MoneyFlow type re-exported from shared so existing callers see no
// change. The canonical declaration lives in sales-dashboard-shared.ts
// so the client editor can import it without dragging server-only.
export type { MoneyFlow } from './sales-dashboard-shared'
import type { MoneyFlow } from './sales-dashboard-shared'

const MONEY_BY_WINDOW: Record<Window, Omit<MoneyFlow, 'netProfit'>> = {
  '1d': {
    cashCollected: 14_820,
    futureCash: 28_400,
    refunds: 0,
    expenses: 7_240,
    priorCashCollected: 11_400,
    cashSeries: [],
  },
  '7d': {
    cashCollected: 84_320,
    futureCash: 138_700,
    refunds: 4_200,
    expenses: 38_100,
    priorCashCollected: 71_800,
    cashSeries: [],
  },
  '30d': {
    cashCollected: 314_903,
    futureCash: 482_500,
    refunds: 8_400,
    expenses: 154_300,
    priorCashCollected: 286_400,
    cashSeries: [],
  },
}

export function getMoneyFlow(window: Window): MoneyFlow {
  const base = MONEY_BY_WINDOW[window]
  const netProfit = base.cashCollected + base.futureCash - base.refunds - base.expenses
  // Daily-ish series for the sparkline on the headline cash card.
  const seriesBase = base.cashCollected / Math.max(1, WINDOW_DAYS[window])
  const series: number[] = []
  for (let i = 0; i < 14; i++) {
    const wobble = 0.7 + rand(`money:${window}:p${i}`) * 0.6
    series.push(Math.max(0, seriesBase * wobble))
  }
  return { ...base, netProfit, cashSeries: series }
}

// Goal + projection defaults / helpers live in
// `sales-dashboard-shared.ts` so the client-side editor can import
// them without dragging the `'server-only'` boundary.

// ---------------------------------------------------------------------------
// Today snapshot — 4 mini-cards on Pulse showing intraday vs same-day
// last week.
// ---------------------------------------------------------------------------

export type TodayCard = {
  id: 'cash' | 'calls' | 'bookings' | 'spend'
  label: string
  today: number
  lastWeekSameDay: number
  format: 'usd' | 'integer'
}

export function getTodaySnapshot(): TodayCard[] {
  return [
    { id: 'cash', label: 'Cash today', today: 14_820, lastWeekSameDay: 11_400, format: 'usd' },
    { id: 'calls', label: 'Calls today', today: 9, lastWeekSameDay: 12, format: 'integer' },
    { id: 'bookings', label: 'Bookings today', today: 14, lastWeekSameDay: 11, format: 'integer' },
    { id: 'spend', label: 'Ad spend today', today: 1_640, lastWeekSameDay: 1_530, format: 'usd' },
  ]
}

// ---------------------------------------------------------------------------
// Sources panel — cash by source over the dashboard's window. Drives
// the "more before new" decision per the video.
// ---------------------------------------------------------------------------

export type SourceRow = {
  id: string
  label: string
  cash: number
  share: number  // 0..1
  delta: number  // pct vs prior period, signed
}

export function getSourcesPanel(window: Window): SourceRow[] {
  const scale = WINDOW_DAYS[window] / 7
  const raw = [
    { id: 'meta', label: 'Meta Ads', cash: 96_400 },
    { id: 'referrals', label: 'Referrals', cash: 71_200 },
    { id: 'youtube', label: 'YouTube', cash: 54_800 },
    { id: 'instagram', label: 'Instagram (organic)', cash: 28_300 },
    { id: 'linkedin', label: 'LinkedIn', cash: 11_900 },
    { id: 'other', label: 'Other / unattributed', cash: 8_400 },
  ]
  const scaled = raw.map((r) => ({ ...r, cash: Math.round(r.cash * scale) }))
  const total = scaled.reduce((s, r) => s + r.cash, 0) || 1
  return scaled.map((r) => ({
    ...r,
    share: r.cash / total,
    delta: (rand(`source:${r.id}`) - 0.5) * 0.6, // -30%..+30%
  }))
}

// ---------------------------------------------------------------------------
// People — per-rep performance for Closers, Setters, CSMs.
// ---------------------------------------------------------------------------

export type RepRole = 'closer' | 'setter' | 'csm'

export type CloserRep = {
  id: string
  name: string
  callsHandled: number       // total booked calls assigned to this closer
  showedCalls: number        // calls that actually showed
  showRate: number           // 0..1
  closeRate: number          // 0..1 (closed ÷ showed)
  oneCallCloseRate: number   // 0..1 (one-call closes ÷ new calls)
  cashPerCall: number        // total cash ÷ showed calls
  cashTotal: number
  aov: number                // total cash ÷ total closed deals
  deposits: number           // # of deposits collected this period
  totalClosedDeals: number
  trend: number[]            // 14-day daily cash sparkline
  showRateTrend: number[]    // 14-day daily show rate
  closeRateTrend: number[]   // 14-day daily close rate
}

export type SetterRep = {
  id: string
  name: string
  triages: number             // total triage conversations this period
  totalDials: number          // total dial attempts (Close calls)
  bookedRate: number          // 0..1 (booked meetings ÷ triages)
  dqRate: number              // 0..1
  downsellRate: number        // 0..1
  avgTimeToDial: number       // minutes
  handOffsCompleted: number   // # of hand-offs completed to closer
  meetingsProduced: number    // # of booked meetings produced
  trend: number[]             // 14-day daily bookings produced
  timeToDialTrend: number[]   // 14-day daily avg time-to-dial (minutes)
}

export type CsmRep = {
  id: string
  name: string
  retention: number    // 0..1
  nps: number          // -100..100
  callsHeld: number
  trend: number[]
}

const CLOSER_NAMES = ['Scott', 'Lou', 'Nico']
const SETTER_NAMES = ['Aman', 'Priya', 'Marco', 'Jaya']
const CSM_NAMES = ['Ella', 'Riya', 'Tomás']

function mockSparkLine(seed: string, base: number, count = 14): number[] {
  const pts: number[] = []
  const trendBias = (rand(`${seed}:trend`) - 0.5) * 0.4 // -20%..+20% over series
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1)
    const trend = 1 + trendBias * (t - 0.5)
    const wobble = 0.8 + rand(`${seed}:p${i}`) * 0.4 // 0.8..1.2
    pts.push(Math.max(0, base * trend * wobble))
  }
  return pts
}

export function getClosers(window: Window): CloserRep[] {
  const scale = WINDOW_DAYS[window] / 7
  return CLOSER_NAMES.map((name, i) => {
    const seed = `closer:${name}`
    const showRate = 0.55 + rand(`${seed}:show`) * 0.25  // 55-80%
    const closeRate = 0.18 + rand(`${seed}:close`) * 0.18 // 18-36%
    const oneCallCloseRate = closeRate * (0.55 + rand(`${seed}:occ`) * 0.3) // ~55-85% of close rate
    const cashPerCall = 1_400 + Math.round(rand(`${seed}:cpc`) * 2_400)
    const callsHandled = Math.max(3, Math.round((22 + i * 4 + rand(`${seed}:calls`) * 16) * scale))
    const showedCalls = Math.max(1, Math.round(callsHandled * showRate))
    const totalClosedDeals = Math.max(1, Math.round(showedCalls * closeRate))
    const cashTotal = Math.round(showedCalls * cashPerCall)
    const aov = cashTotal / totalClosedDeals
    const deposits = Math.max(0, Math.round(totalClosedDeals * (0.42 + rand(`${seed}:dep`) * 0.24)))
    return {
      id: `closer-${i}`,
      name,
      callsHandled,
      showedCalls,
      showRate,
      closeRate,
      oneCallCloseRate,
      cashPerCall,
      cashTotal,
      aov,
      deposits,
      totalClosedDeals,
      trend: mockSparkLine(seed, cashTotal / 7),
      showRateTrend: mockSparkLine(`${seed}:showtrend`, showRate * 100),
      closeRateTrend: mockSparkLine(`${seed}:closetrend`, closeRate * 100),
    }
  }).sort((a, b) => b.cashPerCall - a.cashPerCall)
}

export function getSetters(window: Window): SetterRep[] {
  const scale = WINDOW_DAYS[window] / 7
  return SETTER_NAMES.map((name, i) => {
    const seed = `setter:${name}`
    const triages = Math.max(4, Math.round((40 + i * 6 + rand(`${seed}:tr`) * 20) * scale))
    const bookedRate = 0.32 + rand(`${seed}:book`) * 0.28
    const dqRate = 0.08 + rand(`${seed}:dq`) * 0.18
    const downsellRate = 0.04 + rand(`${seed}:ds`) * 0.10
    const avgTimeToDial = 4 + Math.round(rand(`${seed}:time`) * 12)
    const totalDials = Math.max(triages, Math.round(triages * (1.6 + rand(`${seed}:dials`) * 0.8)))
    const meetingsProduced = Math.max(1, Math.round(triages * bookedRate))
    const handOffsCompleted = Math.max(0, Math.round(meetingsProduced * (0.55 + rand(`${seed}:ho`) * 0.3)))
    return {
      id: `setter-${i}`,
      name,
      triages,
      totalDials,
      bookedRate,
      dqRate,
      downsellRate,
      avgTimeToDial,
      handOffsCompleted,
      meetingsProduced,
      trend: mockSparkLine(seed, meetingsProduced / 7),
      timeToDialTrend: mockSparkLine(`${seed}:t2dtrend`, avgTimeToDial),
    }
  }).sort((a, b) => b.bookedRate - a.bookedRate)
}

// ---------------------------------------------------------------------------
// Team averages — used by the People leaderboard to render a pinned
// "team avg" row and per-cell vs-avg deltas. Computed across the
// currently-rendered team list.
// ---------------------------------------------------------------------------

export type CloserAverages = {
  callsHandled: number
  showedCalls: number
  showRate: number
  closeRate: number
  oneCallCloseRate: number
  cashPerCall: number
  cashTotal: number
  aov: number
  deposits: number
  totalClosedDeals: number
}

export type SetterAverages = {
  triages: number
  totalDials: number
  bookedRate: number
  dqRate: number
  downsellRate: number
  avgTimeToDial: number
  handOffsCompleted: number
  meetingsProduced: number
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

export function getCloserAverages(reps: CloserRep[]): CloserAverages {
  return {
    callsHandled: mean(reps.map((r) => r.callsHandled)),
    showedCalls: mean(reps.map((r) => r.showedCalls)),
    showRate: mean(reps.map((r) => r.showRate)),
    closeRate: mean(reps.map((r) => r.closeRate)),
    oneCallCloseRate: mean(reps.map((r) => r.oneCallCloseRate)),
    cashPerCall: mean(reps.map((r) => r.cashPerCall)),
    cashTotal: mean(reps.map((r) => r.cashTotal)),
    aov: mean(reps.map((r) => r.aov)),
    deposits: mean(reps.map((r) => r.deposits)),
    totalClosedDeals: mean(reps.map((r) => r.totalClosedDeals)),
  }
}

export function getSetterAverages(reps: SetterRep[]): SetterAverages {
  return {
    triages: mean(reps.map((r) => r.triages)),
    totalDials: mean(reps.map((r) => r.totalDials)),
    bookedRate: mean(reps.map((r) => r.bookedRate)),
    dqRate: mean(reps.map((r) => r.dqRate)),
    downsellRate: mean(reps.map((r) => r.downsellRate)),
    avgTimeToDial: mean(reps.map((r) => r.avgTimeToDial)),
    handOffsCompleted: mean(reps.map((r) => r.handOffsCompleted)),
    meetingsProduced: mean(reps.map((r) => r.meetingsProduced)),
  }
}

// ---------------------------------------------------------------------------
// Per-person detail — every call/deal record this person owns, plus
// trends already attached to the rep. Mock-only for now.
// ---------------------------------------------------------------------------

const PERSON_LEAD_POOL = [
  'Alex Carter', 'Bianca Rossi', 'Carlos Mendes', 'Dana Patel', 'Ethan Wright',
  'Fatima Ahmed', 'Grace O’Donnell', 'Liam Donovan', 'Maya Singh', 'Nikolai Petrov',
  'Olivia Reyes', 'Priya Iyer', 'Rachel Cohen', 'Samir Khan', 'Theresa Nguyen',
  'Uma Tashiro', 'Victor Almeida', 'Wendy Park', 'Yara Idris', 'Zhao Tian',
]

const CALL_OUTCOMES = ['closed', 'showed-no-close', 'no-show', 'rescheduled', 'cancelled'] as const
type CallOutcome = typeof CALL_OUTCOMES[number]

export type CloserCallRecord = {
  id: string
  date: string
  leadName: string
  offerType: string
  outcome: CallOutcome
  cashCollected: number | null
}

export type CloserDealRecord = {
  id: string
  date: string
  leadName: string
  offerType: string
  contractAmount: number
  isOneCall: boolean
}

export type SetterTriageRecord = {
  id: string
  date: string
  leadName: string
  outcome: 'booked' | 'dq' | 'downsell' | 'hand-down' | 'no-answer'
  timeToDial: number  // minutes
}

const OFFER_LABELS = ['Core coaching', 'Quarterly mastermind', 'DFY agency service', 'Renewal', 'Upsell']

export function getCloserDetail(window: Window, closerId: string): {
  rep: CloserRep | null
  recentCalls: CloserCallRecord[]
  recentDeals: CloserDealRecord[]
  objections: { id: string; label: string; count: number }[]
} {
  const closers = getClosers(window)
  const rep = closers.find((r) => r.id === closerId) ?? null
  if (!rep) return { rep: null, recentCalls: [], recentDeals: [], objections: [] }

  const seed = `closer-detail:${closerId}:${window}`
  const callsVolume = Math.min(rep.callsHandled, 24)
  const recentCalls: CloserCallRecord[] = []
  for (let i = 0; i < callsVolume; i++) {
    // Outcome distribution roughly matches the rep's show/close rates.
    const r = rand(`${seed}:call:${i}:outcome`)
    let outcome: CallOutcome
    if (r < rep.showRate * rep.closeRate) outcome = 'closed'
    else if (r < rep.showRate) outcome = 'showed-no-close'
    else if (r < rep.showRate + 0.12) outcome = 'no-show'
    else if (r < rep.showRate + 0.18) outcome = 'rescheduled'
    else outcome = 'cancelled'
    const offerType = OFFER_LABELS[Math.floor(rand(`${seed}:call:${i}:offer`) * OFFER_LABELS.length)]
    const cashCollected = outcome === 'closed'
      ? Math.round(rep.aov * (0.6 + rand(`${seed}:call:${i}:cash`) * 0.8))
      : null
    recentCalls.push({
      id: `call-${closerId}-${i}`,
      date: dateForOffset(i),
      leadName: PERSON_LEAD_POOL[(i * 3) % PERSON_LEAD_POOL.length],
      offerType,
      outcome,
      cashCollected,
    })
  }

  const dealsVolume = Math.min(rep.totalClosedDeals, 14)
  const recentDeals: CloserDealRecord[] = []
  for (let i = 0; i < dealsVolume; i++) {
    const offerType = OFFER_LABELS[Math.floor(rand(`${seed}:deal:${i}:offer`) * OFFER_LABELS.length)]
    const isOneCall = rand(`${seed}:deal:${i}:1c`) < (rep.oneCallCloseRate / Math.max(rep.closeRate, 0.001))
    recentDeals.push({
      id: `deal-${closerId}-${i}`,
      date: dateForOffset(i * 2),
      leadName: PERSON_LEAD_POOL[(i * 5) % PERSON_LEAD_POOL.length],
      offerType,
      contractAmount: Math.round(rep.aov * (0.85 + rand(`${seed}:deal:${i}:amt`) * 0.4)),
      isOneCall,
    })
  }

  // Objection breakdown — losing to which objection. Per-closer leaks
  // skew differently so the diagnostic is meaningful.
  const showedNoClose = recentCalls.filter((c) => c.outcome === 'showed-no-close').length
  const objections = [
    { id: 'shopping', label: 'Shopping around', count: Math.round(showedNoClose * (0.25 + rand(`${seed}:obj:shop`) * 0.3)) },
    { id: 'think-fear', label: 'Think about it / fear', count: Math.round(showedNoClose * (0.2 + rand(`${seed}:obj:tf`) * 0.3)) },
    { id: 'spouse', label: 'Spouse / partner', count: Math.round(showedNoClose * (0.1 + rand(`${seed}:obj:sp`) * 0.2)) },
    { id: 'price', label: 'Price', count: Math.round(showedNoClose * (0.15 + rand(`${seed}:obj:pr`) * 0.25)) },
    { id: 'timing', label: 'Wrong timing', count: Math.round(showedNoClose * (0.08 + rand(`${seed}:obj:ti`) * 0.18)) },
  ]

  return { rep, recentCalls, recentDeals, objections }
}

export function getSetterDetail(window: Window, setterId: string): {
  rep: SetterRep | null
  recentTriages: SetterTriageRecord[]
  recentBookings: SetterTriageRecord[]
} {
  const setters = getSetters(window)
  const rep = setters.find((r) => r.id === setterId) ?? null
  if (!rep) return { rep: null, recentTriages: [], recentBookings: [] }

  const seed = `setter-detail:${setterId}:${window}`
  const recentTriages: SetterTriageRecord[] = []
  const recentBookings: SetterTriageRecord[] = []
  const volume = Math.min(rep.triages, 30)
  for (let i = 0; i < volume; i++) {
    const r = rand(`${seed}:tri:${i}:outcome`)
    let outcome: SetterTriageRecord['outcome']
    if (r < rep.bookedRate) outcome = 'booked'
    else if (r < rep.bookedRate + rep.dqRate) outcome = 'dq'
    else if (r < rep.bookedRate + rep.dqRate + rep.downsellRate) outcome = 'downsell'
    else if (r < rep.bookedRate + rep.dqRate + rep.downsellRate + 0.08) outcome = 'hand-down'
    else outcome = 'no-answer'
    const rec: SetterTriageRecord = {
      id: `tri-${setterId}-${i}`,
      date: dateForOffset(i),
      leadName: PERSON_LEAD_POOL[(i * 4) % PERSON_LEAD_POOL.length],
      outcome,
      timeToDial: Math.max(1, Math.round(rep.avgTimeToDial * (0.5 + rand(`${seed}:tri:${i}:t2d`) * 1.0))),
    }
    recentTriages.push(rec)
    if (outcome === 'booked') recentBookings.push(rec)
  }

  return { rep, recentTriages, recentBookings }
}

function dateForOffset(i: number): string {
  // Walk backwards from day 18 of May 2026 by i+1 days.
  const day = Math.max(1, 18 - i)
  return `2026-05-${String(day).padStart(2, '0')}T12:00:00Z`
}

export function getCsms(window: Window): CsmRep[] {
  const scale = WINDOW_DAYS[window] / 7
  return CSM_NAMES.map((name, i) => {
    const seed = `csm:${name}`
    const retention = 0.78 + rand(`${seed}:ret`) * 0.18
    const nps = Math.round(30 + rand(`${seed}:nps`) * 60)
    const callsHeld = Math.max(2, Math.round((12 + i * 3 + rand(`${seed}:c`) * 14) * scale))
    return {
      id: `csm-${i}`,
      name,
      retention,
      nps,
      callsHeld,
      trend: mockSparkLine(seed, callsHeld / 7),
    }
  }).sort((a, b) => b.retention - a.retention)
}

// ---------------------------------------------------------------------------
// Needs Attention — daily review queue stub + emergency triggers.
// ---------------------------------------------------------------------------

export type QueueItem = {
  id: string
  kind: 'expense' | 'call' | 'lead' | 'refund'
  label: string
  detail: string
  // Action surface — what clicking the item does. Stub for now.
  action: string
}

export type EmergencyTrigger = {
  id: string
  label: string
  status: 'ok' | 'warn' | 'crit'
  value: string
  threshold: string
  action?: string
}

export function getReviewQueue(): QueueItem[] {
  return [
    { id: 'q1', kind: 'expense', label: 'Uncategorized expense', detail: 'Stripe — $128 · Vercel · 2 days ago', action: 'Categorize' },
    { id: 'q2', kind: 'expense', label: 'Uncategorized expense', detail: 'Stripe — $44 · Linear · 4 days ago', action: 'Categorize' },
    { id: 'q3', kind: 'call', label: 'Call missing closer', detail: 'Talk Yvonne — 38min · yesterday 14:00 EDT', action: 'Assign closer' },
    { id: 'q4', kind: 'lead', label: 'Lead source unattributed', detail: 'Mark T. · booked 2d ago — no funnel id', action: 'Set source' },
    { id: 'q5', kind: 'refund', label: 'Refund needs reason', detail: '$2,400 · J. Patel · processed 3 days ago', action: 'Set reason' },
  ]
}

export function getEmergencyTriggers(): EmergencyTrigger[] {
  return [
    {
      id: 'booking-capacity',
      label: 'Booking capacity',
      status: 'warn',
      value: '64%',
      threshold: '≥ 70%',
      action: 'Notify content manager',
    },
    {
      id: 'cost-per-call',
      label: 'Cost per booked call (Meta)',
      status: 'ok',
      value: '$112',
      threshold: '≤ $150',
    },
    {
      id: 'show-rate',
      label: 'Show rate · last 7d',
      status: 'crit',
      value: '52%',
      threshold: '≥ 65%',
      action: 'Trigger reminder cadence',
    },
    {
      id: 'one-call-close',
      label: 'One-call close rate',
      status: 'ok',
      value: '24%',
      threshold: '≥ 20%',
    },
  ]
}

// ---------------------------------------------------------------------------
// Funnel + cash by source (Trajectory) — per-source MTD vs target slice.
// ---------------------------------------------------------------------------

export type SourcePace = {
  id: string
  label: string
  mtdActual: number
  targetShare: number  // 0..1 of monthTarget allocated to this source
}

// ---------------------------------------------------------------------------
// CLOSING — objection mix + cash-by-call-type composition.
// ---------------------------------------------------------------------------

export type ObjectionRow = { id: string; label: string; count: number; share: number }

export function getObjectionMix(window: Window): ObjectionRow[] {
  const scale = WINDOW_DAYS[window] / 7
  const raw = [
    { id: 'price', label: 'Price / payment plan', count: 18 },
    { id: 'spouse', label: 'Need to discuss with spouse', count: 11 },
    { id: 'shopping', label: 'Shopping around', count: 9 },
    { id: 'think', label: 'Think about it / fear', count: 7 },
    { id: 'timing', label: 'Wrong timing', count: 5 },
    { id: 'other', label: 'Other / unclear', count: 4 },
  ]
  const scaled = raw.map((r) => ({ ...r, count: Math.max(1, Math.round(r.count * scale)) }))
  const total = scaled.reduce((s, r) => s + r.count, 0) || 1
  return scaled.map((r) => ({ ...r, share: r.count / total }))
}

export type CashByCallType = { id: string; label: string; cash: number }

export function getCashByCallType(window: Window): CashByCallType[] {
  const scale = WINDOW_DAYS[window] / 7
  return [
    { id: 'new', label: 'New consultation calls', cash: Math.round(124_000 * scale) },
    { id: 'followup', label: 'Follow-up calls', cash: Math.round(48_000 * scale) },
    { id: 'deposit', label: 'Deposit collected', cash: Math.round(22_400 * scale) },
    { id: 'direct', label: 'Direct booking led', cash: Math.round(86_000 * scale) },
    { id: 'setter', label: 'Setter led', cash: Math.round(38_000 * scale) },
  ]
}

// ---------------------------------------------------------------------------
// APPOINTMENT SETTING — hand-down breakdown + triage→booked funnel
// ---------------------------------------------------------------------------

export type SetterFunnelStage = { id: string; label: string; count: number }

export function getSetterFunnel(window: Window): SetterFunnelStage[] {
  const scale = WINDOW_DAYS[window] / 7
  return [
    { id: 'triages', label: 'Total triages', count: Math.round(186 * scale) },
    { id: 'qualified', label: 'Qualified after triage', count: Math.round(141 * scale) },
    { id: 'booked', label: 'Booked with closer', count: Math.round(82 * scale) },
    { id: 'confirmed', label: 'Confirmed (no cancel)', count: Math.round(64 * scale) },
  ]
}

// ---------------------------------------------------------------------------
// ADVERTISING — per-creative perf.
// ---------------------------------------------------------------------------

export type AdCreative = {
  id: string
  name: string
  spend: number
  impressions: number
  ctr: number   // 0..1
  cpc: number   // $ per click
  bookings: number
  costPerBooking: number
  status: 'scaling' | 'stable' | 'fatiguing' | 'paused'
  trend: number[]
}

export function getAdCreatives(window: Window): AdCreative[] {
  const scale = WINDOW_DAYS[window] / 7
  const names = [
    'VSL-A · "Quit the agency hamster wheel"',
    'VSL-B · "From 0 to $8M in 4 years"',
    'Static-1 · Founder pic + headline',
    'UGC-1 · Client testimonial reel',
    'Carousel-2 · 5-step framework',
    'Static-2 · Before/after pricing',
  ]
  const statuses: AdCreative['status'][] = ['scaling', 'stable', 'fatiguing', 'paused']
  return names.map((name, i) => {
    const seed = `ad:${i}`
    const spend = Math.round((1_200 + rand(seed + 'sp') * 6_800) * scale)
    const impressions = Math.round((40_000 + rand(seed + 'imp') * 200_000) * scale)
    const ctr = 0.008 + rand(seed + 'ctr') * 0.035
    const clicks = Math.round(impressions * ctr)
    const cpc = clicks > 0 ? spend / clicks : 0
    const bookings = Math.max(1, Math.round((4 + rand(seed + 'bk') * 28) * scale))
    const costPerBooking = bookings > 0 ? spend / bookings : 0
    const status = statuses[Math.floor(rand(seed + 'st') * statuses.length)]
    return {
      id: `ad-${i}`,
      name,
      spend,
      impressions,
      ctr,
      cpc,
      bookings,
      costPerBooking,
      status,
      trend: mockSparkLine(seed, spend / 7),
    }
  }).sort((a, b) => a.costPerBooking - b.costPerBooking)
}

// ---------------------------------------------------------------------------
// FUNNELS — per-funnel drop-off.
// ---------------------------------------------------------------------------

export type FunnelDef = {
  id: string
  name: string
  visits: number
  vslWatched: number
  submits: number
  booked: number
}

export function getFunnels(window: Window): FunnelDef[] {
  const scale = WINDOW_DAYS[window] / 7
  return [
    {
      id: 'fn-main',
      name: 'Main VSL Funnel',
      visits: Math.round(18_200 * scale),
      vslWatched: Math.round(6_400 * scale),
      submits: Math.round(412 * scale),
      booked: Math.round(168 * scale),
    },
    {
      id: 'fn-youtube',
      name: 'YouTube Direct Book',
      visits: Math.round(4_100 * scale),
      vslWatched: Math.round(2_900 * scale),
      submits: Math.round(186 * scale),
      booked: Math.round(94 * scale),
    },
    {
      id: 'fn-event',
      name: 'In-Person Event Reg',
      visits: Math.round(2_800 * scale),
      vslWatched: 0,
      submits: Math.round(312 * scale),
      booked: Math.round(212 * scale),
    },
  ]
}

// ---------------------------------------------------------------------------
// SALES DATA / BACK END REV — revenue composition + cash by offer
// ---------------------------------------------------------------------------

export type RevenueSlice = { id: string; label: string; cash: number; tone: 'primary' | 'secondary' }

export function getRevenueComposition(window: Window): RevenueSlice[] {
  const scale = WINDOW_DAYS[window] / 7
  return [
    { id: 'new', label: 'New cash', cash: Math.round(186_000 * scale), tone: 'primary' },
    { id: 'ar', label: 'Account receivable (collected)', cash: Math.round(84_000 * scale), tone: 'secondary' },
    { id: 'upsell', label: 'Upsells / cross-sells', cash: Math.round(28_400 * scale), tone: 'secondary' },
    { id: 'renewals', label: 'Renewals', cash: Math.round(14_200 * scale), tone: 'secondary' },
    { id: 'mastermind', label: 'Mastermind tickets', cash: Math.round(36_000 * scale), tone: 'secondary' },
    { id: 'refunds', label: 'Refunds', cash: -Math.round(8_400 * scale), tone: 'secondary' },
  ]
}

export type OfferRow = { id: string; label: string; cash: number; units: number; aov: number; ltv: number }

export function getCashByOffer(window: Window): OfferRow[] {
  const scale = WINDOW_DAYS[window] / 7
  return [
    { id: 'core', label: 'Core coaching program', cash: Math.round(154_000 * scale), units: Math.round(22 * scale), aov: 7_000, ltv: 12_400 },
    { id: 'mastermind', label: 'Quarterly mastermind', cash: Math.round(36_000 * scale), units: Math.round(6 * scale), aov: 6_000, ltv: 6_800 },
    { id: 'agency-svc', label: 'Done-for-you agency service', cash: Math.round(58_000 * scale), units: Math.round(4 * scale), aov: 14_500, ltv: 22_000 },
  ]
}

// ---------------------------------------------------------------------------
// BUSINESS COSTS — expenses by category + projection
// ---------------------------------------------------------------------------

export type ExpenseCategory = {
  id: string
  label: string
  actual: number
  projection: number
  topItems: { label: string; amount: number }[]
}

export function getExpenseCategories(window: Window): ExpenseCategory[] {
  const scale = WINDOW_DAYS[window] / 30
  return [
    {
      id: 'labor',
      label: 'Labor',
      actual: Math.round(82_400 * scale),
      projection: Math.round(75_000 * scale),
      topItems: [
        { label: 'Closer commissions', amount: Math.round(32_000 * scale) },
        { label: 'Setter base + comm', amount: Math.round(18_400 * scale) },
        { label: 'CSM team salaries', amount: Math.round(16_000 * scale) },
        { label: 'Contractors', amount: Math.round(9_800 * scale) },
      ],
    },
    {
      id: 'marketing',
      label: 'Marketing',
      actual: Math.round(64_800 * scale),
      projection: Math.round(70_000 * scale),
      topItems: [
        { label: 'Meta ads', amount: Math.round(48_200 * scale) },
        { label: 'YouTube post-prod', amount: Math.round(8_400 * scale) },
        { label: 'Affiliate payouts', amount: Math.round(5_200 * scale) },
      ],
    },
    {
      id: 'overhead',
      label: 'Overhead',
      actual: Math.round(11_600 * scale),
      projection: Math.round(12_000 * scale),
      topItems: [
        { label: 'Software subscriptions', amount: Math.round(4_200 * scale) },
        { label: 'Office + utilities', amount: Math.round(3_400 * scale) },
        { label: 'Legal + accounting', amount: Math.round(2_800 * scale) },
      ],
    },
    {
      id: 'coaching',
      label: 'Coaching / masterminds',
      actual: Math.round(6_400 * scale),
      projection: Math.round(8_000 * scale),
      topItems: [
        { label: 'Founder coach', amount: Math.round(3_500 * scale) },
        { label: 'Sales mastermind dues', amount: Math.round(2_400 * scale) },
      ],
    },
  ]
}

// ---------------------------------------------------------------------------
// FULFILLMENT — client outcomes
// ---------------------------------------------------------------------------

export type FulfillmentSnapshot = {
  activeClients: number
  newClients: number
  churnedClients: number
  callsHeld: number
  avgCallDuration: number  // seconds
  npsScore: number         // -100..100
  retentionRate: number    // 0..1
  outcomesTrend: number[]
}

export function getFulfillmentSnapshot(window: Window): FulfillmentSnapshot {
  const scale = WINDOW_DAYS[window] / 7
  return {
    activeClients: 184,
    newClients: Math.round(11 * scale),
    churnedClients: Math.round(3 * scale),
    callsHeld: Math.round(78 * scale),
    avgCallDuration: 48 * 60,
    npsScore: 64,
    retentionRate: 0.91,
    outcomesTrend: mockSparkLine('fulfillment', 14 * scale),
  }
}

// ---------------------------------------------------------------------------
// Trajectory per-source pacing
// ---------------------------------------------------------------------------

export function getSourcePacing(monthTarget: number): SourcePace[] {
  const allocations = [
    { id: 'meta', label: 'Meta Ads', share: 0.45 },
    { id: 'referrals', label: 'Referrals', share: 0.25 },
    { id: 'youtube', label: 'YouTube', share: 0.18 },
    { id: 'instagram', label: 'Instagram (organic)', share: 0.07 },
    { id: 'linkedin', label: 'LinkedIn', share: 0.03 },
    { id: 'other', label: 'Other', share: 0.02 },
  ]
  // Mock MTD actual at ~58% of target share with per-source variance.
  return allocations.map((a) => {
    const variance = 0.4 + rand(`pace:${a.id}`) * 0.6 // 0.4..1.0 of target
    return {
      id: a.id,
      label: a.label,
      targetShare: a.share,
      mtdActual: Math.round(monthTarget * a.share * variance),
    }
  })
}
