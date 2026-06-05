-- 0076_lead_cycles_dc_funnel.sql
-- Digital College funnel becomes first-class on the cycle (closer-identity
-- routing + downsell tracking). See docs/specs/dc-funnel-closer-routing.md.
--
-- dc_closed_at already exists on lead_cycles (when a DC sale closed). This adds:
--   digital_college_at  — earliest DC signal in the cycle ("when they went DC")
--   dc_booked_at        — DC-closer funnel: a DC call was booked (back-filled)
--   dc_showed_at        — DC-closer funnel: a DC-closer form is present (showed)
--   dc_close_origin     — where a DC close came from:
--                         'dc_closer' | 'downsell_ht_meeting' | 'downsell_confirmation'

alter table public.lead_cycles
  add column if not exists digital_college_at timestamptz,
  add column if not exists dc_booked_at       timestamptz,
  add column if not exists dc_showed_at        timestamptz,
  add column if not exists dc_close_origin     text;
