# CLAUDE.md

Primary context for anyone (human or AI) working on this repo. Read it before making changes.

## Project Purpose

Internal AI-enablement system for a coaching/consulting agency — it replaces and augments human work
across customer success and sales. Two product sides:

- **Fulfillment (CSM side)** — Gregory client-health scoring, Ella the Slack agent, Fathom call
  ingestion + reviews, accountability/NPS/meetings, the CSM dashboard. See `docs/fulfillment/`.
- **Sales side** — the funnel-analytics mirrors (Close, Cortana/Meta, Wistia, Calendly, Typeform,
  Clarity, Airtable) and the sales dashboard. See `docs/sales/`.

It runs in production on Vercel + Supabase. **Status:** the system is mid-handoff — ownership is
transferring from the original solo developer to the company. The transfer audit + plan live in
`docs/handoff/` (start at `00-overview.md`).

## Core Principles (Non-Negotiable)

These four protect the system from lock-in and rebuilds. Apply them to every decision.

1. **Our database is the source of truth.** Every piece of data we touch is mirrored into Supabase. External tools are secondary.
2. **Agents query our database, not external tools.** An agent never calls Fathom, Slack, or the CRM directly for data. Ingestion pipelines populate Supabase; agents read from Supabase.
3. **External tools are replaceable adapters.** Each integration lives in its own module. Swapping one is a contained rewrite, not a system-wide migration.
4. **Interfaces are thin clients on a shared brain.** Agent logic lives in one place. Slack, the dashboard, email — all just front doors. No business logic in interface code.

## Stack

| Layer | Tool | Notes |
|-------|------|-------|
| Database | Supabase (Postgres + pgvector) | Source of truth. All data mirrored here. |
| Backend / Agents | Python 3.11+ | Primary language. |
| Frontend | Next.js 14 + TypeScript | The Gregory dashboard. |
| Orchestration | Make.com + n8n | Make.com handles Airtable ↔ Gregory automation; n8n holds a workflow library. |
| LLM | Anthropic Claude API | Sonnet default, Opus for hard reasoning, Haiku for cheap/simple tasks. |
| Embeddings | OpenAI `text-embedding-3-small` | 1536 dims. Used by `shared/kb_query.py` and all ingestion that writes `document_chunks`. |
| Hosting | Vercel | Next.js frontend + Python serverless functions (`api/`). Crons in `vercel.json`. |
| Voice | ElevenLabs | Course audio. |
| Dev environment | WSL2 Ubuntu on Windows | All dev happens inside WSL. |
| Secrets | `.env.local` (local) + Vercel env vars (prod) | `.env.example` is the template; the full account/credential inventory for the handoff is in `docs/handoff/03-ownership-transfer.md`. `SUPABASE_DB_PASSWORD` in `.env.local` lets ops scripts connect via psycopg2 (migrations, seeds, diagnostics). |

## Language Policy

- **Python first** for agents, ingestion, evals, scripts, data work.
- **TypeScript** for the Next.js frontend and browser code.
- **Other languages only when no reasonable Python/TS option exists** — ask first.

## Folder Structure

```
ai-enablement/
├── CLAUDE.md / README.md / .env.example
├── vercel.json                 # serverless functions + cron schedules (the cron source of truth)
├── docs/
│   ├── fulfillment/            # CSM-side: architecture, conventions, KB-metadata contract
│   ├── sales/                  # sales-side: data model, ingestion, dashboard
│   ├── schema/                 # one file per database table
│   ├── agents/                 # per-agent specs: gregory.md, ella.md, call_reviewer.md
│   ├── runbooks/               # how to run recurring tasks (README explains coverage)
│   ├── decisions/              # ADRs
│   ├── handoff/                # ownership-transfer audit + plan (active)
│   └── archive/                # historical / superseded docs
├── supabase/migrations/        # numbered SQL migrations — source of truth for the schema
├── ingestion/                  # one module per external source
│   ├── fathom/ slack/ content/                              # fulfillment-side
│   └── close/ cortana/ wistia/ calendly/ typeform/ clarity/ airtable/ setter_calls/   # sales-side
├── api/                        # Vercel Python serverless functions (webhooks + crons; see vercel.json)
├── app/                        # Next.js 14 dashboard (clients, calls, teams, ella, tasks, cost-hub, sales-dashboard)
├── components/ · lib/          # dashboard UI primitives + utilities (lib/db/ holds the query layers)
├── agents/                     # agent code: gregory, ella, call_reviewer, setter_call_reviewer
├── shared/                     # shared Python utils: claude_client, kb_query, hitl, logging, db, ingestion validators
├── scripts/                    # operational tooling (+ scripts/archive/ for retired one-shots)
└── tests/                      # pytest suite
```

## Conventions

### Code
- **Python:** PEP 8, type hints everywhere, format with `black`, lint with `ruff`.
- **TypeScript:** strict mode, format with Prettier, lint with ESLint.
- No one-letter variables except tight loops. Functions do one thing (split past ~50 lines). Isolate side effects (DB writes, API calls) in thin layers.

