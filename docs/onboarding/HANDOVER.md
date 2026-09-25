# Handover — context for the AI agent

**Audience: the AI agent (Codex, Claude, etc.) working in this repo.** Read this with `AGENTS.md`.

## The situation

- In **September 2026** the system's builder (Drake) handed it over to **Nabeel**, who now owns and
  operates it. He has access to GitHub, Vercel, Supabase, every third-party account, and the Bitwarden
  vault.
- **Nabeel does not write or review code.** He directs; you do the engineering. He cares about what the
  system does for the business and how to keep it working, not about how the code is built. Expect
  requests like "the sales dashboard is showing the wrong number" or "add X to the Slack digest", not
  "refactor this function".
- He's used AI for personal projects but is new to production systems, git, and deploys. You are the
  engineer in the room, so the carefulness a senior engineer would bring is your job.

## What changed at handover (so old docs make sense)

- `CLAUDE.md` was renamed to **`AGENTS.md`** (Codex reads it). `CLAUDE.md` is now a one-line import of it.
- Added `docs/onboarding/START-HERE-AGENTS.md`, a pre-clone starter Nabeel drops into an empty folder as
  `AGENTS.md` so an agent can set up his Mac before the repo exists there.
- Removed the Claude-Code-only tooling: session hooks, a `/run` command, and `builder_server.py` +
  `.mcp.json`, an MCP server for a "Director / Builder" workflow.
- Dev environment moved from Windows/WSL to **macOS** (`docs/runbooks/setup_mac.md`).
- **Historical references you'll see:** older docs, comments, and commit messages mention "Director",
  "Builder", "Drake's gates", "Gate (d)", and `docs/specs/` + `docs/reports/`. That was Drake's old
  workflow; treat them as history. Where a doc says "Drake sets/adds/runs…", read it as "the operator",
  which is now Nabeel.
- Only clearly dead tooling was removed. **There's likely more stale code**, listed below for you to
  investigate.

## How to work with Nabeel

1. **Plain language.** Explain what a change does and what it affects (dashboard, a Slack channel,
   a sync) instead of how the code works. Skip jargon, or define it in a phrase the first time.
2. **Propose, then act.** For anything beyond a trivial fix: say what you'll change, what it affects, and
   the risk, then get his OK.
3. **You own quality.** He won't read the diff. Run the tests, update docs (AGENTS.md requires it), and
   verify the result yourself before calling something done.
4. **Always get explicit confirmation before anything that touches production:**
   - `git push` to `main`, which **deploys to production immediately** (Vercel auto-deploy)
   - running a script with `--apply`, or any write to the database
   - applying a migration
   - changing Vercel env vars, cron schedules, or webhook registrations
   - anything that sends Slack messages or writes to an external service
5. **After a push, close the loop:** check the Vercel deployment succeeded, verify the change live,
   and tell him in one line how to undo it if needed (`git revert` + push, or Vercel "Instant Rollback").
6. **Teach only what he needs, when he needs it.** One or two sentences of context at the moment a
   concept matters ("pushing = going live, so I'll wait for your OK") is right. Don't lecture.
7. **Never paste secret values into the chat.** Refer to keys by name.

The mental model to give him (briefly, once): **GitHub** holds the code and its history. **Vercel**
runs it (dashboard, webhook receivers, ~23 scheduled jobs) and holds the live keys. **Supabase** is the
database where all the data lives. Data flows: outside tools → `ingestion/` → Supabase → `agents/` →
dashboard + Slack.

## "Prepare my codebase" — setup procedure

**Goal:** Nabeel's Mac is set up so that **you** can do everything on his behalf: pull, commit, and
**push** to GitHub; pull keys and check deploys with the Vercel CLI; and query Supabase. He should only
have to do the things that need him personally (his Mac password, browser logins, Bitwarden).

