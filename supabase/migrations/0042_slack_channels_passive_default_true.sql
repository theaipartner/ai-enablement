-- 0042_slack_channels_passive_default_true.sql
-- Default passive monitoring to ON for all client channels.
--
-- Drake's invariant: any Slack channel Ella is added to should be
-- passively monitored. Ella is added to client channels at
-- onboarding; channels Scott isn't ready for don't have Ella in
-- them. So "Ella present → passively monitored" is the right
-- contract. This migration codifies it as the system default and
-- flips the 130+ pre-existing channels that were created with the
-- old default=false.
--
-- Three parts (all in one transactional migration):
--   1. ALTER COLUMN default false → true on slack_channels.
--   2. Bulk UPDATE existing non-archived, client-mapped channels
--      whose passive_monitoring_enabled was false → true.
--      `is_archived = true` rows and `client_id IS NULL` rows
--      (unmapped) are intentionally left alone.
--   3. CREATE OR REPLACE the onboarding RPC
--      `create_or_update_client_from_onboarding` so Branch C's
--      INSERT into slack_channels writes passive_monitoring_enabled
--      = true explicitly (the default-flip in part 1 would cover
--      the omitted-column case too, but explicit > implicit for an
--      audit-bearing path).
--
-- Body of the RPC is COPIED VERBATIM from migration 0029 (the
-- most-recent reissue — confirmed byte-equal against
-- pg_get_functiondef on cloud pre-apply, no drift since 0029); the
-- only delta is the 3rd `false` in Branch C's VALUES tuple
-- (passive_monitoring_enabled position) → `true`, and the trailing
-- COMMENT ON FUNCTION text appends a 0042 audit suffix mirroring
-- the 0029 pattern.
--
-- test_mode = true channels (e.g. #ella-test-drakeonly) and archived
-- channels are intentionally unaffected by the bulk UPDATE.
--
-- Spec: docs/specs/ella-passive-monitoring-default-on.md.

-- 1. Default flip.
alter table slack_channels
  alter column passive_monitoring_enabled set default true;

-- 2. Bulk UPDATE for existing rows.
update slack_channels
   set passive_monitoring_enabled = true
 where passive_monitoring_enabled = false
   and is_archived = false
   and client_id is not null;

-- 3. CREATE OR REPLACE the onboarding RPC (full body verbatim from
--    0029 + the one-value flip + a comment-text append). See header.

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
          true,
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
  'Path 3 inbound RPC (Airtable onboarding form). Match-or-create on email (primary + metadata.alternate_emails, case-insensitive). Three branches: active match -> updated; archived match -> reactivated; no match -> created. Required inputs: full_name, email, country, start_date, delivery_id. Optional inputs (0026): phone, slack_user_id, slack_channel_id. Re-fire flow: first submission without slack IDs creates the client; later re-fire with slack IDs populated backfills slack_user_id (NULL-only) and creates a fresh slack_channels row via Branch C. Status seeded via direct insert (column NOT NULL DEFAULT precludes RPC-driven seed); csm_standing seeded via RPC (nullable column). Slack ID conflicts raise structured exceptions the receiver translates to HTTP 409. needs_review tag appended idempotently via DISTINCT-on-unnest. Audit attribution via Gregory Bot UUID cfcea32a-062d-4269-ae0f-959adac8f597 with grep-friendly note strings (''onboarding form initial seed'' for create, ''onboarding form submission'' for update/reactivate). 0029 update: slack_channels Branch C INSERT now references passive_monitoring_enabled (renamed from ella_enabled in the same migration). 0042 update: Branch C INSERT now writes passive_monitoring_enabled=true at row creation (Drake''s invariant: any channel Ella is added to should be passively monitored).';

grant execute on function create_or_update_client_from_onboarding(
  text, text, text, text, date, text, text, text
) to service_role;
