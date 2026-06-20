# Sales — Matching & Business Logic

The load-bearing rules. These are the ones that cost real time to get right and break
silently when changed. **Don't "simplify" any of these without understanding why they
exist** — most encode a specific data-quality reality. Source files are named so you
can find the implementation.

---

## The connected signal

`connected` = a **≥90s call** (any direction; `FMR_DIAL_CONNECTED_SEC = 90`) **OR** a
triage/confirmation form that *reached* the lead (any `call_status` except
`Unresponsive – Setter Handover`) **OR** showed/closed (monotonic back-fill).

- A no-show closer form ("Client Ghosted") is **not** a connect.
- A pure self-booked direct booking is **not** a connection → in the Total funnel,
  Books can exceed Connected (intended). Setter/reactivation bookings *do* count.
- `connectedEffective = connected || hasPartnership || showed || closed` — read by the
  Total funnel, the speed box, the roster Connected column, and the per-lead header.
- Per-type: **Total** = `connectedEffective`; **Direct** = `connected || confirmed ||
  showed || closed` (no booking back-fill); **Setter** = `connectedEffective`;
  **Reactivation** = `reactConnected` only (≥90s dial OR setter-triage form *after*
  `reactivated_at`; a confirmation does not count as a reactive connect).

> Note: `getAppointmentSettingMetrics` uses `close_calls.duration > 0` for its "Calls
> Connected" tile; everywhere else uses ≥90s. **Don't unify them** — they answer
> different questions.

---

## utm_term unique-mapping guard — never remove this

`lib/db/calendly-lead-match.ts` (`buildCalendlyLeadResolver` / `inviteeUtmTerm`).

Bookings carry a per-lead token `aaid_<uuid>` in
`calendly_invitees.raw_payload.tracking.utm_term`, mirrored to `close_leads.utm_term`.
The join is `utm_term ↔ utm_term → close_id`.

**The trap:** `utm_term` is overloaded — generic ad-targeting terms ("Broad" maps to
2,591 leads) are shared across thousands of leads. The resolver keeps **only** terms
that map to exactly **one** lead; shared terms resolve to `null`. Removing this guard
silently maps thousands of bookings to the wrong lead. Coverage is ~20% and that's
fine — it's a high-precision key, not a high-recall one.

---

## Booking → lead matching precedence

**Calendly:** `utm_term` token **first**, then **email** (invitee email →
`close_leads.contacts`), then phone, then name. Used in `leads.ts` `directBooked` and across
`funnel-closing.ts` (`leadKeyOf`, `buildBookedByResolver`, `matchForm`).

**OnceHub:** the same precedence with a stronger primary — **hidden `lead_id` first** (when
the field is configured; exact, not ambiguity-gated like utm), then **email → phone → name**
(`lib/db/oncehub-bookings.ts` `buildOnceHubLeadResolver`; the tagger resolves the same way).
The hidden field isn't live yet, so today OnceHub matches on email/phone/name — the utm hack
is replaced by an exact id once Zain adds the hidden field + `?lead_id=` links.

Why email is the reliable middle key: invitee names are often first-name-only ("EDavid"
vs "EDavid Waugh") and the closer form's `prospect_email` is frequently null. **Match by
identity, never by `confirmed_call_date_time`** (sometimes mis-entered).

---

## Form selection — `pickForm`

When a lead has multiple closer forms inside the **±48h** match window, the winner is
**New over Old `form_type`, then most recently submitted** (`airtable_created_at`).
In `funnel-closing.ts` (`matchForm` does the ±48h booking↔form match).

This replaced raw time-proximity, which let a stale Old form beat the new disposition.

**Windows:** **±48h** = closer form ↔ Calendly booking match. **90-min** = (a) dedup of
duplicate closer forms (same call within 90min → keep latest submission) and (b) the CEO
missing-form flag's closer trigger (1.5h after meeting start; setter trigger is 15min).

---

## Engagements — call↔form matching + the missing-form pinger

The precise call↔form link (supersedes lead-level matching for the *phone* forms —
setter triage + closer/confirmation triage, both Close calls). Logic in
`shared/engagements.py`; table `engagements` (migration 0086, see
`docs/schema/engagements.md`); ops + status in [`ingestion.md`](./ingestion.md) §
Engagement pinger. **Both the matching/tracking and the Slack pinger are LIVE (pinger
resumed 2026-06-19 10am ET after the 2026-06-16 fixes) — see ingestion.md for the kill
switch + clean-start mechanics.**

