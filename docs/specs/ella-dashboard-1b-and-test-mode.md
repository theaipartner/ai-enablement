# Dashboard 1b fix + test_mode boolean for passive smoke testing
**Slug:** ella-dashboard-1b-and-test-mode
**Status:** in-flight

## Context

Two bundled changes informed by the 2026-05-11 post-rollout investigation (`docs/reports/ella-v2-batch-2-3-postrollout-investigation.md`):

**Change 1 — fix the `/ella/runs` audit dashboard rendering for passive_monitor runs.** Investigation found that `lib/db/ella-runs.ts` reads `trigger_metadata` keys written by the reactive @-mention path (`channel`, `real_author_role`, `real_author_name`, `thread_ts`) — but the passive-monitor path writes a different shape (`triggering_slack_channel_id`, `author_type`, `triggering_message_slack_user_id`, etc.). Every passive_monitor run renders "unknown / unknown" on the dashboard. Systematic, not Drake-specific. The audit dashboard is blind to passive runs.

**Change 2 — add a per-channel `test_mode` boolean so Drake can smoke-test passive monitoring as a team_member.** The passive monitor's Gate 2 (`author_type='client'` only) is correct production design — passive monitor watches client channels for client questions, not team-member coordination. But this design blocks Drake from validating Ella as himself: every test he runs in `#ella-test-drakeonly` skips with `non_client_author`. The test_mode boolean opts a single channel into "team_member messages also trigger passive monitor" so Drake can validate the four Haiku outcomes (`respond_substantive` / `respond_general_inquiry` / `skip` / `escalate`) live before tomorrow's wider rollout. Default false everywhere; flipped on for `#ella-test-drakeonly` only.

**Issue 2 from the investigation (cost-today rendering zero) is explicitly DEFERRED per Drake's call.** Don't fix in this spec. Don't sneak it in. The fix is small but it's tomorrow's work.

**Bundle rationale.** Both changes are small, both prep for tomorrow's morning validation + 7-channel rollout, both touch the dashboard surface. Single Builder session lands them cleanly. Independence rule (§ CLAUDE.md Director behavior): the two changes are functionally independent (1b is read-side dashboard, test_mode is write-side schema + gate logic), but operationally sequential and co-required for tomorrow's workflow. Acceptable bundle per the rule's "related or sequential tasks" criterion.

## Acclimatization checklist — confirm in 4-5 bullets before any writes

1. **Read `docs/reports/ella-v2-batch-2-3-postrollout-investigation.md`** in full. The Issue 1b root-cause analysis (§ Verification → Issue 1b) names the exact dashboard query lines and the key-name mismatch. The Issue 1a finding (clients-only design) is what the test_mode boolean is opening a controlled exception for.
2. **Read `lib/db/ella-runs.ts`** — specifically the `extractTriggerField` callers at lines ~303, 321, 322, 371, 468, 469, 533, 568 (per investigation report), AND the surrounding query shape that joins on `slack_channels` / `clients` / `team_members` for display-name resolution. Confirm the join pattern exists; the 1b fix will need a similar join for `triggering_message_slack_user_id` if the read-side fix goes that route.
3. **Read `agents/ella/passive_dispatch.py:persist_passive_evaluation`** — specifically the `trigger_metadata` dict construction. Confirm the keys the investigation report lists (`triggering_slack_channel_id`, `triggering_message_slack_user_id`, `triggering_message_ts`, `channel_client_id`, `author_type`, `haiku_decision`, `haiku_reasoning`, `skip_reason`) are what's actually written. For the test_mode runs, you'll add `test_mode_run: true` here when the channel's test_mode is on.
4. **Read `agents/ella/passive_monitor.py`** — specifically Gate 2 (the `non_client_author` skip). The test_mode bypass goes here: when the channel has `test_mode=true`, accept `team_member` in addition to `client`. Do NOT accept `ella`, `bot`, `workflow`, or `unknown` even under test_mode — those should always skip (Ella responding to her own posts, or to system messages, is undesirable regardless of mode).
5. **Read `supabase/migrations/0029_rename_ella_enabled_to_passive_monitoring.sql`** and `0030_pending_ella_responses.sql` for the migration pattern this batch should mirror. New migration 0031 adds the `test_mode` column following the same shape.

## Goal

Ship two co-required changes so Drake can: (1) see passive-monitor runs cleanly on the audit dashboard tomorrow morning, AND (2) smoke-test Ella as himself in `#ella-test-drakeonly` before flipping passive monitoring on for 7 production client channels.

