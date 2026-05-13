# Report: Gregory redesign wrap-up — docs + cleanup
**Slug:** gregory-redesign-wrapup
**Spec:** docs/specs/gregory-redesign-wrapup.md

## Files touched

**Modified**
- `CLAUDE.md` — two paragraph insertions (design workflow + MCP-edit constraint); Current Focus rewritten; Next Session Priorities items 1-8 swapped (existing 9-10 + deferred-decision callout retained).
- `docs/state.md` — new bullet under "Gregory editorial skin shipped" section covering the 2026-05-13 full-redesign ship.

**Created**
- `docs/runbooks/design-handoff.md` — runbook documenting the Drake → Director → Design → Builder workflow, the preview-auth bypass, and the cleanup cadence for design hand-off HTML files.

**Deleted (29 files, single commit)**
- 14 spec/report pairs under `docs/specs/` and `docs/reports/`: `cs-call-summaries-sentiment-only`, `director-docs-topology-and-root-cleanup`, `ella-passive-rollout-7-channels`, `gregory-editorial-dark-skin`, `gregory-list-editable-reorder-refresh`, `gregory-native-select-polish`, `gregory-redesign-part-1-foundations`, `gregory-redesign-part-2-calls-data-layer`, `gregory-redesign-part-2-ella-detail-and-cleanup`, `gregory-redesign-part-2-ella-list-polish`, `gregory-redesign-part-2-ella-visual-verification`, `gregory-redesign-part-2-ella`, `investigate-vercel-build-missing-changes`, `merge-gregory-editorial-skin-to-main`.
- 1 orphan spec without a report: `docs/specs/claude-md-design-workflow-and-mcp-edit-constraint.md` (content merged into this wrap-up).

**Kept in place by design**
- `docs/specs/gregory-redesign-wrapup.md` (this running spec — stays until its own ship; deletes on the next EOD batch).
- `docs/specs/promethean-preview-auth-bypass.md` + `docs/specs/promethean-v0-shell-mock-data.md` (in-flight, no reports yet, target the `promethean-shell` branch).
- `docs/reports/README.md` (directory marker).
- `docs/working/Gregory Calls Redesign.html` and `docs/working/Gregory Clients Redesign.html` (design hand-off references — explicit spec § F-stays).

## What I did, in plain English

Wrapped up the five-bundle doc + cleanup spec. Two CLAUDE.md insertions captured the design workflow + the MCP-edit constraint paragraphs that explain why Director writes specs only. The Current Focus pointer moved off "meeting tracking" onto "Gregory redesign — shipped 2026-05-13" with a forward link to tomorrow's queue. The Next Session Priorities items 1-8 were swapped per the spec — tomorrow's three small client-detail fixes lead, then Send-to-Slack, then action-items-transfer, then Ella redesign, then the carried Ella 2.1 + meeting tracking + NPS piping + Batch C HITL.

`docs/state.md` got a new shipped-state entry under the existing "Gregory editorial skin shipped" section, written in the same voice as the surrounding bullets — single bullet, leading bold-label anchor, prose. Covers the visual+UX pass across Calls / Clients / Ella, the Part 1 primitives, the gold-accent + decoupled sentiment palette, the typography pairing, the Playwright verifier convention, and the design workflow pointer.

`docs/runbooks/design-handoff.md` is new — half-page runbook matching the sibling structure (`# Runbook: <Title>`, intro paragraph, sectioned workflow). Covers when to use the workflow, the four-stage flow, Builder's role, the `NEXT_PUBLIC_DISABLE_AUTH=true` Preview-only bypass, cleanup cadence, and the failure modes already seen (Drake calling out the "keep all 9 columns" caveat on the Clients redesign is the working example of the spec catch-point).

Cleanup hit the hard-stop gate per spec § F. Surfaced 7 from the spec's literal delete-set + 6 extras shipped-but-status-still-in-flight on disk. Drake confirmed "delete all specs and reports, only those, but all of them" — interpreted as every spec+report pair on disk except the explicit-keep list (this wrap-up, the promethean specs, README.md). 29 files removed in one commit.

## Verification

- **No code touched, no tests run.** All edits are docs.
- **CLAUDE.md insertions verified by `str_replace` exact-match.** Both anchors found cleanly; no fuzzy-match fallback needed.
- **state.md voice matched** by reading the surrounding "Gregory editorial skin shipped" section and writing one bullet in the same shape (bold-label anchor → declarative prose → no hedging).
- **Runbook structure matched** against `docs/runbooks/seed_clients.md` and `docs/runbooks/apply_migrations.md` (heading shape, intro paragraph, prerequisites section, workflow section).
- **Cleanup verified post-delete** by listing `docs/specs/` + `docs/reports/` — only the explicit-keep files remain.

## Surprises and judgment calls

- **Hygiene gap on existing specs.** Beyond the 7 specs the wrap-up spec explicitly named, 6 other Gregory-redesign-era specs had matching reports but their `Status:` front-matter still said `in-flight` — they shipped without the status flip. Surfaced in the acclimatization commit (point e); Drake confirmed cleanup with "all of them," so they went with the rest. Two pre-redesign shipped specs (`director-docs-topology-and-root-cleanup`, `ella-passive-rollout-7-channels`) had `Status: shipped` correctly + matching reports; they also went under the same "all of them" instruction.
- **Drake's "all of them" was ambiguous between the spec's 13 files vs. every spec/report pair on disk.** Read as the latter given the emphasis ("but all of them"). Kept the spec's four explicit-keeps (this wrap-up, promethean specs, README); deleted 29 files total instead of the spec's literal 13. Surfacing for visibility — if "all of them" was meant tighter, the deletion's reversible via `git revert`.
- **One git plumbing surprise.** A `cd` inside an earlier Bash invocation persisted into the next call, so the second `rm` from `docs/reports/` initially failed (CWD was still `docs/specs/`). Re-rooted with `cd /home/drake/projects/ai-enablement && cd docs/reports` and the delete went through. Noting because the CLAUDE.md guidance suggests avoiding `cd` chains; will prefer absolute paths in `rm` invocations next time.
- **No push yet.** Per spec § Think this through § "Bundling all five updates...long commit chain — single push", landing the report as the final commit and pushing once after this report lands.

## Out of scope / deferred

- Tomorrow's-queue work itself (CSM editable, NPS / Accountability toggles, back-button fix, Send-to-Slack, action-items transfer, Ella redesign) — separate specs per the Next Session Priorities list.
- Pruning the design hand-off HTML files (`docs/working/Gregory * Redesign.html`) — Drake's call, not Builder's.
- Restructuring CLAUDE.md / state.md / runbooks beyond the specific edits called out.
- The promethean specs and the gregory-redesign-wrapup spec itself — explicit § F-keeps.

## Side effects

- **No production effects.** Doc-only changes. No DB writes, no API calls, no Slack posts, no env-var changes, no deploys.
- **Git history mutated** — 29 file deletions and 5 commits on `main`. Reversible via `git revert` on each commit if needed.
- **No PR opened** (working branch is `main` per spec § Decisions 1).
- **No tests run** — all changes are docs; no test surface affected.
