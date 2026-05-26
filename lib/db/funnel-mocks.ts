import 'server-only'

import type { Window } from './sales-dashboard-shared'
import { WINDOW_DAYS } from './sales-dashboard-shared'

// Funnel page mock data.
//
// Seven stages, left to right, with a coherent conversion cascade so
// the bottleneck flag has real signal. Stage aggregates AND per-entity
// records (each ad / each landing page / each form) live here; trend
// series are 14-point daily values keyed to the stage / entity so the
// sparkline texture stays stable across reloads.

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
// Stage identity
// ---------------------------------------------------------------------------

export type StageId =
  | 'ads'
  | 'landing-pages'
  | 'submits'
  | 'appointment-setting'
  | 'showed'
  | 'closed'
  | 'cash'

export type Stage = {
  id: StageId
  label: string         // short label rendered in the strip cell
  longLabel: string     // human title on the stage detail page
  headlineLabel: string // metric name shown under the stage value
}

// Three stages on the strip — Ads → LP → Appointment Setting.
// The LP detail page hosts the visit / VSL / Typeform / Calendly
// metrics. The Appt Setting detail page hosts first-message-response,
// speed-to-lead, and the closer-triage + setter-triage parallel
// cards. Showed / Closed / Cash come back once those data sources
// are confirmed.
export const STAGES: Stage[] = [
  { id: 'ads', label: 'Ads', longLabel: 'Ads.', headlineLabel: 'Impressions' },
  { id: 'landing-pages', label: 'LP', longLabel: 'Landing page.', headlineLabel: 'LP visits' },
  { id: 'appointment-setting', label: 'Appt set', longLabel: 'Appointment setting.', headlineLabel: 'Triage calls' },
]

// ---------------------------------------------------------------------------
// Conversion cascade — produces stage headline values that match real-
// world ratios. Anchored to ~120K daily impressions; ratios are tuned
// so the bottleneck (Showed→Closed at ~30%) reads as the leak when
// the auto-flag runs.
// ---------------------------------------------------------------------------

const DAILY_IMPRESSIONS_BASELINE = 120_000

// Stage ratios applied to the prior stage's headline. Only the
// ads→LP and LP→submits hops apply to the currently-rendered strip;
// downstream entries are retained as references for the cascade
// helpers used by stage-detail pages that still mock their numbers.
const RATIOS: { from: StageId; to: StageId; rate: number }[] = [
  { from: 'ads', to: 'landing-pages', rate: 0.064 },              // 6.4% impression → LP visit (mock; ads is fake)
  { from: 'landing-pages', to: 'submits', rate: 0.048 },          // 4.8% LP → submit (only used if both stages unwired)
  { from: 'submits', to: 'appointment-setting', rate: 0.34 },
  { from: 'appointment-setting', to: 'showed', rate: 0.604 },
  { from: 'showed', to: 'closed', rate: 0.299 },
  { from: 'closed', to: 'cash', rate: 4_371 },
]

export type StageOverrides = Partial<Record<StageId, number>>

export function getStageHeadlines(
  window: Window,
  // Per-stage overrides for stages we've wired against live data. For
  // each stage: if an override is provided, use it; otherwise compute
  // from the previous stage's value × the mock conversion ratio. This
  // means stages between two wired stages still cascade through mock
  // ratios — only fully-wired stages reflect reality. Downstream
  // conversion %s between two wired stages WILL be a real rate.
  overrides: StageOverrides = {},
): Record<StageId, number> {
  const impressionsAnchor = overrides.ads ?? DAILY_IMPRESSIONS_BASELINE * WINDOW_DAYS[window]
  const headlines: Partial<Record<StageId, number>> = { ads: impressionsAnchor }
  let prev: number = impressionsAnchor
  for (const r of RATIOS) {
    const override = overrides[r.to]
    if (typeof override === 'number') {
      headlines[r.to] = Math.round(override)
      prev = override
    } else {
      const jitter = 0.92 + (hashId(`${window}:${r.from}->${r.to}`) % 100) / 600 // 0.92..1.08
      prev = prev * r.rate * jitter
      headlines[r.to] = Math.round(prev)
    }
  }
  return headlines as Record<StageId, number>
}

export type Conversion = {
  fromStage: StageId
  toStage: StageId
  rate: number          // 0..1 for ratios; for cash it's $/deal
  isMonetary: boolean
}

