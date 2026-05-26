import 'server-only'

import type { Window } from './sales-dashboard-shared'
import { WINDOW_DAYS } from './sales-dashboard-shared'

// Revenue page mock data.
//
// The atomic unit is a TRANSACTION (each individual payment that lands —
// payment plans pay over time so a single deal can produce many).
// Each transaction belongs to a DEAL, which carries the contract-level
// info: lead name, offer type, total contract value, closer/CSM, source.
//
// Two distinct revenue concepts surface on the page:
//   - NEW CASH = sum of transactions that landed in the period
//                (installments and one-time pay-in-fulls both count
//                 because both put money in the bank).
//   - FUTURE   = total contract value of deals CLOSED in the period.
//                Counted once at full contract value, NOT per-
//                installment. This is the sales-performance number
//                ("how much did we sell this month") and resets when
//                a new period begins.
// A single deal can appear in both — that's intentional, not double-
// counting. Future means "we sold this much"; New Cash means "this is
// what actually arrived."
//
// Backend revenue (renewals / upsells / mastermind tickets) lives in
// the SAME deal flow with the CSM listed in the closer slot and the
// offer type set to the appropriate backend product. No separate
// "Backend" entity — the page treats them uniformly.

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
// Canonical offer catalog. Real catalog will live in a Supabase table;
// here we pin three so transactions/deals can reference real product
// shapes (price, default cash-up-front %, deal type).
// ---------------------------------------------------------------------------

export type OfferType = 'core' | 'mastermind' | 'agency-svc' | 'renewal' | 'upsell'

export const OFFERS: Record<OfferType, { label: string; price: number; defaultUpfrontPct: number }> = {
  'core': { label: 'Core coaching program', price: 7_000, defaultUpfrontPct: 0.6 },
  'mastermind': { label: 'Quarterly mastermind', price: 6_000, defaultUpfrontPct: 1.0 },
  'agency-svc': { label: 'Done-for-you agency service', price: 14_500, defaultUpfrontPct: 0.5 },
  'renewal': { label: 'Renewal', price: 7_000, defaultUpfrontPct: 1.0 },
  'upsell': { label: 'Upsell / cross-sell', price: 2_500, defaultUpfrontPct: 1.0 },
}

const SOURCE_OPTIONS = ['Meta Ads', 'YouTube', 'Referrals', 'Instagram', 'LinkedIn', 'Direct'] as const
const CLOSER_OPTIONS = ['Scott', 'Lou', 'Nico'] as const
const CSM_OPTIONS = ['Ella', 'Riya', 'Tomás'] as const

// ---------------------------------------------------------------------------
// Lead-name pool — surfaced in transaction + deal tables. Mocked.
// ---------------------------------------------------------------------------

const LEAD_NAMES = [
  'Alex Carter', 'Bianca Rossi', 'Carlos Mendes', 'Dana Patel', 'Ethan Wright',
  'Fatima Ahmed', 'Grace O’Donnell', 'Hassan Yilmaz', 'Imani Brooks', 'Jorge Salinas',
  'Kaori Yamada', 'Liam Donovan', 'Maya Singh', 'Nikolai Petrov', 'Olivia Reyes',
  'Priya Iyer', 'Quentin Beaumont', 'Rachel Cohen', 'Samir Khan', 'Theresa Nguyen',
  'Uma Tashiro', 'Victor Almeida', 'Wendy Park', 'Xavier Holm', 'Yara Idris',
  'Zhao Tian', 'Adrian Quintero', 'Beatrice Fagan', 'Cyrus Mehta', 'Dimitri Volkov',
  'Eshe Mwangi', 'Felicity Hayes', 'Gunnar Bergstrom', 'Hugo Kessler', 'Inara Ali',
  'Julian Park', 'Kira Lindstrom', 'Lars Eriksson', 'Marisol Vega', 'Nadia Farouk',
]

// ---------------------------------------------------------------------------
// Type shapes
// ---------------------------------------------------------------------------

export type Deal = {
  id: string
  leadName: string
  offerType: OfferType
  contractAmount: number    // full sticker price (might equal price or be discounted)
  closer: string            // closer OR CSM (backend deals list CSM here)
  isBackend: boolean        // true when the "closer" is actually a CSM-driven renewal/upsell
  source: string
  dateClosed: string        // ISO date
}

