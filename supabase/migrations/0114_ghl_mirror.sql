-- 0114_ghl_mirror.sql
-- GHL (GoHighLevel) ingestion mirror — the first non-Close outbound CRM source.
--
-- New outbound campaigns move to GHL while Close keeps the advertising funnel +
-- the two finished Close outbound pools (Revival, Jacob). Per Principles 1-2, we
-- mirror GHL into Supabase and read from here; the dashboard/agents never call
-- GHL directly. Read-only mirror (no write-back to GHL).
--
-- Discovery (live sub-account "Digital College", loc X8hfgbsfvZWAauZHxK9S):
--   * Campaign membership today is carried in contact.source ("DC Revival Lead"),
--     not tags (tags are empty). The campaign registry will key off a tag/source
--     value; this mirror just stores both so either can be matched later.
--   * Rep attribution is on the CALL message (TYPE_CALL.userId), not the contact
--     (assignedTo is set on ~2% of bulk leads).
--   * Calls + SMS both arrive as conversation *messages*: SMS = TYPE_SMS, calls =
--     TYPE_CALL with meta.call.duration (seconds) + meta.call.status. The funnel's
--     "connected" = a TYPE_CALL with status='completed' AND duration >= 90 (parity
--     with Close's >=90s rule, tightened to exclude long voicemail recordings).
--   * Closes stay in Airtable; the join key is an Airtable closer-form "Lead ID"
--     embedded in the contact's "EOC From" custom field (parsed into eoc_lead_id).
--
-- These three tables are the GHL counterpart of close_leads / close_sms /
-- close_calls (GHL collapses SMS + calls into one messages stream, so one table
-- with a message_type discriminator). Refreshed by api/ghl_sync_cron.py via
-- ingestion/ghl/pipeline.py. Read (later) by the re-sourced refresh_outbound_facts
-- GHL arm. Runbook: docs/runbooks/ghl_ingestion.md.

-- 1. Contacts — one row per GHL contact (the lead).
create table if not exists ghl_contacts (
  id            text primary key,                       -- GHL contact id
  location_id   text not null,
  source        text,                                   -- "DC Revival Lead" today (campaign membership lives here)
  first_name    text,
  last_name     text,
  contact_name  text,
  email         text,
  phone         text,
  tags          text[] not null default '{}'::text[],   -- empty today; the long-term per-campaign tag goes here
  assigned_to   text,                                   -- GHL user id (rarely set on bulk-uploaded leads)
  eoc_lead_id   text,                                   -- Airtable closer-form Lead ID parsed from the "EOC From" custom field — the closer-report join key
  date_added    timestamptz,
  date_updated  timestamptz,
  custom_fields jsonb not null default '[]'::jsonb,      -- raw [{id,value}] array
  raw           jsonb not null default '{}'::jsonb,
  synced_at     timestamptz not null default now()
);
create index if not exists ix_ghl_contacts_source on ghl_contacts (source);
create index if not exists ix_ghl_contacts_date_added on ghl_contacts (date_added);
create index if not exists ix_ghl_contacts_eoc_lead_id on ghl_contacts (eoc_lead_id);
create index if not exists ix_ghl_contacts_tags_gin on ghl_contacts using gin (tags);

-- 2. Conversations — one row per GHL conversation. Drives incremental message
--    pulls: re-fetch a conversation's messages only when last_message_date is
--    newer than messages_synced_at (avoids 565 message fetches every cron tick).
create table if not exists ghl_conversations (
  id                 text primary key,
  contact_id         text,
  location_id        text,
  type               text,                              -- TYPE_PHONE, ...
  last_message_date  timestamptz,
  last_message_type  text,                              -- TYPE_SMS / TYPE_CALL / ...
  date_added         timestamptz,
  date_updated       timestamptz,
  raw                jsonb not null default '{}'::jsonb,
  messages_synced_at timestamptz,                       -- watermark: last time we pulled this convo's messages
  synced_at          timestamptz not null default now()
);
create index if not exists ix_ghl_conversations_contact on ghl_conversations (contact_id);
create index if not exists ix_ghl_conversations_last_msg on ghl_conversations (last_message_date);

-- 3. Messages — one row per message (SMS, call, activity). The funnel's
--    responded (inbound TYPE_SMS), called (outbound TYPE_CALL) and connected
--    (TYPE_CALL + call_status='completed' + call_duration>=90) signals all read
--    here; user_id attributes calls to a rep.
create table if not exists ghl_messages (
  id              text primary key,                     -- GHL message id
  conversation_id text,
  contact_id      text,
  location_id     text,
  message_type    text,                                 -- TYPE_SMS / TYPE_CALL / TYPE_EMAIL / TYPE_ACTIVITY_*
  direction       text,                                 -- inbound / outbound
  status          text,                                 -- delivered / completed / voicemail / no-answer / ...
  user_id         text,                                 -- rep who placed the call (calls only) -> team_members
  call_duration   int,                                  -- meta.call.duration (seconds); calls only
  call_status     text,                                 -- meta.call.status
  body            text,
  date_added      timestamptz,
  raw             jsonb not null default '{}'::jsonb,
  synced_at       timestamptz not null default now()
);
create index if not exists ix_ghl_messages_contact_date on ghl_messages (contact_id, date_added);
create index if not exists ix_ghl_messages_type_dir on ghl_messages (message_type, direction);
create index if not exists ix_ghl_messages_conversation on ghl_messages (conversation_id);

comment on table ghl_contacts is
  'Mirror of GoHighLevel contacts (the lead). Campaign membership is in source (and later tags); eoc_lead_id is the Airtable closer-report join key parsed from the "EOC From" custom field. Upserted by ingestion/ghl/pipeline.py. See docs/schema/ghl_contacts.md.';
comment on table ghl_conversations is
  'Mirror of GoHighLevel conversations. messages_synced_at is the incremental watermark driving per-conversation message re-pulls. See docs/schema/ghl_conversations.md.';
comment on table ghl_messages is
  'Mirror of GoHighLevel conversation messages (SMS + calls). responded/called/connected funnel signals read here; call_duration>=90 + call_status=completed = connected. See docs/schema/ghl_messages.md.';

alter table ghl_contacts enable row level security;
alter table ghl_conversations enable row level security;
alter table ghl_messages enable row level security;
