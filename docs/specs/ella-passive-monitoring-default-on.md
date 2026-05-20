# Ella Passive Monitoring Default-On

**Slug:** ella-passive-monitoring-default-on
**Status:** shipped

## Context

Ella's bot is added to every client Slack channel as part of the standard onboarding workflow, but `slack_channels.passive_monitoring_enabled` defaults to `false`. The 7 Batch-1-cohort channels were flipped to `true` on 2026-05-11 as the original rollout; everything else stayed off. Drake's intent — restated this morning after the smoke test surfaced the gap — is **any channel Ella is in should be monitored**. Channels Scott isn't ready for don't have Ella added, so the "Ella present → passively monitored" invariant is the right one.

This spec makes that invariant real in two cuts:

1. **Codify it as the system default.** The Path 3 onboarding RPC (`create_or_update_client_from_onboarding`) currently inserts `slack_channels` rows with `passive_monitoring_enabled=false`. Migration changes the column default to `true` and reissues the RPC so Branch C INSERT picks it up. Every new client onboarded from this point forward lands with passive monitoring on.

2. **Bulk-flip existing channels.** One UPDATE statement sets `passive_monitoring_enabled=true` across all non-archived channels with a valid `client_id`. The `test_mode=true` channel (`#ella-test-drakeonly`) is unaffected (it's already on for test-mode runs); archived channels stay off (they're inactive, no client traffic).

The change is small but architecturally meaningful — it shifts the safe-default from "passive monitoring off until manually enabled" to "passive monitoring on for any Ella-present channel." That's correct given Drake's invariant, but worth being deliberate about: there's no per-channel quiet-period after onboarding anymore.

Concurrent with Spec 1 (`ella-decision-haiku-prompt-sharpening`) — these are independent, can ship in either order. This spec doesn't touch any agent code; only schema + data + the onboarding RPC.

## Acclimatization checklist

- `CLAUDE.md` § Working Norms, § Critical Rules
- `docs/state.md` — particularly the 2026-05-11 entry covering Batch 2.3 rollout and the per-channel toggle
- `supabase/migrations/0026_onboarding_webhook_optional_slack.sql` — current onboarding RPC body
- `supabase/migrations/0029_rename_ella_enabled_to_passive_monitoring.sql` — the rename + RPC reissue pattern to mirror
- `supabase/migrations/0030_pending_ella_responses.sql` and 0031 (`slack_channels_test_mode`) for the recent slack_channels migration neighbors
- `ingestion/slack/realtime_ingest.py:_maybe_dispatch_passive_monitor` — the gate the toggle controls

## What changes — by file

### New: `supabase/migrations/0042_slack_channels_passive_default_true.sql`

