-- 0119_outbound_roster_carveout.sql
-- CSV lead-list carve-out for outbound campaigns. Revival is the Close+GHL
-- catch-all (0118); this lets an admin upload a CSV to create a ROSTER campaign
-- that (a) matches those leads by email/phone across Close AND GHL, (b) removes
-- them from revival, (c) appears in the Outbound dropdown. The CRM-agnostic
-- email/phone match is why it spans both. Generalizes the Jacob roster pattern,
-- but driven by CSV upload and read-only (no write-back tag — we resolve the
-- roster to lead ids and match those).

alter table outbound_campaigns add column if not exists is_roster boolean not null default false;
comment on column outbound_campaigns.is_roster is
  'True = a CSV lead-list campaign. Its leads come from outbound_campaign_members (resolved from outbound_campaign_roster by email/phone). Carved out of the legacy catch-all (revival).';

-- Phone normalization shared with the Jacob tagger: digits only, 10 -> prepend 1,
-- keep the last 11; null if < 11 digits.
create or replace function outbound_norm_phone(p text) returns text language sql immutable as $$
  with d as (select regexp_replace(coalesce(p,''), '\D', '', 'g') as x)
  select case when length(x) = 10 then '1' || x
              when length(x) >= 11 then right(x, 11)
              else null end
  from d
$$;

-- Resolved membership: which lead ids (Close + GHL) a roster campaign covers.
-- Materialized by resolve_campaign_roster() so refreshes are fast id lookups.
create table if not exists outbound_campaign_members (
  campaign_key text not null,
  native_id    text not null,                         -- close_id or ghl_contact id
  source       text not null check (source in ('close','ghl')),
  primary key (campaign_key, native_id)
);
create index if not exists ix_ocm_native on outbound_campaign_members (native_id);
comment on table outbound_campaign_members is
  'Resolved lead ids for a roster (CSV) campaign — outbound_campaign_roster (email/phone) matched against close_leads + ghl_contacts. Read by refresh_outbound_facts (roster arm) and the revival carve-out.';

-- Resolve a campaign's roster (email/phone) to actual Close + GHL lead ids.
-- Called on CSV upload and on Re-tag.
create or replace function resolve_campaign_roster(p_campaign_key text) returns int language plpgsql as $$
declare v_n int;
begin
  delete from outbound_campaign_members where campaign_key = p_campaign_key;
  insert into outbound_campaign_members (campaign_key, native_id, source)
  select distinct p_campaign_key, cl.close_id, 'close'
  from close_leads cl
  where cl.excluded_at is null and (
    exists (
      select 1
      from jsonb_array_elements(coalesce(cl.contacts,'[]'::jsonb)) c
      cross join lateral jsonb_array_elements(coalesce(c->'emails','[]'::jsonb)) em
      join outbound_campaign_roster r on r.campaign_key = p_campaign_key
        and r.email = lower(trim(em->>'email'))
    )
    or exists (
      select 1
      from jsonb_array_elements(coalesce(cl.contacts,'[]'::jsonb)) c
      cross join lateral jsonb_array_elements(coalesce(c->'phones','[]'::jsonb)) ph
      join outbound_campaign_roster r on r.campaign_key = p_campaign_key
        and r.phone = outbound_norm_phone(ph->>'phone')
    )
  )
  union all
  select distinct p_campaign_key, gc.id, 'ghl'
  from ghl_contacts gc
  where exists (
    select 1 from outbound_campaign_roster r
    where r.campaign_key = p_campaign_key
      and ( (gc.email is not null and r.email = lower(trim(gc.email)))
         or (gc.phone is not null and r.phone = outbound_norm_phone(gc.phone)) )
  );
  get diagnostics v_n = row_count;
  return v_n;
end $$;

CREATE OR REPLACE FUNCTION public.refresh_outbound_facts(p_campaign_key text DEFAULT 'revival'::text)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare
  v_cf text; v_floor timestamptz; v_sort int;
  v_field_name text; v_value text;
  v_close_fid text; v_ghl_fid text; v_ghl_source text;
  v_count int := 0; v_n int; v_is_roster boolean;
begin
  select close_cf_id, floor_at, sort_order, match_field_name, match_value, ghl_source_value, coalesce(is_roster,false)
    into v_cf, v_floor, v_sort, v_field_name, v_value, v_ghl_source, v_is_roster
    from outbound_campaigns where key = p_campaign_key;
  if not found then raise exception 'unknown outbound campaign: %', p_campaign_key; end if;

  delete from outbound_lead_facts where campaign_key = p_campaign_key;

  -- =========================================================================
  -- LEGACY (Close-only, exclusivity) — unchanged from migration 0103.
  -- =========================================================================
  if v_field_name is null and not v_is_roster then
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

    -- Legacy GHL extension (0118): also pull GHL leads whose `source` matches,
    -- so the revival catch-all spans Close + GHL. No exclusivity (carve-outs
    -- are handled separately).
    if v_ghl_source is not null then
    insert into outbound_lead_facts (
      campaign_key, close_id, anchor, first_reply, has_inbound, any_call, call90, first_dial,
      booked, booked_dc, booked_ht, showed, closed,
      plan_units, base44_monthly, base44_yearly, wix_monthly, wix_yearly, marked_no_plan,
      reply_bucket, dial_bucket, conn_bucket, updated_at)
    with leads as (
      select gc.id as close_id, greatest(gc.date_added, v_floor) as anchor
      from ghl_contacts gc
      where gc.source ilike v_ghl_source || '%'
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

    -- Carve-out (0119): a lead explicitly listed in an active ROSTER campaign
    -- belongs to that campaign only — drop it from this catch-all.
    delete from outbound_lead_facts f
    where f.campaign_key = p_campaign_key
      and exists (
        select 1 from outbound_campaign_members m
        join outbound_campaigns oc on oc.key = m.campaign_key
        where oc.is_roster and oc.is_active and m.native_id = f.close_id
      );
    return v_count;
  end if;

  -- =========================================================================
  -- ROSTER (CSV lead list) — leads from outbound_campaign_members (matched by
  -- email/phone across Close + GHL at resolve time). No exclusivity.
  -- =========================================================================
  if v_is_roster then
    insert into outbound_lead_facts (
      campaign_key, close_id, anchor, first_reply, has_inbound, any_call, call90, first_dial,
      booked, booked_dc, booked_ht, showed, closed,
      plan_units, base44_monthly, base44_yearly, wix_monthly, wix_yearly, marked_no_plan,
      reply_bucket, dial_bucket, conn_bucket, updated_at)
    with leads as (
      select cl.close_id, greatest(cl.date_created, v_floor) as anchor
      from outbound_campaign_members m
      join close_leads cl on cl.close_id = m.native_id and cl.excluded_at is null
      where m.campaign_key = p_campaign_key and m.source = 'close'
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
    get diagnostics v_n = row_count; v_count := v_count + v_n;
    insert into outbound_lead_facts (
      campaign_key, close_id, anchor, first_reply, has_inbound, any_call, call90, first_dial,
      booked, booked_dc, booked_ht, showed, closed,
      plan_units, base44_monthly, base44_yearly, wix_monthly, wix_yearly, marked_no_plan,
      reply_bucket, dial_bucket, conn_bucket, updated_at)
    with leads as (
      select gc.id as close_id, greatest(gc.date_added, v_floor) as anchor
      from outbound_campaign_members m
      join ghl_contacts gc on gc.id = m.native_id
      where m.campaign_key = p_campaign_key and m.source = 'ghl'
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
end $function$
