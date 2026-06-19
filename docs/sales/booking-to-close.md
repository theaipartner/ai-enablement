# Sales — Booking → Close lifecycle (capture phase live, spine deferred)

> **Status (2026-06-19):** OnceHub is the scheduling platform (Calendly dropped for
> HT closing). **Discovery is done** and the **raw capture layer is built and
> deploying** — `oncehub_bookings` (migration 0092) + the `api/oncehub_events.py`
> webhook + the `ingestion/oncehub/` adapter mirror every booking into Supabase. The
> normalized **`booking_cycles` spine + the per-leg pinger + the Talent closer card
> are still deferred** — they read the mirror, and we build them once real bookings
> (with a real `form_submission` + the hidden lead_id) have accumulated. Live OnceHub
> config + the capture wiring live in [`ingestion.md`](./ingestion.md) § OnceHub;
> this doc remains the durable design record for the spine. Edit in place; delete
> retired sections rather than striking them through (the one folder rule).

## Why this exists — the gap

Today we can see a rep's *dialing* accountability precisely (engagements — see
[`logic.md`](./logic.md) § Engagements + [`engagements.md`](../schema/engagements.md)),
but we **cannot link a booked meeting to its eventual close**. The lead's journey
breaks at the booking:

- **Engagements only cover the call→triage phase.** An engagement is a rep's cluster
  of Close calls to one lead, finalized by a **triage form** (setter/closer triage,
  `airtable_setter_triage_calls`) or a **DC closer form** (`airtable_full_closer_report`
  with a Digital College outcome). **High-Ticket closing is deliberately excluded** —
  an HT-Closed closer form never ends an engagement, and the HT consultation itself is
  a scheduled video meeting, not a Close phone dial, so no engagement even opens for it.
- **No per-closer link from booking to close.** The only existing booking→closer hint
  is the setter-triage `Booked with?` field, populated on just ~11 of 61 HT bookings
  all-time (~18%). The closing dashboard reconstructs a booking↔closer-form match at
  *read time* (Calendly event → closer form, 48h window — `lib/db/funnel-closing.ts`),
  but it's ephemeral dashboard math, not a persisted, pingable state.

The consequence we keep hitting: the Talent page can't show a closer an honest
**Books → Shows → Closes → Cash** funnel, because "Books" has no reliable per-closer
source. We want to build the missing spine.

## The model — a relay, not a single baton

Extend the engagement idea into a multi-leg lifecycle. Each leg has an **expected
artifact**, an **owner**, and a **nudge** when the artifact is missing:

```
Booked ──▶ Confirmation reach-out ──▶ (confirmed? meeting : Setter Pipeline) ──▶ Showed ──▶ Closed
```

1. **Booked.** A scheduled meeting (OnceHub event; Calendly until then) opens a
   booking cycle for the lead. Anchor the spine **on the meeting**, not on a form —
   most HT meetings are **direct books** (lead self-schedules, no setter, no triage
   form), and those must enter the relay too.
2. **Confirmation reach-out.** Every booking gets a reach-out before the meeting —
   by **call** (opens an engagement, finalized by a Closer Triage Form) **or by text**
   (no Close call, so no engagement). Because it can be a text, the **canonical
   "confirmed" signal is the Closer Triage Form outcome**, not the call:
   - `Confirmed Booking` / `Confirmed Booking – New Time` → proceeds to the meeting.
   - **Never confirms → routes to the Setter Pipeline** (`Setter pipeline / Follow up`).
     A setter takes over re-engaging. This is a *handoff*, not a dead end — the cycle
     records the transition instead of pinging forever.
3. **Showed / Closed.** The meeting happens → the closer files the EOC form
   (`airtable_full_closer_report`): showed/closed/cash, or `Client Ghosted (no show)`.
   This is the leg engagements never covered.

At every leg where the expected artifact is missing, the cycle nudges the right person
— same philosophy as the missing-form pinger, applied across the whole journey.

