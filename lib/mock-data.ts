// Promethean V0 mock data — deterministic, seeded RNG so the demo is stable
// across reloads. Types are named to match the eventual Supabase schema so
// the integration swap is `import { LEADS } from './mock-data'` →
// `import { fetchLeads } from './db/promethean'` with the same shape.
//
// IMPORTANT: this file is the single boundary for mock data. When real
// queries land, only this file gets replaced.

import type {
  CountryValue,
  DialOutcomeValue,
  LeadQualityValue,
  LeadStatusValue,
  OutcomeValue,
  QcGradeValue,
  SentimentValue,
  TriageStatusValue,
} from './promethean-vocab'

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32). Same seed → same data → demo is deterministic.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return function () {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const rand = mulberry32(20260512)
function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(rand() * arr.length)]
}
function range(min: number, max: number): number {
  return Math.floor(rand() * (max - min + 1)) + min
}
function randFloat(min: number, max: number, decimals = 2): number {
  const v = rand() * (max - min) + min
  return Math.round(v * 10 ** decimals) / 10 ** decimals
}
function weightedPick<T extends string>(weights: Record<T, number>): T {
  const total = Object.values(weights).reduce((a, b) => (a as number) + (b as number), 0) as number
  let r = rand() * total
  for (const [key, w] of Object.entries(weights) as [T, number][]) {
    r -= w
    if (r <= 0) return key
  }
  return Object.keys(weights)[0] as T
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type Setter = {
  id: string
  name: string
  avatar_initials: string
  hired_at: string
}

export type Closer = {
  id: string
  name: string
  avatar_initials: string
  tier: 'top' | 'mid' | 'developing'
}

export type Lead = {
  id: string
  name: string
  email: string
  phone: string
  country: CountryValue
  source: string
  status: LeadStatusValue
  setter_id: string | null
  closer_id: string | null
  created_at: string
  first_contact_at: string | null
  booked_at: string | null
  showed_at: string | null
  pitched_at: string | null
  outcome: OutcomeValue | null
  cash_collected: number | null
  contract_value: number | null
  payment_plan: boolean
  lead_quality: LeadQualityValue | null
  sentiment: SentimentValue | null
  notes: string | null
  triage_status: TriageStatusValue | null
  last_activity_at: string
  is_overdue: boolean
}

export type Dial = {
  id: string
  setter_id: string
  lead_id: string
  dialed_at: string
  talk_time_seconds: number
  outcome: DialOutcomeValue
}

export type AdSpendDay = {
  date: string
  campaign: string
  country: CountryValue
  spend: number
  impressions: number
  clicks: number
  leads_generated: number
}

export type Payment = {
  id: string
  lead_id: string
  amount: number
  paid_at: string
  payment_plan_position: number | null
  payment_plan_total: number | null
}

export type QcReview = {
  id: string
  setter_id: string
  lead_id: string
  call_at: string
  grade: QcGradeValue
  summary: string
  duration_seconds: number
}

export type InboxNotification = {
  id: string
  kind: 'alert' | 'win' | 'risk' | 'system'
  title: string
  body: string
  created_at: string
  read: boolean
}

// ---------------------------------------------------------------------------
// Date helpers — anchor on 2026-05-12 (the demo "today")
// ---------------------------------------------------------------------------
const TODAY = new Date('2026-05-12T15:00:00Z')

function isoDaysAgo(days: number): string {
  const d = new Date(TODAY)
  d.setUTCDate(d.getUTCDate() - days)
  d.setUTCHours(range(8, 19), range(0, 59), 0, 0)
  return d.toISOString()
}

function isoDateOnly(daysAgo: number): string {
  const d = new Date(TODAY)
  d.setUTCDate(d.getUTCDate() - daysAgo)
  return d.toISOString().slice(0, 10)
}

export const PERIOD_LABEL = 'Apr 12 → May 11'
export const SYNC_LABEL = '9:36 AM'
export const TODAY_ISO = TODAY.toISOString()

// ---------------------------------------------------------------------------
// Setters + closers (names from the transcript)
// ---------------------------------------------------------------------------
const SETTER_SEED = [
  ['set_jam', 'James Whitford'],
  ['set_aub', 'Aubrey Lane'],
  ['set_aid', 'Aiden Rodriguez'],
  ['set_jor', 'Jordan Vance'],
  ['set_mor', 'Morgan Ellis'],
  ['set_pri', 'Priya Shah'],
  ['set_dav', 'Davis Cole'],
] as const

const CLOSER_SEED = [
  ['cls_seb', 'Sebastian Brown', 'top'],
  ['cls_jam', 'James Whitford', 'top'],
  ['cls_aub', 'Aubrey Lane', 'mid'],
  ['cls_aid', 'Aiden Rodriguez', 'mid'],
  ['cls_jor', 'Jordan Vance', 'developing'],
] as const

function initials(name: string): string {
  return name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()
}

export const SETTERS: Setter[] = SETTER_SEED.map(([id, name]) => ({
  id,
  name,
  avatar_initials: initials(name),
  hired_at: isoDaysAgo(range(60, 540)),
}))

export const CLOSERS: Closer[] = CLOSER_SEED.map(([id, name, tier]) => ({
  id,
  name,
  avatar_initials: initials(name),
  tier: tier as Closer['tier'],
}))

// ---------------------------------------------------------------------------
// Leads (50 across the last 60 days)
// ---------------------------------------------------------------------------
const FIRST_NAMES = [
  'Marcus', 'Olivia', 'Noah', 'Ava', 'Liam', 'Sophia', 'Ethan', 'Isla', 'Mason',
  'Zara', 'Caleb', 'Maya', 'Hunter', 'Layla', 'Owen', 'Eliza', 'Wyatt', 'Nora',
  'Levi', 'Hazel', 'Asher', 'Ruby', 'Silas', 'Mila', 'Theo', 'Quinn', 'Felix',
  'Iris', 'Jasper', 'Cora', 'Kai', 'Stella', 'Beau', 'Sage', 'Rowan', 'Vera',
  'Cyrus', 'Reese', 'Drew', 'Talia', 'Hugo', 'Wren', 'Cody', 'Daphne', 'Bryce',
  'Amara', 'Tate', 'Greer', 'Ezra', 'Naomi',
]
const LAST_NAMES = [
  'Carter', 'Hayes', 'Bennett', 'Walsh', 'Russo', 'Mendez', 'Khan', 'Park',
  'Singh', 'Patel', 'Nakamura', 'Costa', 'Hughes', 'Bradley', 'Spencer',
  'Reyes', 'Garcia', 'Knight', 'Booth', 'Wallace', 'Holt', 'Greene', 'Fisher',
  'Lambert', 'Walters', 'Schmidt', 'Travers', 'McGrath', 'Donovan', 'Pope',
]
const SOURCES = ['Meta · Cold Traffic', 'Meta · Retargeting', 'YouTube Ads', 'Referral', 'Organic'] as const

function makeLead(idx: number): Lead {
  const first = pick(FIRST_NAMES)
  const last = pick(LAST_NAMES)
  const name = `${first} ${last}`
  const createdDaysAgo = range(0, 58)
  const status = weightedPick<LeadStatusValue>({
    new: 8, contacted: 10, qualified: 8, booked: 12, showed: 10,
    pitched: 8, won: 6, lost: 8,
  })

  const country = weightedPick<CountryValue>({ USA: 18, CAN: 6, AUS: 4, UK: 5, GBR: 3 })

  let setter_id: string | null = SETTERS[range(0, SETTERS.length - 1)].id
  let closer_id: string | null = null
  let first_contact_at: string | null = null
  let booked_at: string | null = null
  let showed_at: string | null = null
  let pitched_at: string | null = null
  let outcome: OutcomeValue | null = null
  let cash_collected: number | null = null
  let contract_value: number | null = null
  let payment_plan = false
  let lead_quality: LeadQualityValue | null = null
  let sentiment: SentimentValue | null = null

  if (status === 'new') setter_id = null

  if (status !== 'new') {
    first_contact_at = isoDaysAgo(createdDaysAgo - range(0, 1))
  }
  if (['qualified', 'booked', 'showed', 'pitched', 'won', 'lost'].includes(status)) {
    lead_quality = weightedPick<LeadQualityValue>({
      ready_to_buy: 3, good: 6, average: 7, poor: 4,
    })
  }
  if (['booked', 'showed', 'pitched', 'won', 'lost'].includes(status)) {
    booked_at = isoDaysAgo(Math.max(0, createdDaysAgo - range(0, 5)))
    closer_id = CLOSERS[range(0, CLOSERS.length - 1)].id
  }
  if (['showed', 'pitched', 'won', 'lost'].includes(status)) {
    showed_at = booked_at
    sentiment = weightedPick<SentimentValue>({ green: 5, yellow: 4, red: 3 })
  }
  if (['pitched', 'won', 'lost'].includes(status)) {
    pitched_at = showed_at
  }
  if (status === 'won') {
    outcome = 'won'
    contract_value = pick([9700, 12500, 18000, 24000, 32000, 45000])
    payment_plan = rand() > 0.45
    cash_collected = payment_plan
      ? Math.round(contract_value * randFloat(0.25, 0.55))
      : Math.round(contract_value * randFloat(0.9, 1.0))
  }
  if (status === 'lost') {
    outcome = pick<OutcomeValue>(['lost', 'no_show', 'dq'])
  }

  const triage_status: TriageStatusValue | null = status === 'booked'
    ? pick<TriageStatusValue>(['untriaged', 'confirmed', 'follow_up'])
    : null

  const lastActivityDaysAgo = Math.max(0, createdDaysAgo - range(0, 3))
  const is_overdue =
    ['contacted', 'qualified', 'booked'].includes(status) && lastActivityDaysAgo > 4

  return {
    id: `ld_${(idx + 1000).toString(36)}`,
    name,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
    phone: `+1 ${range(200, 989)}-${range(200, 989)}-${String(range(0, 9999)).padStart(4, '0')}`,
    country,
    source: pick(SOURCES),
    status,
    setter_id,
    closer_id,
    created_at: isoDaysAgo(createdDaysAgo),
    first_contact_at,
    booked_at,
    showed_at,
    pitched_at,
    outcome,
    cash_collected,
    contract_value,
    payment_plan,
    lead_quality,
    sentiment,
    notes: rand() > 0.7
      ? pick([
          'Looking to close before end of quarter, husband on the fence.',
          'Already runs ads — wants help with ROAS optimization.',
          'Budget OK, timeline tight. Wants June start.',
          'Pricing concern; said they need to think it over.',
          'Referral from existing client. Warm.',
        ])
      : null,
    triage_status,
    last_activity_at: isoDaysAgo(lastActivityDaysAgo),
    is_overdue,
  }
}

export const LEADS: Lead[] = Array.from({ length: 50 }, (_, i) => makeLead(i))

// ---------------------------------------------------------------------------
// Dials — ~400 over the last 30 days
// ---------------------------------------------------------------------------
function makeDial(i: number): Dial {
  const setter = pick(SETTERS)
  const lead = pick(LEADS)
  const outcome = weightedPick<DialOutcomeValue>({
    no_answer: 12, voicemail: 6, live: 4, booked: 1,
  })
  return {
    id: `dl_${i}`,
    setter_id: setter.id,
    lead_id: lead.id,
    dialed_at: isoDaysAgo(range(0, 29)),
    talk_time_seconds: outcome === 'live' || outcome === 'booked' ? range(60, 540) : range(2, 25),
    outcome,
  }
}
export const DIALS: Dial[] = Array.from({ length: 420 }, (_, i) => makeDial(i))

// ---------------------------------------------------------------------------
// Ad spend — 60 days × 3 campaigns × 4 countries
// ---------------------------------------------------------------------------
const CAMPAIGNS = ['Acquisition · Broad', 'Acquisition · Retargeting', 'YT Brand'] as const
const SPEND_COUNTRIES: CountryValue[] = ['USA', 'CAN', 'AUS', 'UK']

export const AD_SPEND: AdSpendDay[] = (() => {
  const out: AdSpendDay[] = []
  for (let d = 0; d < 60; d++) {
    for (const campaign of CAMPAIGNS) {
      for (const country of SPEND_COUNTRIES) {
        const dayBoost = 1 + Math.sin(d / 6) * 0.18
        const countryWeight =
          country === 'USA' ? 1.0 : country === 'CAN' ? 0.45 : country === 'AUS' ? 0.35 : 0.55
        const campaignWeight =
          campaign === 'Acquisition · Broad' ? 1.0 : campaign === 'Acquisition · Retargeting' ? 0.4 : 0.3
        const spend = Math.round(420 * dayBoost * countryWeight * campaignWeight + range(20, 120))
        const impressions = Math.round(spend * range(35, 90))
        const clicks = Math.round(impressions * randFloat(0.012, 0.029, 4))
        const leads_generated = Math.max(0, Math.round(clicks * randFloat(0.06, 0.16, 4)))
        out.push({
          date: isoDateOnly(d),
          campaign,
          country,
          spend,
          impressions,
          clicks,
          leads_generated,
        })
      }
    }
  }
  return out
})()

// ---------------------------------------------------------------------------
// Payments — pulled off the won-leads list
// ---------------------------------------------------------------------------
export const PAYMENTS: Payment[] = (() => {
  const out: Payment[] = []
  const wonLeads = LEADS.filter((l) => l.outcome === 'won' && l.cash_collected !== null)
  for (const lead of wonLeads) {
    if (lead.payment_plan && lead.contract_value) {
      const planTotal = 3 + range(0, 3) // 3-6 payments
      const positionPaid = Math.min(planTotal, 1 + range(0, planTotal - 1))
      const installment = Math.round(lead.contract_value / planTotal)
      for (let p = 1; p <= positionPaid; p++) {
        out.push({
          id: `pmt_${lead.id}_${p}`,
          lead_id: lead.id,
          amount: installment,
          paid_at: isoDaysAgo(range(0, 30)),
          payment_plan_position: p,
          payment_plan_total: planTotal,
        })
      }
    } else if (lead.cash_collected !== null) {
      out.push({
        id: `pmt_${lead.id}_full`,
        lead_id: lead.id,
        amount: lead.cash_collected,
        paid_at: isoDaysAgo(range(0, 30)),
        payment_plan_position: null,
        payment_plan_total: null,
      })
    }
  }
  return out
})()

// ---------------------------------------------------------------------------
// QC reviews — 28 across recent calls
// ---------------------------------------------------------------------------
const QC_SUMMARIES = [
  'Strong rapport open. Missed reframe on price objection at 11:30.',
  'Discovery rushed. Closer pivoted to demo before pain points landed.',
  'Excellent objection handling on timing. Booked next step cleanly.',
  'Lost control mid-pitch when prospect went tangential about competitor.',
  'Followed framework but felt scripted — flatness on value-stack.',
  'Confident frame throughout. Strong assumptive close.',
  'No urgency built. Prospect left without commitment date.',
  'Recovered from rough opener with solid mid-call discovery.',
] as const
export const QC_REVIEWS: QcReview[] = Array.from({ length: 28 }, (_, i) => ({
  id: `qc_${i}`,
  setter_id: pick(SETTERS).id,
  lead_id: pick(LEADS).id,
  call_at: isoDaysAgo(range(0, 14)),
  grade: weightedPick<QcGradeValue>({ green: 5, yellow: 7, red: 3 }),
  summary: pick(QC_SUMMARIES),
  duration_seconds: range(180, 1800),
}))

// ---------------------------------------------------------------------------
// Inbox notifications
// ---------------------------------------------------------------------------
export const INBOX_NOTIFICATIONS: InboxNotification[] = [
  { id: 'in_1', kind: 'win', title: 'Marcus Carter signed — $24,000', body: 'Aiden Rodriguez closed at 11:42 AM. Full pay, USA.', created_at: isoDaysAgo(0), read: false },
  { id: 'in_2', kind: 'risk', title: '107 follow-ups overdue', body: 'Live Pipeline at $9.5K projected cash. 14 are >5 days stale.', created_at: isoDaysAgo(0), read: false },
  { id: 'in_3', kind: 'alert', title: 'Payment failed — Olivia Hayes', body: 'Stripe charge declined. Installment 3 of 5. Retry in 24h.', created_at: isoDaysAgo(1), read: false },
  { id: 'in_4', kind: 'risk', title: 'Sebastian close rate dropped to 22.3%', body: 'Down 3.1pts from prior 14d. Yellow signal on KPI panel.', created_at: isoDaysAgo(1), read: true },
  { id: 'in_5', kind: 'system', title: 'Meta sync complete · 14 new leads', body: 'YT Brand · Retargeting · Broad campaigns reconciled.', created_at: isoDaysAgo(1), read: true },
  { id: 'in_6', kind: 'alert', title: 'Aiden missed daily dial target', body: '38 dials vs 70 target. 0 conversations after 2 PM.', created_at: isoDaysAgo(2), read: true },
  { id: 'in_7', kind: 'win', title: 'James Whitford booked 7 calls in a day', body: 'Personal record. 11.4% booking rate on the day.', created_at: isoDaysAgo(3), read: true },
]

// ---------------------------------------------------------------------------
// Derived metric helpers — pure functions over the seeded data.
// When integrations land, swap each helper for the equivalent Supabase RPC
// or SQL query with the same return shape.
// ---------------------------------------------------------------------------
export type DateRange = { from: Date; to: Date }

export function getOverviewMetrics() {
  const wonLeads = LEADS.filter((l) => l.outcome === 'won')
  const contract_value = wonLeads.reduce((s, l) => s + (l.contract_value ?? 0), 0)
  const cash_collected = wonLeads.reduce((s, l) => s + (l.cash_collected ?? 0), 0)
  const cash_received = PAYMENTS.reduce((s, p) => s + p.amount, 0)
  const ad_spend = AD_SPEND.reduce((s, d) => s + d.spend, 0)
  const profit = cash_received - ad_spend
  const pipelineLeads = LEADS.filter((l) =>
    ['contacted', 'qualified', 'booked', 'showed', 'pitched'].includes(l.status),
  )
  const active = pipelineLeads.length
  const overdue = pipelineLeads.filter((l) => l.is_overdue).length
  const pipelineProjection = Math.round(active * 92) // historical 0.8% recovery × avg cash
  const avgWhenWon = wonLeads.length
    ? Math.round(cash_collected / wonLeads.length)
    : 0
  return {
    contract_value,
    cash_collected,
    cash_received,
    profit,
    ad_spend,
    pipeline: {
      active,
      overdue,
      avgWhenWon,
      projected_cash: pipelineProjection,
    },
    wins: wonLeads.length,
  }
}

export function getCloserStats() {
  return CLOSERS.map((c) => {
    const calls = LEADS.filter((l) => l.closer_id === c.id && l.pitched_at)
    const won = calls.filter((l) => l.outcome === 'won')
    const lost = calls.filter((l) => l.outcome === 'lost')
    const noShows = LEADS.filter((l) => l.closer_id === c.id && l.outcome === 'no_show')
    const followUps = LEADS.filter(
      (l) => l.closer_id === c.id && ['booked', 'showed'].includes(l.status),
    )
    const cash = won.reduce((s, l) => s + (l.cash_collected ?? 0), 0)
    const contract = won.reduce((s, l) => s + (l.contract_value ?? 0), 0)
    const closeRate = calls.length ? won.length / calls.length : 0
    const aov = won.length ? cash / won.length : 0
    return {
      ...c,
      pitched: calls.length,
      won: won.length,
      lost: lost.length,
      no_shows: noShows.length,
      follow_ups: followUps.length,
      close_rate: closeRate,
      cash_collected: cash,
      contract_value: contract,
      cash_aov: aov,
    }
  }).sort((a, b) => b.cash_collected - a.cash_collected)
}

export function getSetterStats() {
  return SETTERS.map((s) => {
    const dials = DIALS.filter((d) => d.setter_id === s.id)
    const booked = LEADS.filter(
      (l) => l.setter_id === s.id && l.booked_at !== null,
    )
    const showed = booked.filter((l) => l.showed_at !== null)
    const talkSeconds = dials.reduce((sum, d) => sum + d.talk_time_seconds, 0)
    const liveConvos = dials.filter((d) => d.outcome === 'live' || d.outcome === 'booked').length
    const ttl_dials = dials.length
    return {
      ...s,
      dials: ttl_dials,
      conversations: liveConvos,
      bookings: booked.length,
      showed: showed.length,
      talk_minutes: Math.round(talkSeconds / 60),
      booking_rate: ttl_dials ? booked.length / ttl_dials : 0,
      show_rate: booked.length ? showed.length / booked.length : 0,
      avg_speed_to_lead_minutes: range(3, 42),
    }
  }).sort((a, b) => b.bookings - a.bookings)
}

export function getMarketingMetrics() {
  const totalSpend = AD_SPEND.reduce((s, d) => s + d.spend, 0)
  const wonLeads = LEADS.filter((l) => l.outcome === 'won')
  const totalCash = wonLeads.reduce((s, l) => s + (l.cash_collected ?? 0), 0)
  const totalContract = wonLeads.reduce((s, l) => s + (l.contract_value ?? 0), 0)
  const leads = AD_SPEND.reduce((s, d) => s + d.leads_generated, 0)
  const showed = LEADS.filter((l) => l.showed_at !== null).length
  const calls = LEADS.filter((l) => l.booked_at !== null).length
  return {
    spend: totalSpend,
    leads,
    calls,
    showed,
    cash_roas: totalSpend ? totalCash / totalSpend : 0,
    revenue_roas: totalSpend ? totalContract / totalSpend : 0,
    cost_per_lead: leads ? totalSpend / leads : 0,
    cost_per_call: calls ? totalSpend / calls : 0,
    cost_per_show: showed ? totalSpend / showed : 0,
    cost_per_acquisition: wonLeads.length ? totalSpend / wonLeads.length : 0,
  }
}

export function getPairingMatrix(minSamples = 3) {
  const cells: { setter: Setter; closer: Closer; cash: number; deals: number }[] = []
  for (const setter of SETTERS) {
    for (const closer of CLOSERS) {
      const leads = LEADS.filter(
        (l) => l.setter_id === setter.id && l.closer_id === closer.id && l.outcome === 'won',
      )
      if (leads.length >= minSamples) {
        cells.push({
          setter,
          closer,
          cash: leads.reduce((s, l) => s + (l.cash_collected ?? 0), 0),
          deals: leads.length,
        })
      }
    }
  }
  return cells
}

// ---------------------------------------------------------------------------
// Convenience lookups
// ---------------------------------------------------------------------------
export function setterById(id: string | null | undefined): Setter | null {
  if (!id) return null
  return SETTERS.find((s) => s.id === id) ?? null
}
export function closerById(id: string | null | undefined): Closer | null {
  if (!id) return null
  return CLOSERS.find((c) => c.id === id) ?? null
}
export function leadById(id: string): Lead | null {
  return LEADS.find((l) => l.id === id) ?? null
}
