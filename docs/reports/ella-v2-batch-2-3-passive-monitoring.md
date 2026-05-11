# Report: Ella V2 — Batch 2.3 passive monitoring
**Slug:** ella-v2-batch-2-3-passive-monitoring
**Spec:** docs/specs/ella-v2-batch-2-3-passive-monitoring.md

## 1. Files touched

**Created:**

- `supabase/migrations/0029_rename_ella_enabled_to_passive_monitoring.sql` — column rename + index repost + atomic CREATE OR REPLACE of the onboarding RPC with the new column name in its Branch C INSERT.
- `supabase/migrations/0030_pending_ella_responses.sql` — queue table for passive responses; CHECK enums on haiku_decision + status; partial pending_ella_responses_due_idx on queued rows.
- `agents/ella/passive_monitor.py` — six-gate decision pipeline + Haiku call. Pure module: no side effects beyond the LLM call.
- `agents/ella/passive_dispatch.py` — persistence layer. Writes the agent_runs row, inserts the pending_ella_responses queue row for respond_* decisions, fires the backend DM for escalate decisions.
- `api/passive_ella_cron.py` — per-minute Vercel cron drainer. Re-checks both kill switches + CSM-intervention + per-channel toggle before dispatching.
- `docs/schema/pending_ella_responses.md` — schema doc matching the existing schema-doc shape.
- `docs/runbooks/ella_passive_monitoring.md` — ops runbook: dual kill switches, verification queries, failure modes, validation rollout.
- `tests/agents/ella/test_passive_monitor.py` — 18 tests, six gates + Haiku parse + fail-soft.
- `tests/agents/ella/test_passive_dispatch.py` — 6 tests, four decision outcomes + no-primary-CSM gap + cost accounting.
- `tests/api/test_passive_ella_cron.py` — 13 tests, per-row gates + auth + happy paths + per-row error isolation.
- `tests/ingestion/slack/test_realtime_ingest_passive_fork.py` — 3 tests pinning fork dispatches when enabled / no-op when disabled / fail-soft when raises.

**Modified:**

- `ingestion/slack/realtime_ingest.py` — added `_maybe_dispatch_passive_monitor` helper called after successful ingest; extended `_lookup_channel` SELECT to include `passive_monitoring_enabled`. Fail-soft wrap on the fork; ingest itself stays exception-free.
- `agents/ella/agent.py` — added `PassiveResponseResult` dataclass + `respond_to_passive_trigger` (substantive path; reuses speaker resolution + KB retrieval + Sonnet generation from the reactive path) + `handle_passive_general_inquiry` (zero-LLM canned warm opener) + the `_PASSIVE_GENERAL_OPENERS_*` opener lists + `_fetch_message_text` helper.
- `agents/ella/prompts.py` — added "FIRM AFTER FIRST" instruction to the Sonnet system prompt. Affects both reactive @-mention substantive responses and passive substantive responses since they converge on `build_system_prompt`.
- `shared/claude_client.py` — added `claude-haiku-4-5-20251001` (date-suffixed alias) to `_PRICING_PER_MILLION` so cost tracking attributes correctly when callers use the explicit model id.
- `vercel.json` — registered `/api/passive_ella_cron` with `maxDuration: 60` + the per-minute cron schedule entry.
- `lib/supabase/types.ts` — `slack_channels.ella_enabled` → `passive_monitoring_enabled` everywhere (3 spots) + new `pending_ella_responses` table types.
- `tests/conftest.py` — added `agents.ella.passive_dispatch.post_message` to the autouse Slack-post monkeypatch (matches the existing `cs_call_summary_post` re-export pattern).
- `scripts/seed_clients.py` — two column references renamed (one in builder dict, one in upsert payload).
- `scripts/cleanup_master_sheet_completeness.py` — column reference in insert payload renamed.
- `scripts/test_airtable_onboarding_webhook_locally.py` — column reference in SQL fixture renamed.
- `ingestion/slack/pipeline.py` — column reference in slack_channels insert renamed.
- `docs/agents/ella/ella.md` — Trigger section now lists three paths (passive added); Response Location adds the per-decision split for passive responses; Confidence-Based Routing gains a "Firm-after-first" subsection; System Prompt Direction adds point 11; Eval Criteria notes the four Haiku decisions need their own eval set once production data exists; Dependencies line updated.
- `docs/schema/slack_channels.md` — column rename + reader list updated to mention the passive-monitor fork and the cron re-check.
- `docs/agents/ella/future-ideas.md` — "Per-channel ella_enabled beta gating" marked superseded.
- `docs/known-issues.md` — two new follow-ups: (1) future index on agent_runs.trigger_metadata.triggering_slack_channel_id once passive volume grows past ~5000 rows; (2) passive Haiku prompt + thresholds will need iteration from production data.
- `CLAUDE.md` — Hosting paragraph cron list updated; Vercel-deployment paragraph updated (8 → 9 Python functions + new env vars); migration count + Batch 2.3 paragraph added to § Live System State; § Ella Batch 2.3 line moved from "queued next" to "code shipped + migrations applied"; § Next Session Priorities #1 rewritten as a rollout punch list (gate (d) env vars + per-channel toggle + gate (c) validation).