export type Transaction = {
  id: string
  dealId: string
  leadName: string
  offerType: OfferType
  amount: number            // payment amount that landed (one installment or full pay-in-full)
  isInstallment: boolean    // false = single pay-in-full payment
  dateLanded: string        // ISO date
  source: string
  closer: string            // closer OR CSM (for backend deals this is the CSM)
  isBackend: boolean        // true → "closer" is actually a CSM-driven backend deal
}

export type Refund = {
  id: string
  leadName: string
  amount: number            // positive number (UI handles the sign)
  reason: string
  closer: string            // closer who originally closed the deal
  csm: string               // CSM assigned to the client when the refund landed
  dateRefunded: string
}

export type ExpenseCategory = 'labor' | 'marketing' | 'overhead' | 'coaching' | 'software'

export type Expense = {
  id: string
  vendor: string
  amount: number
  category: ExpenseCategory
  dateLogged: string
  note?: string
}

// ---------------------------------------------------------------------------
// Date helpers — mocks anchor "now" at day 18 of a 31-day month so
// Pulse / Trajectory math stays consistent across the dashboard.
// ---------------------------------------------------------------------------

const TODAY_DAY_OF_MONTH = 18
const DAYS_IN_MONTH = 31

function isoOnDay(dayOfMonth: number): string {
  // Synthesize an ISO date string in 2026-05 keyed to dayOfMonth so the
  // mock looks like real records. Time set to 12:00Z so ordering by
  // string sort is stable.
  const d = Math.max(1, Math.min(DAYS_IN_MONTH, Math.round(dayOfMonth)))
  return `2026-05-${String(d).padStart(2, '0')}T12:00:00Z`
}

// Spread N items across the visible period for this window. For 30d
// they fill days 1..18. For 7d they fill the trailing 7 days that end
// today. For 1d they all land on day 18.
function spreadDays(count: number, window: Window): number[] {
  if (count === 0) return []
  const out: number[] = []
  if (window === '1d') {
    for (let i = 0; i < count; i++) out.push(TODAY_DAY_OF_MONTH)
    return out
  }
  const windowSize = WINDOW_DAYS[window] // 7 or 30
  const startDay = Math.max(1, TODAY_DAY_OF_MONTH - windowSize + 1)
  const endDay = TODAY_DAY_OF_MONTH
  const span = endDay - startDay
  for (let i = 0; i < count; i++) {
    const fraction = count === 1 ? 0.5 : i / (count - 1)
    const day = startDay + Math.round(fraction * span)
    out.push(day)
  }
  return out
}

// ---------------------------------------------------------------------------
// Mock generators
// ---------------------------------------------------------------------------

// Tune mock volume per window. These numbers feel right for the
// business shape Drake described (high-ticket coaching, ~$300k/mo cash
// inflow, 30-50 deals closed per month).
const VOLUME: Record<Window, { transactions: number; deals: number; refunds: number; expenses: number }> = {
  '1d': { transactions: 4, deals: 2, refunds: 0, expenses: 6 },
  '7d': { transactions: 22, deals: 10, refunds: 1, expenses: 24 },
  '30d': { transactions: 84, deals: 38, refunds: 3, expenses: 78 },
}

function pickOffer(seed: string): OfferType {
  const r = rand(seed)
  // Weighted: core dominates, mastermind/agency mid, backend smaller
  if (r < 0.55) return 'core'
  if (r < 0.72) return 'mastermind'
  if (r < 0.82) return 'agency-svc'
  if (r < 0.92) return 'upsell'
  return 'renewal'
}

function pickFromList<T>(seed: string, list: readonly T[]): T {
  return list[Math.floor(rand(seed) * list.length)]
}