## What success looks like

### Change 1 — fix dashboard rendering for passive_monitor runs

**Approach: read-side fix.** Modify `lib/db/ella-runs.ts` so the dashboard reads from EITHER the reactive-shape or passive-shape keys in `trigger_metadata`, depending on which is present. This fixes every existing AND future passive_monitor row with no data backfill needed.

Director's calls within the read-side approach (revert if you disagree, but execute these as the default):

- **`team_member` author_type renders as "advisor"** in the dashboard, matching the Batch 1.5 vocabulary (`'client' | 'advisor' | 'unresolvable'`). Mapping: `client` → "client", `team_member` → "advisor", `ella` → "ella", `bot`/`workflow` → "system", `unknown` → "unresolvable". These map to whatever the dashboard's existing role-pill component expects; mirror the reactive path's value vocabulary.
- **Author name lookup at query time** via join against `clients` / `team_members`. Mirror the existing dashboard pattern for channel-name resolution (which already does this — if it doesn't, surface and Director adjusts). The slack_user_id from `trigger_metadata.triggering_message_slack_user_id` resolves first against `clients.slack_user_id` (returns `full_name`), falling back to `team_members.slack_user_id` (returns `full_name`), falling back to displaying the raw slack_user_id with a "unresolved" label.
- **Channel name lookup at query time** via join against `slack_channels.slack_channel_id` → `slack_channels.name`. If the channel mapping doesn't exist (shouldn't happen for passive runs, but defensive), display the raw `slack_channel_id` with an "unresolved" label.

**Specific changes in `lib/db/ella-runs.ts`:**

1. **`extractTriggerField` callers (lines ~303, 371, 533, 568) that read `'channel'`:** extend to also try `'triggering_slack_channel_id'`. Helper function or inline OR-chain — Builder's call, keep it readable.
2. **`extractTriggerField` callers (lines ~321, 468) that read `'real_author_role'`:** extend to also derive from `'author_type'` when `real_author_role` is absent. Apply the mapping above.
3. **`extractTriggerField` callers (lines ~322, 469) that read `'real_author_name'`:** extend to look up the name via the slack_user_id join when `real_author_name` is absent.
4. **`extractTriggerField` callers (lines ~177, 377) that read `'thread_ts'`:** when reading from a passive run (no thread_ts present), the surrounding-thread-context query at line ~382 (per investigation report) should not fire. Either skip the thread context block entirely for passive runs OR render "passive monitor decision — no thread context applicable" as a clean fallback. Builder picks the less-churn option; the goal is the detail page renders cleanly, not blank.
5. **Verify the changes don't break reactive @-mention runs.** The reactive shape still has all the original keys; the fix should be additive (extra fallback reads, not replaced reads). Sample 3-5 recent reactive runs post-edit and confirm they still render correctly.

**Out of scope for the dashboard fix:**
- Issue 2 (cost-today timezone). Explicitly deferred. Do NOT modify the `getEllaSummaryStats` query.
- Polish around how passive run detail pages handle the absent thread context (small UX call, defer to next iteration).
- The anomaly types explainer documentation. Director writes this separately.

### Change 2 — `test_mode` boolean on `slack_channels`

**Migration 0031.** Add `test_mode boolean default false` to `slack_channels`. No index (low cardinality, queried alongside `passive_monitoring_enabled` which already has its own partial index). Comment the column purpose explicitly:

```sql
alter table slack_channels
  add column test_mode boolean not null default false;

comment on column slack_channels.test_mode is
  'Per-channel test mode for passive monitoring. When true, the passive monitor''s author-type gate accepts team_member messages in addition to client messages, so Drake can smoke-test Ella as himself. Default false. NEVER enable on a production client channel — test_mode runs are tagged in agent_runs.trigger_metadata.test_mode_run=true for audit-filter purposes, but the design intent is one test channel at a time.';
```

**Gate 2 bypass in `agents/ella/passive_monitor.py`.** When the channel record has `test_mode=true`, the author-type gate accepts BOTH `client` AND `team_member`. Explicitly does NOT accept `ella`, `bot`, `workflow`, `unknown` — those skip regardless of test_mode. The bypass logic should be a small, readable change to whichever function evaluates Gate 2; flag in the report which function it landed in.

