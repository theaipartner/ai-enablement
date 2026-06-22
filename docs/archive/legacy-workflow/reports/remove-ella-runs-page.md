# Report: Remove the /ella/runs audit page (dead clutter post-@-mention-split)
**Slug:** remove-ella-runs-page
**Spec:** docs/specs/remove-ella-runs-page.md

## Files touched

Deleted (code — 12 files, 3,656 lines):

- `app/(authenticated)/ella/layout.tsx` — admin-tier route gate (only gated the runs subroute).
- `app/(authenticated)/ella/runs/page.tsx` — list-page server component.
- `app/(authenticated)/ella/runs/filter-bar.tsx` — list-page filter UI.
- `app/(authenticated)/ella/runs/pills.tsx` — list/detail pill helpers.
- `app/(authenticated)/ella/runs/runs-table.tsx` — list-page table component.
- `app/(authenticated)/ella/runs/summary-band.tsx` — list-page metric strip.
- `app/(authenticated)/ella/runs/[id]/page.tsx` — detail-page server component.
- `app/(authenticated)/ella/runs/[id]/expandable-message.tsx` — detail-page client component.
- `lib/db/ella-runs.ts` — the entire data layer (1,320 lines: `getEllaRunsList`, `getEllaSummaryStats`, `listChannelsWithEllaRuns`, `fetchEscalationBodies`, `EllaRunsListFilters`, and supporting types/helpers). Verified zero non-route consumers before deletion.
- `scripts/verify-ella-redesign.ts` — Playwright harness for the list/detail redesign (exclusively probed `/ella/runs`).
- `scripts/verify-ella-escalation-output.ts` — Playwright harness for the escalation-output column.
- `scripts/verify-ella-pre-redesign-fixes.ts` — Playwright harness for the pre-redesign fix set.

Modified (code — 4 files):