export function getDeals(window: Window): Deal[] {
  const count = VOLUME[window].deals
  const days = spreadDays(count, window)
  const deals: Deal[] = []
  for (let i = 0; i < count; i++) {
    const offerType = pickOffer(`deal:${window}:${i}:offer`)
    const offer = OFFERS[offerType]
    // Slight contract-amount variance so not every deal is sticker price
    // (some closers run discount holds, some upsell).
    const variance = 0.85 + rand(`deal:${window}:${i}:var`) * 0.3
    const contractAmount = Math.round(offer.price * variance)
    const isBackend = offerType === 'renewal' || offerType === 'upsell'
    const closer = isBackend
      ? pickFromList(`deal:${window}:${i}:csm`, CSM_OPTIONS)
      : pickFromList(`deal:${window}:${i}:closer`, CLOSER_OPTIONS)
    deals.push({
      id: `deal-${window}-${i}`,
      leadName: LEAD_NAMES[i % LEAD_NAMES.length],
      offerType,
      contractAmount,
      closer,
      isBackend,
      source: pickFromList(`deal:${window}:${i}:source`, SOURCE_OPTIONS),
      dateClosed: isoOnDay(days[i]),
    })
  }
  return deals
}

export function getTransactions(window: Window): Transaction[] {
  // Transactions are "payments that landed in the period." Some are
  // pay-in-full (= one transaction per deal), some are installments
  // (= multiple transactions per deal spread across periods). The
  // simplest realistic mock: generate transactions from the deals
  // closed this period AND from earlier-closed payment-plan deals
  // whose installment landed in this period.
  const count = VOLUME[window].transactions
  const days = spreadDays(count, window)
  const transactions: Transaction[] = []
  for (let i = 0; i < count; i++) {
    const offerType = pickOffer(`txn:${window}:${i}:offer`)
    const offer = OFFERS[offerType]
    const isInstallment = rand(`txn:${window}:${i}:install`) < 0.55 && offerType !== 'mastermind' && offerType !== 'upsell'
    const amount = isInstallment
      ? Math.round((offer.price / 3) * (0.95 + rand(`txn:${window}:${i}:amt`) * 0.1))
      : Math.round(offer.price * (0.95 + rand(`txn:${window}:${i}:amt`) * 0.1))
    const isBackend = offerType === 'renewal' || offerType === 'upsell'
    const closer = isBackend
      ? pickFromList(`txn:${window}:${i}:csm`, CSM_OPTIONS)
      : pickFromList(`txn:${window}:${i}:closer`, CLOSER_OPTIONS)
    transactions.push({
      id: `txn-${window}-${i}`,
      dealId: `deal-${window}-${i % VOLUME[window].deals}`,
      leadName: LEAD_NAMES[(i * 7) % LEAD_NAMES.length],
      offerType,
      amount,
      isInstallment,
      dateLanded: isoOnDay(days[i]),
      source: pickFromList(`txn:${window}:${i}:source`, SOURCE_OPTIONS),
      closer,
      isBackend,
    })
  }
  return transactions.sort((a, b) => b.dateLanded.localeCompare(a.dateLanded))
}

const REFUND_REASONS = [
  'Buyer’s remorse — first-week',
  'Couldn’t commit to the schedule',
  'Misaligned expectations',
  'Health emergency',
  'Lost their job',
  'Disputed via card issuer',
]

export function getRefunds(window: Window): Refund[] {
  const count = VOLUME[window].refunds
  const days = spreadDays(count, window)
  const refunds: Refund[] = []
  for (let i = 0; i < count; i++) {
    const offerType = pickOffer(`refund:${window}:${i}:offer`)
    refunds.push({
      id: `refund-${window}-${i}`,
      leadName: LEAD_NAMES[(i * 11) % LEAD_NAMES.length],
      amount: Math.round(OFFERS[offerType].price * (0.4 + rand(`refund:${window}:${i}:amt`) * 0.6)),
      reason: REFUND_REASONS[Math.floor(rand(`refund:${window}:${i}:reason`) * REFUND_REASONS.length)],
      closer: pickFromList(`refund:${window}:${i}:closer`, CLOSER_OPTIONS),
      csm: pickFromList(`refund:${window}:${i}:csm`, CSM_OPTIONS),
      dateRefunded: isoOnDay(days[i]),
    })
  }
  return refunds.sort((a, b) => b.dateRefunded.localeCompare(a.dateRefunded))
}