**Deleted:** none.

## 2. What I did, in plain English

Built the full Batch 2.3 passive-monitoring pipeline end-to-end per the spec.

The shape: every Slack `message` event the realtime layer ingests now forks (after the successful upsert) into Ella's passive-monitor pipeline when the channel has `slack_channels.passive_monitoring_enabled=true`. A new pure decision module (`agents/ella/passive_monitor.py`) walks six gates in order — global kill switch (env var), author-type, CSM-directed auto-skip, KB-relevance, firm-after-first, then a Haiku decision call returning one of `respond_substantive` / `respond_general_inquiry` / `skip` / `escalate`. A new persistence module (`agents/ella/passive_dispatch.py`) writes the agent_runs row and, for respond_* decisions, queues the response to a new `pending_ella_responses` table with a 4-minute delay; for escalate decisions it fires a backend DM to the channel's primary CSM with a Slack deep-link + truncated `haiku_reasoning` and no quoted client content. A new per-minute Vercel cron (`api/passive_ella_cron.py`) drains the queue, re-checks both kill switches + the per-channel toggle + the CSM-intervention slack_messages query, and on intervention-free rows dispatches to either `respond_to_passive_trigger` (full Sonnet generation reusing the reactive prompt path) or `handle_passive_general_inquiry` (a zero-LLM canned warm opener).

Two migrations land it. 0029 renames `slack_channels.ella_enabled` to `passive_monitoring_enabled` and atomically re-issues the `create_or_update_client_from_onboarding` RPC with the new column name in its Branch C INSERT (required — plpgsql parses identifiers at runtime, so a bare rename would have broken the next onboarding event that creates a fresh slack_channels row). 0030 creates the queue table with the haiku_decision + status CHECK enums and the partial `pending_ella_responses_due_idx`.

Default-stance is **stay out**: every uncertain case skips silently. Dual kill switches (`ELLA_PASSIVE_MONITORING_ENABLED` env var + per-channel boolean) both default OFF so the pipeline doesn't fire until Drake explicitly enables it on `#ella-test-drakeonly` for validation.

Test coverage shipped with each piece — 40 new tests across the decision module, the persistence module, the cron, and the ingest fork. Full suite passes (507 tests).

The firm-after-first instruction was also added to the Sonnet system prompt in `agents/ella/prompts.py`. This is prompt-level only, but it affects both reactive @-mention substantive responses and passive substantive responses because they converge on the same `build_system_prompt` output — that was the spec's intent. The gate-level check in `passive_monitor.py` catches the strict keyword-overlap cases; the prompt-level instruction handles the cases the gate misses but Ella can see the prior escalation in her recent-channel-context.

Docs ship in the same commit as code per the CLAUDE.md non-negotiable. CLAUDE.md § Live System State and § Next Session Priorities both updated to reflect the new state.

## 3. Verification

