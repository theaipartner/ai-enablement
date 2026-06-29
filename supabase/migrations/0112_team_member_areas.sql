-- 0112_team_member_areas.sql
-- Separate Gregory by DEPARTMENT, not just access tier. Until now access was
-- only by tier (csm/head_csm/admin/creator): the sales dashboard required admin,
-- so sales REPS (csm tier) couldn't see it at all, while admins saw everything.
-- Add an orthogonal `areas` axis — which departments a person sees — so sales
-- reps get Sales and fulfillment staff get Fulfillment, independently of tier
-- (tier still gates seniority within an area: cost-hub/CEO = admin, /teams = head_csm).
--
-- areas is a text[] (like is_active, flip it with one SQL update, no deploy).
-- Values today: 'fulfillment', 'sales' (extensible). CEO/Content/Tasks stay
-- tier-gated leadership surfaces.

alter table team_members
  add column if not exists areas text[] not null default array['fulfillment'];

comment on column team_members.areas is
  'Departments this person can access in Gregory: subset of {fulfillment, sales}. Orthogonal to access_tier (which gates seniority within an area). Drives the top-nav + the (fulfillment)/(sales) layout gates. Default fulfillment; sales reps get [sales]. Flip with a SQL update — no deploy.';

-- Backfill from the current role/tier (STRICT separation). The "all pages"
-- group (both areas + admin/creator tier) is exactly Drake, Nabeel, Zain, Huzaifa:
--   creator (Drake)                      -> both
--   leadership + admin (Nabeel)          -> both
--   ops + admin (Zain, Huzaifa)          -> both
--   role='sales'                         -> [sales] only
--   everyone else (csm/ops, e.g. Ellis,  -> [fulfillment]
--     Nico, Lou, Scott Wilson)
-- Sentinels (Gregory Bot, Scott Chasing) never log in — left at the default.
update team_members
set areas = case
  when access_tier = 'creator' then array['fulfillment', 'sales']
  when role = 'leadership' and access_tier = 'admin' then array['fulfillment', 'sales']
  when role = 'ops' and access_tier = 'admin' then array['fulfillment', 'sales']
  when role = 'sales' then array['sales']
  else array['fulfillment']
end
where archived_at is null
  and coalesce(metadata->>'sentinel', 'false') <> 'true';

-- Sales reps should not hold admin tier (admin gates CEO/Content/cost-hub).
-- Aman is the only sales+admin today — reduce him to csm (he keeps Sales via area).
update team_members
set access_tier = 'csm'
where role = 'sales' and access_tier = 'admin' and archived_at is null;

create index if not exists ix_team_members_areas on team_members using gin (areas);
