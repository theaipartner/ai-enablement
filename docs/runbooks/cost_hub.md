# Runbook: Cost hub

Operational guide for the admin-tier `/cost-hub` page (migration 0038;
origin specs `cost-hub` + `cost-hub-effective-from-and-title-convention-v2`
+ `cost-hub-call-review-haiku-audit`, deleted at 2026-05-15 —
recover from git history if needed). Closes Gregory V1 — the
cost-reduction-opportunity surface for Nabeel.

## What the page shows

Four sections, top to bottom:

1. **Total this month** — big-number box. Sum of all three categories
   below for the current month (America/New_York). "History" button
   reveals the last 12 completed months, each row expandable to its
   five-bucket + subs + extras breakdown.
2. **Anthropic spend** — five buckets, each with Today / This week /
   This month rows showing runs / total cost / avg-per-run. Costs roll
   up from `agent_runs.llm_cost_usd` (no new infrastructure — the
   existing per-run telemetry is the source).
3. **Monthly subscriptions** — manually-maintained editable table
   (provider / monthly cost / notes). Footer shows the monthly sum.
4. **One-off extras** — manually-maintained editable table (date /
   description / cost), scoped to the current month. Footer shows the
   month's sum.

## Access

Admin-tier only. `app/(authenticated)/cost-hub/layout.tsx` gates the
route; non-admin tiers redirect to `/clients?error=insufficient_access`.
The TopNav "Cost hub" link is hidden for tiers below admin. Every
mutating server action self-checks `tierAtLeast('admin')` as
defense-in-depth.

## The five Anthropic buckets — exact filter strings

These are the canonical `agent_runs` filters. If a future subsystem
starts using Claude under a new `agent_name`, add a sixth bucket to
`BUCKET_DEFINITIONS` in `lib/db/cost-hub.ts` so its spend is visible.

| Bucket (UI label) | `agent_name` | `llm_model` LIKE |
|---|---|---|
| Ella Sonnet | `ella` | `claude-sonnet%` |
| Ella Haiku | `ella` | `claude-haiku%` |
| Call review Sonnet | `call_reviewer` | `claude-sonnet%` |
| Call review Haiku | `call_reviewer` | `claude-haiku%` |
| Gregory brain Sonnet | `ai_call_signal` | `claude-sonnet%` |

**Note on "Call review Haiku":** this bucket captures the sentiment
classifier (`agents/call_reviewer/sentiment_classifier.py`) — a Haiku
call that fires on every call review write. It opens its own
`agent_runs` row with `agent_name='call_reviewer'` +
`trigger_type='sentiment_classifier'` (the Sonnet review pass uses
`trigger_type` of `manual_backfill` / `fathom_pipeline`). Telemetry
was added 2026-05-15 (spec `cost-hub-call-review-haiku-audit`); before
that the sentiment Haiku spend was real but untracked (the classifier
called `complete()` without a `run_id`). **Forward-only fix — the
pre-2026-05-15 sentiment Haiku spend is not backfilled and stays
invisible.** The bucket's `earliestReliableDate` is `2026-05-15`, so
the "(incomplete before 2026-05-15)" caveat communicates the gap until
it ages out (~30 days post-fix). To split sentiment runs from review
runs in a query: filter `trigger_type='sentiment_classifier'`.

**Note on "Gregory brain Sonnet":** the bucket filters on
`agent_name='ai_call_signal'`, NOT `'gregory_brain'`. The Gregory brain
V2's Sonnet calls land under `ai_call_signal` (`agents/gregory/ai_call_signal.py`
is the dominant V2 rubric contributor — state.md). The `agent_name='gregory'`
runs are brain orchestration that delegates the LLM portion to
ai_call_signal and never calls Claude directly — those rows have null
`llm_model` / `llm_cost_usd` and correctly fall outside every bucket.

## Data-incompleteness caveats

Cost tracking didn't start at the same time for every bucket. The
"This month" row shows an "(incomplete before YYYY-MM-DD)" caption when
the bucket's earliest reliable cost-tracking date falls inside the
current month. Determined via a pre-flight inventory query against
`agent_runs` (run at spec time; re-run if you suspect drift):

| Bucket | Earliest reliable cost data | Caveat behavior |
|---|---|---|
| Ella Sonnet | 2026-04-24 (Ella V1) | No caveat — predates any current month going forward |
| Ella Haiku | 2026-05-11 (V2.3 passive monitor added Haiku) | "(incomplete before 2026-05-11)" while current month is May 2026 |
| Call review Sonnet | 2026-05-07 (call_reviewer launch) | "(incomplete before 2026-05-07)" while current month is May 2026 |
| Call review Haiku | 2026-05-15 (sentiment-classifier telemetry added — spec `cost-hub-call-review-haiku-audit`) | "(incomplete before 2026-05-15)" until ~30 days post-fix |
| Gregory brain Sonnet | 2026-05-07 (ai_call_signal launch) | "(incomplete before 2026-05-07)" while current month is May 2026 |

