-- 0082_sales_rep_call_activity_fn.sql
-- Read-only SQL aggregation for the Talent (/people) per-rep call-activity
-- VOLUME, replacing the full close_calls scan + JS session-grouping in
-- getCallActivityMetrics (funnel-appointment-setting.ts). One row per
-- close_calls.user_id over [p_since, p_until):
--
--   total_calls    = every call, ANY duration, ANY direction. The JS volume
--                    scan has NO direction filter — inbound + outbound both
--                    count toward a rep's activity.
--   total_over90s  = calls with duration > 90 (the >90s engagement proxy).
--   total_sessions = distinct lead_id among the >90s calls. Equals the JS
--                    groupCallsIntoSessions with SESSION_GAP_MS = Infinity (all
--                    of a rep's >90s calls to one lead collapse to ONE session).
--                    count(distinct …) ignores null lead_id, matching the JS
--                    `if (r.lead_id)` guard.
--   name_hint      = a raw_payload.user_name for the rep (stable per user_id);
--                    the caller still merges team_members identity on top
--                    (mergeSalesIdentity), so this is only the close_calls hint.
--
-- This is the VOLUME half only. The form outcomes, the form<->call matching, the
-- family attribution, `missing`, and the connected composition
-- (familySessions + familyFormOnly = >=90s-OR-form) all stay in TS. Verified
-- row-for-row against the JS over multiple windows before cut-over.
create or replace function sales_rep_call_activity(
  p_since timestamptz, p_until timestamptz
) returns table (
  user_id text,
  total_calls bigint,
  total_over90s bigint,
  total_sessions bigint,
  name_hint text
) language sql stable as $$
  select c.user_id,
    count(*)                                  as total_calls,
    count(*) filter (where c.duration > 90)   as total_over90s,
    count(distinct c.lead_id)
      filter (where c.duration > 90)          as total_sessions,
    max(c.raw_payload->>'user_name')          as name_hint
  from close_calls c
  where c.activity_at >= p_since
    and c.activity_at <  p_until
    and c.user_id is not null
  group by c.user_id
$$;
