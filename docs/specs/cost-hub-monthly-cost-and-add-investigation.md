# Cost hub — investigate monthly-cost display + add-button failure (read-only, spec follows)
**Slug:** cost-hub-monthly-cost-and-add-investigation
**Status:** shipped

**Target branch: main**

> This is NOT Ella-worktree work — the cost hub lives in `app/(authenticated)/cost-hub/` and is unrelated to the Ella split. Run this from the MAIN checkout (`~/projects/ai-enablement`), not the worktree. Read-only investigation; the FIX is a separate spec written after Director reads the findings. The Close backfill is a separate local OS process; unaffected by reads.

## Why this exists

Drake hit two problems on the `/cost-hub` page and wants clear, evidence-based answers before any fix:

1. **A monthly subscription he "removed" (ElevenLabs) disappeared from THIS month's total.** His expectation: removing/cancelling a sub should stop it recurring NEXT month but keep it counted THIS month (he already paid for it this month). Instead it vanished from the current month's total entirely. **Drake's hypothesis: the cost is still in the data (correctly archived), but the current-month total is just DISPLAYING it wrong / excluding it in the query — i.e. a display bug, not a data-loss bug.** This investigation must confirm or refute that hypothesis with actual data.

2. **The "add" button doesn't work** — he couldn't add the ElevenLabs cost back, nor add a different new cost. Add silently fails.

## The questions to answer — with evidence, not inference

### Q1 — Is the "disappeared cost" a DISPLAY bug or a DATA-loss/exclusion bug?

This is the central question. The delete action (`deleteMonthlySubscriptionAction` in `app/(authenticated)/cost-hub/actions.ts`) does a SOFT archive (`archived_at = now()`), and its comment claims "historical totals still see this row's monthly_cost for months when it was active." So the INTENT is "keep it in the month it was active." Determine what ACTUALLY happens:

- **Is the row still in the DB?** Query `monthly_subscriptions` for the ElevenLabs row (read-only cloud SELECT via psycopg2 pooler). Confirm it exists, and capture its `effective_from`, `archived_at`, `monthly_cost_usd`. If it's there with an `archived_at` timestamp, the data is intact (supports Drake's display-bug hypothesis).
- **How does the current-month total actually compute?** Read the month-total computation — it's NOT in `actions.ts`; it's in `app/(authenticated)/cost-hub/page.tsx` and/or a `lib/db/` query the page calls. Find exactly how monthly subscriptions are summed into the "this month" total. Specifically: does the query filter `archived_at IS NULL` (which would EXCLUDE the archived ElevenLabs row from this month — the bug), or does it include rows whose active window (`effective_from` → `archived_at`) overlaps the current month (the correct behavior the comment intends)?
- **Verdict:** Is the cost (a) excluded from this month's total because the query filters out archived rows regardless of WHEN they were archived (display/query bug — the data is fine, the number is wrong), or (b) genuinely not counted anywhere (data handling bug)? Drake suspects (a). Confirm which, with the specific query/line that causes it.

### Q2 — Why does the "add" button fail?

The `addMonthlySubscriptionAction` + `addCostExtraAction` server actions in `actions.ts` LOOK correct (validate → insert → revalidate). But there's a SPECIFIC suspect Director flagged on read: **`resolveEffectiveFrom` (defined near the top of `actions.ts`) references `ISO_DATE_RE`, but `ISO_DATE_RE` is declared as a `const` further DOWN the file (in the cost_extras section).** JavaScript `const` is not hoisted — if `resolveEffectiveFrom` executes before that `const` initializes, it throws `ReferenceError: Cannot access 'ISO_DATE_RE' before initialization`. Since `addMonthlySubscriptionAction` calls `resolveEffectiveFrom`, this could break every add-monthly-subscription call.

