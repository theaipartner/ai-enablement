# Report (PARTIAL): Ella threshold lowering + Trustpilot first-month carve-out + FAQ harvest

**Slug:** ella-threshold-trustpilot-first-month-faq-harvest
**Spec:** docs/specs/ella-threshold-trustpilot-first-month-faq-harvest.md
**Status:** halted — awaiting Drake gate (a) SQL review of migration 0037 before apply

## Files touched

**Created:**
- `supabase/migrations/0037_trustpilot_cascade_first_month_carve_out.sql` — Task 2 migration. Drops + recreates `clients_trustpilot_cascade_on_happy_before` with the extended 4-clause WHEN (adds `NEW.start_date IS NOT NULL` and `NEW.start_date <= current_date - interval '30 days'`). Trigger function body unchanged. Long block-comment carries the rationale: NULL handling decision, 30-day vs `'1 month'::interval` choice, BEFORE-UPDATE timezone semantics, forward-only design.

**Modified:**
- `agents/ella/passive_monitor.py` — Task 1. Extended `_ESCALATION_BYPASS_KEYWORDS` with four new categories (uncertainty / mismatched expectations / clarification-seeking / soft frustration) — 22 new keywords total. Extended the constant's preceding comment with a paragraph capturing Scott's 2026-05-15 ask + the 0.26% max-match-rate sanity check.
- `docs/runbooks/ella_passive_monitoring.md` — Task 1 doc update. Gate 4 bypass paragraph (under "Gate 4 silently dropping an escalation-worthy message") extended with one sentence noting the new categorical coverage. Keeps the source-of-truth-is-the-frozenset stance.

**Working tree (uncommitted, stashed):**
- `docs/schema/schema-v1.md` — Task 2 schema doc update. One-sentence extension of the line 5 status paragraph noting migration 0037, plus a bump of "Implemented by migrations 0001–0028" to "0001–0037." Stashed per spec sequence step 4: schema doc commit lands AFTER apply.

## What I did, in plain English

Completed Task 1 (keyword extension) end-to-end. Ran a real-API sanity check before committing the keyword list — counted historical matches against 1,568 client-authored `slack_messages` rows; max match rate was 0.26% on `"lost"`, well under the spec's 5% hard-numerical threshold. All 22 candidate keywords cleared, included them all. Existing `test_passive_monitor.py` (31 tests) is green, including the parametrized "each new keyword bucket has at least one entry" sample test — the extension didn't break the bypass-mechanism tests because they validate the dispatching code, which is unchanged.

Wrote the Task 2 migration. The SQL drops the existing trigger and recreates it with the extended WHEN clause; CREATE OR REPLACE TRIGGER cannot mutate WHEN in Postgres, so drop + recreate is the canonical pattern. Trigger function body is unchanged. The block comment block-quotes the rationale Director specified in the spec: NULL handling (precautionary "treat unknown as new"), `'30 days'` vs `'1 month'::interval` (calendar-flat vs month-relative — 30-day is easier to reason about), trigger session timezone semantics, and forward-only design (no backfill, fires on transition not presence). Did NOT apply — hard stop per spec § Hard stops #1.

## Verification

**Task 1:**
- `.venv/bin/python -m pytest tests/agents/ella/test_passive_monitor.py -q` — 31 passed in 1.69s. Includes the parametrized "each category triggers" test, the multi-word phrase test, the case-insensitive test, and the no-regression-on-Gate-4-skip test.
- Real-API keyword sanity check via a one-shot `/tmp/keyword_sanity_check.py` (deleted post-run) against the `slack_messages` table. 1,568 client-authored rows checked. Max match rate 0.26% (`"lost"`, 4 matches); many candidates returned 0 matches in the current corpus — expected, since the keywords target future escalation-worthy phrasings not well-represented yet.

**Task 2:**
- Migration file syntax-readable; the drop + recreate pattern mirrors existing Postgres conventions and the surrounding 0024 migration. NOT yet applied — awaiting Drake's gate (a) review.

## Surprises and judgment calls

- **Spec pointed at `docs/schema/clients.md` for the Task 2 schema doc update; the actual trustpilot-cascade prose lives in `docs/schema/schema-v1.md`.** `clients.md` doesn't enumerate the 14 columns added in 0017 (including `trustpilot_status`) — it lists `journey_stage`, `status`, `nps_standing`, `accountability_enabled`, `nps_enabled`, `start_date`, `program_type`, but not `trustpilot_status`. The cascade prose lives in the schema-v1.md status header. Applied the one-sentence extension to `schema-v1.md` instead. Stashed for now per spec sequence.
- **Sanity-check corpus is 1,568 client-authored slack_messages, not 3,641.** Spec said 3,641. Difference is probably "all author types" vs "author_type='client'" — the bypass keywords only matter on client messages, so I scoped accordingly. Margin-of-safety still huge (0.26% << 5%).
- **Included `"lost"` despite the spec flagging "lost weight" collision risk.** Real-historical match rate was 0.26% (4 matches across 1,568 messages); margin of safety on the 5% threshold is comfortable; Scott is explicitly fine with FPs. Per spec lean: include.

## Out of scope / deferred

Task 2 schema doc commit, Task 3 (prompt + reviewer + backfill + cron + tests + docs), CLAUDE.md priorities rewrite, `docs/state.md` entry, `docs/future-ideas.md` archival paragraph. All blocked on Drake's gate (a) approval of migration 0037.

## Side effects

None outside the repo so far. The sanity-check script issued read-only `select` queries against `slack_messages` (no writes, no Slack posts, no external API calls beyond Supabase reads).

## What's needed to unblock

**Single decision required from Drake:** approve migration 0037 SQL for apply, or push back with changes.

The migration drops + recreates `clients_trustpilot_cascade_on_happy_before` with the new WHEN clause:

```sql
when (
  OLD.csm_standing is distinct from NEW.csm_standing
  and NEW.csm_standing = 'happy'
  and NEW.start_date is not null
  and NEW.start_date <= (current_date - interval '30 days')
)
```

Trigger function body is unchanged (still `NEW.trustpilot_status := 'ask'; return NEW;`). The full SQL with rationale comments is at `supabase/migrations/0037_trustpilot_cascade_first_month_carve_out.sql` — committed in `eb8f86b`. Forward-only — no backfill; existing `csm_standing='happy'` clients with non-`'ask'` trustpilot stay where they are.

**Once approved, Builder resumes with:**
1. Apply via `supabase db push --linked --dns-resolver https --password "$SUPABASE_DB_PASSWORD" --yes`.
2. Dual-verify (pg_proc/pg_trigger WHEN-clause read + `supabase_migrations.schema_migrations` ledger read).
3. Commit the schema doc update (currently stashed).
4. Continue Task 3: prompt + reviewer changes, backfill smoke + apply, faq_digest cron + tests + runbook, then CLAUDE.md / state.md / future-ideas wrap-up.

Resume report will land at `docs/reports/ella-threshold-trustpilot-first-month-faq-harvest-resume.md` per the no-overwrite-on-resume rule.
