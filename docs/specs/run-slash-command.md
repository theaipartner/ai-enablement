# Run slash command

**Slug:** run-slash-command
**Status:** in-flight

## Context

Director (chat-Claude) writes specs to `docs/specs/<slug>.md` and pushes them via GitHub MCP. Builder (this Code session) executes them. Today the trigger is a manual paste — Drake types `execute docs/specs/<slug>.md` in Code and Code reads, executes, reports.

This spec creates a `/run` slash command that removes that friction. Drake pushes a spec from chat-Director, switches to Code, types `/run`, Code does the rest. The UserPromptSubmit hook (shipped in `builder-pull-hooks`) already pulls latest before every turn, so by the time `/run` fires, the new spec is already on disk.

The bootstrap detail: this spec itself can't be triggered by `/run` (the command doesn't exist yet — this spec creates it). Drake will trigger this one with a manual paste. Every subsequent spec gets `/run`.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. What CLAUDE.md § Spec and report convention says about spec/report file paths, status headers, slug format, and cleanup-on-ship.
2. What CLAUDE.md § Builder behavior says about commit/push flow and the six-section end-of-turn report.
3. **How Claude Code's custom slash command mechanism actually works.** Verify via `claude --help`, the docs at https://docs.claude.com, or by inspecting any existing `.claude/commands/` directory. Specifically confirm: where command files live (assumed `.claude/commands/<name>.md`), whether the file body is a prompt template Claude executes or whether it can invoke bash/scripts directly, what frontmatter (if any) is supported, how arguments work if Drake ever wanted to pass one (e.g., `/run <slug>`). If the mechanism is meaningfully different from what this spec assumes, **stop and surface to Drake before improvising** — better to revise the spec than to ship a half-working command.
4. Confirm the project-level `.claude/` directory exists (it does — `.claude/settings.json` was created in `builder-pull-hooks`). The new `commands/` subdirectory goes alongside it.
5. Confirm the repo root contains `docs/specs/` and `docs/reports/` (it does — `docs/reports/README.md` and at least one spec file should exist).

## What success looks like

When Drake types `/run` in a Code session, the command does the following:

1. **Pull defensively.** Run `git pull origin main` from the repo root before scanning. The UserPromptSubmit hook should have already pulled, but a slash command should be self-contained — don't trust prior state. Apply the same fail-soft contract as the hook (timeout, log to stderr, proceed on failure).
2. **Scan `docs/specs/` for executable specs.** An "executable spec" is a markdown file where:
   - The third line of the file matches `**Status:** in-flight` (per CLAUDE.md § Spec and report convention).
   - There is no matching `docs/reports/<slug>.md` file. Slug is the filename minus `.md`.
   - Specs with `Status: shipped` or `Status: superseded` are ignored.
   - Specs without a parseable status header (malformed front-matter) are flagged but not auto-executed — see error handling below.
3. **Branch on match count:**
   - **Zero matches:** report `"no in-flight specs without reports — nothing to run"` and exit. No execution.
   - **Exactly one match:** read the spec at `docs/specs/<slug>.md` and execute it per CLAUDE.md § Builder behavior. Run tests, commit + push per § Commits, write the report to `docs/reports/<slug>.md`, push the report.
   - **Multiple matches:** list each spec with its slug + title (parsed from the `# <Title>` first line) and ask Drake which to execute. Don't auto-pick; spec selection is Drake's call when ambiguous.
4. **Handle malformed specs gracefully.** If a file in `docs/specs/` lacks a parseable `Status:` line, surface it in the listing as `(unparseable status — skipping)`. Don't fail the whole command on one bad spec; just exclude it from the executable set and note it.

## Hard stops

- If the slash command mechanism in Claude Code doesn't support the assumed `.claude/commands/<name>.md` format, **stop and surface to Drake**. Don't fabricate a different mechanism.
- If `git pull` would create a merge conflict on this machine (uncommitted local changes that conflict with remote), stop — don't `git stash` or force.
- If Drake's `/run` invocation lands on a spec that has hard stops of its own (per CLAUDE.md § Spec-writing standards, every non-trivial spec includes hard stops at irreversible/shared-state boundaries), those hard stops still fire. `/run` is a trigger, not a bypass — it doesn't loosen any gates the underlying spec defines.
- If multiple specs match and Drake doesn't pick one in the same Code turn, **don't pick for him.** End the turn after listing options. Drake re-invokes with explicit selection on the next turn.

## Mandatory doc updates

- **CLAUDE.md § Spec and report convention** — add a brief note at the end of that subsection mentioning that `/run` is the conventional trigger from Code once a spec is pushed by Director. Don't restate the slash command's logic — just point at it. One or two sentences.
- **No new runbook needed.** The slash command's behavior is fully captured by this spec + the eventual report.
- **No CLAUDE.md § Live System State entry.** This is infrastructure, not a shipped product feature.

## What could go wrong (think this through yourself)

A few angles worth considering before writing code:

- What if `docs/specs/` has a `README.md` or other non-spec file? The status-header check should naturally exclude it (no matching `Status:` line), but verify.
- What if a spec's slug contains characters that don't round-trip cleanly between filename and the `Status:` parser? Stick to kebab-case-only per CLAUDE.md convention; flag if a spec violates this.
- What if the user pushes a spec and types `/run` before the UserPromptSubmit hook's pull completes? The defensive pull inside `/run` should cover this, but check the timing.
- What if Drake invokes `/run` while a previous `/run` execution is still mid-flight? Likely impossible in a single Code session (Code is sequential), but worth a sanity check.
- What if a report exists but the work was abandoned partway (report is a stub)? The "report exists → spec is done" check is structural, not semantic. Drake would need to delete the stub report manually if he wants to re-trigger. Document this in the slash command's behavior so it's not a surprise.

## Commit + report

Per CLAUDE.md § Commits: one logical commit for the new `.claude/commands/run.md` file, one logical commit for the CLAUDE.md doc update. Push both. Then write a report to `docs/reports/run-slash-command.md` per CLAUDE.md § Spec and report convention and push that as a final commit.

After the report lands, this spec's `Status:` flips to `shipped` and Director (chat-Claude) handles the cleanup commit deleting both `docs/specs/run-slash-command.md` and `docs/reports/run-slash-command.md`. That cleanup is Director's, not Builder's — don't delete the spec or report yourself.
