-- 0029_rename_ella_enabled_to_passive_monitoring.sql
-- Ella V2 Batch 2.3 prep: rename slack_channels.ella_enabled to
-- passive_monitoring_enabled (semantic update — the dormant V1 beta
-- gate becomes the per-channel passive-monitoring kill switch in V2).
--
-- ============================================================================
-- What changes
-- ============================================================================
--
-- 1. Column rename: slack_channels.ella_enabled -> passive_monitoring_enabled.
--    No data change — pre-apply scan confirmed 0 rows have the old column
--    set to true (137 total channels). The semantic stays "Ella behaves
--    differently in this channel when true"; the V2 specifics (which
--    behavior, gated how) live in the application layer.
--
-- 2. Index reposted under the new name. The partial-index predicate
--    references the column, so a column rename does NOT auto-rewrite
--    the index expression — drop + recreate is the cleanest path.
--
-- 3. CREATE OR REPLACE the create_or_update_client_from_onboarding RPC
--    with the new column name in its slack_channels Branch C INSERT.
--    plpgsql function bodies are stored as text and parse identifiers
--    at runtime, so leaving the rename uncoupled from the RPC fix
--    would break the next onboarding event that hits Branch C
--    (fresh slack_channels INSERT — today's common path for new
--    clients). Bundling keeps the transition atomic within this
--    migration's transaction.
--
-- ============================================================================
-- Why bundled
-- ============================================================================
--
-- The clean alternative would be: 0029 = rename column, 0030 = RPC
-- realign, 0031 = pending_ella_responses table. That keeps "one logical
-- change per migration" but leaves a window where 0029 has applied and
-- 0030 hasn't — any onboarding webhook firing during that window breaks.
-- supabase db push applies migrations in order in separate transactions
-- (not one giant transaction across the whole push), so the gap is real
-- between 0029 and 0030.
--
-- The bundled shape here treats "rename the column and realign every
-- read/write to it" as ONE logical change, which it is. The Python
-- script + types.ts edits ship in the same git commit for the same
-- reason. The queue table (0030) stays a separate migration because
-- it's a genuinely independent change.

-- ---------------------------------------------------------------------------
-- 1. Column rename
-- ---------------------------------------------------------------------------
alter table slack_channels
  rename column ella_enabled to passive_monitoring_enabled;

-- ---------------------------------------------------------------------------
-- 2. Index reposted under the new name
-- ---------------------------------------------------------------------------
drop index slack_channels_ella_enabled_idx;
create index slack_channels_passive_monitoring_enabled_idx
  on slack_channels (passive_monitoring_enabled)
  where passive_monitoring_enabled = true;

comment on column slack_channels.passive_monitoring_enabled is
  'Per-channel passive-monitoring kill switch. Default false. When true and the global ELLA_PASSIVE_MONITORING_ENABLED env var is also true, Ella passively monitors client messages in this channel and may decide to respond after a delay. Independent from reactive @-mention behavior, which is always on for client-mapped channels.';

-- ---------------------------------------------------------------------------
-- 3. CREATE OR REPLACE the onboarding RPC to use the new column name
--
-- Body is reproduced verbatim from migration 0026 with one change at
-- the slack_channels Branch C INSERT: column list now references
-- `passive_monitoring_enabled` instead of `ella_enabled`. Default value
-- (false) is unchanged — onboarding-created channels stay opted out of
-- passive monitoring, matching the V1 semantic that they were opted
-- out of beta Ella behavior.
-- ---------------------------------------------------------------------------
create or replace function create_or_update_client_from_onboarding(
  p_full_name        text,
  p_email            text,
  p_phone            text,
  p_country          text,
  p_start_date       date,
  p_slack_user_id    text,
  p_slack_channel_id text,
  p_delivery_id      text
) returns jsonb
language plpgsql
security definer
as $$
declare
  v_gregory_bot         uuid := 'cfcea32a-062d-4269-ae0f-959adac8f597'::uuid;
  v_email_lower         text;
  v_active_id           uuid;
  v_archived_id         uuid;
  v_existing_id         uuid;
  v_existing_archived   boolean;
  v_existing_phone      text;
  v_existing_country    text;
  v_existing_start_date date;
  v_existing_slack_uid  text;
  v_action              text;
  v_metadata            jsonb;

  v_existing_channel_id   text;
  v_existing_channel_arch boolean;
  v_existing_channel_for  uuid;
  v_existing_channel_arch_global boolean;
