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

## Calendly → lead matching precedence

`utm_term` token **first**, then **email** (invitee email → `close_leads.contacts`),
then phone, then name. Used in `leads.ts` `directBooked` and across `funnel-closing.ts`
(`leadKeyOf`, `buildBookedByResolver`, `matchForm`).

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

## Direct vs setter call typing — always from Calendly

The call type comes from the **Calendly event**, never the form:

- **Direct** = `event_type_uri === DIRECT_BOOKING_EVENT_TYPE_URI`
  (`…/event_types/8f6795d3-992a-4cbd-b584-9ecaabb3938c`, "Ai Partner Strategy Call").
- **Setter-led** = event name starts `"partnership call w/"`.
- **Sync/follow-up** = "AI Partner Sync".
- **Robby DC** = `…/event_types/6f06c6ba-6ca2-48d2-ae17-a6c5c1ee75ec` ("Call with Robby").

Filter closer bookings by `calendly_scheduled_events.name` ILIKE the `CLOSER_EVENT_TYPE_
NAMES` entries — **do not** join `event_type_uri` to `calendly_event_types` (58% of
historical events reference retired URIs).

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

## Known inconsistency — dial close-cap (logged 2026-06-12, fix deferred)

`leads.ts` caps a lead's dials at its **New-form** close time (`closeTimeIso`, from
`airtable_full_closer_report` `form_type='New'` HT/DC closes + DC sales, `afterOptIn`).
This **diverges from the tagger's close definition** (`lead_cycle_stages.closed_at`,
which counts *all* closer forms incl. old-format and applies the Robby exclusion). So a
lead that closed via an **old-format** form (e.g. `jkfU9G`, closed 2026-05-29) is **not**
capped by `leads.ts` and its post-close fulfillment dials are counted; conversely
`leads.ts` may cap leads the funnel doesn't count as closed. Net effect is single-digit
dials. **Decision (Drake, 2026-06-12): preserve — the SQL-aggregation rework must
reproduce `leads.ts`'s New-form cap exactly, NOT "fix" it.** When dials are materialized,
reconcile both sides to one close definition (the tagger's) as a deliberate, visible
change.

## Known — per-ad opt-in sum < total opt-ins (all ads)

Selecting "All ads" shows a higher opt-in count than the **sum** of the individual ads.
This is **expected, not a bug**: ~1–2% of unique leads have no `ad_id` (organic / direct
— no Meta ad), so they're in the all-ads total but belong to *no* ad bucket. So
`sum(per-ad opt-ins) = total − (no-ad leads)`. If we ever want them to reconcile, add an
explicit "Organic / no ad" bucket to the ad filter. (Verified 2026-06-11: 362 of ~365
in-window leads carry an ad; the rest are organic.)

## Known perf — remaining slowness after SQL aggregation (logged 2026-06-12)

Navigating funnel → leads / talent still lags ~2s, plus a ~1s "filter/time-window
catching up" after the page appears. Likely causes, in priority order:

1. **`getLeadsForRange` (the roster) is still a JS scan over ~7 tables** (`close_leads`,
   `calendly_*`, `airtable_*`, `close_calls`, `lead_cycles`) — and it's called by **both**
   the funnel page (for the ad-filter options + the rowIds/distinctLeads the funnel
   function needs) and the leads page. This is the biggest remaining bottleneck: Section 1
   sped up the funnel *counting*, but the page still loads this roster every navigation.
   **Next SQL-aggregation target:** have the roster read from the tags (it already
   overrides most fields with tag values — drop the live re-derivation from raw tables).
2. **Talent (`/people`) per-rep metrics** (`getCallActivityMetrics` etc.) still JS-scan.
3. **`PersistPageState` double-fetch:** the page renders with the URL's window, then
   restores the saved window from localStorage on the client → a second navigation/fetch
   (the "time window catching up"). Could restore before first paint, or skip the
   re-fetch when the URL window already matches the saved one.
4. **`force-dynamic` + no caching** — every navigation re-fetches server-side; no reuse
   between visits.

None investigated deeply yet — captured for the next perf pass. The roster (#1) is the
clear first target and the natural Section-3 of the SQL-aggregation arc.

## Cohort vs activity — the mental model

The funnel is an **opt-in-cohort** funnel: a close this week for a lead who opted in
weeks ago does **not** appear in a recent window (intended). Activity-style close metrics
(form-sourced, "what closed this week regardless of opt-in date") live on Talent / Cash,
not on the cohort funnel.
</content>
