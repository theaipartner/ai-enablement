# Report: Dashboard 1b fix + test_mode boolean for passive smoke testing
**Slug:** ella-dashboard-1b-and-test-mode
**Spec:** docs/specs/ella-dashboard-1b-and-test-mode.md

## 1. Files touched

**Created:**
- `supabase/migrations/0031_slack_channels_test_mode.sql` — add `test_mode boolean NOT NULL DEFAULT false` on `slack_channels`, comment the column, inline UPDATE enabling it on `#ella-test-drakeonly`.
- `docs/reports/ella-dashboard-1b-and-test-mode.md` — this report.

**Modified:**
- `ingestion/slack/realtime_ingest.py` — `_lookup_channel` SELECT extended to include `test_mode`; `_maybe_dispatch_passive_monitor` threads it into the `PassiveTriggerPayload`.
- `agents/ella/passive_monitor.py` — `PassiveTriggerPayload` gains a `test_mode: bool = False` field; Gate 2 now uses `allowed_types = ('client', 'team_member') if payload.test_mode else ('client',)`.
- `agents/ella/passive_dispatch.py` — `persist_passive_evaluation` stamps `trigger_metadata.test_mode_run = True` when `payload.test_mode` is True.
- `lib/db/ella-runs.ts` — new helpers `extractChannelId`, `extractAuthorRole`, `extractAuthorName`, `fetchUserNameMap`. All call sites that read `'channel'` / `'real_author_role'` / `'real_author_name'` from `trigger_metadata` now route through the helpers, so both reactive (Batch 1.5) and passive (Batch 2.3) key shapes resolve.
- `lib/supabase/types.ts` — hand-edit: add `test_mode: boolean` to the `slack_channels` Row/Insert/Update interfaces.
- `tests/agents/ella/test_passive_monitor.py` — +3 tests: `test_test_mode_accepts_team_member`, `test_test_mode_still_rejects_ella_author`, `test_test_mode_default_false_keeps_production_behavior`.
- `tests/agents/ella/test_passive_dispatch.py` — +2 tests: `test_test_mode_run_tagged_in_trigger_metadata`, `test_production_run_does_not_carry_test_mode_run_flag`. `_payload()` helper gains `test_mode=False` default param.
- `docs/runbooks/ella_passive_monitoring.md` — new "Smoke testing in #ella-test-drakeonly" section.
- `docs/schema/slack_channels.md` — `test_mode` column documented; example queries extended.
- `CLAUDE.md` — migration count 30 → 31; Batch 2.3 Live System State entry extended with the test_mode bypass + dashboard read-side fix; Next Session Priorities #1 rewritten as the smoke-test rollout checklist.

**Not modified (deliberate per spec § Mandatory doc updates):**
- `docs/specs/ella-v2-batch-2-3-passive-monitoring.md` — in-flight; Drake's EOD cleanup.
- `docs/agents/ella/ella.md` — anomaly types explainer is Director's separate work; test_mode isn't user-facing for Ella's audience.

## 2. What I did, in plain English

Walked the acclimatization checklist. Verified migration UPDATE target matches exactly 1 row (`slack_channel_id='C0AUWL20U8J' AND name='ella-test-drakeonly'`) and that the column doesn't yet exist. Surfaced the SQL for Drake's gate (a) review.

Applied migration 0031 via `supabase db push --linked` after Drake's approval. Dual-verified post-apply: column present (`test_mode boolean NOT NULL DEFAULT false`); ella-test-drakeonly row flipped to `test_mode=true`; 136 other slack_channels rows stayed at the default `false`; ledger advanced to 0031.

