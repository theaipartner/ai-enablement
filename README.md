# AI Enablement

Internal AI system for a coaching/consulting agency. It turns the raw signals of the business — calls,
Slack, CRM, ad/funnel data — into a knowledge base in Supabase, runs agents on top of it, and surfaces the
results in a Next.js dashboard and in Slack. It runs in production on Vercel + Supabase, all on
company-owned infrastructure.

## What it does

Two product sides:

- **Fulfillment (customer success).** Gregory client-health scoring, **Ella** the Slack agent, Fathom call
  ingestion + AI call reviews, accountability/NPS/meeting tracking, and the CSM dashboard.
  → [`docs/fulfillment/`](docs/fulfillment/README.md)
- **Sales.** Funnel-analytics mirrors of Close, Cortana/Meta, Wistia, Calendly, Typeform, Clarity, and
  Airtable, plus the sales dashboard. → [`docs/sales/`](docs/sales/README.md)

## Architecture in one minute

```
external tools  →  ingestion/  →  Supabase (source of truth)  →  agents/  →  dashboard + Slack
  (Fathom,         (one module    (Postgres + pgvector;          (read the   (thin clients —
   Slack, Close,    per source)    everything mirrored here)      KB, call     no business logic)
   Calendly, …)                                                   Claude)
```

Agents never call an external tool for data — ingestion mirrors it into Supabase and agents read from
there. Swapping any external tool is a contained rewrite of its `ingestion/` module. Full detail:
[`docs/fulfillment/architecture.md`](docs/fulfillment/architecture.md).

## Local setup

*New here? [`docs/onboarding/FIRST-DAY.md`](docs/onboarding/FIRST-DAY.md) walks this through step by step with verification checkpoints.*

**Prerequisites:** WSL2 (if on Windows — see [`docs/runbooks/setup_wsl.md`](docs/runbooks/setup_wsl.md)),
Python 3.11+, Node 18+, and the Supabase CLI. All dev happens inside WSL, not the Windows filesystem.

```bash
git clone <repo-url>            # clone inside WSL
cd ai-enablement
cp .env.example .env.local      # then fill in values — see note below
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"         # Python deps (agents, ingestion, tests)
npm install                     # Next.js dashboard deps
```

**Credentials.** `.env.example` is the template. The authoritative inventory of every account, key, and who
owns it is in [`docs/runbooks/credentials-and-accounts.md`](docs/runbooks/credentials-and-accounts.md).
Never commit `.env.local`.

## Running it

```bash
pytest tests/                   # Python test suite (~70 test files)
npm run lint                    # TypeScript / Next.js lint
npm run build                   # type-checks the dashboard
npm run dev                     # dashboard at http://localhost:3000
```

**Deploys** happen by pushing to `main` — Vercel's GitHub integration auto-builds and deploys the Next.js
app + the Python serverless functions in `api/`. Cron schedules live in `vercel.json` (mapped to ET in
[`docs/runbooks/cron_schedule.md`](docs/runbooks/cron_schedule.md)).

## Where to find things

| You want… | Go to |
|---|---|
| to set up the repo on day one | [`docs/onboarding/FIRST-DAY.md`](docs/onboarding/FIRST-DAY.md) |
| how the system fits together | [`docs/fulfillment/architecture.md`](docs/fulfillment/architecture.md) |
| the conventions (UI, call titling, data hygiene) | [`docs/fulfillment/conventions.md`](docs/fulfillment/conventions.md) |
| the sales funnel / dashboard | [`docs/sales/`](docs/sales/README.md) |
| a specific database table | [`docs/schema/`](docs/schema/) (one file per table) |
| a specific agent's behavior | [`docs/agents/`](docs/agents/) (gregory, ella, call_reviewer) |
| how to run/operate a task | [`docs/runbooks/`](docs/runbooks/) (its README explains coverage) |
| why a design call was made | [`docs/decisions/`](docs/decisions/) (ADRs) |
| accounts, keys, and how to rotate them | [`docs/runbooks/credentials-and-accounts.md`](docs/runbooks/credentials-and-accounts.md) |
| conventions + critical rules for editing code | [`CLAUDE.md`](CLAUDE.md) |

**Coverage is intentional, not exhaustive.** The docs are kept accurate but there isn't a doc for every
subsystem, and they're *fairly* — not *fully* — comprehensive. When a doc is absent or in doubt, **the code
is the source of truth**: start from the relevant `api/` handler, `ingestion/<source>/` module, or
`agents/<name>/` package.

## Core principles

1. **Supabase is the source of truth** — every signal is mirrored there.
2. **Agents query the database, not external tools.**
3. **External tools are replaceable adapters** — one module each.
4. **Interfaces are thin clients on a shared brain** — no business logic in the dashboard or Slack layer.

(Expanded, with the full conventions and critical rules, in [`CLAUDE.md`](CLAUDE.md).)

## Repo layout (high level)

`CLAUDE.md` § Folder Structure has the authoritative tree. In brief:

```
docs/        fulfillment, sales, schema, runbooks, decisions, agents, archive
supabase/    numbered SQL migrations (source of truth for the schema)
ingestion/   one module per external source
api/         Vercel Python serverless functions (webhooks + crons; see vercel.json)
app/         Next.js 14 dashboard (clients, calls, teams, ella, tasks, cost-hub, sales-dashboard)
agents/      gregory, ella, call_reviewer, setter_call_reviewer
shared/      claude_client, kb_query, hitl, logging, db, ingestion validators
scripts/     operational tooling (+ archive/ for retired one-shots)
tests/       pytest suite
```