Today + This week rows never show the caveat — they're always recent
enough that every bucket has reliable data.

To re-verify the earliest dates, query:

```sql
SELECT agent_name, MIN(started_at) AS earliest_with_cost
FROM agent_runs
WHERE llm_cost_usd IS NOT NULL
GROUP BY agent_name
ORDER BY agent_name;
```

If reality drifts, update `earliestReliableDate` per bucket in
`BUCKET_DEFINITIONS` (`lib/db/cost-hub.ts`).

## Manual subs + extras workflow

**Add a subscription:** fill provider / monthly cost / notes /
effective from in the Monthly subscriptions box → Add. **Edit:** click
Edit on a row, change fields (including effective from), Save.
**Delete:** click × → confirm. Delete is a SOFT archive (sets
`archived_at`), so historical month totals stay accurate for months
when the sub was active.

**Add an extra:** fill date / description / cost in the One-off extras
box → Add. The date defaults to today (EST) but can be backdated for
late-arriving invoices. Same edit / soft-archive-delete shape.

## Subscription effective date

Each subscription carries an `effective_from` date (migration 0039).
It governs which months the sub contributes to in the total + the
History view. The rule (implemented once in
`lib/db/cost-hub.ts:subscriptionActiveInMonth`):

> A sub counts toward month **M** when `effective_from <= last_day_of_M`
> **and** (`archived_at IS NULL` **or** `archived_at >= first_day_of_M`).

**Why it exists.** Before 0039 the History view summed *every*
non-archived subscription into *every* past month. A sub added today
inflated last month, the month before, and so on back to the start of
history. `effective_from` ties a sub to when it actually started.

**The default.** The Add form defaults `effective_from` to today
(EST). Add a sub normally and it counts from this month forward — it
does **not** retroactively appear in prior months.

**Backdating use case.** A subscription has been
billing since (say) March but was only just added to the hub. Set
`effective_from` to the March date (in the Add form, or Edit an
existing row). The History view then retroactively attributes it to
March, April, May, … — every month at-or-after `effective_from`. This
is the intended escape hatch for "I forgot to log this sub for a few
months."

**Archived subs still count for their active window.** Soft-archiving
a sub sets `archived_at`; the sub still contributes to every month
between `effective_from` and the archive date. It only drops out of
months that begin on/after the archive date. So deleting a sub today
does not erase it from last month's total — AND, after the 2026-05-23
current-month-total fix, doesn't erase it from THIS month's total
either if it was active when the month started or anywhere within
the month (e.g. archiving an active sub on the 23rd keeps its cost
in May's running total; it just stops counting from June onward).

**One list, two surfaces, sum-to-total invariant (2026-05-24).** The
cost-hub page derives ONE list per surface — `subsActiveInMonth` (for
subscriptions) and `extrasForTotal` (for extras) — both archive-
inclusive. The same list feeds BOTH the visible table AND the
"TOTAL · THIS MONTH" running total, so the visible line items'
costs sum to the total displayed at the top. The pre-2026-05-24
shape (separate `editableSubscriptions` for the table vs
`subsActiveInMonth` for the total) was confusing: archived-mid-
month rows were counted in the total but invisible in the table,
so the page didn't add up. Now they show with a "Cancelled" badge
(see next subsection) so what you see is what you get.

**Cancelled subs stay visible with a "Cancelled" badge** for the
month they're still being counted in (post-2026-05-24 redesign).
A subscription that's been Cancelled (soft-archived) mid-month
shows in the Monthly Subscriptions table with a red "Cancelled"
badge in place of the Edit button, an opacity-dimmed strike-
through provider name, and a Remove (×) button as the only
remaining action. Its cost stays in the running total because
it was paid for this month. When the month rolls over, the
cancelled row drops out of the visible list automatically
(`subscriptionActiveInMonth` returns false once `archived_at`
predates the new month's start) and stops counting from there
forward. So the lifecycle is: Active → Cancelled-this-month
(visible, counted, no Edit) → gone from current view + count
next month → still in history for the months it was active.

**Existing-row backfill.** Migration 0039 set `effective_from =
created_at::date` for the rows present at apply time — they retain
the "started when I added them" semantic rather than silently
counting back forever. If one of those should count from earlier,
Edit the row and set the correct `effective_from`.

## Historical sub price drift (locked trade-off)

Monthly subs are stored as "current state" — one row per provider with
`monthly_cost_usd` reflecting today's price. Historical month totals
use today's price even if the actual cost was different at the time.
If a sub price changes mid-period, edit the row in place; old month
totals shift slightly. This is a deliberate V1 simplification.

Note `effective_from` (migration 0039) does **not** solve this — it
governs *which months a sub counts in*, not *what it cost in each
month*. A sub that was $20 in March and $25 now still contributes $25
to March's total. True per-month price history (a price-versioned
sub-rows table or an `effective_from`-keyed price ledger) remains the
out-of-scope-for-V1 future iteration if reconciliation ever needs it.

## Cancel vs Remove (the × menu)

Each subscription row has TWO destructive buttons in its action area
(post-2026-05-24, spec `cost-hub-total-cancel-remove-and-add`):

- **Cancel** (neutral border): soft-archive (`archived_at = now()`).
  The subscription stops counting next month but stays counted in
  THIS month's total + visible in the list with a "Cancelled" badge.
  Use for "I cancelled the sub but already paid for this month."
  Reversible via SQL (set `archived_at = NULL`).

- **Remove (×)** (red border, destructive): hard `DELETE`. The row
  is gone from THIS month's total, gone from all historical month
  totals, gone from the table. Irreversible. Use for mistakes only
  ("typo'd the cost", "added the wrong sub"). The confirm dialog
  warns explicitly before the delete fires.

Cancelled-this-month rows show only Remove in their action area
(Cancel already happened; no point cancelling again). Cancelled
rows whose paid month has passed don't show at all (they drop out
of the visible list once `archived_at` predates the new month's
start; still in history).

