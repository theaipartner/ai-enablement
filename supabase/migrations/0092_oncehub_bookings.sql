-- 0092_oncehub_bookings.sql
-- OnceHub booking mirror — one row per OnceHub booking. Raw, faithful mirror of
-- the v2 booking object (core principle #1: everything we touch is mirrored into
-- Supabase; agents/dashboard read THIS, never api.oncehub.com directly).
--
-- This is the capture/discovery table for the booking->close lifecycle (see
-- docs/sales/booking-to-close.md). The normalized booking_cycles SPINE is a
-- later sibling that READS this table; we land the raw mirror first so we start
-- banking real bookings from day one and can build the spine against reality.
--
-- Populated by: api/oncehub_events.py (webhook, real-time primary) +
-- scripts/backfill_oncehub.py (API backstop / initial load). Both go through
-- ingestion/oncehub/parser.py -> the same row shape, upsert on booking_id.
--
-- Hot fields are denormalized columns; the full booking object stays in
-- raw_payload jsonb so nothing is lost if a field turns out to matter later.

create table if not exists public.oncehub_bookings (
  -- identity
  booking_id        text primary key,                  -- the v2 booking id (BKNG-...)
  tracking_id       text,                              -- human-facing id (usually == booking_id in v2)

  -- the meeting
  subject           text,                              -- e.g. "Ai Partner Strategy Call"
  status            text,                              -- scheduled | canceled | completed | no_show (OnceHub-cased)
  in_trash          boolean not null default false,
  scheduled_at      timestamptz,                       -- starting_time — drives the closing-leg clock
  duration_minutes  integer,
  booked_at         timestamptz,                       -- creation_time (when the booking was made)
  last_updated_time timestamptz,                       -- OnceHub's last_updated_time
  customer_timezone text,
  join_url          text,                              -- virtual_conferencing.join_url

  -- WHO it's booked with — the per-closer owner the round-robin landed on.
  -- This is the attribution that has no reliable source today (booking-to-close.md).
  owner_user_id     text,                              -- assigned host (USR-...)

  -- OnceHub structure refs (resolve to names via ingestion/oncehub inventory later)
  booking_calendar_id text,                            -- BKC-... (the team/round-robin calendar)
  booking_page_id   text,                              -- BP-... (classic surface; usually null on v2)
  master_page_id    text,                              -- BP-... master page
  event_type_id     text,
  contact_id        text,                              -- CTC-...
  conversation_id   text,                              -- CVR-...

  -- the invitee (from form_submission; null on admin/reschedule-created bookings)
  invitee_name      text,
  invitee_email     text,
  invitee_phone     text,

  -- lead attribution
  lead_id           text,                              -- Close lead_id from the hidden custom field (null until configured)
  custom_fields     jsonb not null default '[]'::jsonb,-- the custom_fields array (carries lead_id)
  utm_params        jsonb,                             -- tracking params if the booking link carried them

  -- reschedule / cancel lineage (auto-resolve fuel for the future pinger)
  rescheduled_booking_id text,                         -- prior booking this one replaced
  canceled_by       text,                              -- cancel_reschedule_information.actioned_by (user|customer)
  cancel_user_id    text,                              -- who actioned it (USR-...)
  cancel_reason     text,

  -- provenance
  source            text not null default 'oncehub',
  last_event_type   text,                              -- last webhook type seen (booking.no_show etc.) — set even when status doesn't move
  raw_payload       jsonb not null,                    -- the full booking object

  -- creator-only soft-hide (survives re-sync; parsers NEVER write it — see ingestion.md)
  excluded_at       timestamptz,

  received_at       timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Closer-card / Talent reads: bookings by the rep they landed on.
create index if not exists oncehub_bookings_owner_idx on public.oncehub_bookings (owner_user_id);
-- Closing-leg clock + funnel windows: by meeting time.
create index if not exists oncehub_bookings_scheduled_at_idx on public.oncehub_bookings (scheduled_at);
-- Lead-match join (once the hidden field carries lead_id).
create index if not exists oncehub_bookings_lead_id_idx on public.oncehub_bookings (lead_id) where lead_id is not null;
-- Email/phone fallback matching (primary path until the hidden field exists).
create index if not exists oncehub_bookings_invitee_email_idx on public.oncehub_bookings (lower(invitee_email)) where invitee_email is not null;
-- Reschedule-lineage reverse lookup.
create index if not exists oncehub_bookings_reschedule_idx on public.oncehub_bookings (rescheduled_booking_id) where rescheduled_booking_id is not null;

-- updated_at maintenance (matches the other mirror tables' convention).
create or replace function public.oncehub_bookings_set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists oncehub_bookings_set_updated_at on public.oncehub_bookings;
create trigger oncehub_bookings_set_updated_at
  before update on public.oncehub_bookings
  for each row execute function public.oncehub_bookings_set_updated_at();
