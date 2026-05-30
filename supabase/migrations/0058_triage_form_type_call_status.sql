-- 0058_triage_form_type_call_status.sql
--
-- The Triage Calls EOC Airtable form (tblaoMsiE3FSkHjQt →
-- airtable_setter_triage_calls) was restructured ~2026-05-26: it is now
-- ONE form with a `Form Type` discriminator (Setter Triage Form |
-- Closer Triage Form) and a single shared `Call Status` outcome field.
-- The prior `Setter Status` / `Closer Status` fields (migration 0055)
-- and the older `Booking Status` no longer exist on the Airtable side,
-- so `setter_status` / `closer_status` / `booking_status` stop being
-- populated for forms filed on/after the change.
--
-- This migration adds the two new typed columns. The new fields
-- `Showed %`, `No Show %`, `Booked with Closer?`, `Booked At`,
-- `Confirmed Call Date&Time` already have columns on this table
-- (showed_pct, no_show_pct, booked_with_closer, booked_at,
-- confirmed_call_date_time), so only form_type + call_status are new.
--
-- Discovery + Call Status option set: docs/schema/airtable_setter_triage_calls.md.
-- The old setter_status/closer_status columns are LEFT in place
-- (pre-2026-05-26 rows reference them; harmless, just no longer written).

alter table airtable_setter_triage_calls
  add column if not exists form_type text,
  add column if not exists call_status text;

comment on column airtable_setter_triage_calls.form_type is
  'Airtable "Form Type" discriminator (introduced ~2026-05-26): ''Setter Triage Form'' | ''Closer Triage Form''. Routes the row to the setter vs closer per-rep list. Null for pre-2026-05-26 forms.';

comment on column airtable_setter_triage_calls.call_status is
  'Airtable "Call Status" — the triage outcome, shared by both form types. Values: High Ticket booking, Digital College booking, Confirmed Booking, Confirmed Booking – New Time, Setter pipeline / Follow up, Downsold, Unresponsive – Setter Handover, DQ / Un-interested. Supersedes setter_status/closer_status as of the 2026-05-26 form redesign.';

-- Filtering the per-rep aggregation by form_type is a small in-window
-- scan; the existing airtable_created_at index covers the time bound.
