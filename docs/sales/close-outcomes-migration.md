# Close-native call outcomes — SHELVED (plan-blocked)

**Status:** SHELVED 2026-06-12. Blocked on cost, not on feasibility. Revisit **only**
if Close is upgraded to the Growth plan.

## The problem this was solving

Setter/closer outcome data lives in free-floating **Airtable** forms that have no
pointer back to the specific call/meeting they describe. Tying a form to its call is
done by heuristic matching (±48h window + rep-typed call time), which is **unreliable
at the per-lead level** — the rep-typed `date_time_of_call` is only ~37% within an hour
of the real meeting and ~15% off by >24h. Good enough for aggregate metrics, not for
"every lead's lifecycle reads correctly." See [[logic.md]] for the current matcher.

## What we found (the design, preserved for if/when this is revisited)

- **Setter side is a pure disposition.** The *only* field the dashboard surfaces from
  both setter-side Airtable forms is `call_status` (one disposition). Every other column
  is legacy/0%-populated. So the setter capture maps perfectly onto a **native Close
  Outcome** — a disposition picked from a fixed list that lives **on the call itself**
  (`outcome_id`), so there is **nothing to match**. Verified on a real call: `outcome_id`
  sits on the call object alongside `id` and `lead_id`; a delayed fill is just a later
  edit to the same call. Close also natively logs `transferred_to_user_id` (live
  transfers) and `parent_meeting_id`.
- **Unified outcome list** (setter + confirmation collapsed — locked with Drake):
  High Ticket booking · Digital College booking · Confirmed Booking · Confirmed Booking –
  New Time · Setter pipeline / Follow up · **Live Handoff** · Downsold · DQ / Un-interested.
  (No No-Show / Cancelled — No-Show folds into Setter pipeline; Cancelled re-queues.)
- **Booking state — not caller role — decides confirmation vs triage.** A call is a
  *confirmation* if the lead is directly booked to a closer in Calendly; otherwise it's
  *triage*. Closers sometimes work pipeline and setters sometimes confirm, so caller role
  is unreliable; `form_type` becomes redundant.
- **Closer side needs more than a label** (amount/plan/payment) → would require a Close
  **Custom Activity** (lead-bound, no `call_id`), accepting a light lead+time join — but
  closer calls are usually Calendly-booked, so they have an anchor anyway.
- **Transition plan:** dual-acceptance (read the Close outcome if present, else the
  Airtable form) during cutover so a forgotten entry never blanks the dashboard.
- **Ingestion:** the `activity.call` webhook carries `id` + `lead_id` + `outcome_id`
  together → mirror `outcome_id` onto `close_calls` + map id→name. Small build; the
  `close_calls` mirror and webhook already exist.

## Why it's blocked

Both **Call Outcomes** and **Custom Activities** require Close's **Growth plan**
(~$99/user/month annual). Org `AI Partner` is on a lower tier, and the upgrade is not
approved. Un-gated alternatives don't solve the core problem: lead-level custom fields
are lead-bound + single-latest-value (no better than Airtable for call-binding), and
call notes are unstructured.

## Free fallback if we ever want better matching without Close

Tighten the **deterministic** Airtable matcher instead of the current ±48h/newest-wins:
anchor on the **Calendly meeting** (system-generated truth), pair forms to meetings by
`lead_id` + rep identity + **sequence** (1st form ↔ 1st meeting), using the rep-typed
time only as a tiebreak, and **flag** anything unresolved for review rather than guessing.
Gets "good for aggregates, mostly-right per-lead." Not urgent; not the current priority.
</content>
