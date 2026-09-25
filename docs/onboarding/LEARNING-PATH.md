# Learning Path — for the AI tutor

**Audience of this file: the AI agent (Codex, Claude, etc.).** When the user asks to learn the repo,
get onboarded, or says "teach me" / "continue the learning path", you are their tutor and this is the
curriculum. It's written for Nabeel, who took over this system in September 2026. He has built personal
projects but has not worked on deployed production code or used git in a team setting.

## How to teach

- **One module at a time, one step at a time.** Explain a concept in plain language, show it in *this*
  repo, have him do it, then check understanding. Don't dump a whole module in one message.
- **He types the commands.** Give the command, explain what it will do *before* he runs it, then
  explain the output together. Doing it himself is how it sticks. Only run things yourself when he asks.
- **Use real examples from this repo** — real commits, real files, real tables — not generic tutorials.
- **Check understanding** with the questions at the end of each module. If an answer is shaky,
  re-explain differently; don't just repeat.
- **Keep notes.** Keep a gitignored `.learning-progress.md` at the repo root: modules done, where he
  is, things he found confusing, questions to revisit. Read it at the start of every session and pick up
  from there. Offer a 2-minute recap of the last session first.
- **Pace:** a module is roughly one sitting (30–60 min). Suggest stopping points.
- **Encourage "how would I find this out?"** over memorizing. The goal is that he can navigate the code
  and docs himself, with you as a helper, not that he knows every file.

## Safety rules during lessons (non-negotiable)

This is **live production**: real clients, real Slack channels, real data.

1. **Never push to `main` during a lesson.** Exercises happen on a branch named `learning/<topic>`.
   Pushing to `main` deploys to production.
2. **SQL is read-only** (`SELECT` only) unless he's deliberately doing a real task and understands it.
3. **No script runs with `--apply`** during lessons. `--smoke` / dry-run only, and explain first.
4. **Never print secret values** from `.env.local` into the chat. Refer to variables by name.
5. **Don't change Vercel env vars, cron schedules, or webhooks** as an exercise.
6. If he wants to do something risky for real, stop the lesson, say plainly what could go wrong, and
   confirm he wants to go ahead.

---

## Module 0 — Setup

**Goal:** the repo runs on his Mac.

- Walk him through [`docs/runbooks/setup_mac.md`](../runbooks/setup_mac.md), then
  [`FIRST-DAY.md`](FIRST-DAY.md). Explain each tool as it's installed: Homebrew (installs software),
  Python venv (keeps this project's Python packages separate), npm (the dashboard's JavaScript
  packages), the Vercel and Supabase command-line tools (CLIs).
- Explain what `.env.local` is: the file holding the passwords/API keys the code needs, pulled from
  Vercel, never committed. Bitwarden fills the blanks.

**Done when:** `pytest tests/ -q` runs and `npm run dev` shows the dashboard at localhost:3000.

**Check:** Why is `.env.local` not in git? What happens if a key in it is blank?

## Module 1 — The big picture: three platforms

**Goal:** he can explain where the code lives, where it runs, and where the data lives.

- **GitHub** = the code and its full history. **Vercel** = runs the code (the dashboard, webhook
  receivers, scheduled jobs). **Supabase** = the database, the single source of truth.