export function getConversions(headlines: Record<StageId, number>): Conversion[] {
  return RATIOS.map((r) => ({
    fromStage: r.from,
    toStage: r.to,
    rate: r.to === 'cash'
      ? (headlines.closed > 0 ? headlines.cash / headlines.closed : 0)
      : (headlines[r.from] > 0 ? headlines[r.to] / headlines[r.from] : 0),
    isMonetary: r.to === 'cash',
  }))
}

// Pick the bottleneck — smallest rate among non-monetary conversions,
// skipping any hop that touches a mocked stage so fake numbers can't
// trigger a misleading flag. With ads mocked at ~840K and LP real at
// a few hundred, ads→LP would otherwise dominate as "the worst" — but
// the leak there is the data source, not the funnel.
export function getBottleneck(
  conversions: Conversion[],
  mockedStages: StageId[] = [],
): StageId | null {
  const mocked = new Set(mockedStages)
  let worst = -1
  let worstRate = Infinity
  for (let i = 0; i < conversions.length; i++) {
    const c = conversions[i]
    if (c.isMonetary) continue
    if (mocked.has(c.fromStage) || mocked.has(c.toStage)) continue
    if (c.rate < worstRate) {
      worstRate = c.rate
      worst = i
    }
  }
  return worst >= 0 ? conversions[worst].toStage : null
}

// ---------------------------------------------------------------------------
// Trend series — 14 daily points per stage, shape tied to stage so the
// sparkline reads as real texture, not noise.
// ---------------------------------------------------------------------------

const SPARK_POINTS = 14

function sparkSeries(seed: string, dailyMean: number): number[] {
  const series: number[] = []
  const trendBias = (rand(`${seed}:trend`) - 0.5) * 0.4
  for (let i = 0; i < SPARK_POINTS; i++) {
    const t = i / (SPARK_POINTS - 1)
    const trend = 1 + trendBias * (t - 0.5)
    const wobble = 0.78 + rand(`${seed}:p${i}`) * 0.44
    series.push(Math.max(0, dailyMean * trend * wobble))
  }
  return series
}

export function getStageTrend(stageId: StageId, window: Window): number[] {
  const headlines = getStageHeadlines(window)
  const dailyMean = headlines[stageId] / Math.max(1, WINDOW_DAYS[window])
  return sparkSeries(`stage:${stageId}:${window}`, dailyMean)
}

// ---------------------------------------------------------------------------
// Per-stage AGGREGATE metric blocks. Each metric has a label, value,
// format, and (where the leak might live) a recent delta + trend.
// ---------------------------------------------------------------------------

export type MetricFormatExt = 'usd' | 'usd_precise' | 'integer' | 'decimal' | 'percent_0_100' | 'duration_seconds' | 'count'

export type AggMetric = {
  id: string
  label: string
  value: number | null
  format: MetricFormatExt
  delta?: number          // signed pct vs prior period
  note?: string
}

function scaleByWindow(base: number, window: Window): number {
  return base * WINDOW_DAYS[window]
}

function deltaFor(seed: string): number {
  // signed -30%..+30%
  return (rand(seed) - 0.5) * 0.6
}

// --- ADS aggregate ----------------------------------------------------

export function getAdsAggregate(window: Window): AggMetric[] {
  const h = getStageHeadlines(window)
  const adspend = Math.round(scaleByWindow(11_500, window))
  const linkClicks = Math.round(h.ads * 0.018)
  const cpm = (adspend / h.ads) * 1000
  const cpcPerUnique = adspend / Math.max(1, linkClicks)
  const ctr = (linkClicks / h.ads) * 100
  const frequency = 2.4 + rand(`ads:freq:${window}`) * 0.8
  const cashCollected = h.cash
  const roas = adspend > 0 ? cashCollected / adspend : 0
  return [
    { id: 'adspend', label: 'Total adspend', value: adspend, format: 'usd', delta: deltaFor(`ads:adspend:${window}`) },
    { id: 'roas', label: 'ROAS (cash / spend)', value: roas, format: 'decimal', delta: deltaFor(`ads:roas:${window}`), note: 'Cash collected ÷ adspend' },
    { id: 'impressions', label: 'Total impressions', value: h.ads, format: 'integer', delta: deltaFor(`ads:imp:${window}`) },
    { id: 'unique-clicks', label: 'Unique link clicks', value: linkClicks, format: 'integer', delta: deltaFor(`ads:clicks:${window}`) },
    { id: 'frequency', label: 'Frequency', value: frequency, format: 'decimal', delta: deltaFor(`ads:freq-delta:${window}`) },
    { id: 'ctr', label: 'Click-through rate', value: ctr, format: 'percent_0_100', delta: deltaFor(`ads:ctr:${window}`) },
    { id: 'cpi', label: 'Cost per 1000 impressions', value: cpm, format: 'usd_precise' },
    { id: 'cpc-unique', label: 'Cost per unique click', value: cpcPerUnique, format: 'usd', delta: deltaFor(`ads:cpc:${window}`) },
  ]
}