- Full test suite: `.venv/bin/python -m pytest tests/` → **507 passed** (baseline 467 pre-Batch-2.3 + 40 new tests for this batch). 2 deprecation warnings preserved from the pre-existing supabase-py SDK (not caused by this batch).
- Import-time sanity check on every new module: `import agents.ella.passive_monitor`, `import agents.ella.passive_dispatch`, `import api.passive_ella_cron`, `import ingestion.slack.realtime_ingest` all succeed.
- vercel.json validated as JSON (`python -c "import json; json.load(open('vercel.json'))"`).
- Pre-apply check against cloud Supabase via psycopg2: `SELECT count(*) FROM slack_channels WHERE ella_enabled = true` → **0** (137 channels total). Hard-stop "if any rows are true" not triggered.
- Post-apply dual-verification of both migrations (Builder's discipline per `docs/runbooks/apply_migrations.md`):
  - **Schema reality** (`information_schema.columns` + `pg_indexes` + `pg_proc.prosrc` + `to_regclass`): column renamed cleanly (only `passive_monitoring_enabled` exists; `ella_enabled` is gone); partial index reposted under the new name; onboarding RPC body now uses `passive_monitoring_enabled` in its Branch C INSERT identifier (two remaining `ella_enabled` substrings are in a SQL comment line + the function COMMENT description — both intentional, neither executable); `pending_ella_responses` table exists with all three indexes (pkey + unique + partial due_idx) and both CHECK constraints.
  - **Ledger** (`supabase_migrations.schema_migrations`): `0030`, `0029` both present at the head of the version list.
- Real-API smoke test before bulk run: **NOT run** for this batch — there are no `--apply` bulk operations in this work. The runtime smoke test belongs to gate (c) (Drake validates in `#ella-test-drakeonly` post-deploy).

## 4. Surprises and judgment calls

- **Spec gap I rolled into the migration (judgment call).** The spec said "no code reads `ella_enabled` today" — true for runtime reads, but I found that migrations 0025 and 0026's `create_or_update_client_from_onboarding` RPC literally INSERTs into the column inside its Branch C fresh-insert path. plpgsql function bodies are stored as text and parse identifiers at runtime, so a bare column rename would break the next onboarding event that hits Branch C (today's common path for new clients). I rolled a CREATE OR REPLACE FUNCTION (reproducing the live 0026 body verbatim with the INSERT's column name swapped) into migration 0029 so the rename + RPC realign happens atomically inside one migration's transaction. The alternative — 0029 = rename, 0030 = RPC fix — would leave a window where the column is renamed but the RPC body still references `ella_enabled`; supabase db push applies migrations in separate transactions, so the gap is real. I made the call to bundle and noted it in the migration's header comment.

- **Python script + types.ts renames bundled with migration 0029's commit.** Same rationale — "rename the column and realign every read/write of it" is one logical change. Five Python files + 3 lines in `lib/supabase/types.ts` got the rename in the same commit as the migration SQL.

- **Per-minute Vercel Cron is the most aggressive cadence on Pro.** Spec accepts this; deploy will either accept the schedule entry or reject it with a clear error. If rejected, fallback is 5-minute cadence with the delay window shifting from 3-5 to 8-10 min — that's a one-line change in `vercel.json` and `_RESPOND_AFTER_DELAY` in `passive_dispatch.py`. I shipped per-minute per the spec; Drake will see at deploy time if it stuck.

- **Haiku model identifier and the pricing table.** Spec uses `claude-haiku-4-5-20251001` (date-suffixed). The pre-existing pricing table had `claude-haiku-4-5` (alias). I added the date-suffixed alias with identical rates so cost tracking attributes correctly when `complete()` is called with the explicit model string. Both aliases now resolve to the same per-token rates.

- **Passive substantive path can still emit `[ESCALATE]` from Sonnet.** Even though the Haiku gate already decided "substantive" (not "escalate"), Sonnet might decide mid-generation that the context warrants an escalation (the prompt instructs her to). I honor that: `respond_to_passive_trigger` runs `_detect_and_strip_escalation` on Sonnet's output and, if it finds the marker, writes the escalations row WITHOUT a client-facing post (status `'escalated'` on the agent_runs row, `'sonnet_side_escalation'` as the `slack_error` on the PassiveResponseResult to mark the row `'error'` in the cron). The cron then marks the pending row error. This is consistent with the spec's "default-stance is stay out" principle — when in doubt, don't post.

- **CSM-intervention check uses `slack_ts > since_ts` (lexicographic).** The spec said `sent_at > $2`. Slack ts strings are zero-padded `seconds.microseconds` and sort chronologically as text, so lexicographic ordering matches chronological ordering. I used `slack_ts` for the filter because it's the natural key of the triggering message and ties the comparison directly to the queue row's stored value. The existing `slack_messages_channel_sent_at_idx` covers the `slack_channel_id` portion; PostgreSQL still uses it for the channel filter and falls back to a small in-channel slack_ts scan for the time bound. At today's volume the difference is unmeasurable.

- **Test count in CLAUDE.md was wrong on first commit; fixed in a follow-up.** The first doc commit said "Total suite now 547 tests"; empirically it's 507. The +40 new tests is correct; the baseline I cited was off. Corrected in commit e8ae523.

- **Two intentional `ella_enabled` substrings remain in the RPC body after the migration applies.** One is a SQL comment line ("`-- passive_monitoring_enabled instead of ella_enabled — only change`") inside the function body; the other is the function COMMENT ("`0029 update: slack_channels Branch C INSERT now references passive_monitoring_enabled (renamed from ella_enabled in the same migration)`"). Neither affects execution; both are documentation of the rename. Flagging here so a future grep doesn't trigger a false alarm.

## 5. Out of scope / deferred

- **Production rollout to non-test channels.** Spec explicitly stops at "Drake enables `#ella-test-drakeonly` first for validation. Production rollout to other channels is post-validation work, not in this spec." Honored.
- **Eval set for the four Haiku decisions.** Spec says: "the four Haiku decision outcomes will need their own eval coverage once production data exists. No eval shipped in this batch." Honored; tracked in `docs/agents/ella/ella.md` § Eval Criteria.
- **Firm-after-first iteration past V1 keyword-overlap.** Spec accepts V1 as keyword-overlap; iterate from production. Logged in `docs/known-issues.md` as "Passive Haiku prompt — thresholds + categories will need iteration."
- **Index on `agent_runs.trigger_metadata.triggering_slack_channel_id`** when passive volume grows past ~5000 rows. Logged in `docs/known-issues.md` mirroring the existing `ai_call_signal` entry. No migration in this batch (premature at 0 passive runs).
- **The 24h-max race between a Fathom auto-review landing and the gregory_brain freshness filter** continues to be the accepted trade-off in that pipeline. Unrelated to this batch — just noting it isn't affected.

## 6. Side effects

- **`origin/main` advanced by 12 commits.** Code, migrations, tests, docs, and the post-apply doc bump.
- **Cloud Supabase migrations 0029 + 0030 applied** to project `sjjovsjcfffrftnraocu` via `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`. Both rows present in `supabase_migrations.schema_migrations`. Dual-verified post-apply.
- **No Slack posts fired.** Test suite ran with the conftest's autouse `post_message` monkeypatch (extended this batch to cover `agents.ella.passive_dispatch.post_message` for the same reason cs_call_summary_post's import-time-bound re-export needed coverage). No real Slack channels received traffic from this work.
- **No production data modified beyond schema.** Migration 0029 was a zero-row rename (pre-checked); migration 0030 created an empty table. Existing `clients` / `slack_channels` / `agent_runs` / `escalations` / `slack_messages` rows untouched.
- **No env vars set.** The two new env vars (`ELLA_PASSIVE_MONITORING_ENABLED` + optional `ELLA_PASSIVE_KB_RELEVANCE_THRESHOLD` + optional `SLACK_WORKSPACE`) are Drake's gate (d) — Builder did NOT set them in Vercel. The pipeline is dormant until Drake enables it.
- **No agent_runs rows created** by this work. The first row with `trigger_type='passive_monitor'` will land when Drake flips the global kill switch on, redeploys, and a client posts in a passive-monitoring-enabled channel.
