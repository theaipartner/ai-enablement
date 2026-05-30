-- 0062_closer_report_new_form_fields.sql
--
-- The Full Closer Report form was redesigned (~2026-05-30) around a single
-- "Call Outcome" disposition with conditional sub-fields, distinguished from
-- the legacy form by a "Form Type" select (New | Old). Promote the new
-- disposition + plan/payment fields to typed columns so the dashboard can
-- query them directly (showed/closed/rescheduled derive from Call Outcome).
--
-- Everything was already captured in fields_raw; this is purely promotion to
-- typed columns. The long tail (partner info, age, VSL, financing-typo
-- variants, duplicate date fields) intentionally stays in fields_raw and can
-- be promoted later if a surface needs it.
--
-- All columns nullable + additive — old rows simply have NULLs here. The
-- parser (parse_full_closer) is updated in the same change to populate them;
-- a backfill re-parses existing rows from fields_raw.

alter table airtable_full_closer_report
  -- Core disposition (the new form's spine)
  add column if not exists form_type text,                 -- 'New' | 'Old' — new-vs-legacy filter
  add column if not exists call_outcome text,              -- the single disposition (Call Rescheduled / Call Cancelled / Client Ghosted (no show) / Deposit / Short-Term Follow Up / Long-Term Follow / Digital College Closed / High Ticket Closed / DQ / Bad Fit)
  add column if not exists cancel_reason text,             -- 'Reason' — Closer cancelled | Prospect un-interested (Call Cancelled branch)

  -- Close detail
  add column if not exists digital_college_closed text,    -- 'Digital College Closed' Yes/No
  add column if not exists dc_plans text[],                -- 'What plan did we get them on? (select multiple)' — Base/Wix × Monthly/Yearly
  add column if not exists normal_plan text,               -- 'Select normal plan' — $4k x 2 / $3k x 3 / $2k x 4 (High Ticket branch)
  add column if not exists payment_type text,              -- 'What type of payment was it?' — Deposit | Paid In Full
  add column if not exists payments_same_date text,        -- 'Will all payment be made on same date of each month?' Yes/No
  add column if not exists creative_plan_months text,      -- 'How many monthly payments will there be? (creative plan)' 1-5

  -- Money
  add column if not exists deposit_topup_amount numeric,   -- 'How much to collect on top of this deposit to get them started?' currency
  add column if not exists contract_amount_to_send numeric,-- 'What contract amount should be sent to the client?' number

  -- Dates
  add column if not exists follow_up_date date,            -- 'Follow Up Date?'
  add column if not exists likely_start_date date,         -- 'What's their likely start date?'

  -- Payment schedule (1st–5th installment)
  add column if not exists payment_1_amount numeric,
  add column if not exists payment_1_date date,
  add column if not exists payment_2_amount numeric,
  add column if not exists payment_2_date date,
  add column if not exists payment_3_amount numeric,
  add column if not exists payment_3_date date,
  add column if not exists payment_4_amount numeric,
  add column if not exists payment_4_date date,
  add column if not exists payment_5_amount numeric,
  add column if not exists payment_5_date date;

comment on column airtable_full_closer_report.form_type is
  'New | Old — distinguishes the redesigned single-disposition form from the legacy Showed?/Closed? form. Dashboard reads Call Outcome on New rows, falls back to showed/closed on Old.';
comment on column airtable_full_closer_report.call_outcome is
  'The new form''s single disposition. Drives showed/closed/rescheduled: closed = High Ticket Closed | Digital College Closed; showed = those + Deposit + Short-Term/Long-Term Follow + DQ/Bad Fit; Client Ghosted (no show) = not showed; Call Rescheduled = own bucket; Call Cancelled = not showed.';
