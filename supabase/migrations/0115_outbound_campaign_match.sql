-- 0115_outbound_campaign_match.sql
-- Generalize outbound campaigns to a source-agnostic (custom-field name, value)
-- match across BOTH Close and GHL, and re-source the funnel to compute facts from
-- the GHL mirror as well as Close. This is Phase 2/3 of the GHL outbound move.
--
-- The model (Drake): an outbound campaign is defined by a custom-field NAME + an
-- exact VALUE. A lead belongs to the campaign if it carries that (field -> value)
-- pair — checked against the Close mirror (close_leads.custom_fields_raw, name
-- resolved via close_custom_field_definitions) AND the GHL mirror
-- (ghl_contacts.custom_fields, name resolved via ghl_custom_field_definitions).
-- Campaigns are INDEPENDENT: a lead matching two campaigns is counted in both
-- (double-counting is wanted) — so the new model applies NO exclusivity.
--
-- The two finished legacy pools (Revival, Jacob) are UNCHANGED: they keep their
-- close_cf_id + the sort_order exclusivity (migration 0103). A campaign is
-- "legacy" iff match_field_name IS NULL. The admin adder only manages new-model
-- campaigns; legacy rows are read-only.
--
-- Connected (GHL) = a TYPE_CALL with call_status='completed' AND call_duration>=90
-- (parity with Close's >=90s, tightened to drop long voicemail recordings).
-- Closes/cash stay in Airtable for both sources, joined on lead_id = the lead's
-- native id (close_id, or the GHL contact id == its EOC-From Airtable Lead ID).

-- ---------------------------------------------------------------------------
-- 1. GHL custom-field definitions (name -> id) so the SQL match can resolve a
--    field NAME to the id stored in ghl_contacts.custom_fields. Populated by the
--    GHL sync (ingestion/ghl/pipeline.sync_custom_field_definitions).
-- ---------------------------------------------------------------------------
create table if not exists ghl_custom_field_definitions (
  id           text primary key,        -- GHL custom-field id
  location_id  text,
  name         text,                     -- human name (e.g. "EOC From")
  field_key    text,                     -- e.g. contact.eoc_from
  data_type    text,
  raw          jsonb not null default '{}'::jsonb,
  synced_at    timestamptz not null default now()
);
create index if not exists ix_ghl_cf_defs_name on ghl_custom_field_definitions (name);

comment on table ghl_custom_field_definitions is
  'GHL custom-field definitions (id -> name/field_key). Lets refresh_outbound_facts resolve a campaign match_field_name to the id stored in ghl_contacts.custom_fields. Populated by the GHL sync.';
alter table ghl_custom_field_definitions enable row level security;

-- ---------------------------------------------------------------------------
-- 2. GHL user id on team_members so the by-rep block attributes GHL calls
--    (ghl_messages.user_id) to a named rep, the way close_user_id does for Close.
-- ---------------------------------------------------------------------------
alter table team_members add column if not exists ghl_user_id text;
comment on column team_members.ghl_user_id is
  'GHL (GoHighLevel) user id. Maps ghl_messages.user_id (the rep on a call) to this team member for the Outbound by-rep block. Synced from GHL users by email.';

-- ---------------------------------------------------------------------------
-- 3. The source-agnostic match on outbound_campaigns. Legacy rows keep
--    close_cf_id and leave these NULL; new-model rows set both.
-- ---------------------------------------------------------------------------
alter table outbound_campaigns add column if not exists match_field_name text;
alter table outbound_campaigns add column if not exists match_value text;
-- New-model campaigns have no close_cf_id (they match by name+value), so the
-- original NOT NULL must go. Legacy rows keep their close_cf_id.
alter table outbound_campaigns alter column close_cf_id drop not null;
comment on column outbound_campaigns.match_field_name is
  'New-model campaigns: the custom-field NAME to match (resolved to a Close cf id and/or a GHL field id). NULL = a legacy close_cf_id campaign.';
comment on column outbound_campaigns.match_value is
  'New-model campaigns: the exact custom-field value a lead must carry to belong.';

-- ---------------------------------------------------------------------------
-- 4. refresh_outbound_facts — branch on legacy vs new-model.
-- ---------------------------------------------------------------------------
create or replace function refresh_outbound_facts(p_campaign_key text default 'revival')
returns int language plpgsql as $$
declare
  v_cf text; v_floor timestamptz; v_sort int;
  v_field_name text; v_value text;
  v_close_fid text; v_ghl_fid text;
  v_count int := 0; v_n int;
begin
  select close_cf_id, floor_at, sort_order, match_field_name, match_value
    into v_cf, v_floor, v_sort, v_field_name, v_value
    from outbound_campaigns where key = p_campaign_key;
  if not found then raise exception 'unknown outbound campaign: %', p_campaign_key; end if;

  delete from outbound_lead_facts where campaign_key = p_campaign_key;

  -- =========================================================================
  -- LEGACY (Close-only, exclusivity) — unchanged from migration 0103.
  -- =========================================================================
  if v_field_name is null then
    if v_cf is null then raise exception 'legacy campaign % has no close_cf_id', p_campaign_key; end if;
    insert into outbound_lead_facts (
      campaign_key, close_id, anchor, first_reply, has_inbound, any_call, call90, first_dial,
      booked, booked_dc, booked_ht, showed, closed,
      plan_units, base44_monthly, base44_yearly, wix_monthly, wix_yearly, marked_no_plan,
      reply_bucket, dial_bucket, conn_bucket, updated_at)
    with leads as (
      select cl.close_id, greatest(cl.date_created, v_floor) as anchor
      from close_leads cl
      where cl.excluded_at is null
        and cl.custom_fields_raw ? v_cf
        and nullif(trim(cl.custom_fields_raw ->> v_cf), '') is not null
        -- Mutual exclusivity: drop leads owned by a more specific (higher
        -- sort_order) active legacy campaign. (Migration 0103, unchanged.)
        and not exists (
          select 1 from outbound_campaigns oc
          where oc.is_active and oc.sort_order > v_sort
            and oc.close_cf_id is not null
            and cl.custom_fields_raw ? oc.close_cf_id
            and nullif(trim(cl.custom_fields_raw ->> oc.close_cf_id), '') is not null
        )
    ),
    sms as (
      select l.close_id,
        min(s.activity_at) filter (where s.direction='inbound') as first_reply,
        bool_or(s.direction='inbound') as has_inbound
      from leads l join close_sms s on s.lead_id=l.close_id and s.activity_at >= l.anchor
      group by l.close_id
    ),
    calls as (
      select l.close_id, true as any_call, bool_or(c.duration>=90) as call90,
        min(c.activity_at) as earliest_call,
        min(c.activity_at) filter (where c.duration>=90) as earliest_call90,
        min(c.activity_at) filter (where c.direction='outbound'
             and sm.first_reply is not null and c.activity_at >= sm.first_reply) as first_dial
      from leads l join close_calls c on c.lead_id=l.close_id and c.activity_at >= l.anchor
      left join sms sm on sm.close_id=l.close_id
      group by l.close_id
    ),
    triage as (
      select l.close_id,
        bool_or(lower(t.call_status) like '%booking%') as booked,
        bool_or(lower(t.call_status) like '%digital college booking%') as booked_dc,
        bool_or(lower(t.call_status) like '%high ticket booking%') as booked_ht
      from leads l join airtable_setter_triage_calls t on t.lead_id=l.close_id
        and t.excluded_at is null and t.airtable_created_at >= l.anchor
      group by l.close_id
    ),
    cforms as (
      select l.close_id, f.dc_plans,
        case when f.form_type='New'
          then (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p)<>'') > 0
          else lower(coalesce(f.closed,''))='yes' and lower(coalesce(f.payment_plan_type,'')) ~ 'base|wix|digital college'
        end as is_close,
        case when f.form_type='New'
          then coalesce(f.call_outcome,'')<>'' and lower(f.call_outcome) !~ 'ghost|no show|reschedul|cancel'
          else lower(coalesce(f.showed,''))='yes'
        end as is_showed,
        (f.form_type='New'
          and (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p)<>'') = 0
          and lower(coalesce(f.call_outcome,'')) like '%digital college%') as marked_no_plan
      from leads l join airtable_full_closer_report f on f.lead_id=l.close_id and f.airtable_created_at >= l.anchor
    ),
    closer as (
      select close_id, bool_or(is_showed) as showed, bool_or(is_close) as closed,
        count(*) filter (where marked_no_plan) as marked_no_plan
      from cforms group by close_id
    ),
    plan_per_lead as (
      select cf.close_id,
        sum((lower(p) like '%base%' and lower(p) like '%month%')::int) as b44m,
        sum((lower(p) like '%base%' and (lower(p) like '%year%' or lower(p) like '%annual%'))::int) as b44y,
        sum((lower(p) like '%wix%'  and lower(p) like '%month%')::int) as wixm,
        sum((lower(p) like '%wix%'  and (lower(p) like '%year%' or lower(p) like '%annual%'))::int) as wixy
      from cforms cf cross join lateral unnest(coalesce(cf.dc_plans,'{}'::text[])) p
      where cf.is_close group by cf.close_id
    )
    select p_campaign_key, l.close_id, l.anchor,
      sm.first_reply, coalesce(sm.has_inbound,false),
      coalesce(ca.any_call,false), coalesce(ca.call90,false), ca.first_dial,
      coalesce(tr.booked,false), coalesce(tr.booked_dc,false), coalesce(tr.booked_ht,false),
      coalesce(cl.showed,false), coalesce(cl.closed,false),
      coalesce(pp.b44m,0)+coalesce(pp.b44y,0)+coalesce(pp.wixm,0)+coalesce(pp.wixy,0),
      coalesce(pp.b44m,0), coalesce(pp.b44y,0), coalesce(pp.wixm,0), coalesce(pp.wixy,0),
      coalesce(cl.marked_no_plan,0),
      case when sm.first_reply is not null then floor(extract(hour from (sm.first_reply at time zone 'America/New_York'))/2)::smallint end,
      case when ca.first_dial is not null then floor(extract(hour from (ca.first_dial at time zone 'America/New_York'))/2)::smallint end,
      case when coalesce(ca.call90,false) then floor(extract(hour from (coalesce(ca.earliest_call90, ca.earliest_call) at time zone 'America/New_York'))/2)::smallint end,
      now()
    from leads l
    left join sms sm on sm.close_id=l.close_id
    left join calls ca on ca.close_id=l.close_id
    left join triage tr on tr.close_id=l.close_id
    left join closer cl on cl.close_id=l.close_id
    left join plan_per_lead pp on pp.close_id=l.close_id;
    get diagnostics v_n = row_count; v_count := v_count + v_n;
    return v_count;
  end if;

  -- =========================================================================
  -- NEW MODEL — exact (field,value) match across Close + GHL, NO exclusivity.
  -- =========================================================================
  select close_id into v_close_fid from close_custom_field_definitions
    where name = v_field_name order by close_id limit 1;
  select id into v_ghl_fid from ghl_custom_field_definitions
    where name = v_field_name order by id limit 1;

  -- ---- Close arm ----
  if v_close_fid is not null then
    insert into outbound_lead_facts (
      campaign_key, close_id, anchor, first_reply, has_inbound, any_call, call90, first_dial,
      booked, booked_dc, booked_ht, showed, closed,
      plan_units, base44_monthly, base44_yearly, wix_monthly, wix_yearly, marked_no_plan,
      reply_bucket, dial_bucket, conn_bucket, updated_at)
    with leads as (
      select cl.close_id, greatest(cl.date_created, v_floor) as anchor
      from close_leads cl
      where cl.excluded_at is null
        and (
          cl.custom_fields_raw ->> v_close_fid = v_value
          or (jsonb_typeof(cl.custom_fields_raw -> v_close_fid) = 'array'
              and cl.custom_fields_raw -> v_close_fid ? v_value)
        )
    ),
    sms as (
      select l.close_id,
        min(s.activity_at) filter (where s.direction='inbound') as first_reply,
        bool_or(s.direction='inbound') as has_inbound
      from leads l join close_sms s on s.lead_id=l.close_id and s.activity_at >= l.anchor
      group by l.close_id
    ),
    calls as (
      select l.close_id, true as any_call, bool_or(c.duration>=90) as call90,
        min(c.activity_at) as earliest_call,
        min(c.activity_at) filter (where c.duration>=90) as earliest_call90,
        min(c.activity_at) filter (where c.direction='outbound'
             and sm.first_reply is not null and c.activity_at >= sm.first_reply) as first_dial
      from leads l join close_calls c on c.lead_id=l.close_id and c.activity_at >= l.anchor
      left join sms sm on sm.close_id=l.close_id
      group by l.close_id
    ),
    triage as (
      select l.close_id,
        bool_or(lower(t.call_status) like '%booking%') as booked,
        bool_or(lower(t.call_status) like '%digital college booking%') as booked_dc,
        bool_or(lower(t.call_status) like '%high ticket booking%') as booked_ht
      from leads l join airtable_setter_triage_calls t on t.lead_id=l.close_id
        and t.excluded_at is null and t.airtable_created_at >= l.anchor
      group by l.close_id
    ),
    cforms as (
      select l.close_id, f.dc_plans,
        case when f.form_type='New'
          then (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p)<>'') > 0
          else lower(coalesce(f.closed,''))='yes' and lower(coalesce(f.payment_plan_type,'')) ~ 'base|wix|digital college'
        end as is_close,
        case when f.form_type='New'
          then coalesce(f.call_outcome,'')<>'' and lower(f.call_outcome) !~ 'ghost|no show|reschedul|cancel'
          else lower(coalesce(f.showed,''))='yes'
        end as is_showed,
        (f.form_type='New'
          and (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p)<>'') = 0
          and lower(coalesce(f.call_outcome,'')) like '%digital college%') as marked_no_plan
      from leads l join airtable_full_closer_report f on f.lead_id=l.close_id and f.airtable_created_at >= l.anchor
    ),
    closer as (
      select close_id, bool_or(is_showed) as showed, bool_or(is_close) as closed,
        count(*) filter (where marked_no_plan) as marked_no_plan
      from cforms group by close_id
    ),
    plan_per_lead as (
      select cf.close_id,
        sum((lower(p) like '%base%' and lower(p) like '%month%')::int) as b44m,
        sum((lower(p) like '%base%' and (lower(p) like '%year%' or lower(p) like '%annual%'))::int) as b44y,
        sum((lower(p) like '%wix%'  and lower(p) like '%month%')::int) as wixm,
        sum((lower(p) like '%wix%'  and (lower(p) like '%year%' or lower(p) like '%annual%'))::int) as wixy
      from cforms cf cross join lateral unnest(coalesce(cf.dc_plans,'{}'::text[])) p
      where cf.is_close group by cf.close_id
    )
    select p_campaign_key, l.close_id, l.anchor,
      sm.first_reply, coalesce(sm.has_inbound,false),
      coalesce(ca.any_call,false), coalesce(ca.call90,false), ca.first_dial,
      coalesce(tr.booked,false), coalesce(tr.booked_dc,false), coalesce(tr.booked_ht,false),
      coalesce(cl.showed,false), coalesce(cl.closed,false),
      coalesce(pp.b44m,0)+coalesce(pp.b44y,0)+coalesce(pp.wixm,0)+coalesce(pp.wixy,0),
      coalesce(pp.b44m,0), coalesce(pp.b44y,0), coalesce(pp.wixm,0), coalesce(pp.wixy,0),
      coalesce(cl.marked_no_plan,0),
      case when sm.first_reply is not null then floor(extract(hour from (sm.first_reply at time zone 'America/New_York'))/2)::smallint end,
      case when ca.first_dial is not null then floor(extract(hour from (ca.first_dial at time zone 'America/New_York'))/2)::smallint end,
      case when coalesce(ca.call90,false) then floor(extract(hour from (coalesce(ca.earliest_call90, ca.earliest_call) at time zone 'America/New_York'))/2)::smallint end,
      now()
    from leads l
    left join sms sm on sm.close_id=l.close_id
    left join calls ca on ca.close_id=l.close_id
    left join triage tr on tr.close_id=l.close_id
    left join closer cl on cl.close_id=l.close_id
    left join plan_per_lead pp on pp.close_id=l.close_id;
    get diagnostics v_n = row_count; v_count := v_count + v_n;
  end if;

  -- ---- GHL arm ----
  if v_ghl_fid is not null then
    insert into outbound_lead_facts (
      campaign_key, close_id, anchor, first_reply, has_inbound, any_call, call90, first_dial,
      booked, booked_dc, booked_ht, showed, closed,
      plan_units, base44_monthly, base44_yearly, wix_monthly, wix_yearly, marked_no_plan,
      reply_bucket, dial_bucket, conn_bucket, updated_at)
    with leads as (
      select gc.id as close_id, greatest(gc.date_added, v_floor) as anchor
      from ghl_contacts gc
      where exists (
        select 1 from jsonb_array_elements(gc.custom_fields) e
        where e->>'id' = v_ghl_fid and e->>'value' = v_value
      )
    ),
    sms as (
      select l.close_id,
        min(m.date_added) filter (where m.direction='inbound') as first_reply,
        bool_or(m.direction='inbound') as has_inbound
      from leads l join ghl_messages m on m.contact_id=l.close_id
        and m.message_type='TYPE_SMS' and m.date_added >= l.anchor
      group by l.close_id
    ),
    calls as (
      select l.close_id, true as any_call,
        bool_or(c.call_status='completed' and c.call_duration>=90) as call90,
        min(c.date_added) as earliest_call,
        min(c.date_added) filter (where c.call_status='completed' and c.call_duration>=90) as earliest_call90,
        min(c.date_added) filter (where c.direction='outbound'
             and sm.first_reply is not null and c.date_added >= sm.first_reply) as first_dial
      from leads l join ghl_messages c on c.contact_id=l.close_id
        and c.message_type='TYPE_CALL' and c.date_added >= l.anchor
      left join sms sm on sm.close_id=l.close_id
      group by l.close_id
    ),
    triage as (
      select l.close_id,
        bool_or(lower(t.call_status) like '%booking%') as booked,
        bool_or(lower(t.call_status) like '%digital college booking%') as booked_dc,
        bool_or(lower(t.call_status) like '%high ticket booking%') as booked_ht
      from leads l join airtable_setter_triage_calls t on t.lead_id=l.close_id
        and t.excluded_at is null and t.airtable_created_at >= l.anchor
      group by l.close_id
    ),
    cforms as (
      select l.close_id, f.dc_plans,
        case when f.form_type='New'
          then (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p)<>'') > 0
          else lower(coalesce(f.closed,''))='yes' and lower(coalesce(f.payment_plan_type,'')) ~ 'base|wix|digital college'
        end as is_close,
        case when f.form_type='New'
          then coalesce(f.call_outcome,'')<>'' and lower(f.call_outcome) !~ 'ghost|no show|reschedul|cancel'
          else lower(coalesce(f.showed,''))='yes'
        end as is_showed,
        (f.form_type='New'
          and (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p)<>'') = 0
          and lower(coalesce(f.call_outcome,'')) like '%digital college%') as marked_no_plan
      from leads l join airtable_full_closer_report f on f.lead_id=l.close_id and f.airtable_created_at >= l.anchor
    ),
    closer as (
      select close_id, bool_or(is_showed) as showed, bool_or(is_close) as closed,
        count(*) filter (where marked_no_plan) as marked_no_plan
      from cforms group by close_id
    ),
    plan_per_lead as (
      select cf.close_id,
        sum((lower(p) like '%base%' and lower(p) like '%month%')::int) as b44m,
        sum((lower(p) like '%base%' and (lower(p) like '%year%' or lower(p) like '%annual%'))::int) as b44y,
        sum((lower(p) like '%wix%'  and lower(p) like '%month%')::int) as wixm,
        sum((lower(p) like '%wix%'  and (lower(p) like '%year%' or lower(p) like '%annual%'))::int) as wixy
      from cforms cf cross join lateral unnest(coalesce(cf.dc_plans,'{}'::text[])) p
      where cf.is_close group by cf.close_id
    )
    select p_campaign_key, l.close_id, l.anchor,
      sm.first_reply, coalesce(sm.has_inbound,false),
      coalesce(ca.any_call,false), coalesce(ca.call90,false), ca.first_dial,
      coalesce(tr.booked,false), coalesce(tr.booked_dc,false), coalesce(tr.booked_ht,false),
      coalesce(cl.showed,false), coalesce(cl.closed,false),
      coalesce(pp.b44m,0)+coalesce(pp.b44y,0)+coalesce(pp.wixm,0)+coalesce(pp.wixy,0),
      coalesce(pp.b44m,0), coalesce(pp.b44y,0), coalesce(pp.wixm,0), coalesce(pp.wixy,0),
      coalesce(cl.marked_no_plan,0),
      case when sm.first_reply is not null then floor(extract(hour from (sm.first_reply at time zone 'America/New_York'))/2)::smallint end,
      case when ca.first_dial is not null then floor(extract(hour from (ca.first_dial at time zone 'America/New_York'))/2)::smallint end,
      case when coalesce(ca.call90,false) then floor(extract(hour from (coalesce(ca.earliest_call90, ca.earliest_call) at time zone 'America/New_York'))/2)::smallint end,
      now()
    from leads l
    left join sms sm on sm.close_id=l.close_id
    left join calls ca on ca.close_id=l.close_id
    left join triage tr on tr.close_id=l.close_id
    left join closer cl on cl.close_id=l.close_id
    left join plan_per_lead pp on pp.close_id=l.close_id;
    get diagnostics v_n = row_count; v_count := v_count + v_n;
  end if;

  return v_count;
