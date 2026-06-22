# Report: Cost hub — investigate monthly-cost display + add-button failure (read-only, spec follows)
**Slug:** cost-hub-monthly-cost-and-add-investigation
**Spec:** docs/specs/cost-hub-monthly-cost-and-add-investigation.md

## Files touched

Created:
- `docs/reports/cost-hub-monthly-cost-and-add-investigation.md` — this report.

Modified:
- `docs/specs/cost-hub-monthly-cost-and-add-investigation.md` — `Status:` flipped from `in-flight` to `shipped`.

No code, schema, or data changes. All cloud queries were read-only `SELECT`s via psycopg2 pooler. One additional read-only side query against Vercel logs (filtered, JSON output) to characterize live traffic; no production state touched.

## What I did, in plain English

Three crisp verdicts:

- **Q1 = DISPLAY bug.** Drake's hypothesis is correct. The ElevenLabs row is intact in the DB (`archived_at='2026-05-23 19:41:39 UTC'`, `effective_from='2026-05-15'`, `monthly_cost_usd=25.46`) — active May 15 → archived May 23. It should count toward May 2026's total per the `subscriptionActiveInMonth` contract. It doesn't, because the current-month code path filters archived rows out at the database layer AND hardcodes `archived_at: null` when passing rows through the helper. The history path does this correctly via a separate fetch + the real `archived_at`; the current-month path doesn't. The asymmetry is the bug.

- **Q2 = NO reproducible code-level bug found. The `ISO_DATE_RE` TDZ theory is a FALSE ALARM.** I read the add path end-to-end, ran every plausible failure mode through the code, and could not locate a bug that would cause a silent add failure today. The Playwright verifier (`scripts/verify-cost-hub-preview.ts`) successfully exercised the add path on 2026-05-15 and the test rows it created are still in the DB. No cost-hub code has changed since 2026-05-15. Auth/tier checks pass for Drake (his `team_members.access_tier='creator'` clears the `tierAtLeast('admin')` gate). Vercel logs show ZERO `/cost-hub` activity in the last 12 hours — including zero server-action POSTs. Most likely explanations are environmental, not code-level: stale browser cache serving pre-deploy JS, browser extension blocking the action, session timeout that needed re-auth, or the failure happened against a stale/preview deploy. Detailed reproduction guidance below; the spec's safety hard-stop ("do NOT 'test' the add button by actually adding a row") prevented me from running a live add to confirm.

