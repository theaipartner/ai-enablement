-- 0031_slack_channels_test_mode.sql
-- Ella V2 Batch 2.3 follow-up: add per-channel `test_mode` boolean for
-- smoke-testing passive monitoring as a team_member.
--
-- ============================================================================
-- Why this column
-- ============================================================================
--
-- The passive monitor's author-type gate (Gate 2) skips every non-`client`
-- message by design — passive monitor watches client channels for client
-- questions, not for CSM coordination. Production-correct behavior. But it
-- blocks Drake from validating Ella's four Haiku decision outcomes as
-- himself: every test he runs in #ella-test-drakeonly skips with
-- `non_client_author`.
--
-- The `test_mode` boolean opts a single channel into "team_member messages
-- also trigger passive monitor" so Drake can validate the four outcomes
-- live before flipping passive_monitoring_enabled on for production client
-- channels.
--
-- The application-layer Gate 2 bypass in `agents/ella/passive_monitor.py`
-- accepts ONLY `client` AND `team_member` under test_mode — `ella`, `bot`,
-- `workflow`, `unknown` continue to skip regardless of test_mode (Ella
-- responding to her own posts or to system messages is undesirable in
-- every mode).
--
-- Test-mode runs are tagged in `agent_runs.trigger_metadata.test_mode_run`
-- = true so future audit queries can filter test traffic out of production
-- metrics:
--
--   -- Real production passive decisions only:
--   SELECT count(*) FROM agent_runs
--    WHERE agent_name='ella' AND trigger_type='passive_monitor'
--      AND (trigger_metadata->>'test_mode_run' IS NULL
--        OR trigger_metadata->>'test_mode_run' != 'true');
--
-- ============================================================================
-- Why no index
-- ============================================================================
--
-- Low cardinality (one channel today; at most a handful ever). Always
-- queried alongside `passive_monitoring_enabled` which already has its
-- own partial index. Adding an index here would be overhead for zero
-- benefit. slack_channels is ~137 rows max; sequential scan is fine.

alter table slack_channels
  add column test_mode boolean not null default false;

comment on column slack_channels.test_mode is
  'Per-channel test mode for passive monitoring. When true, the passive monitor''s author-type gate accepts team_member messages in addition to client messages, so Drake can smoke-test Ella as himself. Default false. NEVER enable on a production client channel — test_mode runs are tagged in agent_runs.trigger_metadata.test_mode_run=true for audit-filter purposes, but the design intent is one test channel at a time.';

-- Enable test_mode on #ella-test-drakeonly so Drake can smoke-test the
-- four Haiku outcomes as himself before flipping passive_monitoring_enabled
-- on for production client channels. Channel id captured from
-- docs/reports/ella-v2-batch-2-3-postrollout-investigation.md.
--
-- Defensive WHERE: matches BOTH the slack_channel_id AND the name so a
-- channel rename/archive between report-write and migration-apply
-- silently no-ops rather than flipping test_mode on the wrong channel.
-- Builder verified pre-apply that exactly 1 row matches this predicate.
update slack_channels
   set test_mode = true
 where slack_channel_id = 'C0AUWL20U8J'
   and name = 'ella-test-drakeonly';
