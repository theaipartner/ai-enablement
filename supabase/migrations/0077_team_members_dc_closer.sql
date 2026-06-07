-- Digital College closers as first-class team_members.
--
-- The DC (low-ticket) per-rep view previously hardcoded a single closer
-- (Robby) across three constants in lib/db/funnel-digital-college.ts and
-- grouped meetings by the raw closer-name string — which split one person
-- into two rows ("Robby" from the closer-report forms vs "Robby Bryant" from
-- the Calendly/dials path). This migration makes DC closers data-driven off
-- team_members like every other sales rep, so the view resolves by id and the
-- two-row split disappears. Growth-ready: a new DC closer is a row, not a code
-- change.
--
-- Two schema changes + a seed:
--   1. Extend the sales_role CHECK (0052) to allow 'dc_closer'. Parallel to
--      'setter'/'closer'; keeps DC closers OUT of the regular setter/closer
--      call-activity tables (they get their own DC section).
--   2. Add calendly_event_type_uri — the rep's DC sale link, as the Calendly
--      *event-type* URI (what calendly_scheduled_events.event_type_uri holds
--      and the DC query filters on), NOT the human calendly.com/... link.
--   3. Seed the current DC closer(s).
--
-- Values seeded below were confirmed against cloud on 2026-06-07:
--   close_user_id / event_type_uri = the retired hardcoded constants;
--   airtable_user_id = recXX6mvcERLDrrrx (every DC closer-report form Robby
--   filed carries this single closer_record_id).

-- 1. sales_role CHECK: add 'dc_closer'.
ALTER TABLE team_members
  DROP CONSTRAINT team_members_sales_role_check;

ALTER TABLE team_members
  ADD CONSTRAINT team_members_sales_role_check
  CHECK (sales_role IS NULL OR sales_role IN ('setter', 'closer', 'dc_closer', 'other'));

-- 2. Calendly sale-link event-type URI (nullable; DC closers set it).
ALTER TABLE team_members
  ADD COLUMN calendly_event_type_uri text;

-- 3. Seed the two current DC closers. Neither had a team_members row (they
--    were never in the roster, which is why the module was hardcoded).
--    Robby's email is a placeholder (robby@theaipartner.io) — no real address
--    on file yet (Drake 2026-06-07); update when known. Adam's email/
--    event-type URI were confirmed from the Calendly mirror (host
--    adamcasserly@theaipartner.io; event type behind his "Call with Adam"
--    sale link). airtable_user_id values are each closer's closer_record_id
--    from the closer report.
INSERT INTO team_members
  (full_name, email, role, sales_role, close_user_id, airtable_user_id, calendly_event_type_uri)
VALUES
  (
    'Robby Bryant',
    'robby@theaipartner.io',
    'sales',
    'dc_closer',
    'user_rt4533Y5VcOsbso6UMYAUn8sCdtVaKYGYDnWYLvBW2l',
    'recXX6mvcERLDrrrx',
    'https://api.calendly.com/event_types/6f06c6ba-6ca2-48d2-ae17-a6c5c1ee75ec'
  ),
  (
    'Adam Casserly',
    'adamcasserly@theaipartner.io',
    'sales',
    'dc_closer',
    'user_YEYftzDCXfbLrzEfvT1oK8g6HsqPOLxU4WJZj6AB3g9',
    'recAlHpgA8WLWRRf9',
    'https://api.calendly.com/event_types/40f7fd55-a57e-43cb-98d3-197269b49638'
  );
