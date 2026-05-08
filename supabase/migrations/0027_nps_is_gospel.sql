-- 0027_nps_is_gospel.sql
-- Flip override-sticky semantics in update_client_from_nps_segment to
-- "NPS is gospel" + one-time backfill aligning every eligible client's
-- csm_standing with their current nps_standing.
--
-- Reverses the M5.4 / 0021 decision (Scott-confirmed behavior B —
-- "manual CSM judgment wins"). The new rule is: NPS Survey segment
-- is the source of truth for csm_standing. CSMs can still set
-- 'problem' manually because no segment maps to 'problem' — every
-- other manual override gets overwritten on the next NPS submission.
--
-- ============================================================================
-- BACKFILL EFFECT — confirmed via dry-run 2026-05-08 before apply.
-- ============================================================================
--
-- Backfill realigns 16 stale rows (14 master-sheet seeds + 2 stale
-- auto-derives, zero current CSM manual overrides per dry-run
-- 2026-05-08). Override-sticky was live from M5.4 ship (~2026-05-03)
-- through this migration — the dry-run gate before apply confirmed
-- no real human judgment was on the chopping block. The 1 'problem'
-- → 'at_risk' flip in the list (Saavan Patel) is master-sheet seed
-- origin, not a CSM-flagged issue. Future-you reading this in six
-- months: the backfill realigned a small set of stale auto-writes
-- and seed values; no manual CSM judgments were lost.
--
-- ============================================================================
-- Segment → csm_standing mapping (encoded ONLY inside the function;
-- and ALSO inside the backfill DO block — keep both call sites in sync).
-- ============================================================================
--
--   'promoter' → 'happy'
--   'neutral'  → 'content'
--   'at_risk'  → 'at_risk'
--
-- 'problem' has no auto-derive path. Manual-only.

-- ---------------------------------------------------------------------------
-- 1. Replace update_client_from_nps_segment with the always-auto-derive body
-- ---------------------------------------------------------------------------
create or replace function update_client_from_nps_segment(
  p_client_email text,
  p_segment text
) returns clients
language plpgsql
security definer
as $$
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

  -- Look up the client. Primary clients.email match first, then
  -- fallback to clients.metadata->'alternate_emails'. Case-insensitive,
  -- whitespace-stripped, mirrors CLAUDE.md § "Client Identity
  -- Resolution". Filter on archived_at IS NULL — only active clients.
  -- LIMIT 1 because alternate_emails has no DB-side uniqueness;
  -- ambiguous matches silently pick the first row (no known collisions
  -- in production data; revisit if logs ever show ambiguity).
  select id into v_client_id from clients
  where archived_at is null
    and (
      lower(trim(email)) = lower(trim(p_client_email))
      or exists (
        select 1
        from jsonb_array_elements_text(
          coalesce(metadata->'alternate_emails', '[]'::jsonb)
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
$$;

comment on function update_client_from_nps_segment is
  'Combined NPS-segment update for the V1 Airtable webhook receiver. Always writes clients.nps_standing AND always auto-derives clients.csm_standing from the segment via update_client_csm_standing_with_history (NPS-is-gospel — flipped from override-sticky in migration 0027). Looks up the client by p_client_email against clients.email primary + clients.metadata.alternate_emails fallback (case-insensitive, whitespace-stripped, archived_at IS NULL). Segment → csm_standing mapping is encoded only inside this function: promoter→happy, neutral→content, at_risk→at_risk. ''problem'' has no auto-derive path — manual-only. Idempotency on csm_standing writes is handled by the underlying 0018 RPC (no history row when value unchanged). Raises with descriptive hints on invalid segment, missing email, or no client match.';

grant execute on function update_client_from_nps_segment(text, text) to service_role;

-- ---------------------------------------------------------------------------
-- 2. One-time backfill — align every eligible client's csm_standing
-- with their current nps_standing-derived value.
-- ---------------------------------------------------------------------------
-- Eligible: archived_at IS NULL AND nps_standing IS NOT NULL.
-- Skipped silently by the underlying RPC's idempotency: clients whose
-- csm_standing already matches the derived value (no history row
-- written for a no-op).
-- Mapping kept in sync with the function above by hand — both encode
-- the same three branches.
do $$
declare
  r record;
  v_derived text;
begin
  for r in
    select id, nps_standing
    from clients
    where archived_at is null
      and nps_standing is not null
  loop
    v_derived := case r.nps_standing
      when 'promoter' then 'happy'
      when 'neutral'  then 'content'
      when 'at_risk'  then 'at_risk'
    end;

    perform update_client_csm_standing_with_history(
      r.id,
      v_derived,
      'cfcea32a-062d-4269-ae0f-959adac8f597'::uuid,
      'backfill: NPS-is-gospel migration 0027'
    );
  end loop;
end;
$$;