**An engagement = a rep's cluster of calls to one lead toward one form** (not one call —
back-to-back redials collapse in). Sticky tag-timestamps, set once, never cleared; read
the tags for state (like `lead_cycle_stages`):

- **OPEN** — a **≥90s** outbound call with no open engagement for `(lead, rep)` opens one.
  Only ≥90s seeds one, so no-answer dials never create a form obligation (this sidesteps
  "is a sub-90s call a real connect" — Close's `disposition`/`date_answered` are unreliable,
  ~98% of short dials show `answered`, and most short calls have no recording to transcribe).
- **GROW** — any later call (any length) within **45 min** of `last_call_at` joins it and
  rolls the window. Once 45 min of silence pass the call-set is **frozen** — a later call
  starts a NEW engagement (so an engagement can't span a gap, let alone days).
- **OVERDUE** — 45-min silence with no form → `overdue_at` set; the pinger takes over.
  Only **sales reps** are pinged: the rep must map to a `team_members` row with `sales_role`
  in `setter`/`closer`/`dc_closer` (gated in `due_pings`). Non-rep Close users —
  Nabeel/Scott (leadership), Ellis (ops) — have Close accounts but no `sales_role`, so they
  track engagements but never ping.
- **FINAL** — a form for `(lead, rep)` links to the **oldest** open engagement (FIFO),
  set once. Two forms end an engagement: **(a) a setter/closer triage form** (rep from
  `setter_record_ids`), and **(b) a DC closer form** — a `airtable_full_closer_report`
  row with `call_outcome in ('Digital College', 'Digital College Closed')`, rep from
  `closer_record_ids` (a DC closer who closes over the phone files this instead of a
  triage form). Outcome-based: **High Ticket outcomes never end an engagement.** Rep
  resolves via `team_members.airtable_user_id` → `close_user_id`. A form matching no open
  engagement stays unlinked → the review pile (off-Close ~6-8%, irreducible).
- **DISMISSED** — a rep **@-mentions Ella in the ping's Slack thread** when the form is
  genuinely not needed (e.g. a lead called for tech support, not a sales call). The
  reply's `thread_ts` matches the engagement's recorded `ping_ts` → `dismissed_at` set,
  pinging stops, the rep's text stored as `dismiss_reason`. Thread-reply only (so it
  isn't confused for another ping); whatever they type — or a bare @Ella — dismisses.
  Kept **distinct from FINAL** so a dismissal is never counted as a filed form.

**Form-link routing (which link the ping sends):** closer-triage link **only** when the
lead's latest cycle is *currently direct* — `became_direct_at` set **AND** `reactive_at`
null (reactivation drops direct status). Else the setter-triage link.
(`form_url_for_lead`.)

---

## Closer outcome derivation — `deriveNewOutcome(call_outcome)`

`funnel-closing.ts`, for `form_type='New'` closer EOC forms:

| Call Outcome | Showed | Closed |
|---|---|---|
| High Ticket Closed | yes | yes (ht) |
| Digital College Closed | yes | yes (dc) |
| **Deposit** | yes | **deposit — its own state, NOT a close** |
| Short-Term Follow Up | short_follow | no |
| Long-Term Follow | long_follow | no |
| DQ / Bad Fit | yes | no |
| Client Ghosted (no show) | no | no |
| Call Rescheduled | reschedule | no |
| Call Cancelled | no | no |

- Aggregate **showed** = `yes` + the two follow-ups. Aggregate **closed** = full closes
  only (**deposit excluded**). Upfront cash sums *include* deposits.
- **Deposit = showed-but-not-closed.** Load-bearing distinction.
- **Old/legacy forms** read legacy `Showed?` / `Closed?` / `Payment Plan Type`. The
  tagger normalizes both via `closer_form_outcome(form_type, call_outcome, showed,
  closed, plan)` (HT unless the plan names DC). Earlier it dropped old-style forms and
  missed a $4,400 HT close — now fixed; read **all** closer forms, not just `New`.

---

## Confirmed (Direct only)

A row in `airtable_setter_triage_calls` with `form_type='Closer Triage Form'` (the
confirmation form, ≈ always Aman) whose `call_status` starts with `"Confirmed"`,
matched by `lead_id`. **No ≥90s call gate** — the form alone decides. A confirmation
form with `call_status='High Ticket booking'` also lights confirm + book.

---

## DQ logic

DQ comes from **forms only** — never from Close `status_label` (intentionally
unused/inaccurate). **A close overrides a DQ:** `isDq = dqLeadIds.has(lead) && !closed`,
on both the roster and the per-lead detail (a lead DQ'd then later closed reads as the
close).

---

## Direct vs setter call typing — from the booking platform (Calendly + OnceHub)

The call type comes from the **booking** (a Calendly event or an OnceHub booking), never
the form. OnceHub **replaces Calendly** going forward; the dashboard reads both additively.

**Calendly** (historical + still live):

- **Direct** = `event_type_uri === DIRECT_BOOKING_EVENT_TYPE_URI`
  (`…/event_types/8f6795d3-992a-4cbd-b584-9ecaabb3938c`, "Ai Partner Strategy Call").
- **Setter-led** = event name starts `"partnership call w/"`.
- **Sync/follow-up** = "AI Partner Sync".
- **Robby DC** = `…/event_types/6f06c6ba-6ca2-48d2-ae17-a6c5c1ee75ec` ("Call with Robby").

Filter closer bookings by `calendly_scheduled_events.name` ILIKE the `CLOSER_EVENT_TYPE_
NAMES` entries — **do not** join `event_type_uri` to `calendly_event_types` (58% of
historical events reference retired URIs).

**OnceHub** (`oncehub_bookings`; classified in `lib/db/oncehub-bookings.ts` + the matching
copy in `shared/lead_tagging.py` — **keep both in sync**):

- **Direct** = `master_page` set (`BP-MVKDFLP85W`, the FB funnel) — checked **FIRST**,
  because a direct booking *also* carries a partnership `booking_page` underneath.
- **Setter-led** = `booking_page` set (`BP-UBK4DVGWFX` Aman / `BP-182H3QCWET` Cobe) with
  `master_page` NULL.
- Internal 1:1 "Meeting with X" calendars dropped; **no OnceHub DC** (phone-based).

Both platforms feed the same downstream logic: the tagger unions OnceHub **direct** bookings
into the lead_cycles "booked" signal (setter rides the triage form, same as Calendly), and
`funnel-closing.ts` / `lead-detail.ts` / `ceo-missing-forms.ts` union OnceHub bookings in
additively (OnceHub's `owner` → the same `closerIdentity` as a Calendly host).

**Setter id→name** (`buildSetterNameResolver`): the new closer form dropped the Setter
Name lookup, so resolve record-id→name by learning every `(record_id, name)` pair from
the closer + triage forms.

---

## Monotonic / cumulative funnel

Each stage is counted once per lead; lanes back-fill (a `showed` implies `connected`,
`booked`). A reactive re-book never adds a second Booked. `reachedStage` is the single
predicate behind both the box count and the roster filter (see `data-model.md` §
Funnel).

---

## The 1000-row PostgREST cap — audit for this

PostgREST `db-max-rows = 1000`. A bare `.range(0, 9999)` **silently truncates to 1000,
no error**. The tell-tale: a *wider* date window returns *fewer* rows. This broke the
funnel (63 opt-ins shown for a period that should have been ~331). Fix: paginate via
`fetchAllPaged<T>(build, label)` (`funnel-appointment-setting.ts`).

**Audit any unpaginated `.select()`** on a table that can exceed 1000 rows:
`close_leads`, `close_calls`, `close_sms`, `lead_cycles`, `calendly_*`, `airtable_*`,
`typeform_responses`. **Known open:** `getLeadCycleRows`' first query
(`lib/db/lead-tags.ts`) is still unpaginated — safe only while in-window cycles < 1000.

---

## Timezone (ADR 0003)

Store **UTC**, render **`America/New_York`**, cohort by **ET calendar day**. Bare dates
can shift back a day (a `2026-05-24 00:58 UTC` opt-in is May 23 20:58 ET → the May-23
cohort). Use `lib/time/est-periods.ts` / `lib/db/funnel-window.ts`; don't hand-roll date
math.

---

## Speed-to-lead — business-hours clock (2026-06-16)

Speed-to-lead = opt-in → first outbound dial, counting **only business-hours time
(10:00–22:00 ET)**, DST-aware (`businessHoursElapsedSec` in `est-periods.ts`). Overnight
waits don't count: a 1am opt-in first dialled at noon is **2h**, not 11h. All called leads
are included (24h cap per lead). This replaced the old wall-clock average + the "< 3h"
overnight-stripping subset. Anchors are `lead_cycles.opt_in_at` / `first_call_at`
(tagger-materialized). Drives the Leads-page box, the per-lead "time to call", and the
`/api/speed-to-lead` endpoint.

## Dial close-cap — reconciled to the tagger's definition (2026-06-12)

The roster's dial cap (`closeTimeIso`) now comes from the **tag** — `lead_cycle_stages.closed_at`
(HT) folded with `lead_cycles.dc_closed_at` (DC), in `getLeadCycleRows` (`lib/db/lead-tags.ts`).
This replaced the legacy `leads.ts` New-form-only cap, which both missed old-format HT closes
(leaking their post-close fulfillment dials) **and** capped at Robby's no-plan "Digital College
Closed" over-marks (which aren't real closes). The tag's definition counts *all* closer forms
incl. old-format, requires a real DC plan, and applies the Robby exclusion — so it caps the
old-format closes and stops capping the over-marks. Net single-digit dial shift, in the
accurate direction. (`closeTimeIso` only feeds the funnel's non-default JS dial-scan path; the
default `sales_funnel_counts` SQL computes its own cap.)

## Known — per-ad opt-in sum < total opt-ins (all ads)

Selecting "All ads" shows a higher opt-in count than the **sum** of the individual ads.
This is **expected, not a bug**: ~1–2% of unique leads have no `ad_id` (organic / direct
— no Meta ad), so they're in the all-ads total but belong to *no* ad bucket. So
`sum(per-ad opt-ins) = total − (no-ad leads)`. If we ever want them to reconcile, add an
explicit "Organic / no ad" bucket to the ad filter. (Verified 2026-06-11: 362 of ~365
in-window leads carry an ad; the rest are organic.)

## Perf — what's been done, and what's left (updated 2026-06-12)

**Done:**
- **All sales data-layer reads parallelized** — the per-lead chunked `.in()` loops and the
  independent table fetches across the roster, cohort spine, closer drill, cash, DC, and
  per-lead detail now fan out concurrently (`lib/db/query-parallel.ts` `fetchChunked` /
  `fetchChunkedPaged`), instead of awaiting one chunk/table at a time. Pagination loops stay
  sequential (termination depends on the prior page count).
- **`PersistPageState` double-fetch killed** — the date window now persists to a server-readable
  cookie (`sd_win`, `lib/db/sales-window-cookie.ts` `resolveSalesWindow`), so the first server
  render of a bare navigation already uses the saved window. No client re-navigation (the "~1s
  filter/time-window catching up").
- **Roster reads from tags** — `getLeadsForRange` defaults to `getLeadsForRangeTags`
  (`lib/db/leads.ts`): the cohort spine (already tag-materialized) + `collapseToLatest(getLeadCycleRows)`
  + ONE 1:1 `close_leads` read (ad / reactivated_at), instead of full Calendly scans,
  the three Airtable form reads, and a post-react `close_calls` scan. (Qualified now comes from
  `lead_cycles.qualified` — Typeform-sourced — not close_leads; see data-model.md § Qualified.)
  Verified byte-identical on every consumed field (display + filter + pages) across 4 windows;
  non-consumed diffs were V1 over-marks the funnel already excluded. Legacy live path kept behind
  `SALES_ROSTER_USE_JS=1` for bake-in.

- **Talent (`/people`) per-rep call activity from SQL** — `getCallActivityMetrics` defaults to
  `getCallActivityMetricsRpc`: the per-rep volume (calls / over90s / distinct-≥90s sessions / name)
  comes from `sales_rep_call_activity` (migration 0082, a `GROUP BY user_id` aggregate) instead of
  paginating every call into Node + JS session-grouping. The form outcomes, matching, family
  attribution, `missing`, DC-credit, and the connected composition (≥90s-OR-form) are unchanged.
  Verified byte-identical on every field across setters/closers/aggregates over 4 windows. Legacy
  full-scan kept behind `SALES_REP_ACTIVITY_USE_JS=1`.

**Left:**
- **Talent form-outcome columns** still read the Airtable forms in JS (the gnarly rep-attribution
  part), and the closer/DC drilldowns read Calendly detail — both smaller than the call-volume scan
  that moved to SQL. The DC-close-credit step does two unwindowed full-table form reads (cheap to
  window-scope later).
- **`force-dynamic` + no caching** — every navigation re-fetches server-side. The tag/SQL layers make
  each fresh render fast natively, so this is low priority.
- **`getAppointmentSettingMetrics`** is dead code (its route was removed) — a cleanup candidate; note
  its `duration>0` connected proxy is *not* the live definition (live = ≥90s-OR-form).

## Cohort vs activity — the mental model

The funnel is an **opt-in-cohort** funnel: a close this week for a lead who opted in
weeks ago does **not** appear in a recent window (intended). Activity-style close metrics
(form-sourced, "what closed this week regardless of opt-in date") live on Talent / Cash,
not on the cohort funnel.
</content>