**Where he's coming from:** normally he starts in an empty folder containing
`docs/onboarding/START-HERE-AGENTS.md` saved as `AGENTS.md`. That file covers steps 1–4 below (tools,
GitHub login, clone) and then sends you here. If you're already inside the repo, check steps 1–3 anyway
and fix anything missing. Reference for commands: `docs/runbooks/setup_mac.md`.

**Rules for the whole procedure:** check before installing and skip what's already there. Steps
that need his password, a browser login, or a GUI dialog: give him the exact command to paste into the
**Terminal** app, wait for him, then verify it yourself. If your sandbox blocks network access, ask him
to approve, or give him the Terminal command.

1. **Tools:** Xcode Command Line Tools (`xcode-select -p`), Homebrew, then `git`, `gh`, Python 3.11+,
   Node 18+, `supabase`, `vercel` (commands in START-HERE-AGENTS.md § Step 1–2).
2. **GitHub:** `gh auth status` shows him logged in, `gh auth setup-git` has been run (so git push
   works without prompts), and `git config --global user.name` / `user.email` are set.
3. **Repo access:** `gh repo view theaipartner/ai-enablement` works.
4. **Clone** (if not already): `gh repo clone theaipartner/ai-enablement`, then work inside it.
5. **Dependencies:** `python3.11 -m venv .venv && .venv/bin/pip install -e ".[dev]"`, then `npm install`.
6. **Vercel + keys → `.env.local`** (local, gitignored, never committed):
   - **He** runs `vercel login` in Terminal (browser flow). You verify with `vercel whoami`.
   - You run `vercel link --yes --team success-projects-9dcde12c --project ai-enablement`, then
     `vercel env pull .env.local --environment=production`.
   - Vercel returns **blank values for "Sensitive" vars.** List the blank **names** (never values) and
     say which matter. The Supabase keys are needed for the dashboard and scripts, and
     `SUPABASE_DB_PASSWORD` for DB scripts and migrations. He fills them from **Bitwarden**, by pasting
     into `.env.local` himself (open it for him in a text editor) or via the Bitwarden CLI (`bw`) if he
     prefers.
   - Fallback if the Vercel CLI won't cooperate: copy the values from Vercel → Project → Settings →
     Environment Variables, or from Bitwarden, using `.env.example` as the template.
   - Add `NEXT_PUBLIC_DISABLE_AUTH=true` for local dashboard use (never set in Vercel).
   - Tell him plainly: **this file points at the live production database.**
7. **Supabase CLI:** **he** runs `supabase login` in Terminal (browser flow). Then you run
   `supabase link --project-ref sjjovsjcfffrftnraocu` (it may ask for the DB password, which is
   `SUPABASE_DB_PASSWORD` from `.env.local`). Only migrations need this, but do it now so it's ready.
8. **Verify and report:**
   - `pytest tests/ -q`
   - `npm run build`
   - a read-only DB check (e.g. count rows in `clients`)
   - `vercel ls` (you can see deployments)
   - `git push --dry-run origin main` (you can push)
   - `npm run dev`, then have him open localhost:3000

   Finish with a short checklist: what works, and what (if anything) he still needs to do.
9. **Wrap up with him in a few sentences:**
   - From now on, open Codex **inside the `ai-enablement` folder**. The setup folder can be deleted.
   - When he asks for a change, you'll explain the plan, make it, test it, and **ask before pushing**,
     because pushing to `main` puts it live within minutes.
   - To ship something, he just tells you ("push it" / "ship it") after you've shown him what changed.
   - If something goes wrong after a deploy, you can roll it back.

## Known open issues (as of handover)

- **Calendar syncs are likely broken.** `drake@theaipartner.io` was deactivated, but
  `api/teams_calendar_sync_cron.py` and `api/client_meetings_sync_cron.py` still hardcode it
  (`_DRAKE_EMAIL`) and both crons are still scheduled. Check `webhook_deliveries` for
  `oauth_token_unavailable`, then decide with Nabeel: re-pin to a new Google account (see
  `docs/runbooks/credentials-and-accounts.md`) or unschedule. Drake may have mitigated this outside
  the repo, so verify before changing anything.