// --- LANDING PAGES aggregate -----------------------------------------

export function getLpAggregate(window: Window): AggMetric[] {
  const h = getStageHeadlines(window)
  const avgTime = 48 + Math.round(rand(`lp:time:${window}`) * 30)
  const vslEng = 0.42 + rand(`lp:vsl-eng:${window}`) * 0.18
  const vslDur = 110 + Math.round(rand(`lp:vsl-dur:${window}`) * 60)
  const lpConv = h.submits / Math.max(1, h['landing-pages']) * 100
  const linkClicks = Math.round(h.ads * 0.018)
  const linkToMql = linkClicks > 0 ? (h.submits / linkClicks) * 100 : 0
  return [
    { id: 'visits', label: 'Landing page visits', value: h['landing-pages'], format: 'integer', delta: deltaFor(`lp:visits:${window}`) },
    { id: 'avg-time', label: 'Average time on LP', value: avgTime, format: 'duration_seconds', delta: deltaFor(`lp:time-delta:${window}`) },
    { id: 'vsl-eng', label: 'VSL engagement rate', value: vslEng * 100, format: 'percent_0_100', delta: deltaFor(`lp:vsl-eng-delta:${window}`) },
    { id: 'vsl-dur', label: 'VSL avg view duration', value: vslDur, format: 'duration_seconds', delta: deltaFor(`lp:vsl-dur-delta:${window}`) },
    { id: 'lp-conv', label: 'LP conversion rate', value: lpConv, format: 'percent_0_100', delta: deltaFor(`lp:conv:${window}`) },
    { id: 'click-mql', label: 'Link-click to MQL', value: linkToMql, format: 'percent_0_100', delta: deltaFor(`lp:click-mql:${window}`) },
  ]
}

// --- SUBMITS aggregate ------------------------------------------------

export function getSubmitsAggregate(window: Window): AggMetric[] {
  const h = getStageHeadlines(window)
  const adspend = Math.round(scaleByWindow(11_500, window))
  const submits = h.submits
  const qualified = Math.round(submits * 0.62)
  const nonQualified = submits - qualified
  const tfEngagement = 0.71 + rand(`subs:eng:${window}`) * 0.16
  const tfCompletion = 0.58 + rand(`subs:comp:${window}`) * 0.18
  const cpl = adspend > 0 && submits > 0 ? adspend / submits : 0
  const cpMql = adspend > 0 && qualified > 0 ? adspend / qualified : 0
  const typTime = 22 + Math.round(rand(`subs:typtime:${window}`) * 22)
  const typVslEng = 0.48 + rand(`subs:typvsl-eng:${window}`) * 0.18
  const typVslDur = 80 + Math.round(rand(`subs:typvsl-dur:${window}`) * 40)
  return [
    { id: 'submits', label: 'Typeform submits ("Leads")', value: submits, format: 'integer', delta: deltaFor(`subs:submits:${window}`) },
    { id: 'tf-eng', label: 'Typeform engagement', value: tfEngagement * 100, format: 'percent_0_100', delta: deltaFor(`subs:tf-eng:${window}`) },
    { id: 'tf-comp', label: 'Typeform completion rate', value: tfCompletion * 100, format: 'percent_0_100', delta: deltaFor(`subs:tf-comp:${window}`) },
    { id: 'qualified', label: 'Qualified opt-ins', value: qualified, format: 'integer', delta: deltaFor(`subs:qual:${window}`) },
    { id: 'non-qualified', label: 'Non-qualified opt-ins', value: nonQualified, format: 'integer', delta: deltaFor(`subs:nonqual:${window}`) },
    { id: 'cpl', label: 'Cost per opt-in (CPL)', value: cpl, format: 'usd', delta: deltaFor(`subs:cpl:${window}`) },
    { id: 'cp-mql', label: 'Cost per MQL', value: cpMql, format: 'usd', delta: deltaFor(`subs:cp-mql:${window}`) },
    { id: 'typ-time', label: 'Avg time on TYP', value: typTime, format: 'duration_seconds' },
    { id: 'typ-vsl-eng', label: 'TYP engagement rate', value: typVslEng * 100, format: 'percent_0_100' },
    { id: 'typ-vsl-dur', label: 'TYP avg view duration', value: typVslDur, format: 'duration_seconds' },
  ]
}

