-- 0118_revival_ghl_source_catchall.sql
-- Make the revival campaign a Close + GHL CATCH-ALL. Until now revival was a
-- legacy Close-only campaign (close_cf_id), so the ~476 GHL leads carrying
-- `source = "DC Revival Lead"` were in NO campaign. Per Drake: every revival-
-- tagged lead — Close OR GHL — should sit in revival until a per-campaign CSV
-- carve-out pulls a specific batch into its own campaign.
--
-- Mechanism: a new `outbound_campaigns.ghl_source_value` column. When set (revival
-- = 'DC Revival Lead'), the LEGACY arm of refresh_outbound_facts also matches
-- `ghl_contacts.source ILIKE value||'%'` (the ILIKE prefix also catches Zane's
-- "DC Revival Leads" typo) and builds the same GHL facts as the new-model GHL arm
-- (signals from ghl_messages; closes from Airtable on lead_id = ghl_contacts.id).
-- NO exclusivity on this arm — the CSV carve-out (next) is what removes specific
-- leads from revival.
--
-- Verified: the Close side is byte-for-byte unchanged (md5 of every fact column,
-- old fn vs new fn on identical data; 17,743 Close rows unchanged), +476 GHL rows
-- added. Legacy Jacob + the new-model branch are untouched.

alter table outbound_campaigns add column if not exists ghl_source_value text;
comment on column outbound_campaigns.ghl_source_value is
  'For a (legacy) catch-all campaign: also match GHL contacts whose `source` ILIKE this value||''%''. Set on revival = "DC Revival Lead". NULL for campaigns that do not span GHL via source.';

update outbound_campaigns set ghl_source_value = 'DC Revival Lead' where key = 'revival';

CREATE OR REPLACE FUNCTION public.refresh_outbound_facts(p_campaign_key text DEFAULT 'revival'::text)
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
declare
  v_cf text; v_floor timestamptz; v_sort int;
  v_field_name text; v_value text;
  v_close_fid text; v_ghl_fid text; v_ghl_source text;
  v_count int := 0; v_n int;
begin
  select close_cf_id, floor_at, sort_order, match_field_name, match_value, ghl_source_value
    into v_cf, v_floor, v_sort, v_field_name, v_value, v_ghl_source
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
