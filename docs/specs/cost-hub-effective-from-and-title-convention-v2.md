# Cost hub effective_from + title convention v2
**Slug:** cost-hub-effective-from-and-title-convention-v2
**Status:** in-flight

Two unrelated fixes bundled into one Builder pass per the bundling escape valve. Both are small enough that two separate sessions would be more overhead than the work warrants. Builder commits each task as its own logical-change commit per the rule.

## Context Builder needs

Read these first, confirm understanding in 4-5 bullets:

- `lib/db/cost-hub.ts` — Specifically `getRecentMonthTotals` + `getMonthTotal` + `getCurrentMonthTotal`. The bug Director identified: `getMonthlySubscriptions()` returns every non-archived sub regardless of date, and `getMonthTotal` (called for each historical month) sums all of them — meaning every historical month total includes Claude Max even though it was just added today. Same bug for `getCurrentMonthTotal`'s subscription sum, indirectly.
- `supabase/migrations/0038_cost_hub_tables.sql` — the `monthly_subscriptions` table schema. Adding `effective_from date` and (already present) `archived_at` is the durable fix.
- `app/(authenticated)/cost-hub/cost-hub-tables.tsx` + `app/(authenticated)/cost-hub/actions.ts` — Editable subscriptions table. New `effective_from` field needs to surface in the add form + edit mode.
- `ingestion/fathom/classifier.py` — Specifically `_NEW_TITLE_CONVENTION_CUTOFF`, `NEW_CLIENT_TITLE_PATTERNS`, `_matches_new_client_title_convention`, `_classify_by_new_convention`. The v2 title pattern extends this surface.
- `ClientResolver.lookup_by_name` — Already exists; classifier already does email-first-then-name resolution. The v2 spec uses the same primitive against the **title prefix** instead of the participant display_name.
- `docs/decisions/0002-title-convention-enforcement.md` — ADR to update.

## Task 1: Cost hub subscription `effective_from`

### What changes

A new column `effective_from` (date) on `monthly_subscriptions`. Determines which historical months a subscription contributes to:

