-- 0055_airtable_setter_closer_status.sql
--
-- Split the single `booking_status` field on airtable_setter_triage_calls
-- into two parallel dropdowns reflecting Airtable's 2026-05-27 form
-- redesign: a "Setter Status" field filled by setters, and a "Closer
-- Status" field filled by closers. They are mutually exclusive on a
-- given form (one row carries one or the other, not both).
--
-- booking_status stays in place as-is — Aman's pre-redesign forms
-- referenced it as the single source of truth, and the per-rep tables
-- now render those rows as "NA" rather than back-classifying.
--
-- Both new columns are nullable and have no default. Ingestion writes
-- them; backfill is not required (old rows = old form, intentionally
-- NA in the new UI).
--
-- Setter Status values (new column):
--   - 'Confirmed HT Booking'   → HT Book column
--   - 'Confirmed DC Booking'   → DC Book column
--   - 'DQ'                     → DQ column
--   - 'Follow up'              → Follow-up column
--   - 'Reconfirm'              → Reconfirms column
--
-- Closer Status values (new column):
--   - 'Confirmed Book'         → Confirmed Book column
--   - 'Reschedule'             → Reschedule column
--   - 'Downsell (on call)'     → Downsell column
--   - 'Hand to Setter list'    → Hand down column
--   - 'DQ'                     → DQ column

alter table airtable_setter_triage_calls
  add column if not exists setter_status text,
  add column if not exists closer_status text;

comment on column airtable_setter_triage_calls.setter_status is
  'Setter-filled EOC outcome (Airtable "Setter Status" field, introduced 2026-05-27). Values: Confirmed HT Booking, Confirmed DC Booking, DQ, Follow up, Reconfirm. Null for forms predating this field or filled by closers.';

comment on column airtable_setter_triage_calls.closer_status is
  'Closer-filled EOC outcome (Airtable "Closer Status" field, introduced 2026-05-27). Values: Confirmed Book, Reschedule, Downsell (on call), Hand to Setter list, DQ. Null for forms predating this field or filled by setters.';