### Naming
- Python: `snake_case.py` files, `PascalCase` classes, `snake_case` functions/vars.
- TypeScript: `kebab-case.ts` or `PascalCase.tsx` for components.
- DB tables `snake_case` plural; columns `snake_case`. Env vars `SCREAMING_SNAKE_CASE`.

### Documentation (Non-Negotiable)
Every substantive change updates docs in the same commit:
- **New table** → a `docs/schema/` file (purpose, columns, relationships, what populates/reads it, example queries).
- **New agent** → a `docs/agents/` file (purpose, inputs/outputs, data deps, escalation rules, evals).
- **New ingestion pipeline** → a `docs/runbooks/` runbook (what it does, schedule, failure modes, debugging).
- **Significant architectural decision** → an ADR in `docs/decisions/`.

Docs ship with the code, not "later." That said, coverage is intentional-not-exhaustive: not every
subsystem has a doc, and **the code is the ultimate source of truth** when a doc is absent or in doubt.

### Commits
- One logical change per commit (if the message wants " and "/" also ", split it). Present-tense, imperative.
- **Never commit with failing tests** (`pytest tests/`). **Never commit secrets** — `git diff` before committing.
- Commit at each meaningful unit of work; don't commit half-finished work.

### Client Identity Resolution
The Fathom classifier resolves call participants to `clients` by email first, then display name, consulting
two `clients.metadata` jsonb arrays: `alternate_emails` and `alternate_names` (both case-insensitive,
whitespace-stripped). When you merge an auto-created duplicate into a canonical row, the auto row's email +
full_name must be written into these arrays so future ingestion resolves cleanly. The merge surface is the
dashboard's "Merge into…" flow (migration `0015` syncs the alternates atomically). Any new humans→clients
resolution path must consult these fields before creating a row.

### Error Handling
External API calls wrap retry + timeout + structured logging. DB writes are transactional when multiple
tables are affected. Agent failures escalate to HITL, never fail silently. Never swallow an exception
without logging it.

## Critical Rules

**Never:**
- Commit `.env`, `.env.local`, or any file with credentials.
- Install a new major dependency, or add a new external service/library/language, without asking first.
- Write code without updating the corresponding docs.
- Couple agent logic to a specific external tool. Agents query the KB — if you're writing `fathom_client.get_call(...)` inside an agent, move the fetch to the ingestion layer and persist to Supabase first.
- Bypass HITL. An uncertain agent escalates; it does not guess confidently.
- Use `print()` for anything that should persist — use `shared/logging.py`.
- Write to `documents` / `document_chunks` without running `shared.ingestion.validate` first.

**Always:**
- Ingest through the ingestion layer, not from agents.
- Run the metadata validator before inserting into `documents` / `document_chunks`.
- Read the relevant `docs/` file (and the actual code/schema) before editing a component.

## Operational Discipline

Hard-won patterns. They hold regardless of who's operating the repo:

- **Discovery before build.** For any external integration, verify with one real authenticated call and inspect the actual response shape before writing the adapter. OpenAPI docs lie; deployed reality is truth.
- **Read the live schema before changing it.** Check the current tables/columns (migrations, or query the DB) before drafting a migration. Don't propose a table that already exists or draft against a remembered column.
- **Migrations: dual-verify against cloud.** After applying, confirm both schema reality (`information_schema` / `to_regclass`) AND ledger registration (`supabase_migrations.schema_migrations`). A single-query check can pass against the wrong database.
- **Real-API `--smoke` before `--apply` on backfills.** Mocked tests pass while real-API integration breaks on shape/column drift. Exercise one record end-to-end against the real DB first.
- **Structural fix beats prompt iteration.** When an LLM with an enumerated output keeps picking the wrong value despite emphatic prompt copy, stop iterating on the prompt — remove the wrong option from the schema, or route that input to a different code path before the model sees it.
- **Deploys go out via `git push` to `main`** (Vercel GitHub-integration auto-deploy). If a deploy ships a bad bundle (cache contamination), recover with a dashboard "Redeploy" with **Use existing Build Cache unchecked**; subsequent pushes restore the clean cache.
- **Secrets: read from `.env.local` when a task needs them; never write them to committed code, logs, or persistent files.** For a secret that must survive across stateless tool calls, use a mode-600 `/tmp` file shredded after use — not `argv`.

## A note on history

This repo was built under a now-retired "Director/Builder" workflow (a chat-Claude wrote specs to
`docs/specs/`, a Claude Code session executed them and wrote reports to `docs/reports/`). **That workflow
is no longer used** — there are no specs/reports, and you don't need to follow it. The full original
CLAUDE.md describing it is preserved at `docs/archive/historical/CLAUDE-full-2026-06-22.md` for context.
A new contributor should start at `README.md` → `docs/fulfillment/architecture.md` (or `docs/sales/`).
