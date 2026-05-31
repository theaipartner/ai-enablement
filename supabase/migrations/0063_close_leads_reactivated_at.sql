-- 0063_close_leads_reactivated_at.sql
--
-- Persistent reactivation tag on close_leads.
--
-- A direct-booking lead (one that booked an Ai Partner Strategy Call)
-- becomes "reactivated" the moment it definitively loses that strategy-call
-- spot: a setter handover (Closer Triage / confirmation form call_status =
-- 'Setter pipeline' or 'DQ'), OR its first closer EOC form (the strategy
-- meeting's outcome) reads DQ / Cancelled / Ghosted / Rescheduled — AND it
-- then stays without an active future strategy booking for >3h (the grace
-- window that absorbs a reschedule's cancel→recreate gap, so a drag-dropped
-- reschedule does NOT trigger).
--
-- Set ONCE and never cleared (permanent status). reactivated_at = the
-- triggering event's airtable_created_at (the loss moment). The sales
-- dashboard reads it to (a) classify the lead into the reactivation funnel
-- and (b) scope that funnel's activity (dials / connected / books / shows /
-- closes) to AFTER this timestamp. null = never reactivated.
--
-- Populated by scripts/backfill_reactivated_at.py and maintained going
-- forward by the Airtable ingestion cron pass (set-once, only where null).

alter table close_leads
  add column if not exists reactivated_at timestamptz;

comment on column close_leads.reactivated_at is
  'When a direct-booking lead lost its strategy-call spot and moved to the setter pipeline (confirmation form Setter pipeline / DQ, or first closer EOC form DQ / Cancelled / Ghosted / Rescheduled, with no active future strat booking for >3h after). Set once, permanent. null = never reactivated. Drives the sales-dashboard reactivation funnel + its post-handover activity scoping.';
