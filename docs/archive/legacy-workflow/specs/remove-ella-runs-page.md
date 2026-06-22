# Remove the /ella/runs audit page (dead clutter post-@-mention-split)
**Slug:** remove-ella-runs-page
**Status:** shipped

**Target branch: main**

> NOT Ella-worktree work despite the name — this is the Next.js DASHBOARD route `app/(authenticated)/ella/`, not the Ella agent code (`agents/ella/`). Do NOT touch `agents/ella/` or anything in the worktree. Run from the MAIN checkout. Close backfill unaffected.

## Why

The `/ella/runs` audit page inspected per-run output of Ella's passive/dispatch pipeline. Post-@-mention-split, the passive path is observation-only (feeds the daily digest, no per-run review surface), so the runs page no longer has a purpose — it's stale clutter. Drake wants it REMOVED (not hidden — there's no future use to preserve, and a reachable-by-URL dead page is its own trap).

## What to remove

1. **The whole route directory `app/(authenticated)/ella/`** — confirmed `runs/` is the only thing under `ella/`, and `ella/layout.tsx` exists ONLY to admin-gate the runs route (its own docstring says so). So delete the entire directory:
   - `app/(authenticated)/ella/layout.tsx`
   - `app/(authenticated)/ella/runs/page.tsx`
   - `app/(authenticated)/ella/runs/filter-bar.tsx`
   - `app/(authenticated)/ella/runs/pills.tsx`
   - `app/(authenticated)/ella/runs/runs-table.tsx`
   - `app/(authenticated)/ella/runs/summary-band.tsx`
   - `app/(authenticated)/ella/runs/[id]/` (the run-detail subroute — all files)
   - i.e. `rm -rf app/(authenticated)/ella/`
   - **Verify first** there's nothing else under `ella/` you'd be deleting unintentionally (e.g. another sibling route). If anything other than `runs/` + `layout.tsx` lives under `ella/`, STOP and surface — the spec assumed runs-only.

2. **The nav entry** — find the TopNav/sidebar link to `/ella/runs` (grep for `/ella/runs` and `ella` in the nav component, likely `components/**/top-nav*` or wherever the cost-hub/clients nav items are defined — the cost-hub spec referenced a `requiredTier`-gated TopNav entry pattern). Remove the Ella/Run-history nav item. Confirm no other nav item points into `/ella/*`.

3. **The data layer `lib/db/ella-runs.ts`** — the runs page imports `getEllaRunsList`, `getEllaSummaryStats`, `listChannelsWithEllaRuns`, type `EllaRunsListFilters`. **Verify this module has NO other consumers** (grep `from '@/lib/db/ella-runs'` and `ella-runs` across the repo, including `scripts/`, `api/`, tests, and the worktree-shared code). If the runs page + its `[id]` detail are the ONLY importers, delete `lib/db/ella-runs.ts` entirely. If ANYTHING else imports it, do NOT delete — remove only the now-unused exports if cleanly separable, else leave it and note in the report. STOP-and-surface if a consumer is non-obvious (e.g. a cron or the Ella agent reads it).

4. **Any test files** targeting the runs page or `ella-runs.ts` (grep for them) — remove the ones that exclusively test deleted code.

## What NOT to touch

- `agents/ella/` — the agent itself. Untouched.
- The `ella_runs` DB TABLE / any table the data layer read — this is a CODE removal, not a schema change. Do NOT write a migration, do NOT drop a table. The underlying run-logging (if Ella still writes run rows anywhere) stays; we're only removing the dashboard VIEW of it. If you believe a table is now orphaned, note it as a follow-up — do NOT drop it here.
- The daily digest / passive observation pipeline — unrelated.
- Anything in the worktree.

## Acclimatization checklist

Confirm in 4 bullets:
- `app/(authenticated)/ella/` contains only `layout.tsx` + `runs/` (+ `runs/[id]/`) — nothing else. (If more, STOP.)
- `lib/db/ella-runs.ts`'s consumers — grep confirms only the runs route imports it. (If more, adjust per step 3.)
- The nav entry location for the `/ella/runs` link.
- Whether any test files exclusively cover the deleted code.

## Verification

- `npx tsc --noEmit -p .` clean — no dangling imports of deleted modules/components.
- `npx next lint` clean.
- Grep the repo post-deletion for `/ella/runs`, `ella-runs`, `getEllaRunsList`, `getEllaSummaryStats`, `listChannelsWithEllaRuns`, `EllaRunsListFilters` — ZERO references remain (outside this spec/report + the git history).
- The app still builds (the route's removal shouldn't break the `(authenticated)` layout or sibling routes like `/clients`, `/cost-hub`).
- Nav renders without the Ella item + without a broken link.

## Hard stops

- REMOVE, not hide. Full directory + data layer + nav.
- Do NOT touch `agents/ella/`, the worktree, any DB table/schema, or write a migration.
- If `lib/db/ella-runs.ts` has a non-obvious consumer, or `ella/` has a sibling route, or a table looks orphaned — STOP and surface, don't guess.
- MAIN checkout. No Close touches.

## What could go wrong — think this through yourself

Seeds: the `ella/layout.tsx` admin-gate is route-scoped — deleting it is correct (it only gated runs), but make sure no PARENT or SIBLING relies on it (it doesn't — gates are per-segment in app-router, and the `(authenticated)` parent layout handles auth above it). The data layer is the real "verify before delete" — a cron or the agent might read run stats; the grep must cover `api/`, `scripts/`, `agents/`, and shared lib, not just `app/`. The nav item: removing the link but leaving a `requiredTier` constant or an icon import dangling will lint-fail — clean the whole entry. Don't over-reach into deleting the run-logging WRITE path or a table — Drake explicitly scoped this as removing the VIEW, not the data; an orphaned table is a separate decision. And confirm `/ella/runs/[id]` (the detail route) is gone too — it's easy to delete `runs/page.tsx` and forget the `[id]` subroute, leaving a half-dead route.

## Mandatory doc updates

- `docs/known-issues.md` — if the run-logging table is now orphaned (nothing reads it), add a follow-up entry noting it for a future decision (don't drop it).
- Any runbook/doc referencing `/ella/runs` as a live surface — update to note it's removed.
- `docs/reports/remove-ella-runs-page.md` — the report: what was deleted, the ella-runs.ts consumer-check result, the nav change, tsc/lint/grep-clean confirmation.
- Flip Status to shipped when tsc + lint + grep-clean pass. (Pure deletion; no live smoke needed beyond the build passing — Drake confirms the nav item's gone post-deploy.)
