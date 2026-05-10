# Report: Builder pull hooks

**Slug:** builder-pull-hooks
**Spec:** (no spec file — bootstrap task; the chat prompt was the spec)

## Files touched

**Created:**
- `.claude/settings.json` — project-scoped hook registration for `SessionStart` and `UserPromptSubmit`, both pointing at `/home/drake/.claude/hooks/pull_main.py` with different `--timeout` values.
- `~/.claude/hooks/pull_main.py` — the hook script itself (lives outside the repo per the existing hook convention; not committed).

**Modified:**
- `~/.claude/settings.json` (user-level, outside the repo) — removed the `PreToolUse` block that registered `check_director_writes.py`; the `Stop` block for telegram is untouched.

**Deleted:**
- `~/.claude/hooks/check_director_writes.py` (outside the repo, not committed).

Only `.claude/settings.json` shows in the commit; the script lives in `~/.claude/hooks/` per the existing hook convention and isn't tracked.

## What I did, in plain English

Wrote one Python hook script (`pull_main.py`) that reads the Claude Code hook payload from stdin, finds the repo root via `git rev-parse --show-toplevel` from the payload's `cwd`, and runs `git pull origin main` with a configurable subprocess timeout. Registered it twice in project-level `.claude/settings.json` — once on `SessionStart` with `--timeout 30` (session is loading anyway, generous is fine) and once on `UserPromptSubmit` with `--timeout 5` (tight, per spec, because every turn pays this latency cost). Fail-soft throughout: any failure path — bad payload, non-git cwd, network down, conflict, timeout — logs one line to stderr and exits 0. Then deleted the now-dead `check_director_writes.py` and stripped its `PreToolUse` registration from user-level settings, since chat-Director can't edit local files anyway.

## Verification

Ran the script directly with simulated stdin payloads matching the docs-confirmed shapes:

- **Happy path, SessionStart payload** → `[pull_main] already up to date` + exit 0.
- **Happy path, UserPromptSubmit payload** → same.
- **Non-git cwd (`/tmp`)** → silent exit 0 (`_discover_repo_root` returns None, hook proceeds without action).
- **Malformed JSON on stdin** → silent exit 0.
- **Empty payload `{}`** → falls back to `os.getcwd()`, succeeded against the repo (the test ran from inside it).
- **Forced timeout (`--timeout 0.001`)** → `[pull_main] pull timed out after 0.001s` + exit 0. Confirms the kill-on-timeout path works.

Confirmed both `~/.claude/settings.json` and `.claude/settings.json` parse as JSON via `python3 -c "import json; json.load(...)"`. Confirmed the dead hook file is gone (`ls /home/drake/.claude/hooks/` shows only `check_telegram_reply.py` and the new `pull_main.py`). Confirmed via the official docs that `SessionStart` and `UserPromptSubmit` are real Claude Code hook event names with the input shapes I coded against.

What I didn't do: didn't end-to-end test by actually rebooting the Code session, since that would terminate this session. The script-level simulation covers the hook contract; the in-session integration depends on Claude Code reading the project settings.json and dispatching to the script, which is the standard documented flow.

## Surprises and judgment calls

- **No spec file existed for this task.** Per the prompt, this was a bootstrap task and the chat prompt itself was the spec. Wrote the report anyway since CLAUDE.md § Builder behavior makes the report unconditional.
- **One script, two registrations vs. two scripts.** Chose one script with `--timeout` arg over two near-identical scripts. Cleaner DRY win, no real downside — the timeout difference is the only behavioral split between the two events.
- **SessionStart timeout 30s, UserPromptSubmit 5s.** Drake gave 3-5s as the steer for UserPromptSubmit; picked 5s as the upper end since healthy-network `git pull` to GitHub typically lands in 1-2s and 5s gives margin without feeling laggy. SessionStart got 30s because the session is already loading and there's no incremental UX cost to a slower pull at boot — and a fresh resume after a long offline period might legitimately need to fetch many commits.
- **Hook-handler `timeout` field set to 10s/35s** (vs. the script's internal 5s/30s). The handler-level timeout is a backstop in case the script itself wedges (Python startup, subprocess machinery, etc.). 5-10 seconds of headroom is plenty.
- **No matcher on either hook.** SessionStart supports a `matcher` field for `startup|resume|clear|compact`; omitted it so the hook fires on all four sources. After `/clear` or `/compact` Drake might have new specs to pull, and the cost of an extra pull is negligible.
- **`git pull origin main` not `git pull`.** Per the spec; also more explicit if Builder has ever checked out a non-main branch (which shouldn't happen but the hook stays correct if it does).
- **Used `cwd` from the payload, fell back to `os.getcwd()` if missing.** Defensive; the docs show `cwd` always present, but a missing-field path that exits 0 is cheap insurance.
- **Wrote the script in Python.** Matches the existing hook convention (`check_telegram_reply.py` was Python). Bash with `timeout` would have worked too but Python's `subprocess.run(timeout=...)` is cleaner and the failure-handling is more readable.
- **Did NOT touch `.claude/settings.local.json`.** That file is user-level git-ignored and holds permissions, not hooks. Kept the new hooks in the repo-tracked `.claude/settings.json` so they sync with the codebase (which is what Drake wants — these hooks are for this repo, not all of his work).
- **Failure-mode exit-0 logging is to stderr.** Drake will see the one-line stderr in the Code UI's hook output, which is the right place for it. Happy-path logs ("already up to date") also go to stderr for the same reason.
- **No race-condition handling for concurrent pulls.** If Drake submits two prompts in rapid succession, two `git pull` processes might race on `index.lock`. Git's lock semantics make the second one fail fast; fail-soft handles it. Not worth a mutex.

## Out of scope / deferred

None of the spec is left undone. No new `docs/known-issues.md` or `docs/future-ideas.md` entry warranted — the hook is small, single-purpose, and the failure modes are all already handled by the fail-soft contract.

One thing worth noting for future-Director: the new per-turn pull is the first time Builder actively reaches out to GitHub before every turn. If GitHub auth or remote URL ever breaks (e.g., credential rotation), every turn will log a pull failure to stderr. That's correct fail-soft behavior, but it'll be a visible signal — not a silent break.

## Side effects

- Pushed one commit to `origin/main` (`1a39ea3 hooks: register pull-main on SessionStart and UserPromptSubmit`). This commit is the project-level `.claude/settings.json` only; the hook script lives in `~/.claude/hooks/` and isn't tracked.
- Will push a second commit with this report file (`docs/reports/builder-pull-hooks.md`) as the conventional final commit per CLAUDE.md § Spec and report convention.
- Modified user-level `~/.claude/settings.json` outside the repo (removed dead `PreToolUse` block). Not committed anywhere — that file is per-user.
- Deleted user-level `~/.claude/hooks/check_director_writes.py`. Same — outside the repo, not committed.
- No external API calls, no Slack posts, no DB writes, no tests run against shared resources. The only network egress was the four `git pull` invocations during testing, all of which were no-ops against `origin/main`.
