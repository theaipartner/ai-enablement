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

When he asks to set up or prepare the codebase (or anything is missing), take him to a working setup.
Do the steps yourself where you can. **Pause for him** where a browser login or a password is needed,
telling him exactly what to click. Check before installing; skip what's already there. Reference:
`docs/runbooks/setup_mac.md`.

1. **Check tools:** `brew`, `git`, `gh`, `python3.11` (or any 3.11+), `node` (18+), `vercel`, `supabase`.
   Report what's present and what's missing.
   - Install missing ones with Homebrew (`brew install git gh python@3.11 node supabase/tap/supabase`,
     `npm i -g vercel`). No Homebrew? Ask before installing it. Alternatives: python.org and nodejs.org
     installers, `npx vercel` / `npx supabase` instead of global installs.
   - Your sandbox may block network installs; ask him to approve, or give him the command to run himself.
2. **GitHub auth:** `gh auth status`; if not logged in, he runs `gh auth login` (browser flow).
   Alternative: GitHub Desktop. Confirm he can reach `theaipartner/ai-enablement`.
3. **Repo:** clone it if needed (`gh repo clone theaipartner/ai-enablement`), else `git pull` on `main`.
4. **Dependencies:** `python3.11 -m venv .venv && .venv/bin/pip install -e ".[dev]"`, then `npm install`.
5. **Keys → `.env.local`** (local, gitignored, never committed):
   - He runs `vercel login` (browser). Then `vercel link` (team `success-projects-9dcde12c`, project
     `ai-enablement`) and `vercel env pull .env.local --environment=production`.
   - Vercel returns **blank values for "Sensitive" vars.** List the blank **names** (never values) and
     say which matter. At minimum the Supabase keys are needed for the dashboard and scripts,
     and `SUPABASE_DB_PASSWORD` for DB scripts and migrations. He fills them from Bitwarden. Options: he
     pastes into `.env.local` himself, or uses the Bitwarden CLI (`bw`) if he prefers.
   - Fallback if the Vercel CLI won't cooperate: copy values from Vercel → Project → Settings →
     Environment Variables, or Bitwarden, using `.env.example` as the template.
   - Add `NEXT_PUBLIC_DISABLE_AUTH=true` for local dashboard use (never set in Vercel).
   - Tell him plainly: **this file points at the live production database.**
6. **Supabase CLI** (only needed for migrations; skip unless asked): `supabase login`, then
   `supabase link --project-ref sjjovsjcfffrftnraocu`.
7. **Verify and report:** `pytest tests/ -q`, `npm run build`, a read-only DB check (e.g. count rows in
   `clients`), and `npm run dev` → dashboard at localhost:3000. Finish with a short checklist of what
   works, what's pending, and what he needs to do (if anything).

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
