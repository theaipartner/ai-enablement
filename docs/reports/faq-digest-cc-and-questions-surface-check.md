# Report: FAQ digest CC + questions_asked surface verification

**Slug:** faq-digest-cc-and-questions-surface-check
**Spec:** docs/specs/faq-digest-cc-and-questions-surface-check.md

## Files touched

**Modified:**
- `api/faq_digest_cron.py` — Added `_CC_ENV_VAR`, `_SLACK_USER_ID_RE`, `_resolve_recipients(db)`, `_fire_recipient_dm(...)`. Refactored `run_faq_digest_cron()` from a single-recipient send into a fan-out shape mirroring `agents/ella/escalation_routing.py`: one `post_message` + one `webhook_deliveries` audit row per recipient. Top-level result preserves the pre-CC fields (`status`, `delivery_id`, `slack_ok`, `slack_error`) as Scott's values for backwards-compat; new fields (`recipients`, `cc_present`, `cc_slack_ok`, `cc_slack_error`) carry the multi-recipient detail.
- `tests/api/test_faq_digest_cron.py` — 5 new tests for the CC recipient behavior (4 spec'd + 1 dedup edge case). All 14 pre-existing tests still pass without modification.
- `.env.example` — `FAQ_DIGEST_CC_SLACK_USER_ID` entry under the Ella escalation block (adjacent to `ESCALATION_RECIPIENT_SLACK_USER_ID`). Empty default; comment block covers optional behavior, today's value, gate (d) note, malformed degradation.
- `docs/runbooks/faq_digest.md` — Pipeline step 9 reframed as fan-out; step 10 per-recipient. New § Recipients section enumerates Scott (primary, dynamic resolution) + CC (optional env var) + four edge cases. § Disable section gains a CC-alone removal note.
- `docs/state.md` — Single follow-up bullet under the 2026-05-15 bundle noting the CC follow-up + Task 2's intentional-isolation finding.

**Not modified (Task 2 — investigation only):**
- `lib/db/calls.ts`, `app/(authenticated)/calls/[id]/page.tsx`, `components/gregory/sentiment-pill.tsx` — verified as part of the read-only Task 2 trace; no edits.

## What I did, in plain English

**Task 2 (investigation only, done first per spec sequence).** Grep'd the entire dashboard surface (`app/`, `components/`, `lib/`) for any reference to `questions_asked` — found zero. Then traced the call-review render path on `/calls/[id]`:

- `lib/db/calls.ts` defines `CallReview` as a TypeScript interface that explicitly declares only the four v1 fields: `pain_points`, `wins`, `dodged_questions`, `sentiment_arc`.
- `lib/db/calls.ts:parseCallReview` defensively validates only those four fields exist on the JSON blob and have the correct types. Extra fields in the JSON (like `questions_asked`) are silently dropped at parse time — they don't make it into the `CallReview` object.
- `app/(authenticated)/calls/[id]/page.tsx:ReviewBox` renders by explicit named access: `review.sentiment_arc`, `review.pain_points`, `review.wins`, `review.dodged_questions`. No dynamic JSON-key iteration; no `Object.entries(review)`-style code that would surface unknown fields.

**Verdict: intentional absence.** The TypeScript type acts as a hard filter — the new `questions_asked` field is present in `documents.content` JSON but never reaches the render layer. Only downstream consumer is `api/faq_digest_cron.py`. Clean isolation. The next Builder who adds a new field to the call_reviewer prompt would have to also (1) extend the `CallReview` interface, (2) extend `parseCallReview`'s validation, AND (3) add explicit render code on the detail page — three independent surfaces. Accidental leak is structurally hard.

**Task 1 (code).** Added optional CC recipient to the FAQ digest cron. Implementation choices:

- **Env var name:** `FAQ_DIGEST_CC_SLACK_USER_ID` — namespaced to the source pattern (FAQ_DIGEST_ prefix) per the env var naming feedback memory.
- **Validation:** loose `^U[A-Z0-9]+$` regex — same syntactic check as the `ESCALATION_RECIPIENT_SLACK_USER_ID` precedent. Catches typos, display names, emails, fat-finger trailing spaces (handled via `.strip()` before regex check).
- **Recipient resolution:** new `_resolve_recipients(db)` helper returns the list `[Scott]` or `[Scott, CC]` depending on env var. Scott always primary; CC always appended (when valid + not a dup of Scott).
- **Send refactor:** factored out `_fire_recipient_dm` mirroring `agents/ella/escalation_routing.py:fire_escalation_dms`. Each recipient gets its own `delivery_id` (UUID-suffixed `faq_digest_<uuid>`), its own initial `webhook_deliveries` insert with `payload.recipient_source`, and its own final-state update.
- **Aggregation:** Scott is the source-of-truth recipient. Top-level `status` = `'ok'` iff Scott's send succeeded, regardless of CC outcome. CC failures land in the recipients list + their own audit row but don't change the cron's top-level status (matches spec's "CC Slack fails → audit row with error, Scott still receives, cron returns 200" contract).
- **Pre-fanout failures changed shape.** Previously, document-fetch / Scott-lookup failures wrote a "starting" audit row and marked it failed at exit. The fan-out refactor drops the cron-level starting row to match the escalation_routing precedent — pre-fanout failures now return failed status without writing audit rows; Vercel logs surface them. Net effect: fewer audit rows per tick, cleaner shape, but pre-fanout failures only visible in Vercel logs (not `webhook_deliveries`). Acceptable trade-off — those failure modes are rare; document-fetch in particular is hard to break short of Supabase downtime.

