-- 0088_sales_funnel_counts_rebook_dial.sql
-- Reactivation dials: also count the rebook-driving dial for partnership_rebook.
--
-- A partnership_rebook reactivation anchors reactive_at at the moment the setter
-- LOGS the rebooking (the triage form). The dial that produced that rebook lands
-- a few minutes BEFORE the anchor (Ghazi 2m, Mahmoud 29m), so the strict
-- "dial > reactive_at" rule (0087) misses it and the box shows a booked/connected
-- reactivation with 0 dials. Cold reactivations do NOT have this problem: their
-- anchor is the cold-gap start, and their last pre-anchor outbound dial is a
-- stale primary-phase dial 2-3 days earlier (observed gaps 50-73h) that must NOT
-- count as reactivation work.
--
-- Fix: for partnership_rebook leads ONLY, also count the single most-recent
-- outbound dial in (loi, reactive_at]. New `lastpre` CTE finds that timestamp;
-- the prd filter ORs it in. Cold leads are untouched. Everything else is
-- byte-identical to 0087.
create or replace function sales_funnel_counts(
  p_start timestamptz, p_end timestamptz, p_ad text default null, p_campaign text default null, p_adset text default null
) returns jsonb language sql stable as $$
with cyc as (
  select lc.close_id, lc.opt_in_at,
    (lc.became_direct_at is not null) is_direct,
    (lc.reactive_at is not null)      is_react,
    (lc.dc_closed_at is not null)     dc_closed,
    case when lc.qualified is true then 'q' when lc.qualified is false then 'n' else 'u' end ql,
    bool_or(s.phase='primary'  and s.connected_at is not null) p_conn,
    bool_or(s.phase='primary'  and s.booked_at    is not null) p_book,
    bool_or(s.phase='primary'  and s.confirmed_at is not null) p_conf,
    bool_or(s.phase='primary'  and s.showed_at    is not null) p_show,
    bool_or(s.phase='primary'  and s.closed_at    is not null) p_close,
    bool_or(s.phase='reactive' and s.connected_at is not null) r_conn,
    bool_or(s.phase='reactive' and s.booked_at    is not null) r_book,
    bool_or(s.phase='reactive' and s.confirmed_at is not null) r_conf,
    bool_or(s.phase='reactive' and s.showed_at    is not null) r_show,
    bool_or(s.phase='reactive' and s.closed_at    is not null) r_close
  from lead_cycles lc join close_leads cl on cl.close_id=lc.close_id
  left join lead_cycle_stages s on s.close_id=lc.close_id and s.opt_in_at=lc.opt_in_at
  where lc.opt_in_at >= p_start and lc.opt_in_at < p_end and (p_ad is null or lc.ad_id=p_ad)
    and (p_campaign is null or cl.campaign_id=p_campaign) and (p_adset is null or cl.adset_id=p_adset)
  group by lc.close_id, lc.opt_in_at, lc.became_direct_at, lc.reactive_at, lc.dc_closed_at, lc.qualified),
inwin as (select distinct close_id from cyc),
latest as (select close_id, max(opt_in_at) latest from lead_cycles group by close_id),
caps as (select x.lead_id close_id, min(x.dtc) close_cap from (
    select f.lead_id, f.date_time_of_call dtc from airtable_full_closer_report f join latest o on o.close_id=f.lead_id
      where f.form_type='New' and f.date_time_of_call is not null and f.airtable_created_at>=o.latest
        and (lower(f.call_outcome) like '%high ticket closed%' or lower(f.call_outcome) like '%digital college closed%')
    union all
    select d.lead_id, d.date_time_of_call dtc from airtable_digital_college_sales d join latest o on o.close_id=d.lead_id
      where lower(d.closed)='yes' and d.date_time_of_call is not null and d.excluded_at is null
        and coalesce(d.date_time_of_call,d.airtable_created_at)>=o.latest) x group by x.lead_id),
anchors as (select lc.close_id, max(lc.opt_in_at) loi from lead_cycles lc where lc.close_id in (select close_id from inwin) group by lc.close_id),
-- Per-lead tagger reactive anchor + source, from the lead's latest cycle.
ra as (select distinct on (lc.close_id) lc.close_id, lc.reactive_at, lc.reactive_source
  from lead_cycles lc where lc.close_id in (select close_id from inwin)
  order by lc.close_id, lc.opt_in_at desc),
-- For partnership_rebook leads only: the timestamp of the most-recent outbound
-- dial in (loi, reactive_at] — the dial that drove the rebook. ORed into the
-- reactive dial count below. Cold leads never get a lastpre row.
lastpre as (select a.close_id, max(c.activity_at) ts
  from anchors a join ra on ra.close_id=a.close_id
  join close_calls c on c.lead_id=a.close_id and c.direction='outbound'
  where ra.reactive_source='partnership_rebook'
    and c.activity_at>=a.loi and c.activity_at<=ra.reactive_at
  group by a.close_id),