// --- APPOINTMENT SETTING aggregate -----------------------------------

export function getApptSettingAggregate(window: Window): {
  topLevel: AggMetric[]
  closerGroup: { label: string; total: AggMetric; rows: AggMetric[] }
  setterGroup: { label: string; total: AggMetric; rows: AggMetric[] }
} {
  const h = getStageHeadlines(window)
  const adspend = Math.round(scaleByWindow(11_500, window))
  const submits = h.submits
  const booked = h['appointment-setting']
  const closerTriages = Math.round(submits * 0.62)
  const closerNextDay = Math.round(closerTriages * 0.42)
  const closerTwoDays = Math.round(closerTriages * 0.27)
  const setterTriages = Math.round(submits * 0.38)
  const setterFresh = Math.round(setterTriages * 0.55)
  const setterOld = Math.round(setterTriages * 0.31)
  const setterHandDown = setterTriages - setterFresh - setterOld
  const totalDials = Math.round(scaleByWindow(280, window))
  const firstMsgResponse = 0.34 + rand(`apt:fmr:${window}`) * 0.18
  const triageRate = closerTriages / Math.max(1, submits) * 100
  const convToBook = booked / Math.max(1, closerTriages + setterTriages) * 100
  const dqRate = 0.14 + rand(`apt:dq:${window}`) * 0.08
  const downsellRate = 0.06 + rand(`apt:ds:${window}`) * 0.05
  const handDownRate = 0.08 + rand(`apt:hd:${window}`) * 0.06
  const handOffComp = 0.71 + rand(`apt:ho:${window}`) * 0.16
  const avgTimeCloserDial = 14 + Math.round(rand(`apt:tcd:${window}`) * 12) // minutes
  const avgTimeSetterDial = 9 + Math.round(rand(`apt:tsd:${window}`) * 8)
  const cpTriage = adspend / Math.max(1, closerTriages + setterTriages)
  const cpBooked = adspend / Math.max(1, booked)
  const directBookingPct = 0.42 + rand(`apt:dbp:${window}`) * 0.18
  return {
    topLevel: [
      { id: 'booked', label: 'Booked meetings', value: booked, format: 'integer', delta: deltaFor(`apt:booked:${window}`) },
      { id: 'total-dials', label: 'Total dials', value: totalDials, format: 'integer', delta: deltaFor(`apt:dials:${window}`) },
      { id: 'first-msg', label: 'First-message response rate', value: firstMsgResponse * 100, format: 'percent_0_100', delta: deltaFor(`apt:fmr-delta:${window}`) },
      { id: 'triage-rate', label: 'Triage rate', value: triageRate, format: 'percent_0_100', delta: deltaFor(`apt:tr:${window}`), note: 'Triages ÷ submits' },
      { id: 'conv-book', label: 'Conversation → book', value: convToBook, format: 'percent_0_100', delta: deltaFor(`apt:cb:${window}`) },
      { id: 'dq-rate', label: 'DQ rate', value: dqRate * 100, format: 'percent_0_100', delta: deltaFor(`apt:dq-delta:${window}`) },
      { id: 'downsell', label: 'Downsell rate', value: downsellRate * 100, format: 'percent_0_100' },
      { id: 'hand-down', label: 'Hand-down rate', value: handDownRate * 100, format: 'percent_0_100' },
      { id: 'hand-off-comp', label: 'Hand-off completion', value: handOffComp * 100, format: 'percent_0_100' },
      { id: 'time-closer', label: 'Avg time to closer dial', value: avgTimeCloserDial * 60, format: 'duration_seconds' },
      { id: 'time-setter', label: 'Avg time to setter dial', value: avgTimeSetterDial * 60, format: 'duration_seconds' },
      { id: 'cp-triage', label: 'Cost per triage', value: cpTriage, format: 'usd' },
      { id: 'cp-booked', label: 'Cost per booked meeting', value: cpBooked, format: 'usd', delta: deltaFor(`apt:cpb:${window}`) },
      { id: 'direct-book-meeting', label: 'Direct-book → meeting', value: directBookingPct * 100, format: 'percent_0_100' },
    ],
    closerGroup: {
      label: 'Closer triages',
      total: { id: 'closer-triages', label: 'Total closer triages', value: closerTriages, format: 'integer', delta: deltaFor(`apt:ct:${window}`) },
      rows: [
        { id: 'closer-next-day', label: 'For next-day calls', value: closerNextDay, format: 'integer' },
        { id: 'closer-two-days', label: 'For two-days-out calls', value: closerTwoDays, format: 'integer' },
      ],
    },
    setterGroup: {
      label: 'Setter triages',
      total: { id: 'setter-triages', label: 'Total setter triages', value: setterTriages, format: 'integer', delta: deltaFor(`apt:st:${window}`) },
      rows: [
        { id: 'setter-fresh', label: 'From fresh opt-ins (<3 days)', value: setterFresh, format: 'integer' },
        { id: 'setter-old', label: 'From old opt-ins (>3 days)', value: setterOld, format: 'integer' },
        { id: 'setter-hand-down', label: 'From hand-downs', value: setterHandDown, format: 'integer' },
      ],
    },
  }
}

