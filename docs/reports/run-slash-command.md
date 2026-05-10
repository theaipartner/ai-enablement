# Report: Run slash command

**Slug:** run-slash-command
**Spec:** docs/specs/run-slash-command.md

## Files touched

**Created:**
- `.claude/commands/run.md` — the slash command body. YAML frontmatter (`description`, `disable-model-invocation: true`) plus a four-step prompt that instructs Builder to pull, scan, branch on count, and execute.

**Modified:**
- `CLAUDE.md` — added one paragraph at the end of § Spec and report convention pointing at `/run` as the conventional trigger from Code, with a one-line note that zero or multi matches stop rather than guess.

## What I did, in plain English

Created a project-scoped slash command at `.claude/commands/run.md` that automates the "find the in-flight spec and execute it" loop Drake was previously doing by manual paste. Verified up front via the official Claude Code skills/commands docs that `.claude/commands/<name>.md` is still the supported format (it's now the legacy form of the merged "skills" feature, but still works identically). Wrote the command body as a prompt template that walks Builder through: a defensive `git pull` with timeout, a scan of `docs/specs/` matching `**Status:** in-flight` on line 3 plus absence of a paired `docs/reports/<slug>.md`, and a three-way branch on match count (zero → report nothing; one → execute per Builder behavior; multi → list and ask). Set `disable-model-invocation: true` so Claude can never auto-fire `/run` based on conversation cues — this command always starts with Drake typing it. Updated CLAUDE.md to point at the new command in the same convention paragraph that already covers spec/report paths and slug formatting.

## Verification

Confirmed via WebFetch against `code.claude.com/docs/en/hooks` and the skills doc that `.claude/commands/<name>.md` is supported, that the file body is a prompt template Claude executes, and that `disable-model-invocation: true` correctly restricts the command to user invocation only. Verified the docs' `!`-injection feature exists if needed — chose not to use it because instructing Builder to run the pull via the Bash tool is more robust under the `disableSkillShellExecution` setting and more readable.

Walked the three existing specs under `docs/specs/` to confirm the third-line `**Status:**` parser correctly classifies them:

- `cs-call-summary-review-content.md` — line 3 is `## Goal` → flagged unparseable, excluded (expected; pre-convention spec).
- `ella-v2-batch-1-cloud-slack-ingestion.md` — same → flagged unparseable, excluded (expected).
- `run-slash-command.md` — line 3 is `**Status:** in-flight` and no paired report yet → executable. This is the spec being executed right now, so the next `/run` invocation after this report lands will correctly skip it (report exists structurally).

I did NOT actually invoke `/run` to test it end-to-end — that would require a fresh Code session loading the new project settings, and `/run` would itself try to execute the very spec that just shipped. The end-to-end test is naturally Drake's first real `/run` invocation on the next Director-pushed spec. The command body is a prompt for Claude rather than an executable, so there isn't a meaningful unit test surface — the code is the prompt and it reads correctly against CLAUDE.md § Builder behavior and § Spec and report convention.

JSON parses on both settings files were not touched in this work — `.claude/settings.json` was unchanged.

## Surprises and judgment calls

- **The two older specs lack the new front-matter convention.** `cs-call-summary-review-content.md` and `ella-v2-batch-1-cloud-slack-ingestion.md` predate the three-line `# Title` / `**Slug:**` / `**Status:**` header introduced in CLAUDE.md § Spec and report convention. The scanner correctly flags them "unparseable" rather than guessing, but Drake should know that `/run` will list both as unparseable on the first invocation after this lands. Two paths forward, neither in scope here: (a) leave them — they're old work likely already shipped, and the noise is one-time; (b) Director batches a doc-hygiene commit that adds the missing front-matter or moves them to an `archive/` subfolder. I lean (a) — once those specs ship and are deleted per cleanup convention, the noise vanishes.
- **Did not add argument support (`/run <slug>`).** The spec mentioned this as "if Drake ever wanted" — explicitly a maybe-later, not a requirement. Skipped per YAGNI; the multi-match case is rare in practice (Director typically pushes one spec at a time) and Drake can disambiguate in plain English on the next turn.
- **Used the Bash tool for the defensive pull rather than `!`-injection.** Both work. The `!` form runs at prompt-render time and pre-bakes the result; the Bash-tool form runs as part of Claude's first action. I chose the latter because (1) it's robust under the `disableSkillShellExecution: true` setting if Drake ever flips it, (2) it reads more naturally in the prompt body, and (3) the failure path is clearer — if the pull fails, Claude reports the failure and continues, rather than silently substituting `[shell command execution disabled by policy]` into a frontmatter-rendered prompt.
- **`disable-model-invocation: true`.** Set deliberately. `/run` should be a deliberate Drake action — there's no scenario where Claude should decide on its own to auto-execute the next in-flight spec mid-conversation. The user-invocable surface is unchanged.
- **No `allowed-tools` field.** Omitted because the docs are explicit that omitting it doesn't restrict tools — existing permission settings still govern. Adding a narrow allowlist would have added the risk of accidentally blocking a tool the underlying spec needs (Edit, Write, Read are all in play during execution).
- **Did NOT flip the spec's Status to `shipped` and did NOT delete `docs/specs/run-slash-command.md` or this report file.** The spec explicitly says cleanup is Director's. I left both files in place; chat-Director will handle the Status flip and the cleanup commit.
- **Single short paragraph for the CLAUDE.md update.** Could have linked the command from § Builder behavior too, but § Spec and report convention is the right home — that's where spec/report file path conventions live, and `/run` is conceptually a part of that convention. Two pointers would have been redundant.

## Out of scope / deferred

- Argument support (`/run <slug>`) — see Surprises.
- Backfilling front-matter on the two pre-convention specs — see Surprises. Director's call.
- Any test harness for the slash command. Slash commands are prompts; the natural test is Drake invoking it on real specs.
- A `/run-all` or `/run-each` to execute multiple in-flight specs in sequence. Not in the spec; would conflict with the "don't auto-pick" rule anyway.

## Side effects

- Pushed two commits to `origin/main` (`a949097 commands: add /run slash command for executing in-flight specs`, `0ea5571 docs: point at /run as the conventional spec trigger from Code`). This report file will land as a third commit immediately after.
- No external API calls, Slack posts, DB writes, deploys, or shared-state modifications. Only file creation in the repo + git operations.
- The new slash command becomes available on the next Code session start (or earlier if Claude Code's live skill-directory watcher picks it up — the docs say it does, for `.claude/skills/`; the same likely applies to `.claude/commands/` but I didn't verify).
