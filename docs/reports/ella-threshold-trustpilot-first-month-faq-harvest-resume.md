# Report (RESUME): Ella threshold lowering + Trustpilot first-month carve-out + FAQ harvest

**Slug:** ella-threshold-trustpilot-first-month-faq-harvest
**Spec:** docs/specs/ella-threshold-trustpilot-first-month-faq-harvest.md
**Partial:** docs/reports/ella-threshold-trustpilot-first-month-faq-harvest.md (the partial from the gate-(a) pause stays in place per the no-overwrite rule)

## Files touched

**Created:**
- `supabase/migrations/0037_trustpilot_cascade_first_month_carve_out.sql` — Task 2. Drops + recreates `clients_trustpilot_cascade_on_happy_before` with two new WHEN clauses (`NEW.start_date IS NOT NULL`, `NEW.start_date <= current_date - interval '30 days'`). Trigger function body unchanged. Applied + dual-verified post-apply.
- `api/faq_digest_cron.py` — Task 3b. New weekly Friday cron. Pulls last 7 days of call_review documents, extracts `questions_asked` where `asker='client'`, cluster-light dedups via token-Jaccard (threshold 0.5), sorts by call-count desc, caps at top 50, DMs Scott via `shared.slack_post.post_message`. Modeled on `api/accountability_notification_cron.py`.
- `tests/api/test_faq_digest_cron.py` — 14 tests covering happy path, zero-questions, csm-asked filter, malformed entries, non-JSON content, cluster dedup, cluster count surfacing, missing-Scott failure, 4 auth cases, Slack-failure isolation.
- `docs/runbooks/faq_digest.md` — full operational runbook (schedule + DST drift, audit SQL, failure modes, disable procedure, tuning surfaces).