**Tag test_mode runs in `agents/ella/passive_dispatch.py:persist_passive_evaluation`.** When the channel record carries `test_mode=true`, write `test_mode_run: true` into the `trigger_metadata` dict. This keeps the audit trail honest — future audit queries can filter `trigger_metadata->>'test_mode_run' = 'true'` to see only test-mode runs, or `trigger_metadata->>'test_mode_run' IS NULL` to see real production passive runs only.

**Flip test_mode on for `#ella-test-drakeonly`.** Either a one-line UPDATE in the migration itself (cleanest — same transaction as the column add), OR document the UPDATE as a post-apply step in the runbook for Drake to run. **Migration-internal UPDATE is the cleaner path** since it makes the test channel immediately usable post-apply with no follow-up SQL. Channel id: `C0AUWL20U8J` (from the investigation report's verification queries). Builder confirms via SELECT before writing the UPDATE — defensive verification that the channel is what we think it is.

**Migration shape:**

```sql
alter table slack_channels
  add column test_mode boolean not null default false;

comment on column slack_channels.test_mode is '...';

-- Enable test_mode on #ella-test-drakeonly so Drake can smoke-test the
-- four Haiku outcomes as himself before flipping passive_monitoring_enabled
-- on for production client channels. Channel id captured from
-- docs/reports/ella-v2-batch-2-3-postrollout-investigation.md.
update slack_channels
   set test_mode = true
 where slack_channel_id = 'C0AUWL20U8J'
   and name = 'ella-test-drakeonly';  -- defensive double-check
```

The `name = '...'` clause in the UPDATE is defensive — if the channel was archived or repurposed between report-write and migration-apply, the UPDATE silently affects zero rows rather than flipping test_mode on the wrong channel. Builder verifies the WHERE matches exactly one row before applying.

### Runbook update: morning validation procedure

Update `docs/runbooks/ella_passive_monitoring.md` with a new section:

```markdown
## Smoke testing in #ella-test-drakeonly

Per-channel `test_mode=true` allows team_member messages (e.g. Drake) to
trigger passive monitor in this one channel. Used for validating the four
Haiku decision outcomes before expanding passive monitoring to production
client channels.

To validate:

1. Confirm test_mode is on:
   ```sql
   SELECT slack_channel_id, name, passive_monitoring_enabled, test_mode
     FROM slack_channels WHERE slack_channel_id = 'C0AUWL20U8J';
   ```
   Both `passive_monitoring_enabled` and `test_mode` should be `true`.

2. Post test messages designed to exercise each Haiku outcome:
   - **`respond_substantive` test:** a question the channel-mapped client's KB clearly answers (e.g., "what's the best opener for cold calls" if the client has cold-call training content).
   - **`respond_general_inquiry` test:** a vague "anyone there?" or "hey, can someone help me with something" — general availability ping with no KB hook.
   - **`skip` test:** off-topic chatter ("lol that meeting was wild") — nothing for Ella to do.
   - **`escalate` test:** sensitive content phrasing — "I've been thinking about cancelling" or similar billing/cancellation language.

3. Watch the `/ella/runs` dashboard after each post. Within 1-2 minutes, the
   decision row appears with `trigger_type='passive_monitor'` and the matching
   `haiku_decision` value in `trigger_metadata`. For `respond_*` decisions,
   a second row appears (the cron-drain row) with `trigger_type='passive_substantive'`
   or `'passive_general_inquiry'` when Ella actually posts.

4. Filter audit queries to exclude test_mode runs when computing production metrics:
   ```sql
   -- Real production passive decisions only
   SELECT count(*) FROM agent_runs
    WHERE agent_name='ella' AND trigger_type='passive_monitor'
      AND (trigger_metadata->>'test_mode_run' IS NULL
        OR trigger_metadata->>'test_mode_run' != 'true');
   ```

Disable test_mode when production rollout begins to keep the test channel
clean for future ad-hoc testing — or leave on indefinitely for ongoing
smoke testing, Drake's call.
```

## Hard stops

- **Dashboard fix breaks reactive @-mention rendering.** Sample 3-5 recent reactive runs post-edit and confirm they still render correctly (real_author_role + channel name both populated). If reactive rendering changes, revert and surface.
- **Migration 0031 affects more than one channel via the inline UPDATE.** The `WHERE slack_channel_id = 'C0AUWL20U8J' AND name = '...'` should match exactly one row. SELECT first to confirm. If zero rows match (channel renamed or archived) or more than one row matches (unexpected) — STOP, surface, don't apply.
- **Gate 2 bypass changes behavior for non-test-mode channels.** The bypass must be strictly conditional on `slack_channels.test_mode=true`. Default-false on every other channel means default behavior is preserved. Test this with at least one unit test against a non-test-mode channel confirming team_member still skips.
- **Test_mode runs not tagged in trigger_metadata.** The `test_mode_run: true` flag is the only way to filter test runs out of production audit queries — must be written reliably.
- **Issue 2 (cost-today) sneaking into this spec.** Don't fix it. Don't touch `getEllaSummaryStats`. Don't add `Number()` casts to llm_cost_usd reads. Deferred per Drake's call.

## What could go wrong

- **The dashboard's existing channel-name and author-name resolution pattern might NOT use a query-time join.** If it's a denormalized snapshot stored elsewhere (e.g., cached on `agent_runs` rows directly), the read-side fix shape changes. Discover this during acclimatization step 2 and adapt — if there's no existing join pattern, fall back to write-side: have `persist_passive_evaluation` snapshot the channel name and author name at write time. Surface the choice in the report.
- **Smart_quotes or formatting drift in the migration SQL** if Builder copy-pastes from this spec via a non-plain-text path. Hand-type the SQL or use ASCII-only quotes; verify before push.
- **Multiple `extractTriggerField` callers might have inconsistent fallback chains.** The fix should be consistent across all callers. Consider extracting the OR-chain logic into a helper (e.g., `extractChannel(meta)`, `extractAuthorRole(meta)`, `extractAuthorName(meta)`) so the rule is in one place. Builder's call on whether the helper extraction is worth it for 4-8 callers.
- **The `team_member` → `'advisor'` mapping might collide with existing dashboard logic** that treats `'advisor'` as a specific Batch-1.5-resolved role. Verify that mapping doesn't trigger downstream filters or pills inappropriately.
- **Migration apply produces side effects beyond the column add.** The inline UPDATE on `#ella-test-drakeonly` is the only intended write. Confirm via dry-run that no other rows are affected, no constraints fire, no triggers cascade.
- **The `test_mode` column NOT NULL DEFAULT false** behavior on existing rows. Postgres backfills existing rows with the default at column-add time, but the operation can be slow on large tables. `slack_channels` is small (~8 rows today, 137 max client channels) so this is trivial — but worth confirming the migration runs in <1 second.
- **Drake forgets to disable test_mode after validation.** Won't break production behavior (test_mode only affects the test channel), but it does mean future audit queries on that channel mix test and non-test runs. Runbook mentions but doesn't enforce; acceptable.

## Mandatory doc updates

- **`docs/runbooks/ella_passive_monitoring.md`** — new "Smoke testing in #ella-test-drakeonly" section per the runbook template above.
- **`docs/schema/slack_channels.md`** — add `test_mode` to the columns list with the comment text from the migration.
- **`CLAUDE.md` § Live System State** — update the Batch 2.3 entry's "Dual kill switches" paragraph to mention the test_mode bypass: `+ slack_channels.test_mode boolean default false bypasses Gate 2 for team_member messages on flagged channels (for Drake's smoke testing only; tagged in trigger_metadata.test_mode_run for audit-filter purposes)`. Add migration 0031 to the migrations list.
- **NOT updated:** `docs/specs/ella-v2-batch-2-3-passive-monitoring.md` (already in-flight, will be cleaned up by Drake at EOD); `docs/agents/ella/ella.md` (defer; anomaly types explainer is Director's separate work and the test_mode design isn't user-facing behavior for Ella's audience). Explicitly say "no update" in the report so Drake sees the deliberate skip.

## Commit shape

Suggested:

1. `migration 0031: add slack_channels.test_mode boolean + enable on #ella-test-drakeonly`
2. `fix(ella-passive): tag test_mode runs in trigger_metadata + bypass Gate 2 when channel.test_mode=true`
3. `fix(dashboard): read passive trigger_metadata shape in /ella/runs + map author_type to role display`
4. `docs: runbook section for smoke testing + schema doc + CLAUDE.md`
5. Final report commit.

If commits split further sensibly, let them. The principle is one logical change per commit.

Report at `docs/reports/ella-dashboard-1b-and-test-mode.md` per the spec/report convention.

After report lands, Drake does the morning validation per the runbook, then flips passive_monitoring_enabled on the 7 production client channels.