begin
  -- ============================================================
  -- Validate inputs (5 required; phone / slack_user_id /
  -- slack_channel_id are optional per 0026)
  -- ============================================================
  if p_full_name is null or trim(p_full_name) = '' then
    raise exception 'create_or_update_client_from_onboarding: full_name is required';
  end if;
  if p_email is null or trim(p_email) = '' then
    raise exception 'create_or_update_client_from_onboarding: email is required';
  end if;
  if p_country is null or trim(p_country) = '' then
    raise exception 'create_or_update_client_from_onboarding: country is required';
  end if;
  if p_start_date is null then
    raise exception 'create_or_update_client_from_onboarding: start_date is required';
  end if;
  if p_delivery_id is null or trim(p_delivery_id) = '' then
    raise exception 'create_or_update_client_from_onboarding: delivery_id is required';
  end if;

  v_email_lower := lower(trim(p_email));

  -- ============================================================
  -- Match: active row first (primary email + alternate_emails)
  -- ============================================================
  select id into v_active_id
  from clients
  where archived_at is null
    and (
      lower(trim(email)) = v_email_lower
      or exists (
        select 1
        from jsonb_array_elements_text(
          coalesce(metadata->'alternate_emails', '[]'::jsonb)
        ) alt
        where lower(trim(alt)) = v_email_lower
      )
    )
  limit 1;

  if v_active_id is not null then
    v_existing_id       := v_active_id;
    v_existing_archived := false;
    v_action            := 'updated';
  else
    select id into v_archived_id
    from clients
    where archived_at is not null
      and (
        lower(trim(email)) = v_email_lower
        or exists (
          select 1
          from jsonb_array_elements_text(
            coalesce(metadata->'alternate_emails', '[]'::jsonb)
          ) alt
          where lower(trim(alt)) = v_email_lower
        )
      )
    order by archived_at desc
    limit 1;

    if v_archived_id is not null then
      v_existing_id       := v_archived_id;
      v_existing_archived := true;
      v_action            := 'reactivated';
    end if;
  end if;

  -- ============================================================
  -- Branch 1 + 2: existing client (active or archived)
  -- ============================================================
  if v_existing_id is not null then
    select phone, country, start_date, slack_user_id
      into v_existing_phone, v_existing_country, v_existing_start_date,
           v_existing_slack_uid
    from clients where id = v_existing_id;

    if p_slack_user_id is not null
       and v_existing_slack_uid is not null
       and v_existing_slack_uid <> p_slack_user_id then
      raise exception 'slack_user_id_conflict: existing=% new=%',
        v_existing_slack_uid, p_slack_user_id;
    end if;

    if p_slack_channel_id is not null
       and trim(p_slack_channel_id) <> '' then
      select slack_channel_id, is_archived
        into v_existing_channel_id, v_existing_channel_arch
      from slack_channels
      where client_id = v_existing_id
        and is_archived = false
      order by created_at desc
      limit 1;

      if v_existing_channel_id is not null
         and v_existing_channel_id <> p_slack_channel_id then
        raise exception 'slack_channel_id_conflict_for_client: existing=% new=%',
          v_existing_channel_id, p_slack_channel_id;
      end if;
    end if;

    if v_existing_archived then
      update clients
        set archived_at = null
      where id = v_existing_id;
    end if;

    perform update_client_status_with_history(
      v_existing_id,
      'active',
      v_gregory_bot,
      'onboarding form submission'
    );

    perform update_client_csm_standing_with_history(
      v_existing_id,
      'content',
      v_gregory_bot,
      'onboarding form submission'
    );

    update clients
      set
        phone         = coalesce(v_existing_phone, p_phone),
        country       = coalesce(v_existing_country, p_country),
        start_date    = coalesce(v_existing_start_date, p_start_date),
        slack_user_id = coalesce(v_existing_slack_uid, p_slack_user_id),
        tags = array(
          select distinct unnest(
            coalesce(tags, '{}'::text[]) || array['needs_review']
          )
        )
    where id = v_existing_id;

  else
    -- ============================================================
    -- Branch 3: create new client
    -- ============================================================
    v_metadata := jsonb_build_object(
      'auto_created_from_onboarding_webhook', true,
      'auto_created_from_delivery_id', p_delivery_id,
      'auto_created_at', now()
    );

    insert into clients (
      full_name, email, phone, country, start_date,
      slack_user_id, status, tags, metadata
    ) values (
      p_full_name,
      v_email_lower,
      p_phone,
      p_country,
      p_start_date,
      p_slack_user_id,
      'active',
      array['needs_review']::text[],
      v_metadata
    )
    returning id into v_existing_id;

    insert into client_status_history (
      client_id, status, changed_at, changed_by, note
    ) values (
      v_existing_id,
      'active',
      now(),
      v_gregory_bot,
      'onboarding form initial seed'
    );

    perform update_client_csm_standing_with_history(
      v_existing_id,
      'content',
      v_gregory_bot,
      'onboarding form initial seed'
    );

    v_action := 'created';
  end if;

  -- ============================================================
  -- slack_channels resolution (six branches; see 0025 / 0026 headers).
  -- Wrapped: only execute when p_slack_channel_id is non-null and
  -- non-empty. The Branch C fresh-insert now references
  -- passive_monitoring_enabled instead of ella_enabled — only change
  -- vs migration 0026.
  -- ============================================================
  if p_slack_channel_id is not null
     and trim(p_slack_channel_id) <> '' then
    select client_id, is_archived
      into v_existing_channel_for, v_existing_channel_arch_global
    from slack_channels
    where slack_channel_id = p_slack_channel_id;

    if v_existing_channel_for is not null then
      if v_existing_channel_for = v_existing_id then
        if v_existing_channel_arch_global then
          update slack_channels
            set is_archived = false
          where slack_channel_id = p_slack_channel_id;
        end if;
      else
        raise exception 'slack_channel_id_owned_by_different_client: client_id=%',
          v_existing_channel_for;
      end if;
    else
      if exists (
        select 1 from slack_channels
        where slack_channel_id = p_slack_channel_id
          and client_id is null
      ) then
        update slack_channels
          set client_id = v_existing_id, is_archived = false
        where slack_channel_id = p_slack_channel_id;
      else
        insert into slack_channels (
          slack_channel_id, client_id, name, is_private, is_archived,
          passive_monitoring_enabled, metadata
        ) values (
          p_slack_channel_id,
          v_existing_id,
          p_full_name,
          false,
          false,
          false,
          jsonb_build_object('created_via', 'onboarding_webhook')
        );
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'client_id', v_existing_id,
    'action', v_action
  );
