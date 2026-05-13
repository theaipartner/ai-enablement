# Report: Gregory day-end wrap — Ella booking-link note + cleanup + future ideas + state recalibration
**Slug:** gregory-day-end-wrap-2026-05-14
**Spec:** docs/specs/gregory-day-end-wrap-2026-05-14.md

## Files touched

**Modified:**

- `agents/ella/prompts.py` — added one new line to the WHO YOU ARE section directly after the existing CSM-vs-advisor naming line: "Clients meet with their advisors via a calendar booking link." Universal, no per-CSM logic, no specific URL.
- `CLAUDE.md` — § Current Focus rewritten to reflect the fully shipped 2026-05-14 state (Primary CSM editable + action items transfer fix + Send-to-Slack dry-run + Ella fixes + Ella visual redesign). § Next Session Priorities re-ranked: Send-to-Slack production cutover is now item 1; the three new future ideas land at items 2-4 (CSM utilization check / Teams page / Admin cost hub); carried items renumbered 5-10. The hardcoded `docs/working/<surface> Redesign.html` path in the Design-workflow paragraph also updated.
- `docs/state.md` — appended a 2026-05-14 wrap-day entry under § Gregory editorial skin shipped. Dense paragraph matching the prior entries' voice. Covers all six workstreams (Primary CSM, NPS/Accountability toggles, back-button fix, action items transfer, Send-to-Slack, Ella pre-redesign fixes + visual redesign + prompt note).
- `docs/future-ideas.md` — appended new "Newer ideas (post-redesign, Gregory side)" section between Batch E and the Tooling section. Three entries (CSM utilization audit / Teams page / Admin cost hub), each in the existing What / Why deferred / Revisit trigger / Logged voice.
- `docs/runbooks/design-handoff.md` — three updates: § 2 precedent-design bullet (point Design at live shipped surfaces, not dead-path HTML files); § 3 mock-commit path (recent-precedent is repo root; future sessions confirm with Drake); § Spec/report cleanup (retire the "mocks stay in place" pattern — they're redundant once the live preview is the source of truth).

**Deleted (after Drake's explicit "go" in chat):**

Specs + reports (7 pairs):

- `docs/specs/gregory-action-items-transfer-fix.md` + `docs/reports/...`
- `docs/specs/gregory-client-detail-warmup-fixes.md` + `docs/reports/...`
- `docs/specs/gregory-csm-visual-and-list.md` + `docs/reports/...`
- `docs/specs/gregory-editable-primary-csm.md` + `docs/reports/...`
- `docs/specs/gregory-ella-escalation-output-body.md` + `docs/reports/...`
- `docs/specs/gregory-ella-pre-redesign-fixes.md` + `docs/reports/...`
- `docs/specs/gregory-send-to-slack-action-items.md` + `docs/reports/...`

Orphan report (no matching spec; from yesterday's Ella visual redesign where Drake handed the HTML mock directly):

- `docs/reports/gregory-ella-redesign.md`

Files (untracked, deleted from disk only — never lived in git):

- `Gregory Calls Redesign.html` (repo root)
- `Gregory Clients Redesign.html` (repo root)
- `Gregory Ella Redesign.html:Zone.Identifier` (Windows metadata leftover)

Branches (local + remote):

- `gregory-csm-visual-fixes`
- `gregory-redesign-part-1-foundations`

**Preserved per spec § Hard stop #2:**

- `promethean-shell` branch (local + remote) — unmerged work Drake explicitly preserved.

## What I did, in plain English

End-of-day wrap landed in two phases per spec § Hard stop #1.

**Phase A — non-destructive content edits.** Five commits before the deletion gate:

1. `agents/ella/prompts.py` gains the booking-link line. Insertion point chosen by reading the WHO YOU ARE section — the existing CSM-vs-advisor naming line establishes WHO the client meets with; the new line establishes HOW. Both live in the same paragraph block. Universal phrasing per spec § Decision 1, no per-CSM linking, no specific URL.

2. `CLAUDE.md` § Current Focus rewritten to flip from yesterday's "Gregory redesign — shipped 2026-05-13" to a fully shipped 2026-05-14 state covering the six workstreams from today's session. § Next Session Priorities re-ranked: Send-to-Slack production cutover (item 1, the env-var flip), CSM utilization check (2), Teams page (3), Admin cost hub (4), then carried items (Ella V2 Batch 2.1, Meeting tracking, Batch B/C/D/E) at items 5-10. Yesterday's items 1-4 (warm-up bundle, Send-to-Slack scoping, action items transfer, Ella redesign) all shipped — dropped. § Working Norms already documented the Playwright workflow at line 49 (no change needed there).

3. `docs/state.md` gained a 2026-05-14 wrap-day entry in the existing dense paragraph voice. Covers all six workstreams plus the prompt note and the visual-verification pattern. Appended to the § Gregory editorial skin shipped section before the prior entries.

4. `docs/future-ideas.md` gained three new entries under a new "Newer ideas (post-redesign, Gregory side)" section between Batch E and the Tooling section. Each entry follows the existing What / Why deferred / Revisit trigger / Logged voice.

5. `docs/runbooks/design-handoff.md` updated to remove dead `docs/working/Gregory ... Redesign.html` references; CLAUDE.md's Design-workflow paragraph also updated for consistency. The HTML files themselves were referenced as "the durable visual reference for future Design sessions" — that framing is retired (they're git-history-only now; new sessions can leave a mock at any Drake-confirmed path during the cycle).

**Phase B — deletions (after Drake's explicit "go" in chat).** Three further actions:

6. `git rm` on the 14-file spec/report set + the orphan ella-redesign report.

7. Plain `rm` on the two HTML files at repo root (untracked, never lived in git) + the `Gregory Ella Redesign.html:Zone.Identifier` Windows metadata leftover. `fix pics/` and `Gregory Ella Redesign.html` itself were already gone — Drake cleaned them between turns.

8. `git branch -d` + `git push origin --delete` on the two fully-merged feature branches. `git branch -d` (lowercase) refuses unmerged-commit deletions as a safety net; both branches passed cleanly. `promethean-shell` left intact per spec § Hard stop #2.

## Verification

- **Build:** No code paths changed beyond the one-line Ella prompt addition. The prompt file is a `.py` literal; no TypeScript / ESLint impact. Did not run a full build pass — none of the changes touch the Next.js / React surface.
- **Git state:** `git branch -a` after deletions shows only `main` + `promethean-shell` (both local + remote). `git status --short` shows the working tree clean except for the untracked artifacts Drake's already chosen to leave (`lithium/`, `lithium.zip`, `scripts/.preview/`).
- **Doc references:** `grep -rn "docs/working\|Gregory.*Redesign.html"` across `docs/runbooks/` + `CLAUDE.md` returns only the descriptive (past-tense, history-only) mentions added in this commit — no live broken paths remain.

No Playwright verification needed (spec § Out of scope, no UI changes).

## Surprises and judgment calls

- **HTML files at repo root, not `docs/working/`.** Spec said `docs/working/Gregory ... Redesign.html` — actual paths were repo root. The runbook references in `design-handoff.md` were the only places pointing at `docs/working/`; updated those to the past-precedent framing.

- **`Gregory Ella Redesign.html` and `fix pics/` already gone between turns.** Drake cleaned them at some point. Only the `Gregory Ella Redesign.html:Zone.Identifier` metadata file remained — a Windows-NTFS attribute leftover that doesn't affect rendering but is dead bytes. Deleted with the rest.

- **One orphan report (`gregory-ella-redesign.md`) not in the spec's enumerated delete list.** The Ella visual redesign last turn had no spec file — Drake handed me the HTML mock directly. I wrote a report when work shipped, leaving an orphan. Surfaced in chat; Drake confirmed delete with the rest.

- **`promethean` in the spec maps to `promethean-shell`.** Only one promethean-prefixed branch exists. The spec said "Preserve `promethean`" — I treated that as referring to the actual branch name `promethean-shell`. Confirmed preserved.

- **Both feature branches were fully merged into main.** `git branch --merged main` showed both `gregory-csm-visual-fixes` and `gregory-redesign-part-1-foundations` in the merged set. `git branch -d` (with the lowercase `-d` safety net per spec § C) deleted both cleanly — no `-D` force needed.

- **`agents/ella/prompts.py` insertion point chosen pragmatically.** The booking-link line could have landed in WHAT YOU ESCALATE (alongside other behavioral norms about routing to advisors) or in WHO YOU ARE (alongside the CSM-vs-advisor naming line). Chose WHO YOU ARE because the naming line and the booking-link line form a natural pair — one establishes the noun ("advisor"), the other establishes the mechanism ("calendar booking link"). Ella will infer from both: when a client mentions wanting to talk to their advisor, point at the booking link, not an `@`-mention.

- **No CLAUDE.md § Working Norms change needed.** Spec § Decision 6.c asked to confirm the Playwright workflow is documented. It is (line 49). No new paragraph added.

- **`design-handoff.md` framing shift, not just path replacement.** Originally the HTML mocks were called "the durable visual reference." Drake's lean was to point Design at the live shipped surfaces instead. Updated the language to reflect the retired pattern: mocks stay during the cycle, get archived at EOD wrap. New surface — point Design at `/clients/[id]` (or whichever live surface most matches the chrome they need to extend), not a path that no longer exists.

- **`docs/agents/ella/ella.md` not updated.** Spec § Mandatory doc-update list flagged it as "possibly small. If the prompt change is significant enough to surface in the agent's behavior doc, add. Builder's call." One sentence in a 24KB prompt doesn't warrant a doc update — the prompt itself is the agent behavior, not the docs around it. Skipped; no value-add.

- **No backfill of historical escalations** for the body persistence work from earlier today — explicit out-of-scope per the related spec, restated here for clarity. Pre-deploy escalation rows on `/ella/runs` continue to render `—` muted in the Output column. Going forward, every new escalation carries the body.

## Out of scope / deferred

- Production cutover for Send-to-Slack (env-var flip — Drake's gate (d), now item 1 in Next Session Priorities).
- Implementing any of the three future-ideas entries (CSM utilization / Teams page / Admin cost hub).
- Backfilling historical escalation DM bodies (separate spec if Drake ever wants it).
- The `getClientsList` open-action-items-count predicate bug — same shape as today's `getClientById` fix, separate spec planned (logged in `docs/known-issues.md`).
- Updating `docs/agents/ella/ella.md` for the prompt addition (deemed too small).
- Any tests beyond build cleanliness — explicit out-of-scope per spec.

## Side effects

- **Pushed to `main` directly** (no PR per spec § Context). Eight commits in this spec's slice:
  - `6838c01` — Ella prompt update + acclimatization checkpoint in message
  - `5a00ea7` — CLAUDE.md § Current Focus + § Next Session Priorities recalibration
  - `b89e6b2` — `docs/state.md` 2026-05-14 wrap-day entry
  - `afad8c3` — `docs/future-ideas.md` three new entries
  - `fcee817` — `docs/runbooks/design-handoff.md` + CLAUDE.md dead-path retirements
  - `5654796` — Phase B: 14 spec+report files + 1 orphan report deleted
  - This report's commit (next).
- **Branches deleted on `origin`:** `gregory-csm-visual-fixes`, `gregory-redesign-part-1-foundations`. Both were fully merged into main pre-deletion. `promethean-shell` preserved.
- **No DB writes, no Slack posts, no external API calls** from this run. Pure local file + git operations.
- **Working tree preserved** for untracked items Drake keeps around: `lithium/`, `lithium.zip`, `scripts/.preview/`. Removed: the two HTML mocks at repo root + the Windows metadata leftover.
- **No environment-var changes** from this commit (Send-to-Slack production cutover stays a follow-up gate (d) action).
- **The Ella system prompt change takes effect on the next Vercel deploy** (any push to `main` triggers a deploy via the GitHub integration). The prompt is loaded fresh per Ella invocation, so future Ella runs will see the new line.