- A subscription is **active in month M** when `effective_from <= last_day_of_M` AND (`archived_at IS NULL` OR `archived_at >= first_day_of_M`).
- Current month uses the same rule against today's date.
- The page renders only active-for-this-month subscriptions in the editable table (no change to the current rendering — today's UI already filters by `archived_at IS NULL` which subsumes the new rule for the current month).
- History view's per-month totals filter via the new rule.

### Migration 0039

New migration `0039_subscription_effective_from.sql`:

- Add `effective_from date NOT NULL DEFAULT CURRENT_DATE` to `monthly_subscriptions`.
- Backfill: existing rows get `effective_from = created_at::date` so they retain the "added today" semantic for the rows added during today's cost-hub validation (Claude Max, ElevenLabs, Anthropic extras). Once 0039 applies, all 3 existing rows will have `effective_from='2026-05-15'` (today) — meaning they appear in May 2026 history and onward, NOT in April / March / etc.
- Index: none. The page query reads ~5-10 subs total; full table scan is fine.

**Hard stop — gate (a) SQL review.** Builder writes the migration but does NOT apply. Surface the SQL diff for Drake's review. After approval: apply + dual-verify.

### Schema doc

`docs/schema/monthly_subscriptions.md` — add the new `effective_from` column to the columns table + a short paragraph explaining the month-attribution rule.

### Data layer changes — `lib/db/cost-hub.ts`

1. **`MonthlySubscription` type** gains `effective_from: string` (ISO date YYYY-MM-DD).
2. **New helper** `subscriptionActiveInMonth(sub, monthStart, monthEnd): boolean` implementing the rule above. Pure function, easy to test.
3. **`getMonthlySubscriptions`** — no behavior change. Still returns every non-archived sub. The page-level filter happens at the consumer.
4. **`getMonthTotal`** — call the new helper to filter subs to those active in the given month before summing. Same for the archived-state check.
5. **`getCurrentMonthTotal`** — accept the filtered list of active-this-month subscriptions instead of all non-archived subs. The caller (page.tsx) passes the filtered list.
6. **`page.tsx`** — fetch all subs once, then filter once for "active in current month" before passing to both the editable table render AND `getCurrentMonthTotal`. The page already has the month-boundary in scope via the bucket computation.

### Editable UI — `app/(authenticated)/cost-hub/cost-hub-tables.tsx`

Add `effective_from` as a date input to:
- The "Add subscription" inline form (defaults to today via `new Date().toISOString().split('T')[0]`).
- The per-row edit mode (alongside provider / cost / notes).

Column placement: after Notes, before the actions column. Header label: "Effective from."

### Server actions — `app/(authenticated)/cost-hub/actions.ts`

- `addMonthlySubscriptionAction` — gains `effectiveFrom: string` parameter. Validates ISO date (`YYYY-MM-DD`) at the action boundary. Defaults to today if omitted (defensive — the form should always pass it, but a fallback prevents crashes).
- `updateMonthlySubscriptionAction` — same parameter and validation.

### Migration of existing UI for `cost_extras`?

**No.** `cost_extras.incurred_on` already has the date-attribution semantic — extras only contribute to the month they happened in. This task is subscriptions-only.

### Tests

No Python tests exist for `lib/db/cost-hub.ts`. The Playwright verifier `scripts/verify-cost-hub-preview.ts` covers add+delete. Builder extends the verifier to:

1. Add a subscription with `effective_from` set to two months ago.
2. Open History view, assert the historical-month total reflects that sub.
3. Add another subscription with `effective_from` set to today.
4. Open History view again, assert the historical-month total does NOT reflect the today-added sub (but the current month total does).
5. Delete both subs (soft-archive cleanup).

If the verifier infrastructure can't easily do step 2's history assertion, Builder simplifies to: add today-dated sub, verify it appears in the active table; add backdated sub, verify it appears in the active table. The cost-rollup correctness is then validated via SQL inspection in the report.

### Doc updates

- `docs/runbooks/cost_hub.md` — add a § "Subscription effective date" section explaining the month-attribution rule + the backdating use case (forgot to add a sub for a prior month, now want it to count back).
- `docs/state.md` — single bullet under the 2026-05-15 bundle noting the effective_from follow-up.

### Acceptance criteria for Task 1

- Migration 0039 written, gate (a) reviewed, applied, dual-verified.
- 3 existing subs end up with `effective_from='2026-05-15'`.
- Page renders effective_from in the editable table.
- Adding a sub with today's date → appears in current-month total only.
- Adding a sub with a backdated effective_from → appears in current month AND retroactively in the historical month(s) at-or-after effective_from.
- Deleting a sub → soft-archives; the sub no longer contributes to months at-or-after the archive date.
- `tsc --noEmit` + `next lint` clean.

## Task 2: Title convention v2 — `[Client Name] - Coaching/Sales Call with {Scott|Lou|Nico}`

### What changes

Zain updated the booking-link convention from `Coaching Call with Scott` to `Andrew Hsu - Coaching Call with Scott` (client name prefix). The classifier needs to:

1. Recognize the new pattern alongside the old pattern (both stay valid; no second cutoff).
2. Use the name prefix as the PRIMARY client-resolution signal, with participant email as backup.

### Classifier changes — `ingestion/fathom/classifier.py`

1. **New constant** `NEW_CLIENT_TITLE_PATTERNS_V2`: tuple of `(call_type, csm_name)` pairs that the v2 matcher uses to identify Coaching vs Sales × Scott / Lou / Nico. Could be a list of the same 6 strings as `NEW_CLIENT_TITLE_PATTERNS` but checked as a *suffix* match instead of prefix.

   Actual implementation likely cleaner: a new helper `_extract_v2_title_prefix_and_type(title: str) -> tuple[str, str] | None` that returns `(client_name_prefix, call_type)` if the title matches `^(.+?) - (Coaching|Sales) Call with (Scott|Lou|Nico)` (case-insensitive, trailing context tolerated), else None. Builder picks the regex shape.

2. **Update `_matches_new_client_title_convention`** to ALSO return true if `_extract_v2_title_prefix_and_type` matches. The function currently only checks v1 prefixes — extend to OR with v2.

3. **Update `_classify_by_new_convention`**:
   - Before trying to resolve from external_emails, call `_extract_v2_title_prefix_and_type`. If it returns a (name_prefix, call_type) tuple, attempt to resolve the client via `resolver.lookup_by_name(name_prefix)`.
   - If name resolution succeeds → set `primary_client_id`, `matched_via='title_name_prefix'`, reasoning includes the matched name and call_type.
   - If name resolution fails → fall back to the existing email-based resolution against `external_emails` (current behavior).
   - The auto-create path remains the same (first unresolved external email when no client matches by any signal).

4. **Collision handling.** `resolver.lookup_by_name` returns a single `client_id` from the name map. If two clients have the same full_name, only one gets indexed — the OTHER never resolves by name. This is acceptable surface for V1 — it gracefully falls back to email matching for the unindexed client. Note in the spec what happens; surface in the report if collisions are common (Builder runs a SQL count of duplicate `full_name` values in `clients`).

5. **Derive call_type from the match.** The v2 regex captures `(Coaching|Sales)` — set `call_type='coaching'` or `'sales'` accordingly. Falls through to the existing title-lowercase heuristic if the regex didn't fire (v1 path).

### Test additions

`tests/ingestion/fathom/test_classifier.py` — new tests:

1. **v2 title + name resolves to existing client.** "Andrew Hsu - Coaching Call with Scott" with an external participant matching Andrew Hsu by email → primary_client_id resolves via name prefix; reasoning mentions title_name_prefix.
2. **v2 title + name resolves to existing client + email doesn't match.** Same title, but the actual participant emails are different (rare — client joined from a different email). primary_client_id should still resolve via name prefix.
3. **v2 title + name doesn't resolve + email resolves.** "Unknown Person - Coaching Call with Scott" where "Unknown Person" isn't in any clients row, but the participant email IS. Fall through to email resolution.
4. **v2 title + neither name nor email resolves.** "Unknown Person - Coaching Call with Scott" with unresolvable participants → emits AutoCreateRequest for the first external email (current behavior).
5. **v2 title with no external participants.** Edge case — booking link generated the title but no client is on the invite. Same handling as v1: classify as client, no primary, no auto-create.
6. **v2 title pre-cutoff.** "Andrew Hsu - Coaching Call with Scott" started before 2026-05-18 → falls through to participant-match path (v2 only activates post-cutoff, same as v1).
7. **v1 title post-cutoff still works.** "Coaching Call with Scott" still classifies cleanly. Regression check.
8. **Trailing context tolerated.** "Andrew Hsu - Coaching Call with Scott - May 22 follow up" still matches v2.
9. **Case-insensitive.** "ANDREW HSU - coaching call with SCOTT" matches.
10. **Trims whitespace.** "  Andrew Hsu  -  Coaching Call with Scott  " matches.
11. **Distinct classification_method.** v2 matches surface `classification_method='title_pattern_v2'` (Builder's call on exact string) so audit queries can split v1 from v2 matches. Existing v1 stays at `'title_pattern'`.

Existing classifier tests (~25 around the v1 cutoff logic) should remain green without modification.

### ADR 0002 update

`docs/decisions/0002-title-convention-enforcement.md` — add a "Revision: 2026-05-15" section explaining:
- Zain's natural iteration of the convention (prefix client name).
- The classifier accepts both v1 and v2 patterns indefinitely (no second cutoff).
- v2 uses the name prefix as primary client-resolution signal; email is backup.
- Why no separate ADR 0003: same management lever, same forcing function, same fence; just better.

### Runbook updates

`docs/runbooks/call_title_convention.md` — extend the documented patterns to include v2. Add a note about the name-prefix-as-primary-resolution behavior.

### Doc updates

- `docs/state.md` — single bullet under the 2026-05-15 bundle noting the title convention v2 ship.
- No CLAUDE.md update needed (the convention is documented in the runbook + ADR; CLAUDE.md doesn't enumerate classifier shapes).

### Acceptance criteria for Task 2

- New v2 matcher in classifier.py.
- 11 new tests, all green.
- `pytest tests/ -q` shows the new test count (current 596 → ~607).
- Existing 25-ish classifier tests stay green (regression-free).
- ADR 0002 carries the revision section.
- Runbook updated.

## Hard stops

1. **Migration 0039 apply** — gate (a). Drake reviews SQL diff before apply.
2. **Backfill semantics** — the migration backfills existing rows with `created_at::date`. Builder confirms this is the right choice before applying. (Alternative: backfill with NULL and treat NULL as "always active." Director's lean is the date-from-created-at since it matches Drake's mental model — "subs surface from when I added them.")

## Hard-numerical thresholds

- If `clients.full_name` duplicate count is >5 (i.e., more than 5 pairs of clients share a full_name), surface and flag — title-prefix name resolution will silently miss the unindexed twin. Acceptable but worth knowing.

## What could go wrong

- **Backfill semantics on existing subs.** Builder uses `created_at::date` for backfill, meaning the 3 subs added today get effective_from=2026-05-15. This is the desired behavior. If Drake later wants to back-date Claude Max to whenever he actually started paying for it (April? March?), he edits the row via the UI.
- **History view performance** doesn't materially change — still ~89 queries on cold load. The added filter helper is JS-side.
- **Resolver name map's "single match per name" behavior** — duplicate full_names lose the second-indexed client. Acceptable for V1; collision SQL inspection in the report.
- **v2 regex greedy match** — `(.+?) - (Coaching|Sales)` could over-match on titles like "FW: Andrew Hsu - Coaching Call with Scott". The non-greedy `+?` should anchor to the FIRST ` - (Coaching|Sales)` occurrence, but Builder verifies via test case.
- **The two tasks are independent.** A bug in one doesn't affect the other. Commit them separately per the convention; failure in Task 2 should not block Task 1's apply.

## Mandatory doc-update list

- `docs/schema/monthly_subscriptions.md` (effective_from column added)
- `docs/runbooks/cost_hub.md` (effective date section added)
- `docs/decisions/0002-title-convention-enforcement.md` (revision section)
- `docs/runbooks/call_title_convention.md` (v2 pattern + name-resolution note)
- `docs/state.md` (bullet for both tasks)
- No CLAUDE.md update.

## Sequence

1. Task 1: Pre-flight verify the bug exists (run `getRecentMonthTotals` mentally against current data and confirm the historical-months-include-Claude-Max behavior).
2. Task 1: Migration 0039 written.
3. **HARD STOP — Drake SQL review of 0039.**
4. Task 1: Apply + dual-verify.
5. Task 1: Schema doc + data layer + UI + server action changes.
6. Task 1: Playwright verifier extension.
7. Task 1: Runbook update.
8. Task 2: Classifier changes + 11 new tests.
9. Task 2: ADR + runbook updates.
10. Combined: docs/state.md entry covering both.

If any commit fails its tests, hard stop and surface per the standard rules.
