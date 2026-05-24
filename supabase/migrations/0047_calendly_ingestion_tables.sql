-- 0047_calendly_ingestion_tables.sql
-- Mirror tables for Calendly scheduled events + invitees (the FUNNELS
-- section's six Calendly-sourced rows in the Engine sheet).
--
-- Spec: docs/specs/calendly-ingestion.md
-- Discovery: docs/reports/calendly-discovery.md (verified the event +
--   invitee shapes; 14 active event types; "AI Partner Strategy Call"
--   is the dominant closer-call type; 10 existing Make.com webhook
--   subscriptions confirm plan tier supports webhooks).
-- Schema docs: docs/schema/calendly_{event_types,scheduled_events,
--   invitees}.md.
-- Runbook: docs/runbooks/calendly_ingestion.md.
--
-- Design decisions baked in (per spec):
--
--   1. Mirror-everything posture. Three tables; raw_payload jsonb on
--      events + invitees so any future field is recoverable without
--      re-pulling from Calendly. Same posture as Close.
--
--   2. URI-keyed PKs (text). Calendly's stable IDs are full URIs
--      (e.g. https://api.calendly.com/scheduled_events/{uuid}).
--      Storing the full URI avoids the bare-UUID-vs-URI footgun the
--      discovery flagged.
--
--   3. Loose FKs on invitee.event_uri → events.uri and
--      events.event_type_uri → event_types.uri. Backfill/webhook
--      order isn't guaranteed (a webhook for an invitee may arrive
--      before our backfill has the event; the receiver fetches the
--      event fresh anyway). Same pattern as close_calls/close_sms
--      vs close_leads.
--
--   4. event_type_uri references the URI but 58% of events in the
--      discovery sample referenced RETIRED event-type URIs absent
--      from the active catalog. So we ALSO store the event's own
--      `name` field on the events table — the aggregation layer
--      filters closer bookings by NAME (case-insensitive), not by
--      event_type URI. Documented in column comments.
--
--   5. Cancellation lineage. Canceled events carry a `cancellation`
--      jsonb sub-object {canceled_by, canceler_type, created_at,
--      reason}; on the invitee side, reschedules link via
--      `old_invitee` / `new_invitee` URIs and the `rescheduled`
--      boolean. All preserved so the aggregation layer can
--      distinguish new bookings from reschedules + count cancels
--      with timestamps.
--
--   6. `no_show` mirrored from Calendly's invitee field. The Engine
--      sheet sources No Show from a different system today; flagging
--      this column for potential consolidation in a future spec.

-- ============================================================================
-- calendly_event_types — reference, ~14 rows
-- ============================================================================
-- Refreshed each backfill tick + opportunistically when a webhook
-- references a URI we don't have cached. Aggregation layer uses
-- `name` from the events table directly; this table is for display
-- labels + admin reference.

create table calendly_event_types (
  uri text primary key,
  name text,
  duration_minutes integer,
  kind text,
  active boolean,
  scheduling_url text,
  raw_payload jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table calendly_event_types is
  'Calendly event-type catalog mirror. Reference table; ~14 rows. The aggregation layer typically filters by calendly_scheduled_events.name (case-insensitive) rather than joining on event_type_uri because 58% of historical events reference RETIRED event-type URIs absent from this catalog.';

comment on column calendly_event_types.uri is
  'Stable Calendly URI, e.g. https://api.calendly.com/event_types/{uuid}. PK; also the FK target from calendly_scheduled_events.event_type_uri (loose, not enforced).';

create trigger calendly_event_types_set_updated_at
  before update on calendly_event_types
  for each row execute function set_updated_at();

-- ============================================================================
-- calendly_scheduled_events — one row per Calendly event
-- ============================================================================

create table calendly_scheduled_events (
  uri text primary key,
  name text,
  status text,
  start_time timestamptz,
  end_time timestamptz,
  event_created_at timestamptz,
  event_updated_at timestamptz,
  event_type_uri text,
  host_user_uri text,
  host_user_email text,
  host_user_name text,
  location jsonb,
  invitees_counter jsonb,
  cancellation jsonb,
  raw_payload jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table calendly_scheduled_events is
  'Mirror of Calendly /scheduled_events. URI-keyed PK. Live ingestion via api/calendly_events.py webhook receiver + 7d initial backfill via scripts/backfill_calendly.py. Idempotent UPSERT ON CONFLICT (uri).';

comment on column calendly_scheduled_events.name is
  'Event-type NAME as recorded at booking time. PREFER THIS over event_type_uri for filtering — 58% of historical events reference retired event_type URIs absent from calendly_event_types. Casing may drift (Calendly title-cases at booking time, e.g. "Ai Partner Strategy Call" vs catalog "AI Partner Strategy Call"); aggregation must match case-insensitively.';

comment on column calendly_scheduled_events.event_created_at is
  'When the booking was CREATED in Calendly (i.e. when the invitee booked). Distinct from this row''s created_at (when we mirrored it). The Engine sheet metrics key off this column, not start_time. NOTE: "Next Day" / "Two Days Out" date math should compute (start_time.date - event_created_at.date) in the BUSINESS TIMEZONE America/New_York per ADR 0003, NOT UTC — a near-midnight UTC booking flips to the wrong calendar day otherwise.';

comment on column calendly_scheduled_events.event_type_uri is
  'Reference to calendly_event_types.uri. LOOSE FK — not enforced. 58% of historical events point at retired URIs that no longer appear in the catalog; the aggregation layer should not hard-join on this column.';

comment on column calendly_scheduled_events.cancellation is
  'JSONB sub-object populated on canceled events only: {canceled_by, canceler_type (host|invitee), created_at, reason}. NULL on active events.';

-- Aggregation queries pivot on:
--   - (status, event_created_at) for the per-day New Scheduled count
--   - (name, event_created_at) for closer-booking-by-name-by-day filtering
--   - event_type_uri for catalog joins (loose; with caveats above)
create index calendly_scheduled_events_status_created_idx
  on calendly_scheduled_events (status, event_created_at desc);
create index calendly_scheduled_events_name_created_idx
  on calendly_scheduled_events (name, event_created_at desc);
create index calendly_scheduled_events_event_type_uri_idx
  on calendly_scheduled_events (event_type_uri) where event_type_uri is not null;
create index calendly_scheduled_events_event_created_at_idx
  on calendly_scheduled_events (event_created_at desc);

create trigger calendly_scheduled_events_set_updated_at
  before update on calendly_scheduled_events
  for each row execute function set_updated_at();

-- ============================================================================
-- calendly_invitees — one row per invitee on each event
-- ============================================================================
--
-- Live ingestion source: invitee.created / invitee.canceled webhook
-- events. Backfill: GET /scheduled_events/{uuid}/invitees per event.

create table calendly_invitees (
  uri text primary key,
  event_uri text not null,
  email text,
  name text,
  first_name text,
  last_name text,
  status text,
  invitee_created_at timestamptz,
  invitee_updated_at timestamptz,
  rescheduled boolean not null default false,
  old_invitee text,
  new_invitee text,
  no_show boolean not null default false,
  timezone text,
  cancel_url text,
  reschedule_url text,
  cancellation jsonb,
  raw_payload jsonb,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table calendly_invitees is
  'Mirror of Calendly invitees. URI-keyed PK. Loose FK on event_uri (webhook delivery order vs backfill: invitee.created may arrive before its event lands locally; the receiver fetches the event fresh per delivery anyway). Idempotent UPSERT ON CONFLICT (uri).';

comment on column calendly_invitees.rescheduled is
  'True when this invitee was created as the RESULT of a reschedule (i.e. it replaces a prior canceled invitee). Combined with old_invitee → identifies the second leg of a reschedule. The Engine sheet''s "New Rescheduled Meetings" row counts these; "New Scheduled Meetings" counts only the invitees where rescheduled=false (so a reschedule isn''t double-counted).';

comment on column calendly_invitees.old_invitee is
  'URI of the prior invitee that this one replaces (when rescheduled=true). NULL otherwise.';

comment on column calendly_invitees.new_invitee is
  'URI of the replacement invitee, populated on the CANCELED side of a reschedule pair. Lets aggregation queries reconstruct reschedule lineage from either direction.';

comment on column calendly_invitees.no_show is
  'Calendly''s native no-show flag. The Engine sheet currently sources No Show from a different system; potential consolidation TBD in a future spec.';

create index calendly_invitees_event_uri_idx
  on calendly_invitees (event_uri);
create index calendly_invitees_created_idx
  on calendly_invitees (invitee_created_at desc);
create index calendly_invitees_rescheduled_idx
  on calendly_invitees (rescheduled) where rescheduled = true;
create index calendly_invitees_status_created_idx
  on calendly_invitees (status, invitee_created_at desc);

create trigger calendly_invitees_set_updated_at
  before update on calendly_invitees
  for each row execute function set_updated_at();