- `components/top-nav.tsx` — dropped the `{ href: '/ella/runs', label: 'Ella', requiredTier: 'admin' }` entry from `NAV_ITEMS` and its matching arm in `isActive()`. Updated the nav-vocabulary comment.
- `lib/slack/render-mentions.ts` — rewrote the docstring that referenced `getEllaRunsList` / `getEllaRunDetail` / `lib/db/ella-runs.ts` to describe the helper generically (it's a pure-function transform layer; the call-site DB lookup lives wherever the calling surface keeps its DB code).
- `api/ella_daily_digest_cron.py` — the daily digest body's truncation footer pointed users at `/ella/runs` for the full list. Dropped the pointer; footer now reads `_(… more flagged messages truncated)_`.
- `tests/agents/ella/test_passive_dispatch.py` + `tests/agents/ella/test_passive_monitor.py` — docstring-only updates in two tests (`test_haiku_call_failure_lands_as_status_error`, `test_routed_to_humans_skip_no_haiku_call`); both tests still pass and still test the same behavior. The docstrings cited `/ella/runs WHERE status='error'` / `/ella/runs can filter on it` as where the failure / skip reason became visible — replaced with descriptions tied to the underlying tables (`agent_runs`, `pending_ella_responses`).

Modified (docs — 9 files) — all updates flag the page as removed 2026-05-24 and redirect operational guidance to direct SQL on `agent_runs` / `pending_ella_responses` / `pending_digest_items`:

- `docs/runbooks/ella_passive_monitoring.md` — seven operational refs converted. Two now read "audit page removed 2026-05-24 — use the SQL above"; the rest replace the "Filter in the dashboard" hook with a concrete SQL alternative.
- `docs/runbooks/ella_daily_digest.md` — the truncation-footer doc now describes the generic footer + notes the prior `/ella/runs` pointer was dropped.
- `docs/known-issues.md` — the "5 follow-up fixes flagged during validation" entry is now superseded (page gone → follow-ups die with it). The "passive Haiku prompt thresholds will need iteration" entry's "review the /ella/runs flagged-anomaly view" guidance was rewritten to query `agent_runs` directly.
- `docs/agents/ella/ella.md` — Audit-dashboard access paragraph rewritten as Audit-dashboard removed. Five present-tense operational mentions converted to SQL-on-`agent_runs` framing. Batch 2.2 entry in the timeline marked `shipped 2026-05-11, removed 2026-05-24`.
- `docs/agents/ella/followups.md` — section header `Status-honesty fix: failed LLM calls now visible on /ella/runs` retitled to drop the page reference (the underlying behavior — `agent_runs.status='error'` on LLM-call failure — is what's visible).
- `docs/agents/gregory.md` — `Ella runs page — audit dashboard` section rewritten as a brief historical record of what shipped + when + why it was removed.
- `docs/gregory-conventions.md` — `/ella/runs/[id]` removed from the detail-page slot-order example list; `/ella/runs` removed from the list-page slot-order example list + the optional-metric-strip example + the `FilterBar` example. Two rows removed from the eyebrow-taxonomy table.
- `docs/schema/team_members.md` — admin tier row no longer claims `/ella/runs` is one of its surfaces; head_csm tier row updated for accuracy in the same pass. Resolution paragraph rewritten — currently the admin-only sub-layout is `cost-hub/layout.tsx`, not `ella/layout.tsx` (which was deleted in this spec).
- `docs/decisions/0003-timezone-conventions.md` — ADR's "Consumers today" line moved `lib/db/ella-runs.ts:getEllaSummaryStats` into a parenthetical noting it was a consumer until removal. `lib/db/cost-hub.ts` is the sole remaining consumer.

Created:

- `docs/specs/remove-ella-runs-page.md` — the spec.
- `docs/reports/remove-ella-runs-page.md` — this report.

Spec `Status:` flipped from `in-flight` to `shipped` in the final commit.

## What I did, in plain English

Deleted the `/ella/runs` audit page in full — both routes (`/ella/runs` and `/ella/runs/[id]`), their layout's admin gate, their data layer (`lib/db/ella-runs.ts`), and the three Playwright verify scripts that exclusively probed those URLs. Removed the TopNav entry that pointed at the dead route. Fixed two adjacent code references the deletion orphaned: the daily digest's truncation footer (a user-facing Slack string telling Drake to "see `/ella/runs`") and two stale test docstrings citing `/ella/runs` as the visibility surface for `status='error'` and `skip_reason='routed_to_humans'`. Updated one library docstring (`lib/slack/render-mentions.ts`) that previously named the now-deleted callers. Then a coordinated doc sweep through the runbooks, schema docs, agent docs, ADR, and conventions doc — every live-surface reference to `/ella/runs` was either rewritten to direct-SQL guidance on `agent_runs` / `pending_*` or marked as "removed 2026-05-24" with the spec slug for traceback. Historical narrative refs (state.md batch entries, CLAUDE.md cost-hub-vs-Ella diagnostic mention, the `docs/working/gregory-redesign-compiled.md` design-discussion doc) were left intact — those are records of what happened, not live-surface claims.

## Verification

- `npx tsc --noEmit -p .` → **0 lines of output** (clean). No dangling imports of `lib/db/ella-runs.ts` or any deleted route component.
- `npx next lint` → `✔ No ESLint warnings or errors`. The nav entry + matching arm came out cleanly with no orphaned imports.
- Repo-wide grep for the deleted exports (`getEllaRunsList`, `getEllaSummaryStats`, `listChannelsWithEllaRuns`, `EllaRunsListFilters`, `fetchEscalationBodies`) across `.ts` / `.tsx` / `.py` → **one match remaining**: `agents/ella/escalation_routing.py:23` (a comment naming `lib/db/ella-runs.ts:fetchEscalationBodies`). Hard-stopped per spec — see Surprises.
- Repo-wide grep for `/ella/runs` across code files (`.ts` / `.tsx` / `.py`) → **two matches**: (a) `agents/ella/passive_dispatch.py:97` — a comment, hard-stopped; (b) `components/top-nav.tsx:18` — my own intentional comment in `NAV_ITEMS` explaining the removal + spec slug, kept for future readers.
- Repo-wide grep across `.md` → the surviving matches are all (a) historical narrative in `docs/state.md` + `CLAUDE.md:420` + the frozen `docs/working/gregory-redesign-compiled.md` (kept as records), (b) my own "removed 2026-05-24" markers in updated docs (intentional). No remaining live-surface claims.
- App still builds: implied by `tsc` + `lint` clean, but not separately exercised via `next build` — the route's removal shouldn't affect sibling routes (`/clients`, `/cost-hub`, `/calls`, `/teams`, `/tasks`) since the `(authenticated)` parent layout handles auth above the deleted `ella/layout.tsx`.

## Surprises and judgment calls

**Hard-stop conflict on the grep-zero verification.** The spec's verification rule says "ZERO references remain (outside this spec/report + the git history)" — but two of those references are inside `agents/ella/`, and the spec's hard stops explicitly say "Do NOT touch `agents/ella/`." Resolution: the hard stop wins. The two remaining `agents/ella/` comments are:

- `agents/ella/passive_dispatch.py:97` — `# up on \`/ella/runs WHERE status='error'\`. Keep user-facing`
- `agents/ella/escalation_routing.py:23` — `queryable — the dashboard's \`lib/db/ella-runs.ts:fetchEscalationBodies\``

Both are docstring/comment-only — no runtime behavior depends on the deleted code. They should be cleaned up the next time `agents/ella/` is touched for any other reason (a one-line drift each), or via a tiny dedicated spec if Drake wants the strict-zero state.

**Doc-update scope was broader than the spec literally enumerated.** The spec said "update any runbook/doc referencing /ella/runs as a live surface." I interpreted that as: anywhere the doc still gives operational guidance that depends on the page existing (`docs/runbooks/ella_passive_monitoring.md`, `docs/runbooks/ella_daily_digest.md`, `docs/known-issues.md` operational entries, `docs/agents/ella/ella.md` access + audit framing, `docs/agents/gregory.md` Batch-2.2 description, `docs/gregory-conventions.md` example lists, `docs/schema/team_members.md` admin-tier description, `docs/decisions/0003-timezone-conventions.md` Consumers-today line). I deliberately left untouched: `docs/state.md` (dated batch records — modifying past records is rewriting history), `CLAUDE.md:420` (historical narrative inside § Current Focus), and `docs/working/gregory-redesign-compiled.md` (frozen design-discussion artifact). Call it out if the broader rewrite-history-as-removed shape was wanted instead.

**The `agent_runs` table is NOT orphaned.** Spec's "What could go wrong" anticipated I'd consider dropping the table. I grepped the writers: `agents/ella/passive_dispatch.py`, `agents/gregory/agent.py`, `agents/gregory/ai_call_signal.py`, `agents/call_reviewer/reviewer.py`, `agents/call_reviewer/sentiment_classifier.py`, `api/gregory_brain_cron.py`, plus the readers I just rewrote into the doc-update pass — every Ella/Gregory/call-reviewer agent invocation opens an `agent_runs` row. The table is core telemetry. No schema change made; no follow-up known-issues entry needed.

**Three Playwright verify scripts deleted alongside the route.** `scripts/verify-ella-redesign.ts`, `verify-ella-escalation-output.ts`, `verify-ella-pre-redesign-fixes.ts` — all exclusively `await page.goto(PREVIEW_BASE + '/ella/runs')`. They'd error on every line post-deletion; they exist to verify a surface that no longer exists. Per spec § What to remove #4 ("Any test files... exclusively test deleted code — remove"), they go. The non-Ella verify scripts (`verify-cost-hub-preview.ts`, `verify-csm-visual-fixes.ts`, etc.) are untouched.

**`lib/db/ella-runs.ts:1320` was the single biggest deletion in the diff.** Confirmed it had **zero** non-route imports before deletion (`grep -r "from '@/lib/db/ella-runs'"` and `grep -r "ella-runs"` across `app/` / `api/` / `scripts/` / `tests/` / shared lib / `agents/`). The three remaining `ella-runs` mentions in code are all comments — no real imports. Safe to delete the whole file.

## Out of scope / deferred

- **The two `agents/ella/` comment refs** (`passive_dispatch.py:97`, `escalation_routing.py:23`) — hard-stopped this session. Next `agents/ella/` touch should clean them up incidentally; alternatively a tiny doc-edit spec.
- **Run-logging "write" path** — Ella still writes `agent_runs` rows; spec was explicit ("we're only removing the dashboard VIEW, not the data"). The write path is untouched. The `agent_runs` table remains the source of truth for Ella telemetry.
- **`scripts/audit_ella_interactions.py`** — referenced in the now-deleted detail-page anomaly-checks logic ("Five anomaly checks mirror `scripts/audit_ella_interactions.py`"). The script itself was not deleted; it remains as a CLI audit tool for the same checks. Untouched.
- **Frozen design docs** (`docs/working/gregory-redesign-compiled.md`) — preserved as artifact. If Drake wants design-history docs to be rewritten when surfaces are removed, that's a working-norm change to discuss separately.
- **No `next build` smoke** — `tsc` + `lint` clean is the proxy; Drake confirms the nav item's gone post-deploy (the route deletion can't fail the build given the static-route nature of `app/(authenticated)/ella/`).

## Side effects

- **Zero production calls fired.** Pure code/doc edits + deletions.
- **Zero Slack posts.** The digest-cron string change is a pure source edit — the cron fires on its own schedule; the next real fire will use the new footer.
- **Zero DB writes.** No migrations, no schema touches, no data-mutation scripts run.
- **No env-var changes.** Drake's gate (d) untouched.
- **The Ella nav item disappears for admins** (Drake + Nabeel) on the next deploy — that's the intended visible effect. CSMs / Head CSM never saw it; nothing changes for them.