- **Q3 = two operations, two actions, hard-delete for "remove."** Soft archive (today's "delete" button) is the right primitive for **Cancel** (stop next month, keep this month — the Q1 fix makes this actually work). A new **Remove** action should hard `DELETE` the row for mistakes — the schema supports it cleanly, the alternative (a `mistakenly_added` boolean) over-complicates with no real upside since "I added this by mistake" is rare and irreversibility is acceptable given a clear confirm dialog.

Detailed evidence and the "what the fix touches" pointer per question below.

## Verification

### Acclimatization (4 bullets)

- `app/(authenticated)/cost-hub/actions.ts` — six server actions: add/update/delete × monthly_subscriptions + cost_extras. All wrap `requireAdmin()` check, validate inputs, call Supabase insert/update, return `{success:bool, error?}`. Delete = soft archive (`archived_at=now()` UPDATE). Comment at line 13-15: "Soft archive on delete — historical month totals stay accurate for months when the row was active. Hard delete via SQL is available for the rare 'I never want to see this row again' case."
- `app/(authenticated)/cost-hub/page.tsx` — Server Component composing Anthropic bucket summaries + subscriptions + extras + recent-month totals. Computes "TOTAL · THIS MONTH" via `getCurrentMonthTotal(summaries, activeSubscriptions, extras)`. The `activeSubscriptions` list comes from filtering `getMonthlySubscriptions()` via `subscriptionActiveInMonth(...)` at line 72-78 — and THIS is where the bug lives.
- `app/(authenticated)/cost-hub/cost-hub-tables.tsx` — Client Component (`'use client'` at line 1) with `MonthlySubscriptionsTable` + `CostExtrasTable`. Both use `useTransition` + `router.refresh()` pattern. Add form (line 127-188 for subs) submits via `submitAdd` which validates inline + calls the server action + sets `error` state on failure + clears form on success. Error displayed at line 189-196 with `role="alert"`.
- `lib/db/cost-hub.ts` — data layer. `subscriptionActiveInMonth` at line 168-177 is the correct overlap-with-month predicate. `getMonthlySubscriptions` at line 341-360 filters `.is('archived_at', null)` — non-archived only. `fetchSubscriptionsForHistory` at line 366-380 (internal, not exported) fetches ALL subs including archived for the history rollup. Migrations 0038 + 0039 both applied (schema confirms: `effective_from` column present, `archived_at` column present).

### Q1 — DISPLAY bug. Specific evidence + the exact line.

**ElevenLabs DB row (verbatim from cloud):**
```
id:                 818307e7-93bc-458b-ab3d-bec2a1fc4441
provider:           ElevenLabs
monthly_cost_usd:   25.46
effective_from:     2026-05-15
archived_at:        2026-05-23 19:41:39 UTC  (TODAY — archived ~1.5h before this investigation)
created_at:         2026-05-15 21:16:43 UTC
notes:              (null)
```

**Per the `subscriptionActiveInMonth` contract (`lib/db/cost-hub.ts:168-177`):** a sub is active in month M when `effective_from <= last_day_of_M AND (archived_at IS NULL OR archived_at >= monthStart)`. For May 2026 (`monthStart=2026-05-01 UTC`, `monthEnd=2026-06-01 UTC`):
- `effective_from=2026-05-15 < 2026-06-01` ✓
- `archived_at=2026-05-23 >= 2026-05-01` ✓
- Therefore: **ACTIVE in May 2026. Should count toward May's total.**

**Why the current-month total excludes it — two layered filters:**

1. **`lib/db/cost-hub.ts:341-360` `getMonthlySubscriptions()`:**
   ```ts
   .from('monthly_subscriptions')
   .select('id, provider, monthly_cost_usd, notes, effective_from, ...')
   .is('archived_at', null)              // ← filters archived rows AT THE DB LAYER
   ```
   ElevenLabs has `archived_at != null` → does not come back from this query at all.

2. **`app/(authenticated)/cost-hub/page.tsx:72-78`:**
   ```ts
   const activeSubscriptions = subscriptions.filter((s) =>
     subscriptionActiveInMonth(
       { effective_from: s.effective_from, archived_at: null },   // ← HARDCODES null
       monthStart,
       monthEnd,
     ),
   )
   ```
   Even if step 1's query had returned the archived row, this filter would discard its real `archived_at` value — passing `null` instead — defeating the entire `subscriptionActiveInMonth` overlap logic that was specifically introduced in migration 0039 + commit `2bf11d3` to fix this exact class of bug for the history view.

3. **Downstream consumers:**
   - `getCurrentMonthTotal` (lib/db/cost-hub.ts:519-537) sums `subscriptions` (filtered `activeSubscriptions` from page.tsx). ElevenLabs's $25.46 is missing.
   - The editable `MonthlySubscriptionsTable` (page.tsx:178) shows the same `subRows` derived from `activeSubscriptions` — so it correctly doesn't show the archived row in the editable table.

**The asymmetry that proves it's the current-month path specifically:** the history view (`getMonthTotal` at lib/db/cost-hub.ts:430-501) uses `fetchSubscriptionsForHistory()` which returns ALL subs WITH real `archived_at`, then filters via `subscriptionActiveInMonth(sub, ...)` — that's correct. So an archived ElevenLabs row WOULD correctly count in May 2026's history total once May 2026 becomes a past month (i.e., starting June 1). But right now, while May is the current month, the current-month-total box uses the wrong path and excludes it. That's the asymmetry the spec's "what could go wrong" section predicted.

**The intent vs reality mismatch:** the `2bf11d3` commit message (2026-05-15 17:41 EDT) explicitly says: *"getCurrentMonthBoundaries: exported so page.tsx can filter the current-month sub list once and feed both the editable table AND [the total]."* The author intended one filter for both surfaces. The implementation got it wrong by hardcoding `archived_at: null` — possibly because at the time the page was written, the editable-table fetch (which correctly excludes archived) was conflated with the total-this-month aggregation (which should include archived rows that were active this month).

**What the fix spec will touch:**

- `app/(authenticated)/cost-hub/page.tsx:71-84` — replace the `getMonthlySubscriptions()` + `archived_at: null` filter combo with a fetch that includes archived rows and passes their REAL `archived_at` through to `subscriptionActiveInMonth`. Either expose `fetchSubscriptionsForHistory` (rename, since "history" is misleading now), or add a new `getSubscriptionsForCurrentMonth()` helper that does the overlap filter at the DB or library layer.
- Decision: the editable-table list must still exclude archived rows (you don't want to render an archived sub in the editable table as if it were still active), so the page needs TWO derived lists from one fetch: `editableSubscriptions` (active + non-archived) for the table, `activeInMonthSubscriptions` (overlap-with-month, may include archived) for the total. Or two separate fetches.
- No schema change. No migration. Pure query/filter restructure.

**Hard-stop honored:** I did NOT modify the page or the data layer.

### Q2 — No reproducible code-level bug. Likely environmental.

**Refuting the `ISO_DATE_RE` TDZ theory (FALSE ALARM):**

- `actions.ts` is a module loaded at function-invocation time on the Vercel runtime.
- At module load: top-to-bottom evaluation defines `function resolveEffectiveFrom` at line 41 (function body NOT executed, just declared) and `const ISO_DATE_RE` at line 167 (initialized).
- At REQUEST time: a client triggers the server action. `addMonthlySubscriptionAction` is called → it calls `resolveEffectiveFrom(effectiveFrom)` → which references `ISO_DATE_RE` at line 53.
- By the time `resolveEffectiveFrom` is INVOKED, module load has completed (it ran once, on first import). `ISO_DATE_RE` is initialized. No TDZ.
- TDZ only fires when a `const` is referenced WITHIN ITS OWN DECLARATION-SCOPE BLOCK before the declaration line is reached during evaluation. A function body that captures `ISO_DATE_RE` as a free variable resolves it at call time via normal lexical scoping — not during the function declaration's evaluation.

**Verification via the Playwright verifier:** `scripts/verify-cost-hub-preview.ts` fills the monthly-subscription form and clicks Add (line 116-120), and the resulting rows are in the DB (`__verify_sub_*` rows with `created_at='2026-05-15 22:30:53 UTC'` etc.). The full add path — including `resolveEffectiveFrom` and `ISO_DATE_RE` — was end-to-end-validated. If TDZ fired, those rows wouldn't exist.

**Code-path read for any other plausible silent-failure mode:**

| Failure mode | Code evidence | Plausibility |
|---|---|---|
| Button disabled-state mismatch with handler validation | `disabled={!draftCost}` checks string truthiness; handler checks `Number.isFinite(parseFloat(draftCost))`. A non-numeric string would enable the button but silent-return the handler. | Low — `<input type="number">` blocks non-digits in most browsers. |
| Auth tier rejected, error not shown | `requireAdmin()` returns `{error:'insufficient_access'}`; `submitAdd` else-branch calls `setError(result.error)`; UI shows `<p role="alert">{error}</p>`. | Refuted — Drake's `team_members.access_tier='creator'` clears `tierAtLeast('admin')`. |
| Supabase insert errors, error not shown | Action returns `{success:false, error: error.message}`; UI sets and displays error. | Possible but should produce a visible error string. |
| Server action throws (unhandled rejection in startTransition's async callback) | `submitAdd`'s `startTransition(async () => { ... })` doesn't try/catch; an action that throws would produce an unhandled rejection. React might log to console; user sees nothing. | Plausible but the action code returns structured errors rather than throwing in every path I traced. |
| Stale client bundle / browser cache | Code unchanged since 2026-05-15. If Vercel served a stale bundle from a broken build, the form-submit handler could be from a previous version. | Plausible — investigation deploys have shipped today (1 hour ago: `c493c26`). |

**Vercel logs evidence (sanity-checks the environment angle):**

- Last 12h of production logs, search for any "cost" / "cost-hub" / "addMonthlySub" / "addCostExtra" mention: **zero matches.**
- Last 12h of production logs, search for path `GET|POST /cost-hub`: **zero matches.**
- Sanity check that log capture works: yes — last 1h shows GET/POST traffic to `/api/passive_ella_cron`, `/api/slack_events`, `/api/ella_unanswered_flagger_cron`, `/api/teams_calendar_sync_cron`.
- Last cost-hub row INSERT (from cloud query): 2026-05-15 22:30:53 UTC. NOTHING newer.

The Vercel-log absence implies one of:
- Drake's attempted add never reached the server (client-side blocked or browser cache).
- Drake's attempt was against a different deploy (preview / local dev).
- Drake hasn't actually attempted today and is reporting from memory of a prior failed attempt.

**What the fix spec (or a follow-up reproduction) needs:**

- Drake reproduces the failure WHILE the Vercel log stream is open (`vercel logs --follow`). Three possibilities then:
  - **Action returns `{success:false, error: <msg>}`** → the error string identifies the cause (auth / validation / DB). The UI already shows it via `<p role="alert">`. Drake should see the message.
  - **Action throws server-side** → Vercel logs show a 500 + stack trace. The fix is wherever the stack points.
  - **No POST to `/cost-hub` at all** → client-side issue. Reload the page (`Cmd+Shift+R` to bypass cache), retry. If still nothing, open browser dev tools, check for JS console errors / blocked Next-Action requests.
- Fix spec scope depends entirely on what reproduces. If nothing reproduces post-cache-clear, the bug may be self-resolved.

**Hard-stop honored:** I did NOT add a test row to confirm the failure. The spec explicitly forbade live writes ("Do NOT 'test' the add button by actually adding a row to the live DB — diagnose from the code + a read of existing rows").

### Q3 — Cancel vs Remove design.

**Current state:** one button (×) → `deleteMonthlySubscriptionAction` → soft archive (`archived_at=now()`). The action's docstring claims "historical totals still see this row's monthly_cost for months when it was active" — which is the CORRECT semantic for the cancel use case. Combined with the Q1 fix, this becomes the right behavior for cancel.

**What the schema supports:**
- Soft archive: `archived_at` timestamp column already exists.
- Hard delete: standard SQL `DELETE` would work — no FK dependencies prevent it. After Q1 is fixed, hard-deleting a row that was active this month would remove it from this month's total too (which is what "remove" should do).
- Flag (e.g. `mistakenly_added boolean`): would need a migration. History queries would have to filter on it. Adds complexity for marginal benefit.

**Recommended shape (input for the fix spec):**

| Operation | UI | Action | DB effect | Month-total effect |
|---|---|---|---|---|
| **Cancel** | "Cancel" button (less destructive styling — neutral border) | existing `deleteMonthlySubscriptionAction` (renamed `cancelMonthlySubscriptionAction` for clarity) | `archived_at = now()` | Counts in months it was active (THIS month, prior months); excluded from NEXT month forward |
| **Remove** | "Remove (mistake)" — more destructive styling (red); confirm dialog warns "Permanent — gone from all history" | new `removeMonthlySubscriptionAction` | `DELETE FROM monthly_subscriptions WHERE id=$1` | Gone from all totals, including history |

**Why hard-delete over a flag:** the "I added this by mistake" use case is rare; irreversibility is acceptable when the user explicitly confirms; and a flag adds schema complexity (migration + a `WHERE NOT mistakenly_added` clause everywhere that reads). KISS for V1; revisit if Drake hits a case where he wishes he could un-remove.

**UI shape:** keep the existing × button shape but bifurcate visually. Two options for the fix spec to pick from:
- (A) Two separate buttons in the row's action area: `Cancel` (icon: paused-circle or stop-sign) + `×` (red, smaller, for remove). The × is the existing button; just changes its semantic.
- (B) One menu trigger (•••) that opens a small popup with both options. More clicks, less prominent destructive surface.

Recommendation: (A). Keep the × visible (consistent with the cost_extras table's row pattern), label it explicitly "Remove" in the confirm dialog, and add a "Cancel subscription" button before it. Same applies symmetrically to `cost_extras` if Drake wants the same two-operation model there.

**What the fix spec will touch:**
- New server action `removeMonthlySubscriptionAction(id)` doing hard DELETE. Same shape (`requireAdmin` check + structured return + `revalidatePath`).
- `app/(authenticated)/cost-hub/cost-hub-tables.tsx` SubscriptionRowCmp: add a second action button + import the new server action; rename the existing on-delete handler + button label to "Cancel" for clarity.
- (Optional) Symmetric treatment on `cost_extras` — but the use case is weaker there since extras are already one-off; Drake's call whether to bother.
- No schema change. No migration.

## Surprises and judgment calls

**The 2026-05-15 commit `2bf11d3` knew about this bug shape — it fixed it for history but not for the current month.** The commit message explicitly says the intent was to apply `subscriptionActiveInMonth` to BOTH surfaces, and the helper itself correctly handles archived rows. But the page.tsx implementation hardcoded `archived_at: null`, defeating the helper for the current-month surface. A skim-quality test (do the totals match expectations on archive-during-current-month) would have caught it; the Playwright verifier ran an archive on 2026-05-15 (same day, current-month) but didn't assert that the archived row stayed in the May total — only that it disappeared from the editable table. Worth a follow-up known-issue: "Playwright verifier doesn't assert archived-this-month-counts-this-month."

**Q2's "no reproducible bug" finding is uncomfortable.** Drake said add fails; the code says it shouldn't. The Vercel-logs absence is the most informative single piece of evidence — if Drake had really attempted today, there would be activity. The honest report is "I can't find the bug because no evidence points at one; please reproduce with logs open." I considered violating the no-live-write hard stop to add a test row and confirm, but the spec was explicit. Worth restating the spec's escape valve here: "If a write-test is genuinely needed to confirm Q2, STOP and ask Drake first" — Drake's call whether to grant that.

**The `ISO_DATE_RE` TDZ theory deserved investigation but is firmly refuted.** Module-level `const` declarations are initialized exactly once at module load (top to bottom); a function body that captures them as free variables resolves them at call time via lexical scoping. TDZ only fires for references within the same scope before the declaration line; functions are separate scopes. The verifier's success on 2026-05-15 closes the case empirically — those rows exist in the DB and could not have been written if `resolveEffectiveFrom` threw on its `ISO_DATE_RE` reference.

**Drake's `team_members.access_tier='creator'` shouldn't matter for cost-hub — but it does.** The `requireAdmin()` helper uses `tierAtLeast(actual, 'admin')`; `creator` outranks `admin` (3 vs 2 in `TIER_ORDER`), so Drake passes. Other accounts on the team: `csm` 8, `head_csm` 1, `admin` 1, `creator` 1 (Drake). If anyone non-admin/creator hits the cost-hub page, they'd be redirected at the layout level before reaching the form. Drake's session is fine for cost-hub. Ruled out as a cause.

**The migration 0039 was tagged "(NOT applied)" in the git commit message but actually IS applied.** Cloud `supabase_migrations.schema_migrations` confirms version 0039 + 0040 + 0041 + 0042 etc. are all present. The "(NOT applied)" tag was apparently a commit-time note that became stale. Not a problem; just flagging because the spec asked to verify the schema state.

**Q3 recommendation has a subtle implication for the Q1 fix.** If Drake ships hard-delete for "Remove" without the Q1 fix landing first, hard-deleting a row removes it from EVERY total — but soft-archiving (cancel) ALSO removes it from THIS month's total due to the bug. So the two operations are indistinguishable until Q1 is fixed. Sequence: fix Q1 first (makes cancel semantically correct), then add Remove (gives the two-operation distinction Drake wants). The fix spec should bundle them or sequence carefully.

## Out of scope / deferred

**Director-spec-worthy follow-ups:**

- **The fix spec (`cost-hub-month-total-and-remove`).** Bundles three changes per the recommendations above: (1) fix the current-month total to use the overlap-with-month filter (Q1), (2) add `removeMonthlySubscriptionAction` + UI button for the two-operation cancel/remove model (Q3), (3) optional same for `cost_extras` if Drake wants symmetry. Should NOT include Q2's add-button issue — that needs reproduction first.

- **Reproduction spec for Q2.** Drake reproduces the add failure with Vercel logs open; this spec documents what surfaces and scopes the fix. Could be as small as "clear browser cache, retry, confirm fixed" or as large as a real client-side bug investigation. Don't scope speculatively.

- **Known-issues entry: "Playwright verifier for cost-hub doesn't assert archived-this-month-row-still-counts."** Worth a permanent note so the next person editing the verifier knows to add the assertion. Director writes the entry; the entry should reference this report + name `scripts/verify-cost-hub-preview.ts` as the file to extend.

- **Known-issues entry: "current-month sub total uses different code path from history total — co-edit risk."** Same shape as the Ella prompt co-edit risk: two surfaces that should compute the same thing diverged because the fix only applied to one. Worth a permanent note.

- **Stale "(NOT applied)" tag in commit `14279df`'s message.** Cosmetic; the migration is applied. Not worth a spec; flagged for awareness.

**Not chased in this pass (out of scope):**

- Did NOT investigate whether the Playwright verifier itself is breaking on the current deploy. Could explain Drake's "add fails" if it correlates. Out of scope without explicit ask.
- Did NOT check whether GROW-tier sub editing (Drake's `creator` tier) has any RLS policies on `monthly_subscriptions` that could be silently blocking writes. Spot-checked the schema — no RLS policies visible on the table. Skipped deeper Supabase-policy audit; not the suspected angle.
- Did NOT validate the same Q1 bug class exists for `cost_extras`. The cost_extras current-month total goes through `getCurrentMonthExtras` (lib/db/cost-hub.ts:396-424) which filters `.is('archived_at', null)` + `.gte('incurred_on', monthStartDate)`. So an extras row archived mid-month would also vanish from the current month's total. **Same bug class; symmetric fix should apply.** Worth noting in the fix spec.

## Side effects

**Zero real-world actions.** All cloud queries were read-only `SELECT`s (no `INSERT`/`UPDATE`/`DELETE`). One `vercel logs --no-follow` call (read-only log query). No code changes. No data changes. No Slack posts, no API calls beyond the DB SELECTs and the log query. No deploy.

The spec save + this report save + the spec status-flip are the only file changes; they'll commit + push to `main`. The Close backfill on the main checkout is unaffected — docs-only commit, no code touched, no env vars touched.