## Schema — a sibling to engagements, wired into it

**Decision: a new sibling table, not an extension of `engagements`.** Rationale: a
booking cycle is a *different grain* — meeting-anchored, multi-leg, different owners and
clocks per leg — and `engagements` should stay a clean call→single-form unit. But the
sibling is **connected to** engagements, not divorced from them.

Proposed `booking_cycles` (one row per booked meeting), sticky-timestamp tags read for
state, mirroring `engagements` / `lead_cycle_stages` (set once, never cleared):

| column | purpose |
|---|---|
| `id` | PK. |
| `lead_id` | Close lead (`close_leads.close_id`). |
| `closer_user_id` / `closer_name` | The host the meeting is booked with (from the booking platform). **This is what finally gives Books a reliable per-closer owner.** |
| `source` | `oncehub` \| `calendly` — which adapter produced the booking. |
| `booking_ref` | The platform's event/booking id (normalized key). |
| `scheduled_at` | The meeting time — drives the closing-leg clock. |
| `booked_at` | Cycle opened. |
| `confirm_engagement_id` | FK → `engagements.id` for the confirmation call, when the reach-out was a call. Null if confirmed by text (form-only). **The "sibling but connected" link.** |
| `confirm_form_id` | The Closer Triage Form `record_id` that confirmed (or routed to pipeline). |
| `confirmed_at` | Confirmation leg satisfied. |
| `routed_to_setter_at` | Booking never confirmed → handed to Setter Pipeline. |
| `showed_at` / `no_show_at` | From the EOC form and/or the platform's no-show event. |
| `closed_at` / `outcome` / `close_type` (`ht`/`dc`) | From the EOC form. |
| `closer_form_id` | FK → the `airtable_full_closer_report` row (the close). |
| `upfront` / `contract` | Cash, from the EOC form. |
| `canceled_at` / `rescheduled_to` | Platform cancel / reschedule lineage (auto-resolve, see below). |
| ping bookkeeping | `last_pinged_at`, `ping_count`, `ping_ts[]` — same pattern as engagements. |

**How it threads engagements:** the booking cycle is the spine; engagements remain the
call-accountability layer that feeds it. The confirmation call's engagement links via
`confirm_engagement_id`; the close links via `closer_form_id`. Engagement logic and the
existing missing-form pinger are unchanged.

## How OnceHub fits — and why it's better than Calendly here

OnceHub (`developers.oncehub.com`) supports our setup and closes the matching gap that
Calendly left open:

- **Native lifecycle webhooks**: `booking.scheduled`, `booking.rescheduled`,
  `booking.canceled`, `booking.canceled_then_rescheduled`, `booking.completed`, and a
  real **`booking.no_show`** event. Calendly only exposes a `no_show` *flag* we'd poll;
  OnceHub *tells* us in real time — exactly the signal the closing leg needs to
  auto-resolve a fallen-through meeting (so it stops nudging).
- **Reliable lead_id carriage.** OnceHub personalized links carry custom/hidden fields
  and support embedding a **CRM record ID** that returns in the webhook payload. We set
  the **Close lead_id** as a hidden field on the booking link → every booking hands it
  back directly. This replaces Calendly's `utm_term` `aaid_<token>` hack, which only
  resolves ~20% of bookings (most utm_terms are generic ad labels, dropped for safety —
  `lib/db/calendly-lead-match.ts`). Email/phone/name matching drops from *primary path*
  to *backstop*.
- Webhooks are signed (secret) and UI-configurable (OnceHub Apr 2026 update).

