-- 0113_sales_bot_ro_role.sql
-- The read-only Postgres role for the sales Slack bot (text-to-SQL). This role
-- is the REAL safety boundary: the in-code guard in agents/sales_bot/sql_runner.py
-- is belt; this role + its grants are suspenders. Even if the guard is bypassed,
-- the DB itself refuses writes and anything off the sales allowlist.
--
-- The role is created LOCKED (login allowed, but NO password) so committing this
-- migration never commits a credential. The password is set OUT OF BAND, Drake-
-- gated, and stored ONLY in .env.local + Vercel env (never in code):
--
--     alter role sales_bot_ro login password '<strong-generated-password>';
--
-- Until that runs, the role cannot authenticate. See docs/runbooks/sales_bot.md
-- § Provisioning the RO role for the exact apply + dual-verify sequence.
--
-- Apply path: psycopg2 against the pooler (the careful, Drake-gated migration
-- path — local Docker makes `supabase db push` misroute; see
-- docs/sales/ingestion.md § Ops traps), then insert the ledger row into
-- supabase_migrations.schema_migrations and dual-verify against CLOUD
-- (pg_roles + a real connect AS sales_bot_ro).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'sales_bot_ro') then
    -- LOGIN but no password: the role is locked until the password is set
    -- out of band (see header). NOLOGIN would block the eventual login grant,
    -- so we grant login here and rely on the absent password as the lock.
    create role sales_bot_ro login;
  end if;
end $$;

-- Connect + schema visibility.
grant connect on database postgres to sales_bot_ro;
grant usage on schema public to sales_bot_ro;

-- Hard guardrails at the ROLE level (apply to every session this role opens):
--   read-only transactions  → no writes, ever (even if a grant slips through)
--   statement_timeout       → an 8s hard cap on any single query
--   idle-in-txn timeout     → a stuck session can't hold resources
alter role sales_bot_ro set default_transaction_read_only = on;
alter role sales_bot_ro set statement_timeout = '8000';
alter role sales_bot_ro set idle_in_transaction_session_timeout = '15000';

-- SELECT on the ALLOWLIST only — the sales-owned tables + the shared tables
-- sales legitimately reads. This list MUST stay in sync with the _ALLOW set in
-- agents/sales_bot/sql_runner.py. Default-deny: anything NOT granted here is
-- invisible to the role (relation-does-not-exist / permission-denied).
grant select on
  close_leads, close_calls, close_sms, close_lead_status_changes,
  close_opportunities, close_custom_field_definitions, close_users,
  lead_cycles, lead_cycle_stages, lead_tag_runs, engagements,
  calendly_scheduled_events, calendly_invitees, calendly_event_types,
  airtable_setter_triage_calls, airtable_full_closer_report,
  airtable_digital_college_sales, airtable_rep_eods,
  sales_rep_candidates, sales_rep_verifications,
  typeform_responses, typeform_forms, typeform_form_insights_snapshots,
  landing_pages, landing_page_forms,
  meta_ad_daily, cortana_ad_daily, cortana_campaign_daily, cortana_adset_daily,
  clarity_metrics_daily, wistia_media_daily, wistia_medias,
  setter_call_reviews, setter_call_transcripts,
  outbound_campaigns, outbound_campaign_roster, outbound_lead_facts,
  team_members
to sales_bot_ro;

-- Deliberately NOT granted (fulfillment / client-PII / agent infra):
--   clients, client_*, nps_submissions, slack_messages, slack_channels,
--   documents, document_chunks, agent_*, alerts, escalations, oauth_tokens,
--   calendar_events, calls, call_*, monthly_subscriptions, cost_extras, etc.
-- These stay OFF — that default-deny is the whole safety model. Never widen
-- this list to a fulfillment/client/PII table.
--
-- The sales SQL FUNCTIONS the bot may call (sales_funnel_counts, outbound_funnel,
-- outbound_funnel_by_rep, sales_speed_fmr, sales_rep_call_activity) are
-- SECURITY INVOKER and rely on Postgres's default PUBLIC EXECUTE grant, so they
-- run with this role's privileges and can only read the allowlisted tables they
-- touch (all granted above). No extra EXECUTE grant is needed; that invoker
-- semantics is itself a guardrail (the role can't reach a table through a
-- function that it couldn't reach directly).

-- RLS read policies. Every public table has row-level security ENABLED. The
-- owner / service role bypasses it, but sales_bot_ro does NOT — without a policy
-- the SELECT grants above return ZERO rows. Add a permissive read-only policy
-- (FOR SELECT USING (true)) scoped to this role on each allowlisted table. This
-- is least-privilege (no BYPASSRLS, which would need superuser anyway): the role
-- can only read the tables it was granted, and only via these explicit policies.
do $$
declare t text;
begin
  foreach t in array array[
    'close_leads','close_calls','close_sms','close_lead_status_changes',
    'close_opportunities','close_custom_field_definitions','close_users',
    'lead_cycles','lead_cycle_stages','lead_tag_runs','engagements',
    'calendly_scheduled_events','calendly_invitees','calendly_event_types',
    'airtable_setter_triage_calls','airtable_full_closer_report',
    'airtable_digital_college_sales','airtable_rep_eods',
    'sales_rep_candidates','sales_rep_verifications',
    'typeform_responses','typeform_forms','typeform_form_insights_snapshots',
    'landing_pages','landing_page_forms',
    'meta_ad_daily','cortana_ad_daily','cortana_campaign_daily','cortana_adset_daily',
    'clarity_metrics_daily','wistia_media_daily','wistia_medias',
    'setter_call_reviews','setter_call_transcripts',
    'outbound_campaigns','outbound_campaign_roster','outbound_lead_facts',
    'team_members'
  ] loop
    execute format('drop policy if exists sales_bot_ro_read on public.%I', t);
    execute format(
      'create policy sales_bot_ro_read on public.%I for select to sales_bot_ro using (true)', t);
  end loop;
end $$;
