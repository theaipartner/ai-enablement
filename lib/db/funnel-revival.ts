import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import { type DcPlanCounts, emptyPlans, addPlan, dcPlanUnits } from './funnel-dc'

// Revival funnel — the DC re-engagement campaign (Drake 2026-06-06).
//
// "Revival" leads are flagged by the Close custom field `DC Revival Lead`
// (REVIVAL_CF). The re-engagement SMS automation auto-creates most of them in
// Close as a fresh lead when it first texts a cold contact, so they are NOT
// real high-ticket opt-ins and are deliberately EXCLUDED from every other
// funnel/roster (see getSpeedToLeadCohort + shared/lead_tagging.py). This is
// their own, separate funnel.
//
// Because revival leads have no Typeform opt-in cycle, this funnel does NOT use
// the tagger (lead_cycles); it reads the raw signals directly:
//   close_sms (inbound) · close_calls (>=90s) · airtable_setter_triage_calls ·
//   airtable_full_closer_report.
//
// Funnel (Drake): all revival leads → responded → connected → booked → showed →
// closed, with a cash row. Monotonic backfill upward (a close implies a show
// implies a book implies a connect implies a response).
//
// THE PER-LEAD START ANCHOR (Drake: "when they were created OR when the custom
// field was added"). The blast began Jun 3 (verified: outbound SMS jumps from a
// handful of pre-campaign texts to 742 leads on 2026-06-03; every autocreated
// revival lead was created Jun 3/4/5). Two lead shapes: (a) autocreated when
// first texted → date_created ≈ the text date (Jun 3+); (b) a PRE-EXISTING Close
// lead (created back in Aug 2025) that got tagged — its date_created is old and
// it carries OLD pre-revival activity that must NOT count. The rule that handles
// both: anchor = the LATER of (date_created, REVIVAL_FLOOR). Autocreated leads
// keep their (recent) created date; pre-existing leads floor to the blast start,
// so only revival-era activity counts. (Literal CF-add doesn't work as the
// anchor: the CF was bulk-applied Jun 4/5, AFTER leads created+booked Jun 3/4.)

const REVIVAL_CF = 'cf_QivXkWBvr34UIDkUBKXNCQo6woarc62wEbIacWWbN7P'

// Campaign blast floor — Jun 3 2026, 00:00 ET (EDT = UTC-4). The blast started
// Jun 3; nothing genuine predates it. Flooring here strips pre-existing leads'
// old activity AND the late-May pre-campaign call/SMS trickle (e.g. four Aug-2025
// leads with ≥90s calls on 05-27/05-30 that are NOT revival outreach).
const REVIVAL_FLOOR_ISO = '2026-06-03T04:00:00Z'

// Every Digital College program (Base44 / Wix × Monthly / Yearly) is a flat
// $300, so revival cash = $300 per plan unit closed (mirrors DC_PLAN_PRICE_USD).
const DC_PLAN_PRICE_USD = 300

export type RevivalFunnel = {
  leads: number // all revival-tagged leads (non-excluded)
  responded: number
  connected: number
  booked: number
  bookedDc: number
  bookedHt: number
  showed: number
  closed: number // DC closes — explicit plans only (Robby over-marks "DC Closed")
  closedPlans: DcPlanCounts // Base44/Wix × Monthly/Yearly counts on the closes
  cashUsd: number // $300 per plan unit on the closes
  markedNoPlan: number // "DC Closed" forms with no plan → counted as shows, not closes
}

function isRevival(cf: Record<string, unknown> | null | undefined): boolean {
  const v = cf?.[REVIVAL_CF]
  return v != null && String(v).trim() !== ''
}

// A signal counts only if it happened on/after the lead's revival start anchor.
function reaches(callStatus: string | null): boolean {
  // A triage/confirmation form "reached" the lead unless it's the no-answer
  // setter-handover outcome (mirrors the main funnel's connected definition).
  const s = (callStatus ?? '').toLowerCase()
  return s !== '' && !s.includes('unresponsive') && !s.includes('handover')
}

