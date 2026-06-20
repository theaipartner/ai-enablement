import 'server-only'

import { createAdminClient } from '@/lib/supabase/admin'
import type { DateRange } from './funnel-window'

// =============================================================================
// OnceHub bookings — the normalized read foundation (Phase 1).
//
// This is the OnceHub analog of funnel-calendly.ts + calendly-lead-match.ts. It
// turns raw `oncehub_bookings` rows into the same kind of normalized "booking"
// the Calendly loaders produce, so every downstream sales surface can UNION
// OnceHub bookings in ADDITIVELY (never replacing Calendly). Three jobs:
//
//   1. classify    — which funnel role a booking is (HT consultation / DC /
//                    internal), via its OnceHub master-page / booking-calendar.
//   2. resolve lead — booking → Close lead_id: the hidden lead_id field first
//                    (when configured), then email → phone → name fallback
//                    (the same priority Calendly uses).
//   3. resolve closer — the round-robin `owner` (a OnceHub USR-id) → the
//                    team_member, so "Books" finally has a reliable per-closer
//                    owner (the gap booking-to-close.md describes).
//
// Nothing here reads api.oncehub.com — it reads our mirror (core principle #1).
// =============================================================================

// ---------------------------------------------------------------------------
// 1. Role classification
// ---------------------------------------------------------------------------

// What KIND of meeting a booking is — the booking's intrinsic type, NOT who
// booked it. (Direct-vs-setter is a lead-state concern derived from the triage
// form by the tagger, not from the booking itself.) 'internal' = a non-sales
// meeting (individual 1:1 calendars) we must NOT count as a sales booking.
export type OnceHubBookingRole = 'ht_consultation' | 'partnership' | 'dc' | 'internal' | 'unknown'

// The classification map — the single source of truth for "which OnceHub page
// is which funnel flow". Grows as Zain adds pages; keep it confirmed with him.
// Verified against the live account 2026-06-19.
//
// NOTE (open config): only the FB funnel HT consultation exists today. A DC
// booking page and a dedicated setter link don't exist yet — when they do, add
// them here. Anything unmapped resolves to 'unknown' (surfaced, never silently
// counted) so a new page can't quietly pollute the funnel.
const ROLE_BY_MASTER_PAGE: Record<string, OnceHubBookingRole> = {
  'BP-MVKDFLP85W': 'ht_consultation', // "AI Partner - FB" — FB-funnel inbound HT consultation
}
const ROLE_BY_BOOKING_CALENDAR: Record<string, OnceHubBookingRole> = {
  'BKC-0NJDVMLVJK': 'ht_consultation', // "Ai Partner Strategy Call" (team Closers, round-robin)
  'BKC-L1JK7YLY5X': 'internal', // "Meeting with Jason"
  'BKC-Q45L7XXY52': 'internal', // "Meeting with Cobe"   (individual 1:1 — confirm w/ Drake if setters use it)
  'BKC-LDJ8E33M5X': 'internal', // "Meeting with Aman"   (individual 1:1 — confirm w/ Drake if setters use it)
  'BKC-P96Y2PP26X': 'internal', // "Meeting with Success"
}
// Setter-led "Partnership Call w/ {closer}" pages (the Classic booking-page
// surface). A FB-funnel direct booking ALSO carries one of these as its
// underlying page, so booking_page is only decisive when master_page is absent
// (verified live 2026-06-20: direct = master_page set; partnership = master_page
// null + booking_page set). Hence booking_page is checked LAST below.
const ROLE_BY_BOOKING_PAGE: Record<string, OnceHubBookingRole> = {
  'BP-UBK4DVGWFX': 'partnership', // "Partnership Call w/ Aman"
  'BP-182H3QCWET': 'partnership', // "Partnership Call w/ Cobe"
}

export function classifyOnceHubBooking(b: {
  master_page_id?: string | null
  booking_calendar_id?: string | null
  booking_page_id?: string | null
}): OnceHubBookingRole {
  // Order matters: a FB-funnel direct booking carries master_page AND a
  // partnership booking_page underneath — master_page makes it direct. A bare
  // partnership-page booking has no master_page → setter. So master/calendar
  // are checked before booking_page.
  if (b.master_page_id && ROLE_BY_MASTER_PAGE[b.master_page_id]) {
    return ROLE_BY_MASTER_PAGE[b.master_page_id]
  }
  if (b.booking_calendar_id && ROLE_BY_BOOKING_CALENDAR[b.booking_calendar_id]) {
    return ROLE_BY_BOOKING_CALENDAR[b.booking_calendar_id]
  }
  if (b.booking_page_id && ROLE_BY_BOOKING_PAGE[b.booking_page_id]) {
    return ROLE_BY_BOOKING_PAGE[b.booking_page_id]
  }
  return 'unknown'
}

// ---------------------------------------------------------------------------
// 2. Lead resolution
// ---------------------------------------------------------------------------

function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null
  const digits = raw.replace(/[^0-9]/g, '')
  // OnceHub phones arrive as "1-2269267772"; take the last 10 (drop country code).
  return digits.length >= 10 ? digits.slice(-10) : null
}

