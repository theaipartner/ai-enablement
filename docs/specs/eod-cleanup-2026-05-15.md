# EOD cleanup 2026-05-15: state.md + CLAUDE.md refresh, decisions captured, today's specs and reports archived

**Slug:** eod-cleanup-2026-05-15
**Status:** in-flight

## Context

End-of-day cleanup after a 10-spec day. The codebase is in a coherent post-state but the docs need to catch up — `docs/state.md` has fresh per-spec entries but no consolidating section, `CLAUDE.md` may reference primitives or patterns that have shifted, today's specs and reports are still sitting in `docs/specs/` and `docs/reports/` per the standard EOD-delete convention, and one major architectural decision (the May 18 title convention enforcement + the forcing-function rationale) belongs in `docs/decisions/` as an ADR rather than buried in commit history.

The only remaining Gregory roadmap item Drake wants captured before clearing the deck is the **cost hub** — an admin-only surface showing API spend across Anthropic + OpenAI + Google + Vercel + Supabase. Belongs in `docs/future-ideas.md` as a queued V2 idea.

## Files Builder reads first (acclimatization)

1. `docs/state.md` — read the full file. It's the highest-leverage doc; clean state.md = clean Director handoff Monday morning.
2. `CLAUDE.md` — read end-to-end. Looking for: outdated tech stack lines, outdated migration counts, references to deprecated patterns (e.g., the old Scott-1:1 auto-create), stale env-var lists, anything that contradicts what was shipped in the 10 specs today.
3. `docs/decisions/0001-foundational-stack.md` — read to understand the ADR shape so `0002-*` matches it.
4. `docs/specs/` — list contents. Every spec from today should be deleted as part of this cleanup.
5. `docs/reports/` — list contents. Every report from today should be deleted (already-captured info lives in state.md, runbooks, schema docs, and now decisions).
6. `docs/future-ideas.md` — confirm the file shape so the cost-hub idea entry matches existing patterns.

## Today's shipped specs (all 10) — confirm marked complete and delete

Builder confirms each of these landed cleanly before deleting:

1. `docs/specs/permissions-access-tiers.md` + `docs/reports/permissions-access-tiers.md`
2. `docs/specs/teams-meeting-tracker.md` + `docs/reports/teams-meeting-tracker.md`
3. `docs/specs/teams-calendar-external-attendee-filter.md` + `docs/reports/teams-calendar-external-attendee-filter.md`
4. `docs/specs/teams-personal-email-exclusion-and-nabeel-removal.md` + `docs/reports/teams-personal-email-exclusion-and-nabeel-removal.md`
5. `docs/specs/classifier-enforce-new-title-convention.md` + `docs/reports/classifier-enforce-new-title-convention.md`
6. `docs/specs/auto-created-client-lifecycle.md` + `docs/reports/auto-created-client-lifecycle.md`
7. `docs/specs/director-tasks-and-list-ux-polish.md` + `docs/reports/director-tasks-and-list-ux-polish.md`
8. Plus any others Builder finds in the directory (Builder lists actual directory contents at apply time — don't trust this list as exhaustive).

The deletion is per the standard EOD convention: shipped work moves into state.md + per-feature docs (schema/runbook/decision), the spec+report pair gets removed so the directories stay focused on in-flight work.

## Decisions baked in (do NOT re-litigate)

- **state.md refresh shape:** consolidate today's 10 per-spec entries under one dated section ("2026-05-15 — Permissions, Teams Meeting Tracker, title-convention forcing function, /tasks") at the TOP of the file, with each piece a 2-3 sentence summary. Existing top-line entries that became stale (e.g., the migration count line, env-var inventory, Vercel cron list, Python function count) get updated in their original locations. Don't delete the per-spec entries individually — instead refactor: keep the chronological "what shipped today" block, prune individual sub-entries that are now redundant with the consolidated block.
- **CLAUDE.md refresh shape:** Builder reads it end-to-end and flags anything inconsistent with shipped state. Examples (Builder verifies each):
  - Tech stack lines — should mention `director_tasks`, `oauth_tokens`, `calendar_events`, `access_tier` if not already.
  - Migration count — should be 36.
  - Vercel cron list — should include `teams_calendar_sync_cron`.
  - Routes list — should include `/teams`, `/tasks` (with their tier gates noted).
  - Env vars — should include `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `NEXT_PUBLIC_APP_URL`, `ESCALATION_RECIPIENT_SLACK_USER_ID`.
  - Any reference to the retired `30mins_with_Scott` auto-create as the active pattern → updated to reflect that it's pre-cutoff only.
  - Any reference to Nabeel as a CSM → corrected (he's admin-tier now, `is_csm=false`).
  - Any reference to per-page Slack column always rendering on `/clients` → updated to "conditional on filter state."
- **ADR 0002 captures the May 18 title convention enforcement.** Title: "Enforce booking-link title convention for client classification." Status: Accepted, 2026-05-15. Content covers: context (Drake's management lever, Zain's booking links, Nabeel's expectation), decision (six canonical patterns, case-insensitive prefix match, cutoff at started_at >= 2026-05-18 EST), consequences (forcing function — non-compliant CSMs find calls dropping out; auto-create + needs_review + merge UI as the safety net; historical calls preserved). Reference the spec slug + runbook for operational detail.
- **Cost hub goes into `docs/future-ideas.md`.** Single section, ~10-15 lines. Frames it as: "admin-tier-only page surfacing API spend across providers (Anthropic, OpenAI, Google, Vercel, Supabase) — needed for budget visibility as usage scales. V1: monthly aggregates pulled from each provider's billing API. V2: per-feature breakdown (Ella, gregory_brain, etc.). Open: which providers expose programmatic billing endpoints vs require dashboard scraping."
- **NO new code, no migrations, no env vars.** Pure doc cleanup. Builder doesn't touch the codebase outside of `docs/`.
- **`Status: in-flight` flip:** Builder updates each shipped spec to `Status: shipped` IF a spec file is being modified before deletion. Since the spec files get deleted entirely, the flip is moot — but worth noting that anyone pulling git history will see the spec was shipped because the deletion commit message says so.
- **Spec/report deletion via git delete**, not a rename or archive. They're recoverable from history; that's the canonical archive.

## Implementation

### 1. Read CLAUDE.md and state.md in full

Builder reads both files completely. Flags any discrepancies between shipped state and documented state. Surfaces the flag list in chat or in the report — these are the lines that need editing.

### 2. Update state.md

- Add a consolidated "2026-05-15 — EOD" section at the top covering all 10 specs in plain English. Aim for 4-6 lines per feature; readable in 60 seconds.
- Update the migration count line to 36.
- Update the env-var inventory to include the Google OAuth vars.
- Update the Vercel cron list to include `teams_calendar_sync_cron` (`*/30 * * * *`).
- Update the Python function count to include `teams_calendar_sync_cron.py`.
- Update the routes inventory if one exists — `/teams` (head_csm+) and `/tasks` (creator) are new.
- Prune redundant individual per-spec sub-entries where the consolidated block covers them. Don't aggressively delete; if there's any doubt about a sub-entry's continued value, leave it.

### 3. Update CLAUDE.md

Builder edits each line flagged in step 1. Common shapes:

- Tech stack section: add `director_tasks`, `oauth_tokens`, `calendar_events`, `access_tier` column on team_members.
- Routes / surfaces section: add `/teams`, `/tasks` with their access tiers.
- Vercel crons section: add the 30-min `teams_calendar_sync_cron`.
- Env vars section: add Google OAuth trio.
- Classifier section: note the May 18 cutoff. Reference ADR 0002 + the runbook for detail.
- Any "Drake's role" or "team roster" lines: update Nabeel's `is_csm=false`, note Huzaifa's personal-email exclusion pattern.

### 4. Create `docs/decisions/0002-title-convention-enforcement.md`

ADR shape mirroring `0001`. Sections: Context, Decision, Consequences. Plain English; the audience is Future-Drake or a future Director onboarding to the codebase. Reference the spec slug (`classifier-enforce-new-title-convention`) for the implementation detail, the runbook (`docs/runbooks/call_title_convention.md`) for ops, and the lifecycle spec for the safety net.

### 5. Update `docs/future-ideas.md` — add cost hub entry

Single section. Title: "Admin cost hub — per-provider spend dashboard." Body covers V1 + V2 scope, open technical questions. Status: Queued.

### 6. Delete today's specs and reports

Builder lists `docs/specs/` and `docs/reports/`, confirms which files were created today (commit history will show this), deletes them in one commit. Files outside today's batch (specs / reports that pre-existed) stay untouched.

### 7. Doc updates summary

Modified:
- `docs/state.md`
- `CLAUDE.md`
- `docs/future-ideas.md`

Created:
- `docs/decisions/0002-title-convention-enforcement.md`

Deleted (all 14 files):
- `docs/specs/permissions-access-tiers.md`
- `docs/specs/teams-meeting-tracker.md`
- `docs/specs/teams-calendar-external-attendee-filter.md`
- `docs/specs/teams-personal-email-exclusion-and-nabeel-removal.md`
- `docs/specs/classifier-enforce-new-title-convention.md`
- `docs/specs/auto-created-client-lifecycle.md`
- `docs/specs/director-tasks-and-list-ux-polish.md`
- `docs/reports/permissions-access-tiers.md`
- `docs/reports/teams-meeting-tracker.md`
- `docs/reports/teams-calendar-external-attendee-filter.md`
- `docs/reports/teams-personal-email-exclusion-and-nabeel-removal.md`
- `docs/reports/classifier-enforce-new-title-convention.md`
- `docs/reports/auto-created-client-lifecycle.md`
- `docs/reports/director-tasks-and-list-ux-polish.md`

Plus Builder's own cleanup spec + report after this lands (recursive — the cleanup spec itself gets deleted at the next EOD, but stays in this commit so the report has a target).

## What success looks like

1. **state.md reads top-down as the current truth.** No contradictions with shipped code.
2. **CLAUDE.md describes the system as it is, not as it was.**
3. **ADR 0002 captures the title convention decision** with enough context that a future onboarding read explains why the rule exists and what the safety net looks like.
4. **Cost hub idea is queued in future-ideas.md.**
5. **`docs/specs/` and `docs/reports/` are empty (or only contain pre-2026-05-15 files if any exist).**
6. **No code changes, no migrations, no env vars, no tests run.**
7. **Linting and typecheck still pass** (no broken doc-references in code comments — Builder spot-checks if any comments reference the deleted spec slugs).

## Hard stops

- **Don't delete anything outside `docs/specs/` and `docs/reports/`.** Schema docs, runbooks, decisions, agents docs all stay.
- **Don't touch any non-doc files.** No code edits.
- **Don't flip `Status:` on the specs before deleting** (the deletion is the flip; git history records it).
- **Don't aggressively prune state.md.** When in doubt, leave the line.
- **Don't write a cleanup spec for other directories** (architecture/, ingestion/, etc.). Today's scope is state.md + CLAUDE.md + decisions + future-ideas + the deletions.
- **No new conventions, no new structural patterns.** This is cleanup, not redesign.

## What could go wrong

- **A line in CLAUDE.md or state.md references a spec slug that's about to be deleted.** Common — the per-spec state.md entries link to spec files. Mitigation: Builder updates those references to point at the appropriate runbook / schema doc / decision instead, OR removes the link if the surrounding text stands alone.
- **An ADR-0002 line drifts from the runbook.** Mitigation: ADR points at the runbook for ops detail; runbook is the source of truth for operational behavior, ADR is the source of truth for "why we made this call."
- **Builder finds a stale section in CLAUDE.md that's a much bigger cleanup than expected.** Mitigation: Builder flags it in the report rather than expanding scope. A future spec handles bigger refactors.
- **A spec or report Builder deletes was referenced by a doc that wasn't on the list.** Mitigation: Builder greps for the deleted slugs across `docs/` and fixes any dangling references in the same commit.

## Mandatory doc-update list

- `docs/state.md` — consolidated 2026-05-15 section + targeted line updates.
- `CLAUDE.md` — Builder-flagged outdated lines updated.
- `docs/decisions/0002-title-convention-enforcement.md` — new.
- `docs/future-ideas.md` — cost hub entry added.
- All 14 files in `docs/specs/` and `docs/reports/` from today: deleted.

## Commit shape

- One docs commit (state.md + CLAUDE.md + future-ideas + decisions/0002).
- One deletions commit (`chore: archive 2026-05-15 specs and reports`).
- One report commit.
- Push at end.