**Task 1 (docs).** `.env.example` adds `FAQ_DIGEST_CC_SLACK_USER_ID=` next to `ESCALATION_RECIPIENT_SLACK_USER_ID`. The runbook gains a § Recipients section enumerating Scott + the four CC edge cases (unset, malformed, equal-to-Scott, Slack send fails). § Disable adds a CC-alone removal note. `docs/state.md` carries the single-bullet follow-up under the 2026-05-15 bundle.

## Verification

**Task 2:**
- `grep -rn "questions_asked" app/ components/ lib/` → zero matches.
- Read `lib/db/calls.ts` `CallReview` interface — only four v1 fields declared.
- Read `lib/db/calls.ts:parseCallReview` — defensive type-check validates only the four v1 fields; the parse function is `parsed` cast to `CallReview` so any extra keys in JSON disappear at the type boundary.
- Read `app/(authenticated)/calls/[id]/page.tsx:ReviewBox` (lines ~323–422) — render uses explicit named access only: `review.sentiment_arc`, `review.pain_points`, `review.wins`, `review.dodged_questions`. No `Object.entries`, no dynamic loop over JSON keys.

**Task 1:**
- `pytest tests/api/test_faq_digest_cron.py -q` → **19 passed** (14 existing + 5 new). The 5 new tests:
  1. `test_cc_env_unset_scott_only` — regression: pre-CC behavior preserved when env var is unset.
  2. `test_cc_env_valid_uid_both_recipients_dmed` — happy path: both Scott and CC receive; both audit rows present; bodies identical.
  3. `test_cc_env_malformed_value_scott_only_warning_logged` — degradation: malformed env value → Scott-only + WARNING log line.
  4. `test_cc_env_valid_but_cc_slack_send_fails_scott_still_ok` — fault isolation: Scott succeeds, CC fails, top-level `status='ok'`, CC audit row carries `slack_post_failed: channel_not_found`.
  5. `test_cc_env_equal_to_scott_uid_deduplicated_to_one_recipient` — bonus edge case (not spec'd, defensive): CC env set to Scott's slack_user_id dedups to one DM.
- `pytest tests/ -q` → **596 passed** (591 prior baseline + 5 new). `tsc --noEmit` + `npm run lint` not relevant — no TypeScript or frontend code touched.

## Surprises and judgment calls

- **Pre-fanout audit row dropped.** The pre-existing cron wrote a "starting" `webhook_deliveries` row before resolving Scott so cron-level failures (document fetch failure, Scott lookup failure) had an audit footprint. The fan-out refactor drops this starting row to match `escalation_routing.py`'s shape. Trade-off: pre-fanout failures are now only visible in Vercel logs, not `webhook_deliveries`. Surfaced for visibility; can be re-added cheaply if Drake wants both shapes. Lean: leave it dropped — matches the precedent + the pre-fanout failure modes are rare + Vercel logs are accessible.
- **Top-level result shape preserved for backwards-compat.** Existing tests assert on `result["slack_ok"]`, `result["slack_error"]`, `result["delivery_id"]`. Kept those at top-level as Scott's values rather than renaming to `result["scott_slack_ok"]` etc. New fields (`recipients`, `cc_present`, `cc_slack_ok`, `cc_slack_error`) carry the multi-recipient detail. No existing test required modification.
- **5 tests instead of 4.** Spec'd four CC cases; added a fifth for the "CC equals Scott's slack_user_id" dedup edge case. That edge case is real (Drake could accidentally paste Scott's UID instead of his own; the cron should handle it without double-DMing) and the test was cheap to write. Spec acceptance criteria stated "18 tests total" — I have 19. Slight over-delivery, surfaced for visibility.
- **CC label is hardcoded as `"CC"` in `_resolve_recipients`.** Considered looking up the CC's `team_members.full_name` for a friendlier audit-row label (matching how `escalation_routing._lookup_team_member_label` resolves Scott's name). Decided against — adds a DB round trip per fire for a label that only shows up in audit ledger queries, and the CC use case today is Drake-specific where "CC" is informative enough. If the CC ever lives long-term in production for someone other than Drake, the label lookup becomes worth doing.
- **Task 2 finding could harden against future drift.** Today the TS type acts as a hard filter, but if a future Builder adds a generic "render every key in the JSON" surface (an unlikely but possible refactor), `questions_asked` would leak. The current state is structurally safe but not test-enforced. Mentioning for awareness — not adding a guard test since Drake explicitly wants the field stays unrendered and the spec said no code changes for Task 2.