function normName(n: string | null | undefined): string | null {
  if (!n) return null
  const v = n.toLowerCase().trim()
  return v || null
}

function normEmail(e: string | null | undefined): string | null {
  if (!e) return null
  const v = e.toLowerCase().trim()
  return v || null
}

export type OnceHubLeadResolver = (b: {
  leadIdHidden?: string | null
  email?: string | null
  phone?: string | null
  name?: string | null
}) => string | null

type ContactsBlob = Array<{
  emails?: Array<{ email?: string | null }>
  phones?: Array<{ phone?: string | null }>
}>

// Builds a resolver booking → Close close_id. Priority: hidden lead_id (when
// configured + it points at a real lead — it's tamperable, so we VALIDATE it
// against close_leads rather than trust it) → email → phone → name. Name/email/
// phone maps are unique-only (a key two distinct leads claim → null = ambiguous),
// matching the Calendly/tagger discipline so a shared key can't mis-attribute.
//
// Full close_leads scan, same as buildCalendlyLeadResolver — fine for the low
// booking volume; scope to candidate identities later if it ever matters.
export async function buildOnceHubLeadResolver(
  sb: ReturnType<typeof createAdminClient>,
): Promise<OnceHubLeadResolver> {
  const validIds = new Set<string>()
  const emailToLead = new Map<string, string | null>()
  const phoneToLead = new Map<string, string | null>()
  const nameToLead = new Map<string, string | null>()

  const put = (mp: Map<string, string | null>, key: string | null, cid: string) => {
    if (!key) return
    if (!mp.has(key)) mp.set(key, cid)
    else if (mp.get(key) !== cid) mp.set(key, null) // collision → ambiguous
  }

  let from = 0
  for (;;) {
    const { data, error } = await sb
      .from('close_leads' as never)
      .select('close_id, display_name, contacts')
      .range(from, from + 999)
    if (error) throw new Error(`oncehub-bookings: close_leads read failed: ${error.message}`)
    const rows = (data ?? []) as unknown as Array<{
      close_id: string
      display_name: string | null
      contacts: ContactsBlob | null
    }>
    if (rows.length === 0) break
    for (const r of rows) {
      validIds.add(r.close_id)
      put(nameToLead, normName(r.display_name), r.close_id)
      for (const c of r.contacts ?? []) {
        for (const em of c.emails ?? []) put(emailToLead, normEmail(em?.email), r.close_id)
        for (const ph of c.phones ?? []) put(phoneToLead, normalizePhone(ph?.phone), r.close_id)
      }
    }
    if (rows.length < 1000) break
    from += 1000
  }

  return ({ leadIdHidden, email, phone, name }) => {
    if (leadIdHidden && validIds.has(leadIdHidden)) return leadIdHidden
    const e = normEmail(email)
    if (e && emailToLead.get(e)) return emailToLead.get(e) ?? null
    const p = normalizePhone(phone)
    if (p && phoneToLead.get(p)) return phoneToLead.get(p) ?? null
    const n = normName(name)
    if (n && nameToLead.get(n)) return nameToLead.get(n) ?? null
    return null
  }
}

// ---------------------------------------------------------------------------
// 3. Closer resolution (OnceHub owner → team_member)
// ---------------------------------------------------------------------------

// OnceHub user-id → email seed. The `owner` on a booking is a OnceHub USR-id,
// which we map to a team_member by email. team_members has no oncehub_user_id
// column yet; this seed is the bridge.
//
// SEED (verified live 2026-06-19). When OnceHub users churn or flows expand,
// promote this to a mirrored `oncehub_users` reference table (core principle #1)
// or a `team_members.oncehub_user_id` column — flagged for the C3 wire-up.
const ONCEHUB_USER_EMAIL: Record<string, string> = {
  'USR-4Z2FDWEXG0': 'jason.lau401@gmail.com', // Jason (admin)
  'USR-HTRLWQZU5J': 'cobe@theaipartner.io', // Cobe (closer)
  'USR-A5BCFPWRGT': 'aman@theaipartner.io', // Aman (closer)
  'USR-6C5K0JNR1G': 'success@theaipartner.io', // Success (account owner)
}

// The team-member email for a OnceHub owner USR-id (via the seed directory).
// Lets a consumer feed OnceHub's `owner` into the existing host-email→closer
// resolvers (e.g. funnel-closing's closerIdentity) so OnceHub bookings resolve
// to the same canonical closer identity as Calendly hosts.
export function oncehubOwnerEmail(ownerUserId: string | null | undefined): string | null {
  if (!ownerUserId) return null
  return ONCEHUB_USER_EMAIL[ownerUserId] ?? null
}

export type OnceHubCloser = {
  closeUserId: string | null
  name: string | null
  slackUserId: string | null
  salesRole: string | null
}

export type OnceHubCloserResolver = (ownerUserId: string | null | undefined) => OnceHubCloser | null