Determine:
- **Does the `ISO_DATE_RE` temporal-dead-zone issue actually fire?** In a server-action module, the top-level `const ISO_DATE_RE` runs at module load, so by the time `resolveEffectiveFrom` is CALLED (at request time) the const is initialized — UNLESS something about the module structure or a circular reference breaks that. Verify whether this is a real runtime error or a false alarm. (Check: does adding a monthly subscription actually throw, or does adding a cost-EXTRA also fail? If extras add fine but subscriptions don't, the `ISO_DATE_RE`/`resolveEffectiveFrom` path is implicated. If BOTH fail, the bug is elsewhere — likely the form wiring.)
- **Is the form wiring correct?** Read `app/(authenticated)/cost-hub/cost-hub-tables.tsx` — how the add form calls the server action. Look for: a client/server boundary issue, a form-submit handler that doesn't call the action, an unsurfaced validation rejection (the action returns `{success:false, error}` but the UI swallows it so the user sees nothing happen), or a missing `'use client'`/event-handler bug.
- **Verdict:** the specific reason add fails, with the file+line. Distinguish "throws server-side" from "fails silently client-side" from "validation rejects and UI doesn't show the error."

### Q3 — What's the right shape for CANCEL vs REMOVE? (design input, don't build)

Drake wants TWO distinct operations, where today there's one ("delete" = soft archive):
- **Cancel** — stop recurring next month, KEEP it counted this month (he paid this month). This is what soft-archive is SUPPOSED to do.
- **Remove** — for mistakes; take it out entirely INCLUDING this month. Likely a hard delete or a "never count this" flag.

Report on: what the current single "delete" button maps to, what the DB schema supports (is there a hard-delete path? what does `archived_at` semantically mean for month-total inclusion?), and what the cleanest implementation of the two-operation model would be (two buttons → two actions; cancel = archive-with-month-inclusion-preserved, remove = hard delete or a distinct flag). This is INPUT for the fix spec — describe the options + a recommendation, don't implement.

## Acclimatization checklist

Read first, confirm in 4 bullets:
- `app/(authenticated)/cost-hub/actions.ts` — the six CRUD server actions (already the suspected site for Q2; the delete semantics for Q1/Q3).
- `app/(authenticated)/cost-hub/page.tsx` — the page composition + where it computes the current-month total. THE file for Q1 (how archived rows factor into the total).
- `app/(authenticated)/cost-hub/cost-hub-tables.tsx` — the editable tables + add forms. THE file for Q2's form-wiring angle.
- `app/(authenticated)/cost-hub/history-view.tsx` — how historical months compute (relevant to Q1: if history correctly counts the archived row in its active month but the current-month box doesn't, that's a strong signal the bug is in the current-month query specifically).
- Any `lib/db/` module the page imports for cost aggregation, plus `docs/specs/cost-hub.md` (the original spec) + `docs/runbooks/` if a cost-hub runbook exists — to understand the intended archive/total semantics.
- The `monthly_subscriptions` + `cost_extras` table schema (`docs/schema/` or the migration that created them) — what columns exist (`effective_from`, `archived_at`, etc.) and what they're meant to mean.

## What to do

All read-only. Cloud SELECTs (psycopg2 pooler) + code reads. NO code change, NO data change, NO fix. The fix is a SEPARATE spec written after Director reads this report.

1. Q1: query the ElevenLabs row + read the current-month-total computation + the history computation; determine display-bug vs data-bug with the specific line.
2. Q2: determine why add fails — confirm or refute the `ISO_DATE_RE` TDZ theory, check the form wiring, distinguish server-throw vs silent-client-fail.
3. Q3: report the cancel-vs-remove options + recommendation.

## What success looks like

A report at `docs/reports/cost-hub-monthly-cost-and-add-investigation.md` with clear, evidence-backed verdicts:
- **Q1:** "Display bug — the ElevenLabs row is intact in the DB (archived_at=X, monthly_cost=Y), but `<file:line>` filters `archived_at IS NULL` so it's excluded from the current-month total even though it was active this month. Fix = include rows whose active window overlaps the month." OR "Data bug — [specifics]." With the exact query/line.
- **Q2:** "Add fails because `<specific cause>` at `<file:line>`." With the distinguishing evidence (does extras-add work but subs-add not? etc.).
- **Q3:** the cancel-vs-remove options + a recommended implementation shape, as input for the fix spec.
- A short "what the fix spec will touch" pointer for each — NOT the fix.

## Hard stops

- **Read-only.** No code change, no data change, no fix, no add/delete on the live tables. The fix is a separate spec.
- This is MAIN-checkout work (cost hub is not Ella-worktree). Do not touch Ella files or Close files.
- Do NOT "test" the add button by actually adding a row to the live DB — diagnose from the code + a read of existing rows. (If a write-test is genuinely needed to confirm Q2, STOP and ask Drake first.)

## What could go wrong — think this through yourself

Seeds: the current-month total and the history view might compute totals DIFFERENTLY — if history correctly includes the archived row in its active month but the current-month box doesn't, that asymmetry IS the bug and pinpoints it. The `ISO_DATE_RE` TDZ theory might be a false alarm (module-load-time const init usually completes before request-time action calls) — don't assert it's the cause without confirming the actual failure; check whether cost-EXTRAS add works (different code path, doesn't touch resolveEffectiveFrom) to isolate. "Add silently fails" might be the action returning `{success:false, error}` with the UI not surfacing the error — so the action might be REJECTING valid input (e.g. an effective_from format mismatch between what the form sends and what the validator expects) rather than throwing; check the form's date format against `ISO_DATE_RE`'s `YYYY-MM-DD` expectation. And: confirm whether `archived_at` is even the column the month-total query keys on, or whether there's an `effective_from`/`effective_to` window model that the archive is supposed to set — the fix shape depends on the actual schema.

## Mandatory doc updates

- Write the report to `docs/reports/cost-hub-monthly-cost-and-add-investigation.md`.
- Flip this spec's Status to shipped in the same commit as the report (read-only investigation).
- No other doc edits. Name any known-issues-worthy finding in the report for Director.
