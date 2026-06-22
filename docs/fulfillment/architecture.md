# Architecture

How the pieces of this system fit together. Read this before working on any component.

## One-Sentence Summary

External tools feed data into a central Supabase knowledge base; agents read from the knowledge base, reason with Claude, and either act directly or escalate to a human through a shared HITL layer; interfaces (Slack, web dashboards) are thin clients that trigger agents and surface their output.

## The Layers

```
┌─────────────────────────────────────────────────────────────┐
│  INTERFACES  (Slack, Next.js dashboards, email, future web) │
│                                                             │
│  Thin clients. No business logic.                           │
│  Trigger agents via API. Render agent output.               │
└──────────────────────────┬──────────────────────────────────┘
                           │ API calls / webhooks
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  AGENTS  (slack_bot, csm_copilot, etc.)                     │
│                                                             │
│  The brain. Reason, synthesize, generate.                   │
│  Query the KB, call Claude, produce output or escalate.     │
└──────────┬──────────────────────────────────┬───────────────┘
           │ read                             │ escalate
           ▼                                  ▼
┌────────────────────────┐       ┌────────────────────────────┐
│  KNOWLEDGE BASE        │       │  HITL ESCALATION           │
│  (Supabase)            │       │                            │
│                        │       │  Slack notification +      │
│  Source of truth.      │       │  approval UI.              │
│  Postgres + pgvector.  │       │  Logs decision back.       │
└──────────▲─────────────┘       └────────────────────────────┘
           │ write
           │
┌──────────┴──────────────────────────────────────────────────┐
│  INGESTION PIPELINES                                        │
│                                                             │
│  Fathom → transcripts, summaries, action items              │
│  Slack  → messages, threads                                 │
│  Drive  → docs, SOPs, course content                        │
│  CRM    → contacts, pipeline, activity                      │
│                                                             │
│  Run on schedule via n8n or triggered by webhooks.          │
└──────────────────────────┬──────────────────────────────────┘
                           │ pulls from
                           ▼
┌─────────────────────────────────────────────────────────────┐
│  EXTERNAL TOOLS                                             │
│  Fathom, Slack, Google Drive, CRM (GHL or similar)          │
│                                                             │
│  Accessed only by ingestion layer. Replaceable.             │
└─────────────────────────────────────────────────────────────┘
```

## Current Implementation Status

The diagram above is the architectural shape. What's actually shipped as of 2026-04-22:

- **Ingestion — three pipelines live, all applied against local Supabase:**
  - `ingestion/fathom/` — 389-call backlog ingested (Feb–Apr 2026). Chunks + embeddings for client calls; action items and summaries deferred (Fathom `.txt` exports don't carry them; see `docs/fulfillment/future-ideas.md`).
  - `ingestion/slack/` — 90-day history backfill for 8 pilot channels via Slack Web API. The one-shot post-seed `team_members.email → slack_user_id` resolver lives at `scripts/archive/backfill_team_slack_ids.py` (already run; archived).
  - `ingestion/content/` — filesystem-sourced HTML lessons (297 files). Drive API integration is deferred; today the pipeline reads `data/course_content/` directly.
  - `ingestion/crm/` — not started; data flows through the clients importer (`scripts/seed_clients.py`) instead for V1.
- **Knowledge base — Supabase local stack populated.** See `docs/schema/schema-v1.md` for the per-table row counts.
- **Shared utilities — all shipped:** `shared/db.py`, `shared/claude_client.py`, `shared/kb_query.py`, `shared/hitl.py`, `shared/logging.py`, `shared/ingestion/validate.py`.
- **Agents — three live:**
  - `agents/ella/` — Slack Bot V1, live in `#ella-test-drakeonly`, awaiting pilot rollout (M1.4.5).
  - Fathom ingestion path (`ingestion/fathom/` + `api/fathom_events.py` webhook + `api/fathom_backfill.py` daily cron) — not a "thinking" agent but functions as the calls-data agent end-to-end.
  - `agents/gregory/` — Gregory brain V1.1 (M3.4). Computes per-client health scores + tier + concerns and writes to `client_health_scores`. Weekly cron at `api/gregory_brain_cron.py`; manual trigger at `scripts/run_gregory_brain.py`. Concerns generation gated behind `GREGORY_CONCERNS_ENABLED` env var.
  - CSM Co-Pilot is the next planned agent; not yet started.
- **Interfaces — Gregory dashboard live; Slack live for Ella.** Next.js 14 dashboard at repo root, deployed to `ai-enablement-sigma.vercel.app` — Clients list/detail, Calls list/detail with edit-mode classification, "Merge into…" flow for auto-created client review. Slack app live for Ella.

## The Four Layers in Detail

### 1. External Tools
Fathom (call recordings + transcripts), Slack (messages), Google Drive (docs), CRM (contacts + pipeline). These are where data originates but not where we keep it. Any external tool is replaceable without touching agents.

### 2. Ingestion Pipelines
One module per external tool, in `ingestion/`. Each pipeline knows how to pull data from one external source and write it to the knowledge base in our canonical schema. Scheduled runs via n8n (or webhook-triggered for real-time sources like Slack). If an external tool changes, only its ingestion module changes.

### 3. Knowledge Base (Supabase)
Central Postgres database with pgvector for embeddings. Every piece of data the system uses lives here. Agents read from it. Dashboards render from it. Evals run against it. If a data source isn't here yet, the fix is to build or extend an ingestion pipeline — not to reach out to the external tool from an agent.

### 4. Agents
Python modules in `agents/`. Each agent has a clearly defined purpose, reads from the KB via `shared/kb_query.py`, calls Claude via `shared/claude_client.py`, and either produces output (a response, a score, a summary, an alert) or escalates via `shared/hitl.py`.

### 5. HITL (Human-In-The-Loop)
Shared escalation layer. When an agent is uncertain or an action needs human approval, the agent calls `hitl.escalate(...)` with context. This sends a Slack notification with an approval UI and logs the human's decision back to the KB. Every agent uses the same pattern.

### 6. Interfaces
Slack workspace app, Next.js dashboards, email notifications. These are *thin* — they trigger agents and render results. No reasoning or business logic lives here. Swapping Slack for Discord or adding a web portal is a matter of adding a new interface module; the agents don't change.

## Data Flow Example: Slack Bot Answering a Client Question

1. **Client** posts a question in their Slack channel
2. **Slack interface** (thin client) receives the event, extracts message + context, calls the Slack Bot agent via API
3. **Slack Bot agent**:
   - Queries the KB (`shared/kb_query.py`) for relevant course content, past CSM conversations, FAQs
   - Calls Claude (`shared/claude_client.py`) with the question + retrieved context
   - Evaluates confidence in the response
4. **If confident:** agent returns response; Slack interface posts it in the thread
5. **If uncertain:** agent calls `hitl.escalate(...)`; CSM gets a Slack notification; CSM's approval/edit is captured and sent as the response
6. **Every step logged** to `agent_runs` table for analytics and eval

## Data Flow Example: CSM Co-Pilot Computing Health Scores

1. **Scheduler** (n8n) triggers the CSM Co-Pilot nightly
2. **CSM Co-Pilot agent**:
   - Queries the KB for each active client: recent calls, accountability submissions, NPS, message volume
   - For each client, calls Claude with the data + health-score rubric
   - Writes computed scores + factors to `client_health_scores` table
   - Checks thresholds; creates alerts in `alerts` table for flagged clients
3. **Dashboard** (Next.js frontend) reads `client_health_scores` and renders per-CSM and agency-wide views
4. **Alerts interface** posts high-severity alerts to the relevant CSM's Slack

## Portability Guarantees

The architecture above guarantees:

- **CRM swap:** rewrite `ingestion/crm/`, change nothing else
- **Call tool swap:** rewrite `ingestion/fathom/` (or add `ingestion/gong/`), change nothing else
- **Interface swap:** add a new interface in `frontend/` or equivalent; agents don't change
- **Host swap:** the code is portable; only deployment config changes
- **Database swap:** this is the hardest one, but because all data lives in standard Postgres, migration to another Postgres host is straightforward. Moving off Postgres entirely would be a real project — but that's by design. The database is the one thing we're committing to.

## What Lives Where

| Thing | Location |
|-------|----------|
| Database schema | `supabase/migrations/` |
| Schema docs | `docs/schema/` |
| Agent code | `agents/<agent_name>/` |
| Agent docs | `docs/agents/<agent_name>.md` |
| Ingestion code | `ingestion/<source>/` |
| Ingestion runbooks | `docs/runbooks/ingest_<source>.md` |
| Ingestion metadata conventions | `docs/fulfillment/metadata-conventions.md` |
| Data hygiene rules | `docs/fulfillment/data-hygiene.md` |
| Shared utilities | `shared/` |
| n8n workflows | `orchestration/` (JSON exports) |
| Frontend | `frontend/` |
| Eval datasets | `evals/<agent_name>/` |
| ADRs | `docs/decisions/` |
| Deferred ideas (not yet decisions) | `docs/fulfillment/future-ideas.md` |

## Environments

- **Local:** Full stack runs on developer's WSL2. Supabase local via `supabase start`. n8n local via Docker. Next.js via `npm run dev`.
- **Production:** Supabase cloud project, Vercel for frontend + functions, n8n self-hosted or cloud TBD, Anthropic API for Claude.

## Open Architectural Questions

Track open questions here as they arise. Resolve them via ADRs in `docs/decisions/`.

- n8n self-hosted vs. n8n cloud for production?
- Do we deploy one Supabase project or two (staging + prod) for the internal system?
- At what point do we extract the agent layer into a standalone FastAPI service vs. keeping it as library code called from n8n?