## Out of scope / deferred

- **Drake's gate (d):** set `FAQ_DIGEST_CC_SLACK_USER_ID=U0AMC23G1SM` in Vercel Production env vars. Until that's set, the cron continues Scott-only delivery.
- **Drake's gate (c):** post-deploy manual curl of `/api/faq_digest_cron` with the production `CRON_SECRET` to validate Drake receives the CC DM. First scheduled Friday tick under CC is May 22, 2026.
- **CC removal procedure** documented in the runbook's § Disable temporarily — unset the env var, redeploy; Scott's delivery is uninterrupted.
- **Task 2 follow-up if needed:** if Drake ever changes his mind about `questions_asked` surfacing on `/calls/[id]`, the path is straightforward — extend `CallReview` TS interface, extend `parseCallReview` validation, add a new `ReviewSection` in `app/(authenticated)/calls/[id]/page.tsx`. No data migration needed since the field is already populated in `documents.content`.

## Side effects

- **No cloud DB writes for Task 2** — read-only investigation.
- **No cloud DB writes for Task 1 today** — the cron only fans out when invoked at a scheduled tick or via manual curl, neither of which happens during a Builder pass.
- **No Slack posts.** First real CC delivery happens after Drake sets the env var + the next cron tick (Friday May 22 unless manually curl'd sooner).
- **No env var values changed.** `.env.example` is documentation-only; the actual Vercel value is Drake's gate (d).
- **Push triggers Vercel auto-deploy** of the new code path; the cron's existing weekly schedule (`0 19 * * 5`) is unchanged. CC behavior activates the moment Drake sets the env var.