**Modified:**
- `agents/ella/passive_monitor.py` — Task 1. `_ESCALATION_BYPASS_KEYWORDS` extended with 22 new keywords across four new categories (uncertainty / mismatched expectations / clarification-seeking / soft frustration). Comment block extended with the Scott 2026-05-15 rationale + the 0.26% max-match-rate sanity-check note.
- `docs/runbooks/ella_passive_monitoring.md` — one-line Gate 4 bypass extension noting the new categorical coverage.
- `agents/call_reviewer/prompt.py` — Task 3a. `SYSTEM_PROMPT` gained the fifth top-level key `questions_asked` with full field semantics (substantive + process Q's, excludes rhetorical/pleasantry/conversational clarifying); `PROMPT_VERSION` bumped `"v1"` → `"v2"`.
- `agents/call_reviewer/reviewer.py` — Task 3a. `_REQUIRED_KEYS` extended; `_validate_review_shape` now enforces list-type on `questions_asked`. Separately: `_MAX_OUTPUT_TOKENS` bumped 4096 → 8192 after one real call truncated mid-JSON at ~3,800 tokens under the v2 prompt (discovered bug — see Surprises).
- `tests/agents/call_reviewer/test_reviewer.py` — `_VALID_REVIEW` fixture gained a `questions_asked` entry; +2 tests for missing-key + wrong-type-for-questions_asked.
- `vercel.json` — `api/faq_digest_cron.py` function entry (60s maxDuration) + `0 19 * * 5` cron schedule.
- `docs/schema/schema-v1.md` — Task 2 schema doc. Status header bumped from "0001–0028" to "0001–0037" and one-sentence note appended about 0037's first-month carve-out.
- `docs/agents/call_reviewer.md` — `questions_asked` mentioned in the surface intro, FAQ-cron pointer added, prompt_version metadata note bumped to `"v2"`.
- `docs/state.md` — single 2026-05-15 bundled entry covering Tasks 1/2/3 with the full per-task detail Director needs for chronological reference.
- `CLAUDE.md` — § Next Session Priorities collapsed from 10 items to 2 (Admin cost hub + Gregory V2 sales side) per Drake's confirmation that the 10 prior priorities are done or shelved.
- `docs/future-ideas.md` — new "Shelved 2026-05-15" callout block near the top capturing Ella V2 Batch 2.1 retrieval scope + NPS V1.5 piping + Client Business Context Vault as off the active pointer with explicit revisit triggers.

## What I did, in plain English

Three independent Scott-driven asks bundled in one Builder pass per the spec's bundling escape valve.

**Task 1** extended Ella's escalation-bypass keyword list to catch softer signals (uncertainty, mismatched expectations, clarification-seeking, soft frustration) that previously died at Gate 4 before Haiku could see them. Real-API sanity check against 1,568 historical client-authored `slack_messages` confirmed every new keyword matches <0.26% of the corpus — well under the spec's 5% hard threshold; included the full set since Scott explicitly favors coverage over precision (Haiku still arbitrates).

**Task 2** wrote migration 0037 to add a first-month carve-out to the M5.7 trustpilot cascade. The trigger WHEN clause gained two new gates (`start_date IS NOT NULL`, `start_date <= current_date - interval '30 days'`) so clients in their first 30 days no longer get auto-flipped to `trustpilot_status='ask'` when `csm_standing` transitions to `'happy'`. Drake reviewed the SQL at the gate-(a) pause (partial report at the canonical path); I applied via `supabase db push --linked` and dual-verified — `pg_get_triggerdef` shows the new 4-clause WHEN; `schema_migrations.version='0037'` registered.

**Task 3a** added a `questions_asked` field to the call_reviewer prompt (v2) capturing every FAQ-useful question raised during the call, tagged with `asker='client'|'csm'` so downstream consumers filter cheaply. Backfilled all May 2026 reviews under v2 by following the script's documented DELETE-then-re-apply pattern (the script filters out already-reviewed calls upstream — in-place upsert wasn't an option as the spec assumed). 84 reviews now under v2 prompt; 82/84 have populated `questions_asked` (the 2 empty arrays are calls with no FAQ-relevant client questions, expected per the prompt's "Empty array is fine" clause).

**Task 3b** wrote the weekly Friday FAQ digest cron, modeled structurally on `api/accountability_notification_cron.py`. Token-Jaccard clustering (threshold 0.5, no LLM) groups near-duplicate questions; the longest member of each cluster becomes the representative; clusters sort by call-count descending; top 50 surface in the Slack DM. Scott's `slack_user_id` is resolved dynamically from `team_members` rather than hardcoded. Schedule `0 19 * * 5` lands Scott's DM at 15:00 EDT during DST, 14:00 EST after fallback.

Wrap-up: CLAUDE.md priorities collapsed to the 2-item version (Admin cost hub + Gregory V2 sales side), shelved items archived in `docs/future-ideas.md` with explicit revisit triggers, `docs/state.md` carries a single bundled 2026-05-15 entry.

## Verification

**Task 1:**
- `pytest tests/agents/ella/test_passive_monitor.py` — 31 passed. Existing parametrized "each category triggers" test covers the new bypass mechanism unchanged.
- Real-API sanity check: 1,568 client-authored slack_messages queried; max match rate 0.26% on `"lost"` (4 matches). Every other new keyword <0.20%. Well under the 5% hard threshold.

**Task 2:**
- Dual-verify post-apply via `psycopg2` against the pooler URL: `pg_get_triggerdef` returned the expected 4-clause WHEN (`OLD.csm_standing IS DISTINCT FROM NEW.csm_standing AND NEW.csm_standing = 'happy' AND NEW.start_date IS NOT NULL AND NEW.start_date <= (CURRENT_DATE - '30 days'::interval)`). `supabase_migrations.schema_migrations.version='0037'` present; latest 5 ledger entries are 0033–0037 in order.
- `tests/supabase/` does not exist (confirmed); per spec contingency, post-apply dual-verify is the discipline.

**Task 3a:**
- `pytest tests/agents/call_reviewer/test_reviewer.py` — 22 passed (20 pre-existing + 2 new for missing-questions_asked + wrong-type-questions_asked).
- Real-API smoke succeeded on first try; the smoke review (`Intekhab Naser - Lou - 1 on 1`) returned 12 well-formed `questions_asked` entries with `asker='client'`, prompt_version="v2", sentiment_tier="yellow".
- Full backfill end-state: 84/84 May 2026 reviews under v2 prompt; 82/84 with populated `questions_asked` arrays (2 empty by design); 0 reviews under v1 in the window. Total cost across smoke + main apply + retries: **~$5.88** (vs spec's expected $1.50; difference primarily from 84 calls in the May 2026 window vs spec's stated 31, plus the `_MAX_OUTPUT_TOKENS` retry — see Surprises).

**Task 3b:**
- `pytest tests/api/test_faq_digest_cron.py` — 14 passed.
- Full suite: `pytest tests/ -q` → **591 passed** (575 baseline + 14 new cron + 2 new reviewer).

**Test suite delta:** 575 → 591 (+16 net).

## Surprises and judgment calls

- **The spec's expected backfill cost ($1.50) was based on 31 May 2026 reviews; actual count was 84.** The spec was written at an earlier date; May has continued to accumulate calls. I processed all 84 per the spec's intent (regenerate all May reviews under v2) rather than artificially capping at 31. Net cost ~$5.88 vs $1.50; within autonomous range, surfaced for visibility.

- **The spec's "idempotent upsert overwrites old shape" assumption was wrong about the script's actual behavior.** `scripts/backfill_call_reviews.py` filters out calls whose `external_id` already has a `documents` row — it skips, doesn't overwrite. I followed the script's own docstring-documented DELETE-then-re-apply pattern instead: deleted all 82 May 2026 call_reviews via psycopg2, then ran the backfill. The spec said this should be in-place; the script said otherwise; trusted the script. No data loss — sentiment_tier and questions_asked were both regenerated cleanly under v2.

- **`_MAX_OUTPUT_TOKENS=4096` was too tight for the v2 prompt** — discovered when one call (`Dhamen Hothi - Lou - 1 on 1`) returned JSON truncated at character 15,140 / ~3,800 tokens. v2's `questions_asked` field can push dense calls past the prior cap. Bumped to 8192 (commit `14b9c39`) — the retry succeeded at 3,580 output tokens. This is a v2-prompt-induced bug discovered during the backfill; fix lands as part of the same Builder pass since it's load-bearing for v2.

- **Spec pointed at `docs/schema/clients.md` for the Task 2 schema doc; trustpilot cascade prose actually lives in `docs/schema/schema-v1.md`.** Added the one-sentence note where the prose lives and bumped the file's status-header migration range from 0001–0028 to 0001–0037 to reflect cloud state.

- **Two Fathom auto-reviews fired during the backfill while I had v2 code locally but had not yet pushed to Vercel.** The deployed Fathom pipeline was still v1, so two new May 2026 calls (`Rahim Ali`, `[Client] Session with Scott (Andrew Hsu)`) got v1 reviews during my work window. After the main backfill completed I re-ran `--apply` once for the new call without a review (Rahim Ali) and separately deleted + re-apply'd the v1 Andrew Hsu review so the final state is uniformly v2. Going forward, once this push deploys, future Fathom auto-reviews fire under v2 automatically — no further cleanup needed.

- **2 reviews have empty `questions_asked` arrays.** The prompt explicitly permits this for calls with no FAQ-relevant client questions. Not a bug; per the prompt's "Empty array is fine for calls with no FAQ-relevant questions; favor more questions over fewer when in doubt." Mentioned for completeness against the spec's hard-numerical threshold #2 ("if all 31 reviews come back with empty arrays, stop and surface").

- **The script's wall-clock cost-sum captured before the smoke ran is sometimes off by a few seconds** because the Supabase agent_runs `started_at` is set at row-insert time which can predate the script's `datetime.now()` capture due to clock skew. The actual cost is correctly recorded on each agent_run; the script's printed summary just under-reports for the smoke window. Confirmed via direct query — real cost was $0.0648 for the smoke even though the script printed $0.0000. Cosmetic; not fixed in this spec.

- **Sanity-check corpus was 1,568 messages, not the 3,641 the spec mentioned.** Difference is `author_type='client'` vs all author types. Scoped to client messages since the bypass only matters on client-authored messages. Margin of safety on the 5% threshold is still huge.

## Out of scope / deferred

- **Push triggers Vercel auto-deploy.** Drake's gate (c) walkthrough now: curl `/api/faq_digest_cron` with the production `CRON_SECRET` once the deploy is green; confirm `webhook_deliveries.source='faq_digest_cron'` shows `processing_status='processed'` with a populated payload + `slack_ok=true`. Scott's first real Friday tick is May 22, 2026.
- **The 2 empty-questions_asked reviews** could be re-run with a more aggressive prompt iteration if Scott finds the digest thin. Not necessary today.
- **No code path migrates the v1 → v2 prompt version on the 31 pre-spec reviews — those got fully regenerated under v2 in this batch.** Future iterations of the prompt should preserve the regen pattern.

## Side effects

- **Cloud Supabase writes:**
  - 1 row in `supabase_migrations.schema_migrations` (version `0037`).
  - 1 trigger DROP + 1 trigger CREATE on `clients` (`clients_trustpilot_cascade_on_happy_before` — same name, new WHEN).
  - 84 rows deleted from `documents` (May 2026 call_review rows; via two DELETEs — the main batch + the v1 cleanup).
  - 84 rows inserted into `documents` (all v2 prompt). Final state: 84 May 2026 call_review rows.
  - ~85 rows inserted into `agent_runs` for `call_reviewer` runs (84 successes + 1 transient error for Dhamen Hothi which was later replaced by the retry's success row).
- **Anthropic API spend:** ~$5.88 total across all backfill activity for the day. Each agent_run has its own `llm_cost_usd` for line-item attribution.
- **No Slack posts.** The FAQ digest cron is deployed but the first scheduled fire is Friday May 22, 2026; no manual fire issued from this Builder pass (gate (c) for Drake).
- **No env var changes.** All new functionality uses the existing `CRON_SECRET`, `SUPABASE_*`, `SLACK_BOT_TOKEN`, `ANTHROPIC_API_KEY`. No new secrets needed.
- **Vercel `vercel.json` change** triggers a fresh deploy on push — once green, the new `api/faq_digest_cron.py` route is live and the Friday cron is scheduled.
