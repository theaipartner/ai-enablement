# Ella threshold lowering + Trustpilot first-month carve-out + FAQ harvest from call reviews
**Slug:** ella-threshold-trustpilot-first-month-faq-harvest
**Status:** in-flight

Three independent, sequential changes bundled into one spec per the bundling escape valve (related surfaces: Ella passive monitoring, Trustpilot cascade, call_reviewer + a new weekly cron). Three Scott-driven asks landed in one Director session, all small enough that spinning up three separate Builder sessions would be more overhead than the work warrants. Builder splits into multiple commits per the one-logical-change-per-commit rule — order below preserved as commit order.

## Context Builder needs

Read these first, confirm understanding in 4–5 bullets:

- `agents/ella/passive_monitor.py` — specifically the `_ESCALATION_BYPASS_KEYWORDS` frozenset (~line 130) and `_has_escalation_bypass_keyword` helper. Constant edit only; the bypass mechanism is already wired up.
- `supabase/migrations/0024_trustpilot_cascade_on_happy.sql` — the trigger WHEN clause is the surface to extend. Function body unchanged.
- `agents/call_reviewer/prompt.py` — the `SYSTEM_PROMPT` is where the new `questions_asked` key gets specified. Also bump `PROMPT_VERSION` from `"v1"` to `"v2"` so old reviews stay attributable to the prompt that produced them.
- `agents/call_reviewer/reviewer.py` — `_REQUIRED_KEYS` tuple needs the new key added; `_validate_review_shape` needs the new key validated.
- `agents/call_reviewer/persistence.py` — the doc is content-only JSON; no schema change. `questions_asked` rides along as the fifth top-level key in `content`.
- `api/accountability_notification_cron.py` — the structural template for the new weekly cron: signature validation, fail-soft per-recipient, audit ledger via `webhook_deliveries`.
- `scripts/backfill_call_reviews.py` — the backfill harness pattern. The same `--smoke` / `--apply` / `--limit` flags apply for re-running the 31 existing reviews to pick up the new field. Per the spec: backfill IS in scope.
- `docs/runbooks/ella_passive_monitoring.md` — Gate 4 bypass paragraph extends here.
- `docs/runbooks/trustpilot_cascade.md` if it exists; if not, no new runbook required for #2 (the migration comment carries the doc weight).

This spec touches three independent surfaces. Builder confirms the four bullets cover the right files before starting; if any of the above file shapes have drifted since this spec was written, surface and stop.

## Task 1: Ella escalation-bypass threshold — lower

**What Scott asked.** Scott is happy with current bypass coverage on hard signals (refund, cancel, lawsuit). He wants softer signals through too: "I'm confused," "this isn't what I expected," "can you clarify why X." Said explicitly he's fine with false positives — Haiku is still the final decider; bypass only decides whether Haiku gets to look.

**What changes.** Extend the `_ESCALATION_BYPASS_KEYWORDS` frozenset in `agents/ella/passive_monitor.py`. Categorically the new entries are uncertainty / confusion / mismatched-expectations / clarification-seeking. Suggested additions (Builder may refine — these are starting phrases, not a frozen list; pruning duplicates or near-duplicates is fine):

- Confusion: `"confused"`, `"confusing"`, `"not sure i understand"`, `"i don't understand"`, `"don't understand"`, `"doesn't make sense"`, `"makes no sense"`, `"lost"` (careful — could collide with "lost weight"; Builder can decide whether the FP rate is acceptable since Haiku catches it. Lean: include.)
- Mismatched expectations: `"not what i expected"`, `"thought this was"`, `"thought it was"`, `"expected"` (broad — Builder check the FP rate via dry-run query against historical `slack_messages` before locking. If too broad, narrow to `"expected something"` / `"expected this to"`.)
- Clarification-seeking with implied frustration: `"can you clarify"`, `"clarify why"`, `"why did you"`, `"why does"`, `"explain why"`, `"what do you mean"`
- Soft frustration: `"this isn't working"`, `"not working for me"`, `"struggling with this"`

These are starting points — Builder makes the final call on which to include based on a sanity check against the 3,641 backfilled `slack_messages` rows. The instruction is: favor coverage over precision (Scott explicitly fine with FPs), but don't include phrases so generic they'd fire on every other message.

Run a quick exploratory query before committing the list — count how many historical `slack_messages` (limit to `author_type='client'`) would have matched each new phrase. Goal isn't to optimize; goal is to make sure no entry trips on ~every message (e.g., `"i think"` would). Surface in the report.