Migration number assumed `0042` (`0041` was the unanswered flagger's column additions). Builder verifies against `supabase/migrations/` before writing.

```sql
-- Migration 0042: passive_monitoring_enabled defaults to true.
--
-- Drake's invariant: any channel Ella is added to should have
-- passive monitoring on. Ella is added to client channels at
-- onboarding; channels Scott isn't ready for don't have Ella in
-- them. So "Ella present → passively monitored" is the right
-- contract.
--
-- Three changes in this migration:
--   1. ALTER COLUMN default false → true on slack_channels.
--   2. Bulk UPDATE existing non-archived client-mapped channels to
--      passive_monitoring_enabled = true.
--   3. CREATE OR REPLACE the onboarding RPC so its Branch C INSERT
--      writes passive_monitoring_enabled = true at row creation.
--      (Default would cover the omitted-column case anyway, but
--      making it explicit keeps the RPC self-documenting.)
--
-- test_mode = true channels (#ella-test-drakeonly) are unaffected.
-- Archived channels (is_archived = true) are unaffected — they're
-- not getting traffic.

-- 1. Default flip.
ALTER TABLE slack_channels
  ALTER COLUMN passive_monitoring_enabled SET DEFAULT true;

-- 2. Bulk UPDATE for existing rows.
UPDATE slack_channels
SET passive_monitoring_enabled = true
WHERE passive_monitoring_enabled = false
  AND is_archived = false
  AND client_id IS NOT NULL;

-- 3. CREATE OR REPLACE the onboarding RPC with passive=true in the
--    Branch C INSERT. Body copied from migration 0029 (post-rename
--    version), then the relevant INSERT updated.
--
-- NOTE: Builder reads the current body from migration 0029 (or the
-- most recent reissue) and applies the minimum-delta change. The
-- RPC must be reissued atomically — Postgres CREATE OR REPLACE
-- handles this safely.

-- [Builder fills in the full RPC body here, with the Branch C
-- INSERT's slack_channels insert clause changed from omitting the
-- column (relying on default) to setting passive_monitoring_enabled = true
-- explicitly. Default-flip in step 1 means omission would work too,
-- but explicit > implicit for an audit-bearing change.]
```

**Builder action items in writing this migration:**

- Read the CURRENT body of `create_or_update_client_from_onboarding` from production (via `pg_get_functiondef(oid)` or by reading migration 0029's body and any subsequent reissues). Migration 0026 made slack fields optional; 0029 renamed the column. Confirm no further reissues exist post-0029.
- Identify the slack_channels INSERT in Branch C and add `passive_monitoring_enabled` to the column list with value `true`. (Or rely on the new default; either works. Lean: be explicit.)
- Copy the rest of the RPC body verbatim.
- Wrap the migration in a transaction implicitly (Supabase migrations are transactional by default).

**Hard stop:** Builder writes the SQL, surfaces the diff to Drake in the report (gate (a)), waits for explicit "approved" before applying. The SQL has three parts; Drake reads and approves all three.

**Dual-verification post-apply:**

- **Schema reality:** `SELECT column_default FROM information_schema.columns WHERE table_name='slack_channels' AND column_name='passive_monitoring_enabled'` returns `true`.
- **Data state:** `SELECT count(*), passive_monitoring_enabled FROM slack_channels WHERE is_archived = false AND client_id IS NOT NULL GROUP BY passive_monitoring_enabled` shows 0 false, all-true count matches the non-archived client-mapped channel count.
- **RPC reality:** `pg_get_functiondef('create_or_update_client_from_onboarding'::regproc)` shows the Branch C INSERT carrying the new column or relying on the new default.
- **Ledger:** `SELECT version FROM supabase_migrations.schema_migrations WHERE version = '0042'` returns one row.

Schema doc `docs/schema/slack_channels.md` (if it exists; if not, leave it — the column is documented in the runbook) gets a one-line update noting the new default.

### Modify: `docs/agents/ella/ella.md`

The "Passive Monitoring" or "Channel Toggle" section gets updated language: passive monitoring is the default for client channels. The opt-out path (set `passive_monitoring_enabled=false` per-row) is still documented for channels where Ella shouldn't observe, but it's now an explicit opt-out rather than the default state.

### Modify: `docs/runbooks/ella_passive_monitoring.md`

Same update — the runbook's "How channels become monitored" section now reads "all client-mapped channels are monitored by default; opt-out via a per-row UPDATE." Add a one-paragraph note explaining the 2026-05-19 flip + reasoning (Ella's bot membership equals monitoring intent).

### Modify: `docs/state.md`

New entry under today's date covering this migration's shipped state: migration count 41 → 42, the bulk-flip count from the dual-verify (insert the actual number from the verify SELECT), the default-flip language.

## Tests

This migration has minimal code surface and primarily a data + schema change. Tests required:

**`tests/api/test_airtable_onboarding_webhook.py`** (extend existing):
- New client onboarded via the webhook lands with `passive_monitoring_enabled=true` in the resulting `slack_channels` row.
- Existing test_mode channels are unaffected by re-onboarding (the onboarding RPC is upsert-shaped; passive_monitoring_enabled should not be overwritten on existing rows).

**`tests/ingestion/slack/test_realtime_ingest_passive_fork.py`** (verify, modify if needed):
- The fork now finds non-test channels with `passive_monitoring_enabled=true` by default. Most existing tests probably already work; verify.

No new test files needed.

Hard stop: `pytest tests/` must not regress below the current baseline.

## Hard stops

1. **Pre-apply migration SQL review.** Builder writes the migration, runs a dry-read of the full RPC body to confirm correct interpolation, surfaces the SQL diff to Drake in the report. Wait for explicit "approved" before applying. Gate (a).

2. **Migration apply discrepancy.** Dual-verify post-apply must show schema reality + data state + RPC body + ledger all consistent. STOP if mismatched.

3. **Test suite regression.** `pytest tests/` must not regress.

4. **`tsc --noEmit` / `npm run lint`.** No TS touched; should be clean by definition. Verify.

5. **RPC body interpolation risk.** The migration depends on Builder reading the current RPC body correctly from migration 0029 (or later reissues if any). If the body has drifted since 0029 in ways Builder can't fully account for, STOP and surface — incorrectly reissuing the RPC would break onboarding for future clients.

## Smoke test gate (post-deploy)

Phase 1: immediate post-apply checks (Builder runs these, surfaces results in the report):

1. `SELECT count(*), passive_monitoring_enabled FROM slack_channels WHERE is_archived=false AND client_id IS NOT NULL GROUP BY passive_monitoring_enabled` — expect all rows in the true bucket.

2. `SELECT column_default FROM information_schema.columns WHERE table_name='slack_channels' AND column_name='passive_monitoring_enabled'` — expect `true`.

Phase 2: behavioral validation (Drake validates over the next few hours):

3. Post a message in any previously-disabled client channel (Drake picks one). Expect `agent_runs` row written within seconds with a Haiku decision.

4. Watch `/ella/runs` over the next hour — expect many more runs than yesterday's traffic, because the previously-129-disabled channels are now monitored.

Phase 3 (cron behavioral; ~2 hours):

5. The unanswered flagger cron will now see digest items from channels that previously weren't monitored. Verify it doesn't post about old test-channel pollution to `#unanswered-channels` (separate issue from this spec — flagged for a follow-up spec to add a `test_mode=false` filter).

## What could go wrong

1. **Sudden volume spike on Haiku spend.** Currently 7 channels are monitored. Flipping ~129 more on means a 15-20x increase in passive-monitor traffic immediately. Haiku is cheap but the cost-hub will show a spike. Mitigation: Ella spend baseline is ~$1.25/month; a 15x spike puts us at ~$20/month, still well under the $200/month watchpoint. Worth being aware but not blocking.

2. **Unanswered flagger generates a flood of unanswered DMs on day one.** Channels that were previously-unmonitored have client messages from earlier today that may flag and 2 hours later post to `#unanswered-channels`. Drake checks `#unanswered-channels` after the migration applies and may need to mute the channel briefly while the system catches up. Mitigation: the 7-day backstop in the flagger query prevents ancient backlog; only today's traffic flows through.

3. **Haiku misjudgments on previously-quiet channels.** Spec 1 (prompt sharpening) is concurrent; if Spec 1 hasn't shipped yet when this lands, Haiku's existing over-skip pattern affects more channels. Acceptable — Spec 1 should ship first or same-day.

4. **RPC body drift.** Worst case: Builder's RPC body interpolation misses a recent change. Mitigation: gate (a) review — Drake reads the full SQL before apply.

5. **Channels Ella isn't actually in.** Edge case: a `slack_channels` row exists with `client_id` set but Ella's bot was never actually invited to that Slack channel. The bulk flip enables monitoring at the DB level, but the realtime ingest won't fire because Slack doesn't deliver events for channels Ella isn't in. Net effect: zero traffic on those channels, no harm done. They'll start producing traffic when/if the bot is added. This is correct behavior.

## Mandatory doc updates

- `docs/state.md` — today's entry with migration 0042 details and bulk-flip count.
- `docs/agents/ella/ella.md` — passive monitoring section updated to "default on."
- `docs/runbooks/ella_passive_monitoring.md` — same update + the 2026-05-19 reasoning note.

## Done means

- Migration 0042 applied, dual-verified (schema + data + RPC + ledger), ledger registered.
- All file changes pushed to `main`, Vercel deploy successful (mostly a no-op deploy since no code changed, but the migration must apply first).
- `pytest tests/` passes, no regression.
- Phase 1 immediate smoke (count + default queries) passes.
- Spec status flipped to `shipped`.
- Report at `docs/reports/ella-passive-monitoring-default-on.md` follows 6-section structure.

Drake's gates:
- (a) Migration 0042 SQL review (3 parts) — pre-apply.
- (b) Any genuinely context-confusing decision Builder hits — surface immediately.
- (c) Phase 2 behavioral validation — Drake follow-up over the next few hours; not blocking spec completion.
- (d) None — no env vars.
