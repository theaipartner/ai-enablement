# Report: EOD cleanup 2026-05-15 — state.md + CLAUDE.md refresh, decisions captured, today's specs and reports archived

**Slug:** eod-cleanup-2026-05-15
**Spec:** docs/specs/eod-cleanup-2026-05-15.md

## Files touched

**Created**
- `docs/decisions/0002-title-convention-enforcement.md` — new ADR capturing the May 18 cutoff. Sections: Context (Drake's management lever per Nabeel, Zain's booking links, the convention adoption problem) / Decision (six canonical patterns, cutoff at `started_at >= 2026-05-18T00:00:00 America/New_York`, safety net via auto-create + Merge UI + manual override) / Consequences (positive, accepted costs, what's NOT changed) / Implementation pointers / Review triggers.

**Modified**
- `docs/state.md` — new "## 2026-05-15 — EOD: Director-tier surfaces + permissions infrastructure + May 18 forcing function" section at the top of "Gregory editorial skin shipped" with a 2-3 sentence summary per shipped spec across the 10-spec window (covers both 2026-05-14 + 2026-05-15 work). Per-spec entries below preserved as chronological record. Top-line entries (migration count, env vars, Vercel cron list, Python function count) already current from per-spec commits earlier today; no further edits there.
- `CLAUDE.md` — five targeted line edits: (1) § Project Purpose active-focus paragraph rewritten to reflect Director-tier surfaces post-shipping; (2) Stack table secrets row gains the new env vars (`ESCALATION_RECIPIENT_SLACK_USER_ID`, Google OAuth trio, `SLACK_DRY_RUN`, `ELLA_PASSIVE_MONITORING_ENABLED`) under a "Feature-specific" heading; (3) Folder Structure annotation `(8 deployed)` → `(10 deployed — see state.md)`; (4) § Current Focus rewritten as a 7-bullet post-state summary referencing ADR 0002; (5) § Next Session Priorities reordered — Send-to-Slack production cutover stays #1, post-cutoff title-convention adoption review added #2, `/teams` gate (c) walkthrough added #3, CSM utilization + Admin cost hub stay queued.
- `docs/runbooks/auto_created_client_management.md` — header reference + "Spec + code pointers" section updated to point at ADR 0002 + the call-title-convention runbook instead of the deleted spec.
- `docs/runbooks/call_title_convention.md` — "Per spec ..." opening paragraph + "Spec + code pointers" section rewritten to reference ADR 0002.
- `docs/runbooks/director_tasks.md` — "Spec + code pointers" section retitled "Code + schema pointers"; spec-line removed.
- `docs/runbooks/teams_meeting_tracker.md` — Filter-behavior "Why this exists" sentence + footer "Spec + migration" section both updated to drop spec links.
- `docs/schema/calls.md` — Populated-by line replaces the spec link with `docs/decisions/0002-title-convention-enforcement.md` (rationale) alongside the existing runbook link.
- `docs/schema/calendar_events.md` — Populated-by reference to the external-attendee filter spec replaced with a pointer to the teams_meeting_tracker runbook's § Filter behavior; trailing "Spec" section renamed "Origin" and references the migration + runbook only.
- `docs/schema/director_tasks.md` — trailing "Spec" section renamed "Origin"; references the migration + runbook.
- `docs/schema/oauth_tokens.md` — same shape as director_tasks.
- `docs/agents/ella/ella.md` — audit-dashboard-access paragraph updated to reference `docs/schema/team_members.md § Access tiers` instead of the deleted permissions spec.

**Deleted (14 files)**
- `docs/specs/permissions-access-tiers.md` + `docs/reports/permissions-access-tiers.md`
- `docs/specs/teams-meeting-tracker.md` + `docs/reports/teams-meeting-tracker.md`
- `docs/specs/teams-calendar-external-attendee-filter.md` + `docs/reports/teams-calendar-external-attendee-filter.md`
- `docs/specs/teams-personal-email-exclusion-and-nabeel-removal.md` + `docs/reports/teams-personal-email-exclusion-and-nabeel-removal.md`
- `docs/specs/classifier-enforce-new-title-convention.md` + `docs/reports/classifier-enforce-new-title-convention.md`
- `docs/specs/auto-created-client-lifecycle.md` + `docs/reports/auto-created-client-lifecycle.md`
- `docs/specs/director-tasks-and-list-ux-polish.md` + `docs/reports/director-tasks-and-list-ux-polish.md`

**Not touched** (per spec hard stops)
- Code in `app/`, `ingestion/`, `agents/`, `lib/`, `shared/`, `tests/`, `supabase/migrations/`.
- Yesterday's spec/report pairs (`ella-escalation-unify-and-route-to-scott`, `ella-passive-escalation-keyword-bypass`, `gregory-day-end-wrap-2026-05-14`) — spec explicitly limited cleanup to today's batch.
- `docs/future-ideas.md` — the Admin cost hub idea is already present at lines 201-206 in the standard four-line format; the spec's call to "add a cost hub entry" is already satisfied by the existing entry. Adding a duplicate would be unhelpful. Flagged in Surprises.

## What I did, in plain English

EOD pass on a 10-spec window (2026-05-14 + 2026-05-15) that left state.md / CLAUDE.md drifting from shipped reality. Three workstreams: docs refresh, decision capture, archive.

The state.md refresh added a single consolidated section at the top of the "Gregory editorial skin shipped" block — 2-3 sentences per shipped piece, readable in 60 seconds. The per-spec entries below stayed as the chronological record per the spec's "don't aggressively prune" hard stop. Top-line entries (migration count 36, Python function count 10, env-var inventory, Vercel cron list including the new 30-min Teams sync) were already current from per-spec commits earlier today; no further edits.

CLAUDE.md got five targeted edits: the active-focus paragraph stopped saying "Batch A — CSM accountability" (long shipped) and now reads as "Director-tier surfaces + role-gated visibility post-Gregory-V2"; the Stack table's secrets row expanded the env-var list with the new feature-specific ones; the folder-structure Python-function count bumped 8 → 10; § Current Focus got rewritten as a 7-bullet post-state covering today's shipped surfaces with a reference to ADR 0002; § Next Session Priorities reshuffled with the post-cutoff adoption review and `/teams` gate (c) walkthrough moved up to slots 2 and 3.

ADR 0002 captures the May 18 title-convention enforcement decision in ADR shape (mirrors 0001). Reads top-down for a future Director onboarding: Context (Drake's management lever, Zain's booking links, Nabeel's expectation), Decision (six patterns + cutoff + cascade behavior), Consequences (the forcing function + the safety net + what's NOT changed), Implementation pointers (code + tests + runbook + the lifecycle runbook for auto-create), Review (when to revisit). Acknowledges the spec was deleted at this EOD.

The dangling-spec-reference sweep caught 9 lines across 6 doc files (runbooks + schema docs + ella.md) that linked to soon-to-be-deleted spec paths. Each was updated to point at the appropriate runbook / schema doc / ADR instead. state.md's per-spec entries kept their slug references — they're cleanly recoverable from git history via `git log --diff-filter=A` searches and the surrounding text stands alone.

The deletions landed in one commit covering exactly the 7 today-spec/report pairs (14 files). Yesterday's leftover pairs stayed untouched per spec scope. This EOD cleanup spec itself stays in `docs/specs/` until the next EOD per the spec's recursive note — it needs to exist to point at this report.

## Verification

- **`pytest tests/`** → 575 passed, 0 failed. No code changed.
- **`npx tsc --noEmit`** → clean.
- **`npm run lint`** → "No ESLint warnings or errors."
- **`grep -rln "docs/specs/<7-slugs>" docs/ CLAUDE.md`** post-edit: only `docs/state.md` (per-spec entries, intentional slug refs) and `docs/decisions/0002-title-convention-enforcement.md` (deletion acknowledgment, intentional). No other doc files carry broken paths.
- **`ls docs/specs/ docs/reports/`** post-deletion: only `eod-cleanup-2026-05-15.md` (specs) and the matching report + the three yesterday-shipped pairs + `docs/reports/README.md` remain.
- **`git log --oneline -3`** confirms the two-commit shape (docs refresh, then deletions). No squashing.

## Surprises and judgment calls

- **Admin cost hub entry already exists in `docs/future-ideas.md`** at lines 201-206 in the standard four-line format (What / Why deferred / Revisit trigger / Logged), dated 2026-05-14 from the day-end-wrap conversation. The spec's directive to "add a cost hub entry" is satisfied by the existing entry — adding a duplicate would have been harmful (two entries for the same idea). Flagged here rather than silent-skip. Existing entry covers V1 (Anthropic + Supabase first since data already exists / direct access) and V2 (per-provider scope as integration cost is justified) — same shape the spec's body language called for.
- **state.md per-spec entries kept their `docs/specs/<slug>.md` paths** rather than updating each to a slug-only reference. The spec's hard stop "Don't aggressively prune state.md. When in doubt, leave the line." pointed me toward minimal edits. The paths are dangling-after-deletion but functionally serve as slug identifiers; git history reconstructs the actual spec body if needed. Worth flagging because a future reader clicking those paths sees a 404 in the GitHub web view.
- **CLAUDE.md § Stack table edit** — spec said "Tech stack section: add `director_tasks`, `oauth_tokens`, `calendar_events`, `access_tier` column on team_members." But the Stack table is high-level (Database, Backend, Frontend layers), not table-level. Adding individual table names would have broken the table's information density. Instead I expanded the secrets row with the new env vars (which IS the kind of thing the Stack table tracks) and left the migration / table inventory to `docs/state.md` where it lives today. Worth flagging because it's a deliberate deviation from the spec's literal language; the spirit (CLAUDE.md shouldn't drift from shipped reality) is honored differently.
- **The "consolidated section at the TOP of the file" placement** — spec said "TOP of the file" but state.md has a top-line system-state block at the head + a `## Gregory editorial skin shipped` section. I put the consolidated section at the top of the "Gregory editorial skin shipped" section, not above the top-line system-state block. Rationale: the top-line block is the cross-batch snapshot (always-current); shipped batches accumulate below. Putting the consolidated section above the top-line block would have broken the file's structural rhythm. If Drake meant literally the absolute top, this is the trivial fix at next EOD.
- **No "Routes inventory" line in CLAUDE.md to update** — spec § 3 called out "Routes / surfaces section: add `/teams`, `/tasks` with their access tiers." CLAUDE.md has no such inventory section today — the routes live implicitly in § Current Focus (which I updated) and the TopNav reference in the codebase. The 5-tab TopNav (Clients / Calls / Teams / Ella / Tasks) is now stated in § Current Focus.
- **The eod-cleanup-2026-05-15 spec stays in docs/specs/ this commit** per the spec's own recursive note. It'll get deleted at the next EOD. Same for this report (eod-cleanup-2026-05-15.md in docs/reports/).