// Maps a OnceHub owner USR-id → team_member (by email via the seed). Returns
// null for owners with no team_member match (e.g. the OnceHub admin account).
export async function buildOnceHubCloserResolver(
  sb: ReturnType<typeof createAdminClient>,
): Promise<OnceHubCloserResolver> {
  const { data, error } = await sb
    .from('team_members' as never)
    .select('close_user_id, full_name, slack_user_id, sales_role, email')
  if (error) throw new Error(`oncehub-bookings: team_members read failed: ${error.message}`)
  const rows = (data ?? []) as unknown as Array<{
    close_user_id: string | null
    full_name: string | null
    slack_user_id: string | null
    sales_role: string | null
    email: string | null
  }>
  const byEmail = new Map<string, OnceHubCloser>()
  for (const r of rows) {
    const e = normEmail(r.email)
    if (!e) continue
    byEmail.set(e, {
      closeUserId: r.close_user_id,
      name: r.full_name,
      slackUserId: r.slack_user_id,
      salesRole: r.sales_role,
    })
  }
  return (ownerUserId) => {
    if (!ownerUserId) return null
    const email = ONCEHUB_USER_EMAIL[ownerUserId]
    if (!email) return null
    return byEmail.get(normEmail(email)!) ?? null
  }
}

// ---------------------------------------------------------------------------
// 4. The normalized loader
// ---------------------------------------------------------------------------

export type OnceHubBooking = {
  bookingId: string
  role: OnceHubBookingRole
  leadId: string | null // resolved Close close_id (null = unresolved)
  ownerUserId: string | null
  closer: OnceHubCloser | null
  subject: string | null
  scheduledAt: string | null // meeting time (the closing-leg clock)
  bookedAt: string | null // when the booking was made (the funnel "booked" key)
  status: string | null
  isCanceled: boolean
  isNoShow: boolean
  isRescheduled: boolean // this booking replaced a prior one (reschedule new-leg)
  rescheduledFromId: string | null
  inviteeName: string | null
  inviteeEmail: string | null
  inviteePhone: string | null
}

type OnceHubRow = {
  booking_id: string
  master_page_id: string | null
  booking_calendar_id: string | null
  booking_page_id: string | null
  lead_id: string | null
  owner_user_id: string | null
  subject: string | null
  scheduled_at: string | null
  booked_at: string | null
  status: string | null
  last_event_type: string | null
  rescheduled_booking_id: string | null
  invitee_name: string | null
  invitee_email: string | null
  invitee_phone: string | null
}

export type LoadOnceHubOptions = {
  // Which timestamp the range filters: 'booked_at' (when made — the funnel
  // "booked" signal, default) or 'scheduled_at' (when the meeting is — for the
  // closing-leg / scheduled tables).
  dateField?: 'booked_at' | 'scheduled_at'
  // Roles to include. Default = the sales-funnel meetings only (drops internal
  // 1:1s and unmapped pages).
  roles?: OnceHubBookingRole[]
}

// Loads + normalizes OnceHub bookings in a range, lead- and closer-resolved.
// The one entry point downstream surfaces call before unioning OnceHub in.
export async function loadOnceHubBookings(
  range: DateRange,
  opts: LoadOnceHubOptions = {},
): Promise<OnceHubBooking[]> {
  const dateField = opts.dateField ?? 'booked_at'
  const roles = opts.roles ?? ['ht_consultation', 'partnership']

  const sb = createAdminClient()
  const { data, error } = await sb
    .from('oncehub_bookings' as never)
    .select(
      'booking_id, master_page_id, booking_calendar_id, booking_page_id, lead_id, owner_user_id, subject, ' +
        'scheduled_at, booked_at, status, last_event_type, rescheduled_booking_id, ' +
        'invitee_name, invitee_email, invitee_phone',
    )
    .is('excluded_at', null)
    .gte(dateField, range.startUtcIso)
    .lt(dateField, range.endUtcIso)
  if (error) throw new Error(`oncehub-bookings: oncehub_bookings read failed: ${error.message}`)
  const rows = (data ?? []) as unknown as OnceHubRow[]
  if (rows.length === 0) return []

  const [resolveLead, resolveCloser] = await Promise.all([
    buildOnceHubLeadResolver(sb),
    buildOnceHubCloserResolver(sb),
  ])

  const out: OnceHubBooking[] = []
  for (const r of rows) {
    const role = classifyOnceHubBooking(r)
    if (!roles.includes(role)) continue
    out.push({
      bookingId: r.booking_id,
      role,
      leadId: resolveLead({
        leadIdHidden: r.lead_id,
        email: r.invitee_email,
        phone: r.invitee_phone,
        name: r.invitee_name,
      }),
      ownerUserId: r.owner_user_id,
      closer: resolveCloser(r.owner_user_id),
      subject: r.subject,
      scheduledAt: r.scheduled_at,
      bookedAt: r.booked_at,
      status: r.status,
      isCanceled: r.status === 'canceled',
      isNoShow: r.last_event_type === 'booking.no_show' || r.status === 'no_show',
      isRescheduled: !!r.rescheduled_booking_id,
      rescheduledFromId: r.rescheduled_booking_id,
      inviteeName: r.invitee_name,
      inviteeEmail: r.invitee_email,
      inviteePhone: r.invitee_phone,
    })
  }
  return out
}