- **Fathom env vars:** the live keys are `FATHOM_API_KEY1` / `FATHOM_WEBHOOK_SECRET1`; the un-suffixed
  ones are stale (credentials runbook has the safe cleanup).
- **Meta token** is a user token tied to Zain; a System User token is the durable fix.
- Open work: `docs/future-plans.md` (ClickFunnels remainder, Vercel bill reduction).

## Stale-code candidates to investigate

Probably a decent amount. **Verify before removing anything:**
- search for references (imports, `vercel.json` functions + crons, `lib/db/` queries)
- check whether it runs in production (Vercel logs, recent `webhook_deliveries` rows, last-written
  timestamps in its tables)
- read its runbook and `git log`

Then present findings to Nabeel in plain terms (what it was, evidence it's dead, what removing it
affects) and remove **one thing per commit**, docs included. Dropping database tables needs a migration
and explicit sign-off; prefer removing code first and tables later.

| Candidate | Why it looks stale |
|---|---|
| **Cortana**: `api/cortana_sync_cron.py`, `ingestion/cortana/`, `scripts/backfill_cortana.py`, `cortana_*` tables, `CORTANA_*` env | Retired 2026-06-30 for the Meta API, "kept for revert". Function still deployed, no cron. |
| **GHL**: `ingestion/ghl/`, `scripts/backfill_ghl.py`, `ghl_*` tables, `GHL_*` env | Sync retired 2026-09-01 (cron and endpoints already removed). |
| **Passive Ella**: `api/passive_ella_cron.py`, `agents/ella/passive_monitor.py`, `ELLA_PASSIVE_MONITORING_ENABLED` | Drainer cron unscheduled 2026-09-02. Confirm whether passive monitoring is wanted at all. |
| **Clarity**: `api/clarity_sync_cron.py` (still runs daily), `ingestion/clarity/`, `clarity_metrics_daily` | Dashboard comment says its tiles were removed 2026-06-16 ("Clarity retired"). Check if anything still reads the table. |
| **Close webhook**: `api/close_events.py` | Credentials runbook says "not yet live". |
| **Wistia**: deprecated functions in `ingestion/wistia/client.py` and `parser.py` | Marked DEPRECATED after the 2026-05-24 cutover. |
| **`ingestion/content/`** | Nothing in `api/`, `agents/`, or `shared/` imports it; may be a manually run CLI for course content. Confirm before touching. |
| **Sales feature flags**: `SALES_FUNNEL_USE_JS`, `SALES_REP_ACTIVITY_USE_JS`, `SALES_ROSTER_USE_JS`, `SALES_SPEED_USE_SCAN`, `SALES_DASHBOARD_MOCK` in `lib/db/` | Look like migration toggles. Check the Vercel values and remove the dead branch. |
| **`scripts/`** (68 files) | `explore_*` discovery probes, one-offs (`*_may.py`, `cleanup_master_sheet_*`, `import_master_sheet.py`), `test_*_locally.py`, `verify-*-preview.ts`, backfills for retired sources. Move dead ones to `scripts/archive/`. |
| **Drake-specific hardcodes** | `_DRAKE_EMAIL` (above), `drake@theaipartner.io` in User-Agent strings, the `*_CC_SLACK_USER_ID` env vars, `#ella-test-drakeonly` references. |
| **Git branches** | `claude/set-slack-env-vars-xWJla` and `cost-hub-total-cancel-remove-and-add` are fully merged; `promethean-shell` is a stale May 2026 design experiment. Ask before deleting. |
| **Docs** | References to the Director/Builder workflow, `docs/specs/` (gone), and the ~2 stale AGENTS.md section refs about Ella in scripts. |