// --- SHOWED aggregate -------------------------------------------------

export type NoShowRow = {
  id: string
  leadName: string
  reason: string
  closer: string
  date: string
}

const NO_SHOW_REASONS = [
  'Ghosted — no notice',
  'Cancelled day-of',
  'Tech issue / failed to connect',
  'Rescheduled within 24h',
  'Wrong contact info',
]

const SHOWED_LEAD_NAMES = ['Alex Carter', 'Bianca Rossi', 'Carlos Mendes', 'Dana Patel', 'Ethan Wright', 'Fatima Ahmed', 'Grace O’Donnell', 'Liam Donovan']
const CLOSERS = ['Scott', 'Lou', 'Nico']

export function getShowedAggregate(window: Window): {
  metrics: AggMetric[]
  noShows: NoShowRow[]
} {
  const h = getStageHeadlines(window)
  const booked = h['appointment-setting']
  const showed = h.showed
  const noShows = Math.round(booked * 0.18)
  const reschedules = Math.round(booked * 0.12)
  const cancelled = booked - showed - noShows - reschedules
  const showRate = showed / Math.max(1, booked) * 100
  const avgDuration = 38 * 60 + Math.round(rand(`show:dur:${window}`) * 16 * 60)
  const ccmi = Math.round(showed * 0.83)
  const newScheduled = Math.round(booked * 0.78)
  const list: NoShowRow[] = []
  const noShowVolume = Math.min(noShows, 12)
  for (let i = 0; i < noShowVolume; i++) {
    list.push({
      id: `noshow-${window}-${i}`,
      leadName: SHOWED_LEAD_NAMES[(i * 3) % SHOWED_LEAD_NAMES.length],
      reason: NO_SHOW_REASONS[i % NO_SHOW_REASONS.length],
      closer: CLOSERS[i % CLOSERS.length],
      date: `2026-05-${String(15 + (i % 4)).padStart(2, '0')}`,
    })
  }
  return {
    metrics: [
      { id: 'new-scheduled', label: 'New scheduled meetings', value: newScheduled, format: 'integer', delta: deltaFor(`show:newsched:${window}`) },
      { id: 'showed', label: 'Showed meetings', value: showed, format: 'integer', delta: deltaFor(`show:showed:${window}`) },
      { id: 'no-shows', label: 'No-shows / ghosts', value: noShows, format: 'integer', delta: deltaFor(`show:noshows:${window}`) },
      { id: 'reschedules', label: 'Reschedules', value: reschedules, format: 'integer' },
      { id: 'cancelled', label: 'Cancelled meetings', value: Math.max(0, cancelled), format: 'integer' },
      { id: 'show-rate', label: 'Show rate on new calls', value: showRate, format: 'percent_0_100', delta: deltaFor(`show:rate:${window}`) },
      { id: 'avg-duration', label: 'Avg meeting duration', value: avgDuration, format: 'duration_seconds' },
      { id: 'ccmi', label: 'CCMI', value: ccmi, format: 'integer' },
    ],
    noShows: list,
  }
}

// --- CLOSED aggregate -------------------------------------------------

