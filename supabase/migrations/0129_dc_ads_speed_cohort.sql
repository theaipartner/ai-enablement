-- 0129_dc_ads_speed_cohort.sql
-- Per-lead timing/effort rows behind the DC ads page's speed-to-lead boxes
-- (the four top-line stats ported from /sales-dashboard/leads). Hands back
-- raw per-lead facts; the business-hours (10a–10p ET) speed clock runs in
-- lib/db/dc-ads.ts with the SAME helper the Leads page uses
-- (businessHoursElapsedSec), so the two pages can never drift on the math.
--
--   dials     = outbound calls since the opt-in anchor (global, not window-
--               bounded — "how hard did we work this lead", the Leads page's
--               intensity semantics)
--   connected = the funnel's broad Connected (≥90s call OR a later stage)

create function dc_ads_speed_cohort(
  p_start timestamptz,
  p_end timestamptz,
  p_campaign_id text default null,
  p_adset_id text default null,
  p_ad_id text default null,
  p_form_id text default null
)
returns jsonb
language sql
stable
as $function$
with f as (
  select * from dc_ads_lead_facts
  where anchor >= p_start and anchor < p_end
    and (p_campaign_id is null or campaign_id = p_campaign_id)
    and (p_adset_id is null or adset_id = p_adset_id)
    and (p_ad_id is null or ad_id = p_ad_id)
    and (p_form_id is null or form_id = p_form_id)
)
select coalesce(jsonb_agg(jsonb_build_object(
  'anchor',    f.anchor,
  'firstDial', f.first_dial,
  'dials',     coalesce(d.n, 0),
  'connected', (f.call90 or f.booked or f.showed or f.closed)
)), '[]'::jsonb)
from f
left join lateral (
  select count(*) as n from close_calls c
  where c.lead_id = f.close_id and c.direction = 'outbound' and c.activity_at >= f.anchor
) d on true
$function$;
