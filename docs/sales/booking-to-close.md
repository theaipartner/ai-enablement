# Sales — Booking → Close lifecycle (spine SHELVED)

> **Status: the `booking_cycles` spine is SHELVED — not built, not planned.** This doc
> originally designed a persisted per-booking lifecycle table; the design is kept below as
> the durable record in case the revisit trigger fires.
>
> **OnceHub was trialed and removed (2026-06-22).** A OnceHub scheduling integration was
> built and briefly shipped (additive to Calendly) to make booking→closer linkage more
> reliable, then **removed — we're not going with OnceHub**. Calendly is the scheduling
> platform; the booking→close linkage is handled by **read-time reconstruction** in
> `funnel-closing.ts` (48h booking↔closer-form match) plus the per-lead journey in
> `lead_cycles`. No persisted spine.
>
> **Why shelved (the decision).** The spine was justified by two things, both of which fell
> away:
> 1. **Pinging.** Persisting a per-booking record only earned its keep if we *nudged* off
>    it — you can't ping read-time math. Drake took booking-leg pinging off the table, which
>    removes the main reason to persist anything.
> 2. **Unreliable booking→closer linkage.** Calendly can't reliably say who a booking was
>    with, so a hand-maintained link looked necessary. But the read-time reconstruction in
>    `funnel-closing.ts` (booking↔closer-form match) + `lead_cycles` (per-lead journey) is
>    good enough for every consumer asking today. A persisted spine would duplicate working
>    read-time logic with no consumer asking for per-booking durability.
>
> **Revisit trigger.** Build `booking_cycles` if/when EITHER (a) booking-leg pinging becomes
> a real priority (nudging closers for missing EOC forms on booked meetings — the
> engagement-pinger philosophy extended to bookings), OR (b) the read-time Talent
> reconstruction gets slow enough to need materializing (the SQL-aggregation perf concern in
> [`README.md`](./README.md) § Performance). Until one bites, it's premature.
>
> Edit in place; delete retired sections rather than striking them through (the one folder
> rule).

---

## The shelved design (preserved for the revisit trigger)

Everything below is the **original spine design. It is NOT built.** Kept so that if the
trigger fires we resume from a worked-through design instead of a blank page.

## Why this existed — the gap

We could see a rep's *dialing* accountability precisely (engagements — see
[`logic.md`](./logic.md) § Engagements + [`engagements.md`](../schema/engagements.md)),
but **could not link a booked meeting to its eventual close** at the persistence layer:

- **Engagements only cover the call→triage phase.** An engagement is a rep's cluster
  of Close calls to one lead, finalized by a **triage form** (setter/closer triage,
  `airtable_setter_triage_calls`) or a **DC closer form** (`airtable_full_closer_report`
  with a Digital College outcome). **High-Ticket closing is deliberately excluded** —
  an HT-Closed closer form never ends an engagement, and the HT consultation itself is
  a scheduled video meeting, not a Close phone dial, so no engagement even opens for it.
- **No persisted per-closer link from booking to close.** The only booking→closer hint
  is the setter-triage `Booked with?` field (~18% populated). The closing dashboard
  reconstructs a booking↔closer-form match at *read time* (48h window —
  `lib/db/funnel-closing.ts`). That read-time match is what the dashboard relies on today;
  a persisted spine would only be needed if we wanted to nudge off it.

## The model — a relay, not a single baton

Extend the engagement idea into a multi-leg lifecycle. Each leg has an **expected
artifact**, an **owner**, and a **nudge** when the artifact is missing:

```
Booked ──▶ Confirmation reach-out ──▶ (confirmed? meeting : Setter Pipeline) ──▶ Showed ──▶ Closed
```

1. **Booked.** A scheduled meeting (Calendly event) opens a booking cycle for the lead.
   Anchor the spine **on the meeting**, not on a form — most HT meetings are **direct
   books** (lead self-schedules, no setter, no triage form), and those must enter the
   relay too.
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
| `source` | Which adapter produced the booking (`calendly`). |
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

**The adapter principle (core principle #3).** Do **not** wire the lifecycle to a
platform's payload shape. Mirror a **normalized booking** into our DB —
`{lead_id (resolved), closer, scheduled_at, status, source, booking_ref}` — fed by a
thin adapter per platform. `booking_cycles` and the pinger read *our* table, so a future
platform swap is a contained ingestion rewrite, never a journey-logic rewrite.

## Matching priority (when a booking arrives)

1. **Close lead_id from the platform** (Calendly `utm_term` token, ~20% of bookings).
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