Comment update on the constant: the existing comment block explains the bypass mechanism with reference to "money / commitment / complaints / crisis / quitting / legal" categories. Extend with the new category (label as "uncertainty / mismatched expectations / clarification-seeking" or similar). Three-prod-misses paragraph stays.

No test changes required beyond the existing `_has_escalation_bypass_keyword` tests — those test the mechanism, which is unchanged. If Builder adds a categorical assertion test (e.g., "each new keyword bucket has at least one entry"), that's value-add but not required.

**Doc update.** `docs/runbooks/ella_passive_monitoring.md` Gate 4 bypass paragraph: extend with a one-line mention of the new categorical coverage (uncertainty / mismatched expectations / clarification-seeking). Don't enumerate the keywords — they iterate too fast to keep doc-synced; the source-of-truth lives in the frozenset itself.

## Task 2: Trustpilot cascade — first-month carve-out

**What Scott asked.** The M5.7 cascade (migration 0024) currently flips `trustpilot_status = 'ask'` on every transition to `csm_standing='happy'`. Scott wants new clients excluded — they're too early in the relationship to ask for a public review. "First month" = ~30 days from `start_date`.

**What changes.** New migration `0037_trustpilot_cascade_first_month_carve_out.sql`. The migration `CREATE OR REPLACE TRIGGER` is the canonical way to update a trigger WHEN clause — Postgres requires drop + recreate when changing the WHEN, so the migration drops the existing trigger and recreates it with the extended WHEN. Trigger function itself unchanged.

New WHEN clause:

```sql
when (
  OLD.csm_standing is distinct from NEW.csm_standing
  and NEW.csm_standing = 'happy'
  and NEW.start_date is not null
  and NEW.start_date <= (current_date - interval '30 days')
)
```

Three semantic gates added:

1. **`NEW.start_date is not null`** — explicit. NULL `start_date` means "we don't know when this client started." Scott's intent is "don't ask new clients"; the precautionary read of an unknown start is "treat as new, don't cascade." A CSM can still manually flip `trustpilot_status` to `'ask'` via the dashboard.
2. **`NEW.start_date <= (current_date - interval '30 days')`** — the carve-out itself. Client must have entered the program at least 30 days ago.
3. Existing two gates preserved verbatim.

Migration comment carries: the rationale, the NULL handling decision, the 30-day specifically (not `'1 month'::interval` — `'30 days'` is calendar-flat, easier to reason about), and that the trigger is BEFORE UPDATE so the date check is against the in-flight row.

No backfill. Existing clients already in `csm_standing='happy'` with non-`'ask'` trustpilot stay where they are — same forward-only design as the original 0024.

**Schema doc.** `docs/schema/clients.md` already documents the `trustpilot_status` cascade through prose references to 0024. Extend the relevant paragraph with one sentence noting the 0037 first-month exclusion. Don't rewrite the section — one sentence inline.

**Test.** Add a Python test in `tests/supabase/test_migration_0037_trustpilot_first_month.py` (mirror the existing test patterns under `tests/supabase/`, which exercise migrations via psycopg2 fixtures). Cases:

