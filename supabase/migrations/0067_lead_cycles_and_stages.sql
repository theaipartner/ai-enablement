-- 0067_lead_cycles_and_stages.sql
--
-- Persistent lead-tag system (replaces the live-computed leadType/bookingType
-- and the dormant reactivated_at path from 0063-0065). Two tables, both
-- populated by ONE tagger (Python module + cron pass) and read directly by the
-- sales dashboard. Scope: leads/cycles with activity on or after 2026-05-24
-- (the dashboard's effective date); earlier cycles get no tags.
--
-- MODEL
--   A "cycle" = one opt-in. A lead can re-opt-in (Close keeps ONE close_id and
--   increments number_of_opt_ins); each opt-in is a separate cycle, so a lead
--   is counted once PER cycle (re-opt-ins double-count in the funnel). Events
--   (calls / forms / bookings) attach to the cycle whose opt_in_at is the
--   latest one <= the event time.
--
--   lead_cycles        — the spine + accretive identity tags (set-once, never
--                        cleared): opt_in (the row itself), direct, reactive,
--                        dq. Each is a nullable timestamp = when it was earned.
--   lead_cycle_stages  — per cycle, per phase (primary = pre-reactive,
--                        reactive = post-reactive), the additive journey stages
--                        connected -> booked -> confirmed -> showed -> closed,
--                        each a nullable timestamp (null = not reached). Stages
--                        are independent facts (connected is kept even though
--                        a direct booking can skip it).
--
-- Identity tags never change; display precedence (dq > reactive > direct >
-- opt_in, with an HT close suppressing dq) is applied at READ time, not stored.

create table if not exists lead_cycles (
  close_id          text not null,
  opt_in_at         timestamptz not null,   -- cycle anchor (the opt-in moment)
  opt_in_seq        integer not null,       -- 1,2,3... within the lead
  source            text not null,          -- how opt_in_at was sourced
  became_direct_at  timestamptz,            -- direct tag: a strat-call booking landed
  reactive_at       timestamptz,            -- reactive tag: lost the spot / went cold
  reactive_source   text,                   -- 'cold' | 'partnership_rebook'
  dq_at             timestamptz,            -- dq tag: earliest DQ output in the cycle
  dq_source         text,                   -- which form produced the DQ
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  primary key (close_id, opt_in_at),
  constraint lead_cycles_source_chk
    check (source in ('typeform', 'close_fallback')),
  constraint lead_cycles_reactive_source_chk
    check (reactive_source is null or reactive_source in ('cold', 'partnership_rebook'))
);

comment on table lead_cycles is
  'One row per lead opt-in cycle (a re-opt-in = a new cycle on the same close_id). Carries the set-once accretive identity tags (opt_in is the row; direct/reactive/dq are nullable timestamps = when earned). Written by the lead tagger, read by the sales dashboard. Scope: 2026-05-24+.';
comment on column lead_cycles.opt_in_at is
  'The opt-in moment that anchors this cycle. From a matched Typeform SFedWelr submission (source=typeform) or close_leads.latest_opt_in_date (source=close_fallback).';
comment on column lead_cycles.became_direct_at is
  'Direct tag. event_created_at of an "Ai Partner Strategy Call" booking assigned to this cycle. null = never went direct (a pure opt-in cycle). A strat booking after reactive_at is logged, not tagged (excluded edge).';
comment on column lead_cycles.reactive_at is
  'Reactive tag. Earliest of: (cold) no inbound SMS and no >=90s call (either direction) for 3 days with no active future booking; or (partnership_rebook) a direct cycle booked a partnership call. Set once, never cleared.';
comment on column lead_cycles.dq_at is
  'DQ tag. Earliest DQ output in the cycle (setter-triage DQ, confirmation DQ/Un-interested, closer EOC DQ/Bad Fit, DC Follow Up?=No). Stored always; an HT close in the same cycle suppresses it at display time (close-overrides-dq, per cycle).';

create table if not exists lead_cycle_stages (
  close_id      text not null,
  opt_in_at     timestamptz not null,
  phase         text not null,          -- 'primary' (pre-reactive) | 'reactive'
  connected_at  timestamptz,
  booked_at     timestamptz,
  confirmed_at  timestamptz,
  showed_at     timestamptz,
  closed_at     timestamptz,
  close_type    text,                   -- 'ht' | 'dc' (set with closed_at)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  primary key (close_id, opt_in_at, phase),
  constraint lead_cycle_stages_phase_chk
    check (phase in ('primary', 'reactive')),
  constraint lead_cycle_stages_close_type_chk
    check (close_type is null or close_type in ('ht', 'dc')),
  constraint lead_cycle_stages_cycle_fk
    foreign key (close_id, opt_in_at)
    references lead_cycles (close_id, opt_in_at) on delete cascade
);

comment on table lead_cycle_stages is
  'Per cycle, per phase (primary=pre-reactive, reactive=post-reactive), the additive journey stages connected->booked->confirmed->showed->closed as nullable timestamps (when first reached). The funnel reads furthest stage from here. Stages are independent (connected kept even when a direct booking skips it).';
comment on column lead_cycle_stages.connected_at is
  '>=90s call OR a form output other than setter-handover (a confirm auto-fires connected). Skippable only for a pure {opt_in,direct} primary phase (a self-booked strat call is not a connect).';
comment on column lead_cycle_stages.confirmed_at is
  'Direct primary phase: the confirmation form (Confirmed Booking / - New Time). Every other phase: booked auto-fires confirmed.';

create index if not exists idx_lead_cycles_close_id on lead_cycles (close_id);
create index if not exists idx_lead_cycles_opt_in_at on lead_cycles (opt_in_at);
create index if not exists idx_lead_cycles_reactive on lead_cycles (reactive_at) where reactive_at is not null;
create index if not exists idx_lead_cycles_direct on lead_cycles (became_direct_at) where became_direct_at is not null;
create index if not exists idx_lead_cycle_stages_close_id on lead_cycle_stages (close_id);