export type ObjectionRow = { id: string; label: string; count: number }

export function getClosedAggregate(window: Window): {
  metrics: AggMetric[]
  objections: ObjectionRow[]
} {
  const h = getStageHeadlines(window)
  const showed = h.showed
  const closed = h.closed
  const closedNew = Math.round(closed * 0.62)
  const closedFollowUp = closed - closedNew
  const closedDirect = Math.round(closed * 0.44)
  const closedSetter = closed - closedDirect
  const oneCallClose = (closedNew / Math.max(1, showed)) * 100
  const overallCloseRate = (closed / Math.max(1, showed)) * 100
  const objShopping = Math.round(showed * 0.11)
  const objThinkFear = Math.round(showed * 0.08)
  const objSpouse = Math.round(showed * 0.06)
  const followUpLooms = Math.round(closedFollowUp * 1.4)
  return {
    metrics: [
      { id: 'closed-total', label: 'Total closed deals', value: closed, format: 'integer', delta: deltaFor(`close:tot:${window}`) },
      { id: 'closed-new', label: 'Closed — new meetings', value: closedNew, format: 'integer', delta: deltaFor(`close:new:${window}`) },
      { id: 'closed-followup', label: 'Closed — follow-up meetings', value: closedFollowUp, format: 'integer' },
      { id: 'closed-direct', label: 'Closed — direct-booking-led', value: closedDirect, format: 'integer' },
      { id: 'closed-setter', label: 'Closed — setter-led', value: closedSetter, format: 'integer' },
      { id: 'one-call-close', label: 'One-call close rate', value: oneCallClose, format: 'percent_0_100', delta: deltaFor(`close:occ:${window}`) },
      { id: 'overall-close', label: 'Overall close rate', value: overallCloseRate, format: 'percent_0_100', delta: deltaFor(`close:occ-overall:${window}`) },
      { id: 'follow-up-looms', label: 'Follow-up Looms sent', value: followUpLooms, format: 'integer' },
    ],
    objections: [
      { id: 'shopping', label: 'Shopping around', count: objShopping },
      { id: 'think-fear', label: 'Think about it / fear', count: objThinkFear },
      { id: 'spouse', label: 'Spouse / partner', count: objSpouse },
    ],
  }
}

// --- CASH aggregate (consumed by the stage strip; the detail page
//     for Cash redirects to Revenue rather than duplicating). --------

export function getCashHeadline(window: Window): {
  totalCash: number
  totalContracted: number
  aov: number
  cashPerBookedMeeting: number
  costPerSale: number
  costPerShowed: number
} {
  const h = getStageHeadlines(window)
  const adspend = Math.round(scaleByWindow(11_500, window))
  return {
    totalCash: h.cash,
    totalContracted: Math.round(h.cash * 1.45),
    aov: 4_371,
    cashPerBookedMeeting: h.cash / Math.max(1, h['appointment-setting']),
    costPerSale: adspend / Math.max(1, h.closed),
    costPerShowed: adspend / Math.max(1, h.showed),
  }
}

// ---------------------------------------------------------------------------
// Per-entity records — each ad / LP / form. Used in the stage detail
// pages' entity tables.
// ---------------------------------------------------------------------------

export type AdRow = {
  id: string
  name: string
  spend: number
  impressions: number
  ctr: number          // 0..100
  cpc: number          // $
  bookings: number
  costPerBooking: number
  status: 'scaling' | 'stable' | 'fatiguing' | 'paused'
  trend: number[]
}

const AD_NAMES = [
  'VSL-A · "Quit the agency hamster wheel"',
  'VSL-B · "From 0 to $8M in 4 years"',
  'Static-1 · Founder pic + headline',
  'UGC-1 · Client testimonial reel',
  'Carousel-2 · 5-step framework',
  'Static-2 · Before/after pricing',
]

const AD_STATUSES: AdRow['status'][] = ['scaling', 'stable', 'fatiguing', 'paused']

