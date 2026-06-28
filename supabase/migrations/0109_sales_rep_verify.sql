-- 0109_sales_rep_verify.sql
-- Admin "verify new sales rep" surface (/sales-dashboard/reps).
--
-- A new sales rep enters the company in the Airtable "Sales Team Member" table
-- (base appCWa6TV6p7EBarC, tbl tblpSaR3Iq4vBBbpO). That table holds the rec id
-- (= team_members.airtable_user_id, the one join key with no sync), the name, and
-- a Job Title — but NOT email, Close ID, or Calendly. The verify page surfaces
-- each NEW Airtable rep (created on/after a forward-only cutoff), lets an admin
-- resolve the Close link + email (a Close-user picker or manual entry), pick the
-- sales role, optionally add a Calendly event-type URI, and Complete — which
-- writes the team_members row so the rep auto-appears on every per-rep surface
-- (Outbound by-rep, Talent, People, Roster) via the existing joins.
--
-- Three tables:
--   close_users            — mirror of Close /user/ (the picker source). Filled by
--                            api/close_users_sync_cron.py (which already iterates
--                            Close users daily for the team_members.close_user_id sync).
--   sales_rep_candidates   — mirror of the Airtable Sales Team Member table. Filled by
--                            api/sales_rep_candidates_sync_cron.py.
--   sales_rep_verifications — human-entered draft + final state, keyed by the Airtable
--                            rec id. Survives re-sync (the mirror crons never touch it).
--
-- RLS enabled with no policies (deny-default) to match the V1 posture — the
-- dashboard reaches these through the service-role admin client, which bypasses RLS.

-- ---------------------------------------------------------------------------
-- close_users — Close /user/ mirror, the verify-page Close-ID picker source.
-- ---------------------------------------------------------------------------
create table if not exists close_users (
  close_user_id text primary key,            -- Close "user_XXX" id
  email         text,
  first_name    text,
  last_name     text,
  full_name     text,
  is_active     boolean,
  synced_at     timestamptz not null default now()
);

create index if not exists ix_close_users_email on close_users (lower(email));

comment on table close_users is
  'Mirror of Close /user/ — the source for the sales-rep verify page''s Close-ID picker. Upserted by api/close_users_sync_cron.py (same cron that fills team_members.close_user_id by email).';

alter table close_users enable row level security;

-- ---------------------------------------------------------------------------
-- sales_rep_candidates — Airtable "Sales Team Member" mirror.
-- ---------------------------------------------------------------------------
create table if not exists sales_rep_candidates (
  airtable_record_id  text primary key,      -- the "rec..." id == team_members.airtable_user_id
  full_name           text,
  first_name          text,
  last_name           text,
  job_title           text,                  -- Airtable Job Title (Closer/Setter/Sales Manager/CSM)
  is_active           boolean,
  airtable_created_at  timestamptz,          -- Airtable record createdTime — drives the forward-only cutoff
  synced_at           timestamptz not null default now()
);

create index if not exists ix_sales_rep_candidates_created
  on sales_rep_candidates (airtable_created_at);

comment on table sales_rep_candidates is
  'Mirror of the Airtable "Sales Team Member" table (base appCWa6TV6p7EBarC, tbl tblpSaR3Iq4vBBbpO). The verify page reads forward-only rows (airtable_created_at >= cutoff) not yet mapped into team_members. Upserted by api/sales_rep_candidates_sync_cron.py.';

alter table sales_rep_candidates enable row level security;

-- ---------------------------------------------------------------------------
-- sales_rep_verifications — human draft + final verification state.
-- ---------------------------------------------------------------------------
create table if not exists sales_rep_verifications (
  airtable_record_id      text primary key,  -- the candidate being verified
  status                  text not null default 'draft'
                            check (status in ('draft', 'completed', 'deleted')),
  full_name               text,
  sales_role              text check (sales_role in ('setter', 'closer', 'dc_closer')),
  email                   text,
  close_user_id           text,
  calendly_event_type_uri text,              -- fully optional (DC closers can close by phone)
  team_member_id          uuid,              -- set on Complete (the row written to team_members)
  created_by              text,
  updated_by              text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);

create index if not exists ix_sales_rep_verifications_status
  on sales_rep_verifications (status);

comment on table sales_rep_verifications is
  'Per-Airtable-rep verify state for /sales-dashboard/reps. status: draft (Save, in progress) / completed (Complete → team_members row written, team_member_id set) / deleted (Delete → dismissed test/junk). The mirror crons never write this table.';

-- Bump updated_at on every update (mirrors the team_members trigger pattern).
create or replace function set_updated_at_sales_rep_verifications()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_sales_rep_verifications_updated_at on sales_rep_verifications;
create trigger trg_sales_rep_verifications_updated_at
  before update on sales_rep_verifications
  for each row execute function set_updated_at_sales_rep_verifications();

alter table sales_rep_verifications enable row level security;
