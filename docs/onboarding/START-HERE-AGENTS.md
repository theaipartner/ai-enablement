# AGENTS.md — ai-enablement setup starter

> **For Nabeel:** put this file in a new empty folder (e.g. `~/Projects/ai-enablement-setup/`),
> rename it to exactly `AGENTS.md`, open Codex in that folder, and say **"prepare my codebase"**.
> Codex takes it from there.

---

**For the AI agent (Codex):** you are setting up a Mac so that its owner, **Nabeel**, can run and
change the `ai-enablement` codebase **through you**. This is a production system (Next.js dashboard +
Python on Vercel, Supabase database) that Nabeel took over from its builder, Drake, in September 2026.
**Nabeel does not write code.** He directs and you do the engineering. By the end of setup, **you**
must be able to pull, commit, and push the repo, and to use the Vercel and Supabase CLIs on his behalf.

When he says **"prepare my codebase"** (or similar), follow the steps below in order. This file gets
you as far as cloning the repo. After that, the repo's own `AGENTS.md` and
`docs/onboarding/HANDOVER.md` take over.

## How to guide him

- Plain language, one step at a time. Say what each step is for in one sentence ("git is how code
  is downloaded and saved; GitHub is where it lives").
- **Check before installing.** Skip anything already there.
- **Some steps need him, not you:** anything that asks for his Mac password (`sudo`), a browser login,
  or a pop-up dialog. For those, give him the exact command to paste into the **Terminal** app (or tell him
  what to click), wait for him to say it's done, then verify it yourself.
- **Your sandbox may block network access** (downloads, logins, git). If a command is blocked, ask him to
  approve it. If it still can't run, give him the command to run in Terminal.
- Never paste passwords, tokens, or keys into the chat.

## Step 1 — Command-line basics (Xcode Command Line Tools + Homebrew)

1. Check `xcode-select -p`. If it fails, **he** runs `xcode-select --install` and clicks through the
   dialog (this also installs `git`). Wait for it to finish (can take several minutes).
2. Check `brew --version`. If missing, **he** pastes the official installer into Terminal (it asks for his
   Mac password):
   `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`
   Then run the two `eval "$(/opt/homebrew/bin/brew shellenv)"` lines the installer prints at the end
   (Apple Silicon) so `brew` is on the PATH. Verify `brew --version`.

## Step 2 — Tools

Install whatever is missing (verify each with `--version` afterwards):

```bash
brew install git gh python@3.11 node supabase/tap/supabase
npm install -g vercel
```

- **git**: saves and syncs code versions. **gh**: GitHub's CLI, which handles login. **python@3.11** and
  **node**: the two languages the codebase uses. **vercel**: the hosting platform's CLI.
  **supabase**: the database's CLI.
- If `npm install -g` fails on permissions, use `npx vercel` everywhere instead of `vercel`.

## Step 3 — GitHub login (so you can pull and push)

1. Check `gh auth status`. If not logged in, **he** runs in Terminal:
   `gh auth login --hostname github.com --git-protocol https --web`
   and completes the browser flow with his GitHub account.
2. Then run `gh auth setup-git` (makes `git push` use that login, with no password prompts).
3. Set his identity for commits (ask for the name and email he wants on commits; a GitHub
   `...@users.noreply.github.com` address is fine):
   `git config --global user.name "…"` and `git config --global user.email "…"`
4. Confirm access: `gh repo view theaipartner/ai-enablement`. If it's not found, run `gh repo list` and
   `gh repo list theaipartner` to locate it (it may have moved to his account). If he truly has no access,
   stop and tell him to ask Drake.

## Step 4 — Clone the repo

Clone it **inside this folder**:

```bash
gh repo clone theaipartner/ai-enablement
```

(Use the actual owner/name found in Step 3 if it differs.)

## Step 5 — Hand off to the repo

1. Read `ai-enablement/AGENTS.md` and `ai-enablement/docs/onboarding/HANDOVER.md` in full.
2. Continue with HANDOVER.md § "Prepare my codebase" **from the step after cloning** (dependencies,
   Vercel keys, Supabase, verification), running commands inside `ai-enablement/`.
3. When setup is finished, tell him: **from now on, open Codex in the `ai-enablement` folder** (not
   this setup folder), because that's where Codex picks up the repo's instructions. This setup folder
   can be deleted afterwards.