For the test_mode bypass, threaded the channel-level flag from the ingest layer through the passive monitor pipeline:
- `_lookup_channel` SELECT picks up `test_mode` alongside the existing `passive_monitoring_enabled`.
- `PassiveTriggerPayload` gains `test_mode: bool = False` (default keeps backwards-compat with tests that don't pass it explicitly).
- Gate 2's old `if payload.author_type != "client"` becomes `allowed_types = ('client', 'team_member') if payload.test_mode else ('client',)` then `if payload.author_type not in allowed_types`. `ella`, `bot`, `workflow`, `unknown` still skip regardless of test_mode — Ella responding to her own posts or to system messages is undesirable in every mode.
- `persist_passive_evaluation` stamps `trigger_metadata.test_mode_run = True` when the payload carries `test_mode=True`. Production passive runs never carry the flag, so audit queries like `WHERE trigger_metadata->>'test_mode_run' IS NULL` reliably select production traffic only.

For the dashboard read-side fix (Issue 1b from the post-rollout investigation), added four new helpers at the top of `lib/db/ella-runs.ts`:
- `extractChannelId(meta)` — checks `channel` then falls back to `triggering_slack_channel_id`.
- `extractAuthorRole(meta)` — checks `real_author_role` then derives from `author_type` via the mapping: `client → 'client'`, `team_member → 'advisor'`, `ella → 'ella'`, `bot/workflow → 'system'`, `unknown → 'unresolvable'`.
- `extractAuthorName(meta, userNameMap)` — checks `real_author_name` then looks up via `triggering_message_slack_user_id` against the per-batch user-name map.
- `fetchUserNameMap(supabase, runs)` — bulk-resolves the speaker slack_user_ids of runs that don't carry `real_author_name` (i.e. passive_monitor runs). Two `IN (...)` queries against clients + team_members; mirrors the existing `fetchChannelMap` pattern.

Every call site in `lib/db/ella-runs.ts` that previously read the reactive-shape keys now uses these helpers. The thread-context block in `getEllaRunDetail` correctly short-circuits when `thread_ts` is null (which it always is for passive runs) so passive run detail pages render with empty `thread_messages` rather than firing a useless query.

Issue 2 (cost-today timezone) explicitly deferred per the spec. No changes to `getEllaSummaryStats`'s `todayMs` computation.

## 3. Verification

**Pre-apply defensive check** (cloud Supabase via psycopg2 against the pooler URL):
```
=== rows matching migration UPDATE WHERE (defensive pre-check) ===
  rows matched: 1
  ('C0AUWL20U8J', 'ella-test-drakeonly', False, True, 'd1f69a08-9764-4ab8-ac04-94d9986721a0')

=== confirm test_mode column does NOT yet exist ===
  rows: []
```

**Post-apply dual-verification:**
- Schema: `('test_mode', 'boolean', 'NO', 'false')` (column exists, NOT NULL, default false).
- Per-channel state: `('C0AUWL20U8J', 'ella-test-drakeonly', True, True)` — both `passive_monitoring_enabled` and `test_mode` are True on the test channel.
- 136 other rows have `test_mode=false` (only the test channel was flipped).
- Ledger has `0031` at the head: `[0031, 0030, 0029]`.

**Test suite:** `.venv/bin/python -m pytest tests/` → **512 passed** (was 507 pre-Batch-2.3-followup; +5 new tests for test_mode bypass + tagging).

**TypeScript compile:** `npx tsc --noEmit` → clean (no errors after `lib/db/ella-runs.ts` changes and `lib/supabase/types.ts` column add).

**40/40 existing passive tests still pass** after the `PassiveTriggerPayload` field add — the default `test_mode=False` keeps backwards-compat with every test that constructs the payload without the field.

**Reactive-rendering regression check.** Sampled 3 most-recent reactive (`trigger_type='slack_mention'`) `agent_runs` rows. All carry `channel`, `real_author_role`, `real_author_name` per the Batch 1.5 shape (verified earlier in the investigation). The helpers preserve this path: `extractChannelId` reads `channel` first; `extractAuthorRole` reads `real_author_role` first; `extractAuthorName` reads `real_author_name` first. Only when those are absent do they fall back to passive-shape keys. So reactive rendering is unchanged.

## 4. Surprises and judgment calls

- **`real_author_id` field doesn't have a passive equivalent.** The reactive path writes `real_author_id` = the resolved client_id (Batch 1.5 stamps the channel-mapped client at @-mention time). Passive runs have `triggering_message_slack_user_id` (raw Slack id) and `channel_client_id` (the CHANNEL's mapped client, not the SPEAKER's resolved client id — the speaker on a passive run is the client posting). They aren't the same concept. Left `extractTriggerField(meta, 'real_author_id')` in the B' anomaly check unchanged; on passive runs that returns null, the role-only fallback (`realRole === 'advisor'`) covers the team_member-via-test_mode case correctly. Documented in the inline comment.

- **B' anomaly on test_mode runs.** When Drake posts in `#ella-test-drakeonly` as a team_member, `extractAuthorRole` returns `'advisor'` (via the `team_member → advisor` mapping), which fires the B' anomaly check. That's correct behavior — a team_member posting in a client channel IS the kind of role mismatch B' is designed to flag. Under test_mode this is expected and benign; the `test_mode_run=true` tag on the same row makes it filterable from anomaly metrics if Drake wants. Not changing B' to skip test_mode runs — keeping the anomaly check honest.

- **`extractAuthorName` adds a per-batch DB query.** `fetchUserNameMap` runs two `IN (...)` queries against clients + team_members for the speaker slack_user_ids of runs that don't carry `real_author_name`. Today's volume is trivial (~28 V1 reactive runs + 2 passive runs); even at scale (hundreds of passive runs/day) the two batch queries are cheap. Skipped query optimization (no caching, no deduplication beyond the Set) — premature.

- **Default `test_mode=False` in `PassiveTriggerPayload`.** Keeps backwards-compat with all existing tests and the cron-side `respond_to_passive_trigger` / `handle_passive_general_inquiry` paths (which don't construct `PassiveTriggerPayload` themselves — they receive pending_ella_responses rows). Means a future code path that constructs the payload without threading the channel's `test_mode` will silently default to production behavior, which is the safe default.

- **`team_member → 'advisor'` mapping might be over-broad.** Some `team_member` rows could be ops/admin not advisors. The mapping is borrowed from the Batch 1.5 `agents.ella.identity` module's role resolution which uses the same heuristic. If a future contributor wants more granularity, that's a Batch 1.5 update; for now the dashboard's role-pill component handles `'advisor'` as the standard label.

- **Spec listed `extractTriggerField` call sites at lines ~177, ~301, ~382 in `getEllaRunDetail`.** Line numbers in the live file are off (line ~382 is the surrounding-thread-context block, line ~515-517 is the trigger_ts/thread_ts read). Numbering drifted between spec write and file state. Didn't matter — I greped for the keys and found all callers either way. Mentioned here so future-Director knows the spec's line numbers don't track future file edits.

- **The dashboard fix is read-side only.** The spec's "What could go wrong" #1 raised the option of write-side fix (snapshot channel + author names at write time into `trigger_metadata`). Empirically, the existing `fetchChannelMap` pattern already does query-time joins for channel-name resolution. Mirroring that pattern for author-name resolution is the smaller surface and keeps the data normalized — write-side denormalization would let names go stale when clients rename. Stayed with read-side.

- **No regression in `getEllaSummaryStats`.** Issue 2 (cost-today timezone) is deferred. The spec was explicit; I confirmed by re-reading `getEllaSummaryStats` post-edit and the `todayStart` / `todayMs` computation is byte-identical to pre-edit. No `Number()` cast added either — defensive, but not in scope for this bundle.

## 5. Out of scope / deferred

- **Issue 2 — `getEllaSummaryStats` cost-today timezone fix.** Spec explicit: "Don't fix in this spec. Don't sneak it in." Honored. Next session's work.
- **Anomaly type explainer doc** (Issue 3 from the investigation report). Director's separate work.
- **Polish around passive-run detail page rendering** when there's no thread context. Empty array → presumably-clean component render today; if it looks weird, that's the next small UX iteration. Out of scope for this bundle.
- **Production rollout to 7 client channels.** Drake's gate (c)/(d) work after the smoke test in `#ella-test-drakeonly` validates.

## 6. Side effects

- **Cloud Supabase migration 0031 applied** to project `sjjovsjcfffrftnraocu` via `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`. Schema + ledger dual-verified.
- **One row in `slack_channels` flipped to `test_mode=true`** by the migration's inline UPDATE: `#ella-test-drakeonly` (slack_channel_id `C0AUWL20U8J`). 136 other rows unchanged.
- **No production data writes** beyond schema + the one cell flip on the test channel.
- **No Slack posts fired.** Test suite ran under the conftest's autouse `post_message` monkeypatch (existing pattern).
- **5 new commits on `origin/main`:**
  1. `8c24156` — migration 0031: add slack_channels.test_mode + enable on #ella-test-drakeonly
  2. `2aeb845` — fix(ella-passive): tag test_mode runs + bypass Gate 2
  3. `c3791ff` — fix(dashboard): read passive trigger_metadata shape
  4. `f1f2f84` — test(ella-passive): cover test_mode bypass + tag + types.ts
  5. `8dca6d2` — docs: runbook + schema + CLAUDE.md
  Plus this report commit as the final.

---

## Drake's next steps (rollout checklist)

1. **Redeploy** Vercel (push triggers auto-deploy; the latest passive_monitor.py changes are in commits 2aeb845 onwards). Confirm `● Ready` via `vercel ls --yes | head -3`.
2. **Smoke test in `#ella-test-drakeonly`** per `docs/runbooks/ella_passive_monitoring.md` § "Smoke testing in #ella-test-drakeonly":
   - Post a `respond_substantive` candidate (curriculum-anchored question).
   - Post a `respond_general_inquiry` candidate ("hey, anyone there?").
   - Post a `skip` candidate (off-topic chatter).
   - Post an `escalate` candidate (billing/cancellation language).
3. **Watch `/ella/runs`** after each post. Confirm:
   - The decision row appears with `trigger_type='passive_monitor'` and the matching `haiku_decision` value.
   - Author renders as your name (not "unknown") — Issue 1b fix validation.
   - Channel renders as `ella-test-drakeonly` (not "unknown") — Issue 1b fix validation.
   - For `respond_*` decisions: a follow-up row appears within 1-2 minutes (`passive_substantive` or `passive_general_inquiry`) when Ella posts.
4. **Once happy: flip `passive_monitoring_enabled=true` on the 7 production client channels** (gate (d)). Leave `test_mode=false` on every production channel.

Issue 2 (cost-today $0) stays as a known annoyance until next session's fix lands. Don't sweat the dashboard summary band's cost number for now — per-run cost on detail pages is correct.
