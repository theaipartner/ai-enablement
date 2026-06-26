-- 0100_nps_rpc_guard_alternate_emails.sql
-- Harden update_client_from_nps_segment against malformed metadata.alternate_emails.
--
-- The email-lookup fallback ran jsonb_array_elements_text() over every active
-- client's metadata.alternate_emails while scanning for a match. If ANY active
-- client had alternate_emails stored as a JSON scalar (e.g. a double-encoded
-- string "[]" instead of the array []), the scan threw
-- `cannot extract elements from a scalar` (SQLSTATE 22023) — order-dependent and
-- intermittent, so the live NPS webhook could 500 for an unrelated client's
-- submission depending on the query plan. (Three such rows were found + repaired
-- on 2026-06-25; this guard prevents recurrence regardless of how the bad value
-- got written.)
--
-- Fix: only expand alternate_emails when it is actually a JSON array; any other
-- type (string / object / number / null) is treated as an empty array. This
-- replaces the prior coalesce(..., '[]') which only handled the NULL case.
--
-- Pure logic hardening: behavior is identical for well-formed array data; only
-- the malformed-scalar error path changes (now a clean no-match instead of a raise).

create or replace function public.update_client_from_nps_segment(p_client_email text, p_segment text)
returns clients
language plpgsql
security definer
as $function$
declare
  v_client_id uuid;
  v_derived_csm_standing text;
  v_updated clients%rowtype;
begin
  -- Validate inputs.
  if p_client_email is null or trim(p_client_email) = '' then
    raise exception 'update_client_from_nps_segment: client_email is required'
      using hint = 'Provide a non-empty email string';
  end if;

  if p_segment is null
     or p_segment not in ('promoter', 'neutral', 'at_risk') then
    raise exception 'update_client_from_nps_segment: invalid segment %', p_segment
      using hint = 'Allowed values: promoter, neutral, at_risk';
  end if;

  -- Look up the client. Primary clients.email match first, then fallback to
  -- clients.metadata->'alternate_emails'. Case-insensitive, whitespace-stripped,
  -- mirrors CLAUDE.md § "Client Identity Resolution". Filter on archived_at IS
  -- NULL — only active clients. LIMIT 1 because alternate_emails has no DB-side
  -- uniqueness; ambiguous matches silently pick the first row (no known
  -- collisions in production data; revisit if logs ever show ambiguity).
  --
  -- The CASE guard ensures jsonb_array_elements_text only ever runs against a
  -- real JSON array; a malformed scalar (or null/object) is treated as empty so
  -- a single bad row can't abort the whole scan (SQLSTATE 22023).
  select id into v_client_id from clients
  where archived_at is null
    and (
      lower(trim(email)) = lower(trim(p_client_email))
      or exists (
        select 1
        from jsonb_array_elements_text(
          case
            when jsonb_typeof(metadata->'alternate_emails') = 'array'
              then metadata->'alternate_emails'
            else '[]'::jsonb
          end
        ) alt
        where lower(trim(alt)) = lower(trim(p_client_email))
      )
    )
  limit 1;

  if v_client_id is null then
    raise exception 'update_client_from_nps_segment: no active client matches email %', p_client_email
      using hint = 'Check primary email and clients.metadata.alternate_emails';
  end if;

  -- Always mirror the segment to clients.nps_standing.
  update clients set nps_standing = p_segment where id = v_client_id;

  -- NPS-is-gospel: always auto-derive csm_standing from the segment.
  -- The override-sticky branch from 0021 is gone — every segment write
  -- propagates to csm_standing unconditionally. Idempotency is handled
  -- inside update_client_csm_standing_with_history (no history row
  -- written when the value is unchanged).
  v_derived_csm_standing := case p_segment
    when 'promoter' then 'happy'
    when 'neutral'  then 'content'
    when 'at_risk'  then 'at_risk'
  end;

  perform update_client_csm_standing_with_history(
    v_client_id,
    v_derived_csm_standing,
    'cfcea32a-062d-4269-ae0f-959adac8f597'::uuid,
    'auto-derived from NPS segment ' || p_segment || ' (NPS-is-gospel)'
  );

  -- Re-SELECT to capture post-update state.
  select * into v_updated from clients where id = v_client_id;
  return v_updated;
end;
$function$;

comment on function public.update_client_from_nps_segment(text, text) is
  'NPS-is-gospel: mirror an NPS segment to clients.nps_standing and auto-derive csm_standing (with history). Email match falls back to metadata.alternate_emails, guarded against non-array values (0100).';