end;
$$;

comment on function create_or_update_client_from_onboarding is
  'Path 3 inbound RPC (Airtable onboarding form). Match-or-create on email (primary + metadata.alternate_emails, case-insensitive). Three branches: active match -> updated; archived match -> reactivated; no match -> created. Required inputs: full_name, email, country, start_date, delivery_id. Optional inputs (0026): phone, slack_user_id, slack_channel_id. Re-fire flow: first submission without slack IDs creates the client; later re-fire with slack IDs populated backfills slack_user_id (NULL-only) and creates a fresh slack_channels row via Branch C. Status seeded via direct insert (column NOT NULL DEFAULT precludes RPC-driven seed); csm_standing seeded via RPC (nullable column). Slack ID conflicts raise structured exceptions the receiver translates to HTTP 409. needs_review tag appended idempotently via DISTINCT-on-unnest. Audit attribution via Gregory Bot UUID cfcea32a-062d-4269-ae0f-959adac8f597 with grep-friendly note strings (''onboarding form initial seed'' for create, ''onboarding form submission'' for update/reactivate). 0029 update: slack_channels Branch C INSERT now references passive_monitoring_enabled (renamed from ella_enabled in the same migration).';

grant execute on function create_or_update_client_from_onboarding(
  text, text, text, text, date, text, text, text
) to service_role;