One-off extras have only **Remove** (no Cancel — there's no "next
month" semantic for a one-off cost). Same destructive confirm
pattern.

## Recovering a bad delete

For **Cancel** (soft archive): the row is still in the table, just
filtered out of forward months once they begin. Restore with:

```sql
-- monthly_subscriptions
UPDATE monthly_subscriptions SET archived_at = NULL WHERE id = '<uuid>';

-- cost_extras
UPDATE cost_extras SET archived_at = NULL WHERE id = '<uuid>';
```

Find recently-archived rows:

```sql
SELECT id, provider, monthly_cost_usd, archived_at
FROM monthly_subscriptions
WHERE archived_at IS NOT NULL
ORDER BY archived_at DESC LIMIT 20;

SELECT id, incurred_on, description, cost_usd, archived_at
FROM cost_extras
WHERE archived_at IS NOT NULL
ORDER BY archived_at DESC LIMIT 20;
```

For **Remove** (hard delete): the row is gone — no recovery from the
DB. Restore by manually re-adding via the Add form with the same
provider/cost/effective_from. Note: the new row will have a fresh
`id` + `created_at`, so it won't be a perfect "undo" — but the
totals will reconcile.

The Playwright verifier (`scripts/verify-cost-hub-preview.ts`)
hard-DELETEs its `__verify_*` test rows in a try/finally cleanup
step (post-2026-05-24 rewrite). If the verifier ever fails mid-run
in a way that breaks the cleanup, the leftover test rows can be
removed via SQL — same pattern that resolved the 2026-05-23
pollution incident:

```sql
DELETE FROM monthly_subscriptions WHERE provider LIKE '__verify_%';
DELETE FROM cost_extras WHERE description LIKE '__verify_%';
```

## Performance notes

- The page makes ~5 parallel bucket queries × 3 periods + subs + extras
  + 12 months of history (each ~5 bucket queries + 1 extras query) on
  initial load. At current data volumes (~hundreds of rows per window)
  this is fine. If the History view gets slow at scale, batch the
  per-month queries into a single Postgres function returning all 12
  months at once — out of scope for V1.
- `agent_runs` aggregation is JS-side (fetch `llm_cost_usd` rows, sum
  in JS) because PostgREST doesn't expose `sum()` cleanly. Per-window
  row counts are small enough that this is not a concern; revisit if a
  bucket's monthly run count climbs past ~10k.

## Disabling temporarily

Remove the TopNav entry (`components/top-nav.tsx` `NAV_ITEMS`) and/or
make the layout redirect unconditionally. There's no cron or webhook —
the page is pure read + manual-edit, so "disabling" just means hiding
the route. No infrastructure to tear down.

## Origin

Migration `0038_cost_hub_tables.sql` (tables) + `lib/db/cost-hub.ts`
(data layer) + `app/(authenticated)/cost-hub/*` (page, layout, actions,
client components). Schema docs: `docs/schema/monthly_subscriptions.md`,
`docs/schema/cost_extras.md`.