export function getAds(window: Window): AdRow[] {
  const headlines = getStageHeadlines(window)
  const totalSpend = scaleByWindow(11_500, window)
  const totalBookings = headlines['appointment-setting']
  return AD_NAMES.map((name, i) => {
    const seed = `ad:${name}:${window}`
    // Weight: first two creatives get the lion's share of spend.
    const weight = i === 0 ? 0.30 : i === 1 ? 0.24 : i === 2 ? 0.15 : i === 3 ? 0.13 : i === 4 ? 0.10 : 0.08
    const spend = Math.round(totalSpend * weight * (0.88 + rand(`${seed}:s`) * 0.24))
    const impressions = Math.round(spend / 11_500 * (DAILY_IMPRESSIONS_BASELINE * WINDOW_DAYS[window]) / WINDOW_DAYS[window] * WINDOW_DAYS[window])
    const ctrPct = 1.2 + rand(`${seed}:ctr`) * 1.6 // 1.2-2.8%
    const clicks = Math.round(impressions * (ctrPct / 100))
    const cpc = clicks > 0 ? spend / clicks : 0
    const bookings = Math.max(1, Math.round(totalBookings * weight * (0.85 + rand(`${seed}:b`) * 0.3)))
    const costPerBooking = bookings > 0 ? spend / bookings : 0
    const status = AD_STATUSES[Math.floor(rand(`${seed}:st`) * AD_STATUSES.length)]
    return {
      id: `ad-${i}`,
      name,
      spend,
      impressions,
      ctr: ctrPct,
      cpc,
      bookings,
      costPerBooking,
      status,
      trend: sparkSeries(`${seed}:trend`, spend / 7),
    }
  }).sort((a, b) => a.costPerBooking - b.costPerBooking)
}

export type LandingPageRow = {
  id: string
  name: string
  url: string
  visits: number
  avgTime: number       // seconds
  vslEng: number        // 0..100
  vslDuration: number   // seconds
  lpConv: number        // 0..100
  trend: number[]
}

const LP_DEFS = [
  { id: 'main-vsl', name: 'Main VSL · /', url: '/' },
  { id: 'youtube-direct', name: 'YouTube direct-book · /direct', url: '/direct' },
  { id: 'event-reg', name: 'In-person event reg · /event', url: '/event' },
]

export function getLandingPages(window: Window): LandingPageRow[] {
  const headlines = getStageHeadlines(window)
  const totalVisits = headlines['landing-pages']
  const totalSubmits = headlines.submits
  return LP_DEFS.map((def, i) => {
    const seed = `lp:${def.id}:${window}`
    const weight = i === 0 ? 0.62 : i === 1 ? 0.24 : 0.14
    const visits = Math.round(totalVisits * weight * (0.92 + rand(`${seed}:v`) * 0.16))
    const lpConv = 3 + rand(`${seed}:c`) * 6 // 3-9%
    const submits = Math.round(totalSubmits * weight * (0.88 + rand(`${seed}:s`) * 0.24))
    const conv = submits / Math.max(1, visits) * 100
    return {
      id: def.id,
      name: def.name,
      url: def.url,
      visits,
      avgTime: 35 + Math.round(rand(`${seed}:t`) * 40),
      vslEng: 40 + rand(`${seed}:e`) * 18,
      vslDuration: 95 + Math.round(rand(`${seed}:d`) * 50),
      lpConv: conv > 0 ? conv : lpConv,
      trend: sparkSeries(`${seed}:trend`, visits / 7),
    }
  })
}

export type FormRow = {
  id: string
  name: string
  submits: number
  engagement: number    // 0..100
  completionRate: number // 0..100
  qualifiedPct: number  // 0..100
  cpl: number           // $
  trend: number[]
}

const FORM_DEFS = [
  { id: 'main-application', name: 'Main coaching application' },
  { id: 'event-reg', name: 'Event registration form' },
  { id: 'partnership', name: 'Partnership inquiry' },
]

export function getForms(window: Window): FormRow[] {
  const headlines = getStageHeadlines(window)
  const totalSubmits = headlines.submits
  const adspend = scaleByWindow(11_500, window)
  return FORM_DEFS.map((def, i) => {
    const seed = `form:${def.id}:${window}`
    const weight = i === 0 ? 0.71 : i === 1 ? 0.22 : 0.07
    const submits = Math.round(totalSubmits * weight * (0.9 + rand(`${seed}:s`) * 0.2))
    const cpl = adspend * weight / Math.max(1, submits)
    return {
      id: def.id,
      name: def.name,
      submits,
      engagement: 60 + rand(`${seed}:e`) * 30,
      completionRate: 50 + rand(`${seed}:c`) * 30,
      qualifiedPct: 55 + rand(`${seed}:q`) * 25,
      cpl,
      trend: sparkSeries(`${seed}:trend`, submits / 7),
    }
  })
}
