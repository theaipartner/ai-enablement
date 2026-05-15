# Report (PARTIAL): Cost hub effective_from + title convention v2

**Slug:** cost-hub-effective-from-and-title-convention-v2
**Spec:** docs/specs/cost-hub-effective-from-and-title-convention-v2.md
**Status:** halted — awaiting Drake gate (a) SQL review of migration 0039 before apply

## Files touched

**Created:**
- `supabase/migrations/0039_subscription_effective_from.sql` — Task 1 migration. Adds `effective_from date NOT NULL DEFAULT CURRENT_DATE` to `monthly_subscriptions`; backfills existing rows to `created_at::date`. Block comment carries the bug rationale, the backfill-choice reasoning, and the no-index decision.

## What I did, in plain English

Walked the spec's 5-bullet acclimatization checklist and confirmed the bug Director identified is real: `lib/db/cost-hub.ts:getMonthTotal` calls `getMonthlySubscriptions()` (every non-archived sub) and sums all of them into every historical month. A subscription added during 2026-05-15 cost-hub validation (Claude Max etc.) currently inflates April 2026, March 2026, and every prior month's total — because the data layer has no notion of when a subscription began.

Wrote migration 0039. The durable fix is an `effective_from date` column; combined with the existing `archived_at`, a subscription is "active in month M" when `effective_from <= last_day_of_M AND (archived_at IS NULL OR archived_at >= first_day_of_M)`. The migration backfills existing rows to `created_at::date` (per spec § Hard stops #2 — the spec's locked choice; matches Drake's "subs surface from when I added them" model). Did NOT apply — hard stop per spec § Hard stops #1.

Task 2 (title convention v2) is independent and not started — it has no migration and no hard stop, so it proceeds after the Task 1 apply.

## Verification

- **Bug confirmed by code reading:** `getMonthTotal` (cost-hub.ts:523-527) does `const subs = await getMonthlySubscriptions(); const subscriptions = subs.reduce(...)` with zero date filtering. `getRecentMonthTotals` calls `getMonthTotal` for offsets 1..12, so every one of the last 12 months gets the full current sub list summed in.
- **Migration not yet applied** — awaiting gate (a). No dual-verify yet.

## Surprises and judgment calls

- None yet. The backfill choice (`created_at::date` vs NULL-means-always-active) was pre-decided by the spec (§ Hard stops #2); I confirmed `created_at::date` is correct — NULL-as-always-active would re-introduce the exact bug for the 3 existing rows.

## Out of scope / deferred

Everything past 0039's apply: data layer changes, UI, server actions, schema doc, verifier extension, runbook (Task 1); the entire Task 2 (classifier v2 + 11 tests + ADR 0002 revision + call_title_convention runbook); the combined state.md entry.

## Side effects

None outside the repo. No DB writes (migration not applied), no API calls, no Slack posts.

## What's needed to unblock

**Single decision from Drake:** approve migration 0039 SQL for apply, or push back.

```sql
alter table monthly_subscriptions
  add column effective_from date not null default current_date;

update monthly_subscriptions
   set effective_from = created_at::date;
```

Plus a `comment on column`. The 3 existing rows (added during today's validation) will land at `effective_from='2026-05-15'`. Reversible: `alter table monthly_subscriptions drop column effective_from;` (nothing references it yet — the data-layer changes that consume it land after apply). Full SQL with rationale at `supabase/migrations/0039_subscription_effective_from.sql`, committed `14279df`.

**Spec § Hard stops #2 also asks Builder to confirm the backfill choice before applying:** I confirm `created_at::date` is correct. The 3 existing subs were all added during 2026-05-15 validation, so they get `effective_from='2026-05-15'` — appearing in May 2026 history onward, not retroactively in April/March. The NULL-means-always-active alternative would leave the bug intact for exactly these rows. If Drake later wants Claude Max attributed to when he actually started paying, he edits the row's `effective_from` via the cost-hub UI (the editable field lands as part of the post-apply Task 1 work).

**Once approved, Builder resumes with:**
1. Apply via `supabase db push --linked --dns-resolver https --password "$SUPABASE_DB_PASSWORD" --yes`.
2. Dual-verify (column present + NOT NULL + default via information_schema; 3 rows = `effective_from='2026-05-15'`; ledger row 0039).
3. Task 1 remainder: data layer (`subscriptionActiveInMonth` helper, `getMonthTotal`/`getCurrentMonthTotal`/page filter), UI date input, server-action params, schema doc, verifier extension, cost_hub runbook.
4. Task 2 in full: classifier v2 + 11 tests + ADR 0002 revision + call_title_convention runbook.
5. Combined state.md entry.

Resume report will land at `docs/reports/cost-hub-effective-from-and-title-convention-v2-resume.md` per the no-overwrite-on-resume rule.
