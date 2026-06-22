# AI Enablement

Internal AI enablement system for a coaching/consulting agency. Agents across customer success, sales, and operations. Shared knowledge base, portable architecture, documented as it's built.

## Quick Start

1. Complete WSL2 setup if on Windows: see `docs/runbooks/setup_wsl.md`
2. Clone this repo inside WSL (not on the Windows filesystem)
3. Copy `.env.example` to `.env.local` and fill in values (ask Drake for keys)
4. `python -m venv .venv && source .venv/bin/activate`
5. `pip install -e ".[dev]"`
6. `npm install` (for the Next.js dashboard at repo root)

## Read Before Contributing

- `CLAUDE.md` — project context, conventions, working norms, Director / Builder system, and current state
- `docs/fulfillment/architecture.md` — how the system fits together
- `docs/archive/legacy-workflow/collaboration.md` — how work is divided
- `docs/archive/historical/known-issues.md` — open bugs and ops gaps with concrete next actions
- `docs/archive/historical/future-ideas.md` — Gregory V2 batches A–E (deferred features)
- `docs/decisions/` — architecture decision records (when populated)

## Project Status

See the **Current Focus** and **Live System State** sections of [`CLAUDE.md`](CLAUDE.md) for canonical status. Active focus: Gregory V2 (CSM-facing dashboard + brain) — meeting tracking is the in-flight work; Batch A CS visibility surfaces (call summary + accountability notification) shipped 2026-05-05; Call Review V1 + Gregory brain V2 shipped 2026-05-07/08.

## Key Principles

1. Our database is the source of truth
2. Agents query the database, not external tools
3. External tools are replaceable adapters
4. Interfaces are thin clients on a shared brain

Full detail in `CLAUDE.md`.

## Structure

High-level shape — `CLAUDE.md` § Folder Structure has the authoritative tree.

```
ai-enablement/
├── CLAUDE.md            # Primary project context (read first)
├── docs/                # Architecture, schema, agents, decisions, runbooks, known issues
├── supabase/            # Database migrations and seed data
├── ingestion/           # Data pipelines from external tools (Fathom, Slack, content)
├── api/                 # Vercel Python serverless functions (8 deployed)
├── agents/              # Agent implementations (gregory, ella, call_reviewer, csm_copilot)
├── app/                 # Next.js 14 dashboard routes (Gregory)
├── components/          # Dashboard UI primitives + client-detail
├── lib/                 # Dashboard utilities (db/, supabase/)
├── orchestration/       # n8n workflow exports
├── shared/              # Shared Python utilities (claude_client, kb_query, slack_post, etc.)
├── evals/               # Golden datasets and eval runner
├── scripts/             # Active tooling + archive/ for one-shots
├── tests/               # pytest suite
└── builder_server.py    # MCP server exposing delegate_to_builder for the Director / Builder system
```

## Contact

Drake — primary developer and architect
Zain — technical operations and n8n workflows

