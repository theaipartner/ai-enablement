---
description: Find the single in-flight Director-pushed spec under docs/specs/ and execute it per Builder behavior. Stops if zero or multiple match.
disable-model-invocation: true
---

You are Builder. Drake invoked `/run` to execute a Director-pushed spec. Do the following in order.

## Step 1 — Defensive pull

Run `timeout 5 git pull origin main 2>&1 | tail -5` from the repo root via the Bash tool. Fail-soft: if it errors or times out, note it in one line and continue. The UserPromptSubmit hook should have already pulled, but `/run` is self-contained — don't trust prior state.

## Step 2 — Find executable specs

An "executable spec" is a file under `docs/specs/<slug>.md` where:

- One of the first ~5 lines matches `**Status:** in-flight` exactly (per CLAUDE.md § Spec and report convention). Actual specs put a blank line between the `# Title` and the `**Slug:**` / `**Status:**` block, so don't assume a fixed line number — scan.
- No matching `docs/reports/<slug>.md` file exists. Slug = filename minus `.md`.

For each `.md` file under `docs/specs/`:

- Read the first ~5 lines.
- If none of them match `**Status:** ...`, flag the file as `(unparseable status — skipping)` and exclude it from the executable set. Don't fail the whole command on one bad file.
- If status is `shipped` or `superseded`, skip silently.
- If status is `in-flight` AND `docs/reports/<slug>.md` exists, skip silently (already reported).
- If status is `in-flight` AND no matching report exists, it's executable.

## Step 3 — Branch on count

**Zero executable specs.** Tell Drake `no in-flight specs without reports — nothing to run` and stop. Mention any unparseable files surfaced in Step 2 so Drake knows they exist.

**Exactly one executable spec.** Read `docs/specs/<slug>.md` in full and execute it per CLAUDE.md § Builder behavior:

1. Walk the spec's acclimatization checklist (if it has one) and confirm in 4-5 bullets before any code work.
2. Execute the spec.
3. Run tests when relevant.
4. Commit + push per § Commits — one logical change per commit, never with failing tests, never with secrets.
5. Write the report to `docs/reports/<slug>.md` with the six standard sections (Files touched / What I did, in plain English / Verification / Surprises and judgment calls / Out of scope / Side effects).
6. Push the report as a final commit.

Hard stops in the underlying spec still fire — `/run` is a trigger, not a bypass. Drake's gates per CLAUDE.md § Drake's gates still apply.

**Multiple executable specs.** List each with `<slug>` + title (parsed from line 1 `# <Title>`). Do NOT auto-pick — spec selection is Drake's call when ambiguous. End the turn after listing. Drake re-invokes with an explicit selection (or types the next `/run` after a different one is picked).

## Edge cases

- Non-spec files in `docs/specs/` (e.g. a stray `README.md` or `.gitkeep`) fail the status-line check and get flagged unparseable — expected, not a bug.
- A stub report from abandoned work blocks re-execution structurally. The check is "report file exists," not "report has real content." Drake must delete the stub to re-trigger.
- After successful execution, do NOT flip the spec's `Status:` to `shipped` or delete spec/report files yourself — that cleanup belongs to Director per CLAUDE.md § Spec and report convention.