**The adapter principle (core principle #3).** Do **not** wire the lifecycle to a
platform's payload shape. Mirror a **normalized booking** into our DB —
`{lead_id (resolved), closer, scheduled_at, status, source, booking_ref}` — fed by a
thin OnceHub adapter (and a Calendly adapter only if we need the interim). `booking_cycles`
and the pinger read *our* table, so a future platform swap is a contained ingestion
rewrite, never a journey-logic rewrite.

**Discovery — done 2026-06-19** (against the live v2 account). Confirmed: account is
v2; events fire as listed above; the booking object carries `owner` = the assigned
rep (USR-…) even on the team round-robin calendar, `rescheduled_booking_id` for
reschedule lineage, and `cancel_reschedule_information` {reason, actioned_by,
user_id}. Signature is `Oncehub-Signature: t=<ts>,s=<hex>`, HMAC-SHA256 over
`<ts>.<body>`. The one thing **not yet observed** is a real `form_submission`
(invitee name/email/phone) + a populated hidden-field `custom_fields` entry — the
two admin/reschedule test bookings have `form_submission: null`. The parser is
written defensively for both; **one real booking through the public link with the
form filled (and a `?lead_id=` param once the hidden field exists)** is the last
discovery step before the spine relies on those fields.

## Matching priority (when a booking arrives)

1. **Close lead_id from the platform** (OnceHub hidden field; Calendly `utm_term` token).
2. **Email**, then **phone**, then **normalized name** — the existing resolver
   (`calendly-lead-match.ts` + the booked-by identity resolver in `funnel-closing.ts`).
   Reuse it; don't rebuild.

## Pinging — different owner and clock per leg

- **Confirmation leg.** Owner = the closer/setter responsible for the reach-out. The
  clock runs **before** the meeting (nudge to confirm); if it never confirms, the cycle
  flips to `routed_to_setter_at` (Setter Pipeline) rather than nagging indefinitely.
- **Closing leg.** Owner = the **closer the meeting is booked with**. The clock starts
  **after `scheduled_at` + grace** — you can't ask for an EOC before the call happens.
  This is a new trigger type vs. the engagement pinger's 45-min call-silence clock.
- **Auto-resolve.** A platform `canceled` / `no_show` / reschedule must transition or
  close the obligation so it stops pinging. (A genuine no-show often still earns a form —
  `Client Ghosted` is a valid EOC outcome — so the nudge is still useful pressure; it
  just needs an escape hatch.)

## What this means for the Talent page we ultimately want

The Talent **Roster** (one block per rep — see [`surfaces.md`](./surfaces.md) § Talent;
currently a sub-page at `/people/by-rep`) is the consumer. With booking→close linked, the
**closer card** finally gets an honest, sourced funnel:

- **Dials** — `close_calls` (closer's outbound).
- **Books** — booking cycles where this closer is the host. *This is the metric that has
  no reliable source today; the booking cycle is what fixes it.*
- **Shows** — cycles that reached `showed_at`.
- **Closes — HT and DC** — `closed_at` split by `close_type`.
- **Cash** — overall, and **cash per show** (`upfront ÷ shows`).

The block shows only these crucial metrics; **clicking a rep opens the full per-leg
drilldown** — the booking, the confirmation engagement/form, the EOC form, every call —
i.e., the lead's whole journey through that rep, reconstructed from the spine. Same shape
for the setter card (its booked-meeting attribution becomes real too). Once this is
trusted, the Roster replaces the current section-by-call-type Talent page.

Until then the Roster reads the existing read-time loaders as-is, and the closer-card
Books/Shows/Closes metrics stay approximate (the closing dashboard's Calendly-matched
numbers).

## Open decisions to confirm at build time

- Confirm the **Closer Triage Form outcome is the canonical "confirmed" signal** (text
  confirmations produce no call/engagement) — current working assumption.
- **OnceHub cutover timing** decides whether we build the Calendly adapter at all or go
  straight to OnceHub.
- Whether **direct + setter-booked** meetings share one `booking_cycles` shape (assumed
  yes) or need a discriminator beyond the funnel's existing Direct/Setter/Reactivation
  split.
- Exact OnceHub webhook payload field names + host attribution — from the discovery call.