1. Client with `start_date = current_date - interval '40 days'` (old): transition to `happy` → `trustpilot_status = 'ask'`.
2. Client with `start_date = current_date - interval '10 days'` (new): transition to `happy` → `trustpilot_status` unchanged.
3. Client with `start_date = NULL`: transition to `happy` → `trustpilot_status` unchanged.
4. Exact-boundary: `start_date = current_date - interval '30 days'`: transition to `happy` → `trustpilot_status = 'ask'` (inclusive on the 30-day mark per the `<=` operator).
5. Already-happy stays already-happy: a client already at `happy` who has another field updated → trigger does NOT fire (existing M5.7 forward-only semantics; sanity check that the carve-out doesn't break this).

If `tests/supabase/` doesn't have the precedent fixture (it might not — most schema testing is dual-verify post-apply), this becomes pure post-apply dual-verify discipline as documented in `docs/runbooks/apply_migrations.md`. Use the existing pattern.

**Hard stop — gate (a) SQL review.** Builder writes the migration but does NOT apply it. Surface to Drake with the SQL diff for review before `supabase db push --linked …` per the standard migration gate. Once Drake approves, Builder applies + dual-verifies (schema reality + ledger), then continues.

## Task 3: FAQ harvest from call reviews

**What Scott asked.** Scott is building a client-facing FAQ. He wants a weekly Slack DM listing questions clients asked during the week's calls so he can pick from them for blind-spot coverage. Accuracy and dedup are explicitly NOT priorities — "favor lots of questions over accurate and deduped questions." He'll scan and pick. Friday 15:00 ET delivery (Scott is in Europe, sleeps earlier than the rest of the team).

Direction: cluster-light dedup (simple text similarity, no LLM dedup pass — keep cost down).

**Three sub-pieces.**

### 3a. Extend the call_reviewer prompt to extract questions

`agents/call_reviewer/prompt.py`:

- Add a new fifth top-level key `questions_asked` to the JSON shape:

```json
{
  "pain_points": [ ... ],
  "wins": [ ... ],
  "dodged_questions": [ ... ],
  "sentiment_arc": "...",
  "questions_asked": [
    {"question": "...", "asker": "client" | "csm", "evidence": "..."}
  ]
}
```

- Field semantics in the prompt: questions the client asked during the call where the answer would be useful to capture for FAQ purposes. Both substantive ("how does the X workflow handle Y?") and process ("how do I share access with my VA?"). NOT rhetorical ("you know what I mean?"). NOT social pleasantries. Include `asker` field because clients ask their CSM questions but CSMs also ask clients clarifying questions — Scott only cares about the client-asked questions for FAQ purposes, so flagging `"asker"` lets the downstream cron filter without re-running the LLM. Empty array is fine for calls with no meaningful client questions.
- Bump `PROMPT_VERSION` from `"v1"` to `"v2"`. The `prompt_version` field on document metadata records which version produced each review — keeps old reviews attributable.

`agents/call_reviewer/reviewer.py`:

- Add `"questions_asked"` to `_REQUIRED_KEYS`.
- Extend `_validate_review_shape` to validate it's a list.

`agents/call_reviewer/persistence.py`:

- No changes. The review dict serializes whole into `documents.content` as JSON; the new key rides along automatically. Metadata schema is unchanged. The `validate_document_metadata` call validates `metadata` not `content`, so it doesn't care about the new key.

**Backfill.** Per Scott's direction: backfill the existing 31 May 2026 reviews using `scripts/backfill_call_reviews.py --apply --limit 31` (or similar — match the script's actual API). The script already exists and idempotently upserts; with the new `PROMPT_VERSION="v2"` and new required field, an upsert against an existing call_review document will re-generate and overwrite with the new shape. Cost: ~$1.50 (May 2026 batch already ran at this cost; same shape applies).

Smoke first (`--smoke`), then apply. Mandatory per the working norm — never apply a backfill without a smoke first.

### 3b. New weekly cron — `api/faq_digest_cron.py`

Structural template: `api/accountability_notification_cron.py`. Same shape — `CRON_SECRET` validation, `webhook_deliveries` audit row, fail-soft on send failures.

Cron schedule: `0 20 * * 5` — Friday at 20:00 UTC = 15:00 EST = 16:00 EDT (depending on DST). Use the UTC slot that corresponds to 15:00 ET; verify against current DST status when adding to `vercel.json`. Today (May 15, 2026) is DST = `0 19 * * 5` (19:00 UTC = 15:00 EDT). DST flips fall back in November; locking on 15:00 ET means the UTC slot shifts. Two acceptable resolutions:

- **(A) Lock on UTC, accept ±1hr drift twice a year.** Pick one — `0 19 * * 5` (favors DST window, 6 months active each year). Simpler.
- **(B) Two cron entries.** One for DST window, one for standard. Vercel doesn't have native DST handling.