tmem as (select close_id,
    bool_or(opt_in_at>=p_start and opt_in_at<p_end and became_direct_at is not null) is_direct,
    bool_or(opt_in_at>=p_start and opt_in_at<p_end and became_direct_at is null) is_setter,
    bool_or(opt_in_at>=p_start and opt_in_at<p_end and reactive_at is not null) is_react
  from lead_cycles where close_id in (select close_id from inwin) and (p_ad is null or ad_id=p_ad) group by close_id),
dl as (select a.close_id,
    count(c.*) filter (where c.activity_at>=a.loi and (cap.close_cap is null or c.activity_at<=cap.close_cap)) dbc,
    count(c.*) filter (where c.activity_at>=a.loi and (cap.close_cap is null or c.activity_at<=cap.close_cap)
       and ((ra.reactive_at is not null and c.activity_at>ra.reactive_at)
            or (lp.ts is not null and c.activity_at=lp.ts))) prd
  from anchors a
  left join ra on ra.close_id=a.close_id
  left join lastpre lp on lp.close_id=a.close_id
  left join caps cap on cap.close_id=a.close_id
  left join close_calls c on c.lead_id=a.close_id and c.direction='outbound' group by a.close_id),
dials as (select coalesce(sum(dl.dbc),0) td, coalesce(sum(dl.dbc) filter(where tm.is_direct),0) dd,
    coalesce(sum(dl.dbc) filter(where tm.is_setter),0) sd, coalesce(sum(dl.prd) filter(where tm.is_react),0) rd
  from dl join tmem tm on tm.close_id=dl.close_id),
agg as (select count(*) optins,
    count(*) filter(where p_conn or r_conn) tc, count(*) filter(where p_book or r_book) tb,
    count(*) filter(where p_conf or r_conf) tcf, count(*) filter(where p_show or r_show) tsh,
    count(*) filter(where p_close or r_close) tcl, count(*) filter(where dc_closed) tdc,
    count(*) filter(where ql='q') dq, count(*) filter(where is_direct and (p_conn or r_conn)) dc2,
    count(*) filter(where is_direct and (p_book or r_book)) db, count(*) filter(where is_direct and (p_conf or r_conf)) dcf,
    count(*) filter(where is_direct and (p_show or r_show)) dsh, count(*) filter(where is_direct and (p_close or r_close)) dcl,
    count(*) filter(where is_direct and dc_closed) ddc,
    count(*) filter(where not is_direct) sp, count(*) filter(where not is_direct and ql='q') sq,
    count(*) filter(where not is_direct and ql='n') su, count(*) filter(where not is_direct and (p_conn or r_conn)) sc,
    count(*) filter(where not is_direct and (p_book or r_book)) sb, count(*) filter(where not is_direct and (p_show or r_show)) ssh,
    count(*) filter(where not is_direct and (p_close or r_close)) scl, count(*) filter(where not is_direct and dc_closed) sdc,
    count(*) filter(where is_react) rp, count(*) filter(where is_react and ql='q') rq, count(*) filter(where is_react and ql='n') ru,
    count(*) filter(where is_react and r_conn) rc, count(*) filter(where is_react and r_book) rb,
    count(*) filter(where is_react and r_show) rsh, count(*) filter(where is_react and r_close) rcl,
    count(*) filter(where is_react and dc_closed) rdc
  from cyc)
select jsonb_build_object(
  'total', jsonb_build_object('optIns',optins,'dials',(select td from dials),'connected',tc,'books',tb,'confirms',tcf,'shows',tsh,'closes',tcl,'closesHt',tcl,'closesDc',0,'dcCloses',tdc),
  'direct', jsonb_build_object('qualifiedOptIns',dq,'dials',(select dd from dials),'books',db,'connected',dc2,'confirms',dcf,'shows',dsh,'closes',dcl,'closesHt',dcl,'closesDc',0,'dcCloses',ddc),
  'setter', jsonb_build_object('pool',sp,'qualified',sq,'unqualified',su,'dials',(select sd from dials),'connected',sc,'books',sb,'shows',ssh,'closes',scl,'closesHt',scl,'closesDc',0,'dcCloses',sdc),
  'reactivation', jsonb_build_object('pool',rp,'qualified',rq,'unqualified',ru,'dials',(select rd from dials),'connected',rc,'books',rb,'shows',rsh,'closes',rcl,'closesHt',rcl,'closesDc',0,'dcCloses',rdc))
from agg $$;