## Out of scope / deferred

- **CLAUDE.md does not list every shipped table.** Tables are in `docs/state.md` + the per-table schema docs in `docs/schema/`. Pushing each shipped table into CLAUDE.md would balloon the file and undo the 2026-05-11 split that moved state out of CLAUDE.md.
- **No re-architecture of state.md.** Spec said "When in doubt, leave the line." The per-spec entries from before today stayed.
- **No cleanup of yesterday's leftover spec/report pairs** (`ella-escalation-unify-and-route-to-scott`, `ella-passive-escalation-keyword-bypass`, `gregory-day-end-wrap-2026-05-14`). Spec scoped the cleanup to today's batch. If Drake wants those swept too, the next EOD cleanup catches them.
- **No new code, no migrations, no env vars** — pure doc cleanup per spec hard stops.

## Side effects

- **Two commits pushed to `main`** (about to push after this report writes): `8e4676a` (docs refresh — state + CLAUDE + ADR + runbook/schema reference fixes), `cee0082` (deletions of the 14 spec/report files). Report commit lands next.
- **No cloud DB changes.** No migrations applied; no SQL run.
- **No code changes.** Tests didn't need to re-run beyond the pre-commit verification (which they did, 575 passing as expected).
- **No external API calls, no Slack posts, no Vercel deploys triggered by code path** — but the push will fire Vercel's auto-deploy on the docs-only changes. Effectively a no-op for the deployed surface.
- **GitHub web view shows broken paths** in the state.md per-spec entries until those entries naturally age out of being relevant. Acceptable since the surrounding text stands alone and git-log searches recover the spec body.