My (Director's) lean: **A** with `0 19 * * 5`. Scott receives at 15:00 ET in summer (active DST), 14:00 ET in winter (post-fallback). 14:00 ET is still within his European afternoon. Builder lean is fine to override if there's a reason; surface the choice in the report.

**Cron logic:**

1. Auth check via `CRON_SECRET`.
2. Compute the time window: last 7 days (`now() - interval '7 days'` to `now()`).
3. Query `documents` for `source='fathom'`, `document_type='call_review'`, `metadata->>'started_at'` falls within the window. Parse `content` as JSON. Extract every `questions_asked` item where `asker='client'`. Defensive: filter out malformed entries (missing `question` key, empty string, non-string).
4. Cluster-light dedup. Simple approach: lowercase + strip punctuation + tokenize, then merge questions where the Jaccard similarity of content tokens (no stop words) exceeds some threshold (e.g., 0.6). Builder picks the threshold based on a sanity dry-run against backfilled data — too tight = many near-duplicates, too loose = unrelated questions clustered. Each cluster surfaces ONE representative (the longest question — typically most specific) + a count of how many calls it came from. No LLM. Use `difflib.SequenceMatcher` or token-Jaccard; whichever is cleaner.
5. Sort clusters by count descending (most-asked first), then by representative-question alphabetical for stability.
6. Format the Slack message. Suggested shape:

```
:question: *FAQ digest — week of {Monday}–{Friday}*

{N} unique client questions across {M} calls this week.

1. "How does the X workflow handle Y?" (asked in 3 calls)
2. "Where do I add my VA's access?" (asked in 2 calls)
3. "What does the Z signal mean in Gregory?" (asked in 1 call)
...
```

Cap at, say, 50 questions in the message — Slack messages have a 40k character limit but Scott shouldn't be scrolling through 200 entries. If clusters exceed 50, take the top 50 by count and append "...and N more (less frequent)." If under 50, no truncation.

7. Send via `shared/slack_post.py` (the same helper the CS visibility cron uses). Recipient: Scott's DM. His `slack_user_id` should resolve via `team_members` where `full_name ILIKE 'Scott Wilson%'` and `is_csm=true` — fetch this dynamically rather than hardcoding the UID. Audit row in `webhook_deliveries` with `source='faq_digest_cron'`.
8. Fail-soft: if zero questions for the week, send an explicit "No client questions surfaced this week" message rather than skipping entirely (so Scott knows the cron ran). If the Slack send fails, log + audit-row-with-error + return 200 anyway (cron should not retry on Slack failures).

**`vercel.json`:** add the cron entry under `crons:` and a function entry under `functions:` for the new file with `maxDuration: 60`.

**Env var:** new `CRON_SECRET` is already validated by the other crons; reuse. No new env vars required for V1 (Scott's recipient is resolved dynamically by name).

### 3c. Tests

For the prompt + reviewer changes:

- Existing `tests/agents/call_reviewer/test_reviewer.py` (or wherever the parsing tests live): add a test that a response missing `questions_asked` raises ValueError, and that a well-formed response with `questions_asked` parses cleanly.
- Builder may want an LLM-output golden test, but the parse-shape tests cover the spec contract.

For the cron:

- New `tests/api/test_faq_digest_cron.py`. Mirror `tests/api/test_accountability_notification_cron.py` for structure. Test cases:
  1. Happy path with seeded `documents` rows (faked Fathom call_review entries) — assert Slack message body includes expected questions.
  2. Zero-questions case → explicit "no questions" message sent.
  3. Cluster dedup — two near-identical questions cluster to one; two different questions don't.
  4. CSM-asked filter — `asker='csm'` entries are excluded.
  5. Auth check — missing/wrong `CRON_SECRET` returns 401, no Slack send.
  6. Slack send failure → audit row records the error, cron returns 200 anyway.

### Doc updates for Task 3

- `docs/agents/gregory.md` or wherever the call_reviewer surface is documented (Builder checks): mention the new `questions_asked` field on the V2 prompt + the weekly FAQ cron at a paragraph level.
- New runbook `docs/runbooks/faq_digest.md` covering: what it does, schedule, what Scott sees, audit SQL for "which questions surfaced last week," failure modes (Slack send failure, zero questions, malformed call_review content), how to disable temporarily (remove the cron entry from `vercel.json`).
- `docs/schema/documents.md` if the call_review content shape is documented there — add the new `questions_asked` key. If not documented, skip.

## Hard stops

1. **Task 2 migration apply** is gate (a) — Drake reviews the SQL diff before `supabase db push`. Builder writes the migration, runs `tests/supabase/` if applicable, and STOPS for review. After Drake approves, Builder applies + dual-verifies, then continues with Task 3.
2. **Task 3 backfill apply** — `scripts/backfill_call_reviews.py --apply` is not strictly irreversible (an upsert with the V1 prompt could regenerate the old shape), but it's a real-API cost ($1.50). Builder runs `--smoke` first, surfaces output, then proceeds with `--apply` autonomously — this is not a gate. Smoke results in the report.
3. **Task 3 cron deploy** — git-push fires the deploy, not a gate. Drake validates via `/api/faq_digest_cron` manual curl with `CRON_SECRET` post-deploy as gate (c).

## Hard-numerical thresholds

- Task 1: if the historical-message dry-run for any single new keyword shows >5% of all `author_type='client'` `slack_messages` matching it, stop and surface. That keyword is too broad.
- Task 3 cron: if the first run produces 0 clusters with non-trivial content (i.e., backfill failed silently and `questions_asked` arrays are empty across the 31 reviews), stop after the first dry-run-against-real-data and surface — backfill didn't take.

## What could go wrong

Think this through yourself. Things Director didn't anticipate:

- **Task 1:** A keyword too broad might fire so often that Haiku spend balloons. Each Haiku call is ~$0.001 so this is small in absolute terms but worth watching the first few days. If a single keyword drives >50% of bypass fires, narrow it. Surface in report.
- **Task 2:** The trigger fires BEFORE UPDATE on the in-flight NEW row. Date semantics: `current_date` is the trigger's execution date in the cluster's timezone (UTC for Supabase). If a CSM in Australia transitions a client at their local midnight, the trigger's `current_date` is the UTC date. Edge case: a client whose `start_date` is exactly 30 days ago in their CSM's timezone but 29 days in UTC — the trigger considers them new. This is acceptable surface; the carve-out is approximate by design.
- **Task 3 prompt change:** Sonnet may resist returning the new field if the prompt isn't tight enough. Concrete examples in the prompt help; verify on the backfill smoke that all 31 calls produce non-empty `questions_asked` (most calls have at least one client question).
- **Task 3 cron clustering:** Jaccard on tokens can cluster unrelated questions if their wording overlaps superficially ("how do I set up X" and "how do I set up Y" might cluster if X and Y are short common words). Builder picks the threshold based on a dry-run sanity check.
- **Task 3 Friday timing:** The 19 UTC slot maps to 15:00 EDT (summer). Once US DST ends Nov 1, 2026, it'll map to 14:00 EST. Surface this in the runbook so Scott (and future Director) knows the seasonal drift exists.

## Mandatory doc-update list

- `docs/runbooks/ella_passive_monitoring.md` — one-line Gate 4 bypass extension.
- `docs/schema/clients.md` — one-sentence note about 0037 carve-out in the `trustpilot_status` paragraph.
- `docs/agents/gregory.md` (or wherever call_reviewer is documented) — mention `questions_asked` + weekly cron.
- New `docs/runbooks/faq_digest.md` — full runbook for the new cron.
- `docs/schema/documents.md` IF it documents the call_review content shape (Builder checks).
- `docs/state.md` — add a bullet under the live-system-state section covering all three changes. Group as one entry, dated 2026-05-15.
- **CLAUDE.md § Next Session Priorities** — full rewrite. Per Drake's confirmation, all 10 prior priorities are done or shelved. Replace the section content with a tight version:
  1. Admin cost hub — closes Gregory V1.
  2. Gregory V2 — sales side.

  Note the shelved items are archived in `docs/future-ideas.md` (Builder adds a short paragraph there capturing what was shelved: Ella V2 Batch 2.1 retrieval scope, NPS V1.5 piping, Client Business Context Vault). Done items are reflected throughout `docs/state.md` already; no separate archival needed.

## Acceptance criteria

- Task 1: New keywords in `_ESCALATION_BYPASS_KEYWORDS`. Comment block extended. `pytest tests/agents/ella/test_passive_monitor.py` green. Optionally, sanity-check the new keywords against historical `slack_messages` and report the FP rate.
- Task 2: Migration 0037 written + reviewed by Drake (gate (a)) + applied + dual-verified. Test exists (in `tests/supabase/` if applicable, otherwise post-apply verify). Schema doc updated.
- Task 3: Prompt V2 in place, `_REQUIRED_KEYS` extended, validation in place. Backfill smoke + apply complete on the 31 May 2026 reviews. New cron deployed via `vercel.json`. New runbook in place. Tests for the cron green (`pytest tests/api/test_faq_digest_cron.py`).
- All three tasks: full pytest suite green. `tsc --noEmit` not relevant (no TS touched). `npm run lint` not relevant.
- CLAUDE.md § Next Session Priorities rewritten per spec.
- `docs/state.md` carries the bundled entry.

## Sequence

Commits (one per logical change per the convention):

1. Task 1 keyword extension + comment + doc update.
2. Task 2 migration file (NOT applied yet — gate (a)).
3. **HARD STOP — Drake reviews migration 0037 SQL diff. Apply + dual-verify after approval.**
4. Task 2 schema doc update.
5. Task 3a prompt + reviewer changes + tests.
6. Task 3a backfill smoke (output in report).
7. Task 3a backfill apply.
8. Task 3b cron + vercel.json + tests.
9. Task 3b runbook + agent doc updates.
10. CLAUDE.md § Next Session Priorities rewrite + `docs/state.md` entry + `docs/future-ideas.md` archival paragraph.

If any commit fails its tests, hard stop and surface — don't push half-finished work per the standard rules.