const EXPENSE_VENDORS: Array<{ vendor: string; category: ExpenseCategory; baseline: number; notePattern?: string }> = [
  { vendor: 'Meta Ads (account 1)', category: 'marketing', baseline: 2_400 },
  { vendor: 'Meta Ads (account 2)', category: 'marketing', baseline: 1_600 },
  { vendor: 'YouTube post-production', category: 'marketing', baseline: 480 },
  { vendor: 'Closer commission · Scott', category: 'labor', baseline: 2_200 },
  { vendor: 'Closer commission · Lou', category: 'labor', baseline: 1_900 },
  { vendor: 'Closer commission · Nico', category: 'labor', baseline: 2_400 },
  { vendor: 'Setter payouts', category: 'labor', baseline: 1_300 },
  { vendor: 'CSM team salaries', category: 'labor', baseline: 1_100 },
  { vendor: 'Vercel', category: 'software', baseline: 95 },
  { vendor: 'Supabase', category: 'software', baseline: 120 },
  { vendor: 'Linear', category: 'software', baseline: 44 },
  { vendor: 'Anthropic API', category: 'software', baseline: 260 },
  { vendor: 'Stripe fees', category: 'overhead', baseline: 380 },
  { vendor: 'Legal retainer', category: 'overhead', baseline: 600 },
  { vendor: 'Office + utilities', category: 'overhead', baseline: 240 },
  { vendor: 'Founder coach', category: 'coaching', baseline: 800 },
  { vendor: 'Sales mastermind dues', category: 'coaching', baseline: 500 },
]

export function getExpenses(window: Window): Expense[] {
  const count = VOLUME[window].expenses
  const days = spreadDays(count, window)
  const expenses: Expense[] = []
  for (let i = 0; i < count; i++) {
    const entry = EXPENSE_VENDORS[i % EXPENSE_VENDORS.length]
    const jitter = 0.8 + rand(`expense:${window}:${i}:amt`) * 0.4
    expenses.push({
      id: `expense-${window}-${i}`,
      vendor: entry.vendor,
      amount: Math.round(entry.baseline * jitter),
      category: entry.category,
      dateLogged: isoOnDay(days[i]),
    })
  }
  return expenses.sort((a, b) => b.dateLogged.localeCompare(a.dateLogged))
}

// ---------------------------------------------------------------------------
// Period summary — drives the five Revenue tiles on the main page.
// ---------------------------------------------------------------------------

export type RevenueSummary = {
  newCash: number
  future: number
  refunds: number          // positive number; UI adds the minus
  expenses: number         // positive number; UI adds the minus
  profit: number           // newCash - refunds - expenses
  // Deltas vs prior comparable period (mocked).
  newCashDelta: number     // signed pct
  profitDelta: number
}

export function getRevenueSummary(window: Window): RevenueSummary {
  const txns = getTransactions(window)
  const deals = getDeals(window)
  const refunds = getRefunds(window)
  const expenses = getExpenses(window)
  const newCash = txns.reduce((s, t) => s + t.amount, 0)
  const future = deals.reduce((s, d) => s + d.contractAmount, 0)
  const refundTotal = refunds.reduce((s, r) => s + r.amount, 0)
  const expenseTotal = expenses.reduce((s, e) => s + e.amount, 0)
  const profit = newCash - refundTotal - expenseTotal
  // Mock deltas — anchored by window so reloads are stable.
  const newCashDelta = (rand(`rev:${window}:cash-delta`) - 0.5) * 0.4
  const profitDelta = (rand(`rev:${window}:profit-delta`) - 0.5) * 0.5
  return {
    newCash,
    future,
    refunds: refundTotal,
    expenses: expenseTotal,
    profit,
    newCashDelta,
    profitDelta,
  }
}

// ---------------------------------------------------------------------------
// MTD daily series — used by the projection chart on Revenue to show
// actual cash collected per day so far this month. Capped at today's
// day-of-month; future days remain null in the consumer.
// ---------------------------------------------------------------------------

export type DailyCashPoint = { day: number; actual: number }

export function getMtdDailyCash(): { dayOfMonth: number; daysInMonth: number; points: DailyCashPoint[] } {
  const points: DailyCashPoint[] = []
  // Daily mean ~$17k with light noise so a real-feeling shape emerges.
  const dailyMean = 17_200
  for (let day = 1; day <= TODAY_DAY_OF_MONTH; day++) {
    const wobble = 0.55 + rand(`mtd:day:${day}`) * 0.95
    points.push({ day, actual: Math.round(dailyMean * wobble) })
  }
  return { dayOfMonth: TODAY_DAY_OF_MONTH, daysInMonth: DAYS_IN_MONTH, points }
}