end $$;

-- ---------------------------------------------------------------------------
-- 5. outbound_funnel_by_rep — add a GHL call arm (ghl_messages -> ghl_user_id).
--    Closes are already source-agnostic (Airtable joined on the lead's native
--    id, which is the GHL contact id for GHL leads). Legacy campaigns are
--    unaffected: their leads' ids aren't in ghl_messages, so the GHL arm is empty.
-- ---------------------------------------------------------------------------
create or replace function outbound_funnel_by_rep(
  p_campaign_key text,
  p_start timestamptz,
  p_end timestamptz
)
returns jsonb language sql stable as $$
with leads as (
  select close_id from outbound_lead_facts where campaign_key = p_campaign_key
),
calls as (
  select cc.user_id,
    max(cc.raw_payload ->> 'user_name') as user_name,
    count(*) filter (where cc.direction = 'outbound') as dials,
    count(*) filter (where cc.duration >= 90)         as connections
  from close_calls cc
  join leads l on l.close_id = cc.lead_id
  where cc.activity_at >= p_start and cc.activity_at < p_end
    and cc.user_id is not null
  group by cc.user_id
),
calls_rep as (
  select coalesce(tm.id::text, ca.user_id)                        as rep_key,
         coalesce(tm.full_name, ca.user_name, ca.user_id)         as rep_name,
         sum(ca.dials)::int as dials, sum(ca.connections)::int as connections
  from calls ca
  left join team_members tm on tm.close_user_id = ca.user_id
  group by 1, 2
),
calls_ghl as (
  select gm.user_id,
    count(*) filter (where gm.direction = 'outbound') as dials,
    count(*) filter (where gm.call_status = 'completed' and gm.call_duration >= 90) as connections
  from ghl_messages gm
  join leads l on l.close_id = gm.contact_id
  where gm.message_type = 'TYPE_CALL'
    and gm.date_added >= p_start and gm.date_added < p_end
    and gm.user_id is not null
  group by gm.user_id
),
calls_ghl_rep as (
  select coalesce(tm.id::text, 'ghl:' || cg.user_id) as rep_key,
         coalesce(tm.full_name, cg.user_id)          as rep_name,
         sum(cg.dials)::int as dials, sum(cg.connections)::int as connections
  from calls_ghl cg
  left join team_members tm on tm.ghl_user_id = cg.user_id
  group by 1, 2
),
calls_all as (
  select rep_key, rep_name, sum(dials)::int as dials, sum(connections)::int as connections
  from (select * from calls_rep union all select * from calls_ghl_rep) u
  group by rep_key, rep_name
),
closes_raw as (
  select t.rid, t.nm, f.lead_id,
    (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p) <> '') as units
  from airtable_full_closer_report f
  join leads l on l.close_id = f.lead_id
  cross join lateral unnest(f.closer_record_ids, f.closer_names) as t(rid, nm)
  where f.form_type = 'New' and f.digital_college_closed = 'Yes'
    and f.airtable_created_at >= p_start and f.airtable_created_at < p_end
    and (select count(*) from unnest(coalesce(f.dc_plans,'{}'::text[])) p where trim(p) <> '') > 0
),
closes_rep as (
  select coalesce(tm.id::text, cr.rid, cr.nm)  as rep_key,
         coalesce(tm.full_name, cr.nm)         as rep_name,
         count(distinct cr.lead_id)::int       as closes,
         (coalesce(sum(cr.units), 0) * 300)::int as cash
  from closes_raw cr
  left join team_members tm on tm.airtable_user_id = cr.rid
  group by 1, 2
),
merged as (
  select
    coalesce(cl.rep_key, co.rep_key)   as rep_key,
    coalesce(cl.rep_name, co.rep_name) as rep_name,
    coalesce(cl.dials, 0)       as dials,
    coalesce(cl.connections, 0) as connections,
    coalesce(co.closes, 0)      as closes,
    coalesce(co.cash, 0)        as cash
  from calls_all cl
  full outer join closes_rep co on cl.rep_key = co.rep_key
)
select coalesce(jsonb_agg(jsonb_build_object(
    'rep', rep_name, 'dials', dials, 'connections', connections,
    'closes', closes, 'cash', cash
  ) order by closes desc, cash desc, connections desc, dials desc), '[]'::jsonb)
from merged
where closes > 0;
$$;