- Draw the flow from the [README](../../README.md#architecture-in-one-minute):
  external tools → `ingestion/` → Supabase → `agents/` → dashboard + Slack.
- Explain the four Core Principles in [`AGENTS.md`](../../AGENTS.md), especially *agents read our
  database, never the external tools*, and why that makes tools swappable.
- Have him log in to each of the three dashboards and find this project in each.

**Check:** A Fathom call ends. Where does the data go first, and who reads it after?

## Module 2 — Git fundamentals

**Goal:** he understands commits, branches, pull, and push, and knows why `main` is special.

Teach these one at a time, each with a command he runs:

1. **Repository and history.** `git log --oneline -20` reads the recent history. Pick a real
   commit, run `git show <hash>`, and read it together: what changed, and why the message says so.
2. **Working tree and status.** `git status`. Edit a file, see it show up, and undo it with
   `git restore <file>`.
3. **Commits.** A saved snapshot with a message. Point out the repo's convention: one logical change
   per commit, imperative messages, `feat:` / `fix:` / `docs:` prefixes (show examples in the log).
4. **Branches.** `git switch -c learning/git-basics`. Create a scratch file (e.g. `scratch.txt`), commit it,
   and see it in `git log`. Switch back to `main` and see it isn't there.
5. **Remote: pull and push.** `origin` is GitHub. `git pull` brings others' changes down. `git push`
   sends yours up. **Pushing to `main` = deploying to production** (Vercel watches `main`).
6. **Undoing things.** `git restore` (uncommitted edits), `git revert <hash>` (safely undo a pushed
   commit with a new commit), and why rewriting pushed history is dangerous.
7. **Cleanup.** Delete the practice branch (`git switch main && git branch -D learning/git-basics`).

**Check:** What's the difference between committing and pushing? If a bad change reached `main`,
what's the safe way to undo it? Why do we pull before starting work?

## Module 3 — Secrets and safety

**Goal:** he knows what can hurt production and how to avoid it.

- Walk through [`docs/runbooks/credentials-and-accounts.md`](../runbooks/credentials-and-accounts.md):
  what each account is for, where keys are minted and rotated, and that Vercel holds the authoritative set.
- **His `.env.local` points at the production database.** Any script that writes, writes for real.
  Explain the `--smoke` → `--apply` pattern (AGENTS.md § Operational Discipline).
- What to do if a secret is ever committed: rotate the key immediately (deleting the commit is not
  enough, because git history and GitHub keep it).

**Check:** You want to try a backfill script. What do you run first, and why?

## Module 4 — Supabase: the data

**Goal:** he can find and read any table and knows how the schema changes.

- In the Supabase dashboard, open the Table Editor and SQL Editor. Run read-only queries on
  `clients`, `calls`, `team_members`, `slack_channels`. Explain rows, columns, and foreign keys
  using real examples.
- `docs/schema/` has one doc per table. Have him pick a table, read its doc, and query it.
- **`webhook_deliveries`** is the audit log that webhooks and crons write to. It's the first place to
  look when something broke. Query the most recent rows together.
- **Migrations** (`supabase/migrations/`): numbered SQL files that are the history of the schema. Open
  a small recent one and read it. Explain why an applied migration is never edited, only followed by a
  new one. The apply process is [`apply_migrations.md`](../runbooks/apply_migrations.md) (read it, don't
  run it).

**Check:** How would you find out which table holds NPS scores and what populates it?

## Module 5 — Vercel: where it runs

**Goal:** he can see deploys, read logs, and understands crons and webhooks.

- In the Vercel dashboard: the Deployments list (each corresponds to a push to `main`), and the
  Logs of a function.
- Open [`vercel.json`](../../vercel.json): `functions` (each Python file in `api/` becomes an endpoint)
  and `crons` (scheduled jobs). Translate a few schedules together using
  [`cron_schedule.md`](../runbooks/cron_schedule.md).
- **Webhooks vs crons:** webhooks = an outside service calls *us* when something happens
  (`api/*_events.py`). Crons = *we* wake up on a schedule and go fetch or process (`api/*_cron.py`).
- **Rolling back a bad deploy:** the Redeploy / promote-previous flow (AGENTS.md § Operational
  Discipline has the build-cache detail).
- **Branch pushes** usually create a Preview deployment, not production. Check in the dashboard whether
  previews are enabled and which env vars (and therefore which database) they use before relying on one.

**Check:** A daily Slack digest didn't post this morning. Where do you look, in what order?

## Module 6 — Trace one flow end to end: a Fathom call

**Goal:** he can follow data through the system by reading code, which is the core skill for everything else.

Open each file with him and read only the key parts:

1. `api/fathom_events.py`: Fathom calls this webhook. It verifies the signature (proving it's really
   Fathom), logs to `webhook_deliveries`, and hands off to ingestion.
2. `ingestion/fathom/`: `webhook_adapter.py` → `pipeline.py` (`ingest_call`). The parser reads the
   payload, the classifier decides what kind of call it is and which client it's for, and the chunker
   splits the transcript. Writes to `calls`, `call_participants`, `call_action_items`, `documents`,
   `document_chunks`.
3. `agents/gregory/cs_call_summary_post.py`: after ingestion, posts the call summary to Slack.
4. The dashboard's calls pages under `app/(authenticated)/` read those same tables via `lib/db/`.

Then have him find a real recent call in the `calls` table and its Slack post.
Reference: [`docs/fulfillment/architecture.md`](../fulfillment/architecture.md).

**Check:** If a call shows up in Fathom but not the dashboard, name three places it could have failed.

## Module 7 — The agents and the dashboard

**Goal:** he knows what each agent does and how the dashboard is put together.

- Agents (`agents/`), with specs in `docs/agents/`: Gregory (client health), Ella (Slack assistant),
  call reviewers, sales bot, dc_intel. For each: what triggers it, what it reads, what it outputs.
  `shared/claude_client.py` is the single place LLM calls go through.
- Dashboard (`app/`, `components/`, `lib/db/`): Next.js pages, UI components, and query functions.
  Pick one page, run it locally, and trace one number on screen back to its query.
- Sales side overview: [`docs/sales/README.md`](../sales/README.md).

## Module 8 — Tests and making a change safely

**Goal:** he can make, test, and ship a small change the way the repo expects.

- `tests/` mirrors the code layout. Run one test file, read one test, and explain what it proves. Break
  something on purpose on a branch, watch the test fail, and restore it.
- **The shipping workflow:** `git pull` → branch → change → update docs (AGENTS.md requires docs to
  ship with code) → `pytest tests/ -q` + `npm run lint`/`build` if the dashboard was touched →
  commit → decide how it reaches `main` (a merge or PR he reviews; ask the user which he prefers) →
  watch the Vercel deploy → verify in production.
- Exercise: a tiny real change he chooses (a doc fix is ideal) taken all the way through, **with his
  explicit go-ahead at the push step.**

## Module 9 — Operating the system

**Goal:** he can respond when something breaks.

- [`docs/runbooks/README.md`](../runbooks/README.md) is the list of how-tos. Read the runbook for one
  cron and one webhook.
- Debug loop: symptom → `webhook_deliveries` / Vercel logs → the handler in `api/` → the module it
  calls → fix → test → ship.
- **First real task (good capstone):** the calendar syncs. `drake@theaipartner.io` was deactivated but
  `api/teams_calendar_sync_cron.py` and `api/client_meetings_sync_cron.py` still look it up (see
  `credentials-and-accounts.md` § calendar-sync Google account). Investigate whether they're failing,
  then decide: re-pin to a new account or unschedule.
- Open work and plans: `docs/future-plans.md`.

## How to keep learning after the path

- Start from a question ("how does X work?"), find the entry point (`api/` handler, `ingestion/<source>/`,
  `agents/<name>/`), and read outward. Ask the AI to trace it with you.
- Docs are good but not exhaustive. **The code is the source of truth.**
- Before changing anything, read its doc and the actual code/schema (AGENTS.md § Critical Rules).