function showedFromCloser(f: { form_type: string | null; call_outcome: string | null; showed: string | null }): boolean {
  if (f.form_type === 'New') {
    const co = (f.call_outcome ?? '').toLowerCase()
    return co !== '' && !['ghost', 'no show', 'reschedul', 'cancel'].some((x) => co.includes(x))
  }
  return (f.showed ?? '').toLowerCase() === 'yes'
}

// A close requires EXPLICIT plans. Robby (the DC closer) habitually marks
// "Digital College Closed" on calls that didn't actually close, so the outcome
// alone is unreliable (Drake 2026-06-06). Only count a close when the plan field
// ("What plan did we get them on?", dc_plans) is filled. A "DC Closed" form with
// no plan is treated as a SHOW (showedFromCloser already catches it), not a
// close — surfaced separately as markedNoPlan so the habit is visible.
function dcCloseUnits(f: {
  form_type: string | null
  call_outcome: string | null
  closed: string | null
  dc_plans: string[] | null
  payment_plan_type: string | null
}): { isClose: boolean; units: number; markedNoPlan: boolean } {
  const units = (f.dc_plans ?? []).filter((p) => (p ?? '').trim() !== '').length
  if (f.form_type === 'New') {
    const marked = (f.call_outcome ?? '').toLowerCase().includes('digital college closed')
    if (marked && units > 0) return { isClose: true, units, markedNoPlan: false }
    return { isClose: false, units: 0, markedNoPlan: marked }
  }
  // Legacy form: closed=yes + a DC plan_type → a real close, one plan unit.
  const legacyClose =
    (f.closed ?? '').toLowerCase() === 'yes' &&
    ['base', 'wix', 'digital college'].some((x) => (f.payment_plan_type ?? '').toLowerCase().includes(x))
  return legacyClose ? { isClose: true, units: 1, markedNoPlan: false } : { isClose: false, units: 0, markedNoPlan: false }
}

export async function getRevivalFunnel(): Promise<RevivalFunnel> {
  const sb = createAdminClient()

  // 1. All revival-tagged, non-excluded leads + their start anchor. close_leads
  // is ~7.6k rows; page through and JS-filter the CF (mirrors isRevival usage
  // in funnel-appointment-setting.ts). Guard the 1000-row PostgREST cap.
  const anchor = new Map<string, string>() // close_id → revival-start ISO
  for (let from = 0; ; from += 1000) {
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, date_created, custom_fields_raw')
      .is('excluded_at', null)
      .range(from, from + 999)
    if (error) throw new Error(`close_leads revival read failed: ${error.message}`)
    const rows = (data ?? []) as unknown as Array<{
      close_id: string
      date_created: string | null
      custom_fields_raw: Record<string, unknown> | null
    }>
    for (const l of rows) {
      if (!isRevival(l.custom_fields_raw)) continue
      const created = l.date_created ?? ''
      anchor.set(l.close_id, created > REVIVAL_FLOOR_ISO ? created : REVIVAL_FLOOR_ISO)
    }
    if (rows.length < 1000) break
  }
  const ids = Array.from(anchor.keys())
  if (ids.length === 0) {
    return { leads: 0, responded: 0, connected: 0, booked: 0, bookedDc: 0, bookedHt: 0, showed: 0, closed: 0, closedPlans: emptyPlans(), cashUsd: 0, markedNoPlan: 0 }
  }
  const after = (lid: string, ts: string | null | undefined): boolean => {
    const a = anchor.get(lid)
    return ts != null && a != null && ts >= a
  }

  const responded = new Set<string>()
  const connected = new Set<string>()
  const booked = new Set<string>()
  const bookedDc = new Set<string>()
  const bookedHt = new Set<string>()
  const showed = new Set<string>()
  const closed = new Set<string>()
  const closedPlans = emptyPlans()
  let markedNoPlan = 0

  // 2. Pull each signal in id-chunks (every signal set is well under 1000 rows,
  // so a 200-id chunk never trips the cap).
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200)

    // Responded = an inbound SMS since the anchor.
    const { data: sms, error: smsErr } = await sb
      .from('close_sms' as never)
      .select('lead_id, activity_at')
      .in('lead_id', chunk)
      .eq('direction', 'inbound')
    if (smsErr) throw new Error(`close_sms read failed: ${smsErr.message}`)
    for (const r of (sms ?? []) as unknown as Array<{ lead_id: string | null; activity_at: string | null }>) {
      if (r.lead_id && after(r.lead_id, r.activity_at)) responded.add(r.lead_id)
    }

    // Connected = a >=90s call since the anchor.
    const { data: calls, error: callErr } = await sb
      .from('close_calls' as never)
      .select('lead_id, activity_at')
      .in('lead_id', chunk)
      .gte('duration', 90)
    if (callErr) throw new Error(`close_calls read failed: ${callErr.message}`)
    for (const r of (calls ?? []) as unknown as Array<{ lead_id: string | null; activity_at: string | null }>) {
      if (r.lead_id && after(r.lead_id, r.activity_at)) connected.add(r.lead_id)
    }

    // Triage/confirmation forms → connected (reached) + booked (DC/HT booking).
    const { data: triage, error: trErr } = await sb
      .from('airtable_setter_triage_calls' as never)
      .select('lead_id, call_status, airtable_created_at')
      .in('lead_id', chunk)
      .is('excluded_at', null)
    if (trErr) throw new Error(`triage read failed: ${trErr.message}`)
    for (const r of (triage ?? []) as unknown as Array<{ lead_id: string | null; call_status: string | null; airtable_created_at: string | null }>) {
      if (!r.lead_id || !after(r.lead_id, r.airtable_created_at)) continue
      const s = (r.call_status ?? '').toLowerCase()
      if (reaches(r.call_status)) connected.add(r.lead_id)
      if (s.includes('booking')) {
        booked.add(r.lead_id)
        if (s.includes('digital college booking')) bookedDc.add(r.lead_id)
        if (s.includes('high ticket booking')) bookedHt.add(r.lead_id)
      }
    }

    // Closer EOC forms → showed + DC-closed (+ cash).
    const { data: eoc, error: eocErr } = await sb
      .from('airtable_full_closer_report' as never)
      .select('lead_id, form_type, call_outcome, showed, closed, dc_plans, payment_plan_type, airtable_created_at')
      .in('lead_id', chunk)
    if (eocErr) throw new Error(`closer report read failed: ${eocErr.message}`)
    for (const f of (eoc ?? []) as unknown as Array<{
      lead_id: string | null
      form_type: string | null
      call_outcome: string | null
      showed: string | null
      closed: string | null
      dc_plans: string[] | null
      payment_plan_type: string | null
      airtable_created_at: string | null
    }>) {
      if (!f.lead_id || !after(f.lead_id, f.airtable_created_at)) continue
      if (showedFromCloser(f)) showed.add(f.lead_id)
      const close = dcCloseUnits(f)
      if (close.isClose) {
        closed.add(f.lead_id)
        addPlan(closedPlans, f.dc_plans)
      } else if (close.markedNoPlan) {
        markedNoPlan += 1
      }
    }
  }

  // 3. Monotonic backfill upward — a later stage implies every earlier one.
  closed.forEach((id) => showed.add(id))
  showed.forEach((id) => booked.add(id))
  booked.forEach((id) => connected.add(id))
  connected.forEach((id) => responded.add(id))

  return {
    leads: ids.length,
    responded: responded.size,
    connected: connected.size,
    booked: booked.size,
    bookedDc: bookedDc.size,
    bookedHt: bookedHt.size,
    showed: showed.size,
    closed: closed.size,
    closedPlans,
    cashUsd: dcPlanUnits(closedPlans) * DC_PLAN_PRICE_USD,
    markedNoPlan,
  }
}
