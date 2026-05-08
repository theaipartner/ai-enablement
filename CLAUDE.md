# CLAUDE.md

Primary context for any Claude Code instance working on this repo. Read this fully before making changes.

## Project Purpose

Internal AI enablement system for a coaching/consulting agency. Replaces and augments human work across customer success, sales, and operations. The consumer business runs on this system first; later, the same system will be deployed to other agencies as a productized consulting offering.

**Active focus:** Gregory V2, organized into batches A–E (`docs/future-ideas.md`). Batch A — CSM accountability visibility — is the in-flight priority. See § Current Focus and § Next Session Priorities.

## Core Principles (Non-Negotiable)

These four principles protect the system from lock-in and rebuilds. Apply them to every decision.

1. **Our database is the source of truth.** Every piece of data we touch is mirrored into Supabase. External tools are secondary.
2. **Agents query our database, not external tools.** An agent never calls Fathom, Slack, or the CRM directly for data. Ingestion pipelines populate Supabase; agents read from Supabase.
3. **External tools are replaceable adapters.** Each integration lives in its own module. Swapping any one is a contained rewrite, not a system-wide migration.
4. **Interfaces are thin clients on a shared brain.** Agent logic lives in one place, exposed via API. Slack, future web portals, email — all just front doors. No business logic in interface code.

## Stack

| Layer | Tool | Notes |
|-------|------|-------|
| Database | Supabase (Postgres + pgvector) | Source of truth. All data mirrored here. |
| Backend / Agents | Python 3.11+ | Primary language. FastAPI for services. |
| Frontend | Next.js 14 + TypeScript | Gregory dashboard + approval UI. |
| Orchestration | n8n (self-hosted) + Make.com | Workflows, scheduling, HITL routing. Make.com handles Airtable ↔ Gregory automation; n8n holds the workflow library. |
| LLM | Anthropic Claude API | Sonnet as default, Opus for complex reasoning, Haiku for simple/cheap tasks. |
| Embeddings | OpenAI `text-embedding-3-small` | 1536 dims. Used by `shared/kb_query.py` and all ingestion that writes `document_chunks`. |
| Hosting | Vercel | Frontend + serverless Python functions. |
| Voice | ElevenLabs | Course audio, future voice agents. |
| Dev environment | WSL2 Ubuntu on Windows | All dev happens inside WSL. VS Code with Remote-WSL extension. |
| Secrets | Bitwarden master list + env vars | `.env.local` locally, Vercel env vars in production. See `.env.example` — required keys today: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`. `SUPABASE_DB_PASSWORD` is also set in `.env.local` for ops scripts that connect directly via psycopg2 (migrations, seeds, diagnostics) — not required by webhooks or the agent runtime. |

## Language Policy

- **Python first** for agents, ingestion pipelines, evals, scripts, data work
- **TypeScript** for Next.js frontend and browser code
- **Other languages only when no reasonable Python or TS option exists.** Ask before introducing a new language.

## Folder Structure

```
ai-enablement/
├── CLAUDE.md                   # This file
├── README.md                   # Human-facing project overview
├── .env.example                # Template for required env vars
├── .gitignore
├── pyproject.toml              # Python project config
├── docs/
│   ├── architecture.md         # System overview, data flow, component map
│   ├── collaboration.md        # How Drake and Zain divide work
│   ├── future-ideas.md         # Gregory V2 batches A–E (active focus)
│   ├── followups.md            # Gregory real bugs / ops reminders
│   ├── schema/                 # One markdown file per database table
│   ├── agents/
│   │   ├── gregory.md          # Gregory full spec + build log (active)
│   │   └── ella/               # Ella docs (sidelined; resumes post Gregory V2)
│   │       ├── ella.md         # Ella full spec
│   │       ├── ella-v1-scope.md # Team-facing V1 scope summary
│   │       ├── future-ideas.md # Ella deferred work
│   │       └── followups.md    # Ella known bugs / ops gaps
│   ├── decisions/              # Architecture Decision Records (ADRs)
│   └── runbooks/               # How to do recurring tasks
├── supabase/
│   ├── migrations/             # Numbered SQL migration files
│   └── seed/                   # Seed data for local testing
├── ingestion/                  # Data ingestion pipelines
│   ├── fathom/                 # Call transcripts — backlog `.txt` path + realtime webhook
│   ├── slack/                  # Channel history backfill (REST only; Events API deferred to Ella V2)
│   ├── content/                # Filesystem-sourced HTML lessons (Drive API deferred to Ella V2)
│   └── crm/                    # (planned)
├── api/                        # Vercel Python serverless functions (8 deployed)
│   ├── slack_events.py         # Ella's Slack handler
│   ├── fathom_events.py        # Fathom realtime webhook
│   ├── fathom_backfill.py      # Daily cron — Fathom backlog backstop
│   ├── gregory_brain_cron.py   # Weekly cron — Gregory brain sweep
│   ├── airtable_nps_webhook.py # Path 1 inbound: Airtable NPS receiver (M5.4)
│   ├── accountability_roster.py # Path 2 outbound: Make.com daily-pull GET (M5.7+)
│   ├── airtable_onboarding_webhook.py # Path 3 inbound: onboarding form receiver (M5.9)
│   └── accountability_notification_cron.py # Daily 7am EST per-CSM accountability alert (M6.1, Batch A)
├── app/                        # Next.js 14 dashboard routes (Gregory)
├── components/                 # Dashboard UI — top-nav, ui/* primitives, client-detail/*
├── lib/                        # Dashboard utilities — db/, supabase/, etc.
├── agents/                     # Agent implementations
│   ├── ella/                   # Slack Bot V1 (sidelined)
│   ├── gregory/                # Brain V1.1 — signal computations, scoring rubric, concerns gen
│   └── csm_copilot/            # (planned — Batch C territory)
├── orchestration/              # n8n workflow exports (JSON)
├── shared/                     # Shared Python utilities (claude_client, kb_query, hitl, logging, db, ingestion validators)
├── evals/                      # Golden datasets + eval runner (empty for now)
├── scripts/                    # Active tooling — seeds, harnesses, admin tasks, one-shots
└── tests/                      # pytest suite — see § Live System State for count
```

## Conventions

### Code

- **Python:** PEP 8. Type hints everywhere. Format with `black`, lint with `ruff`.
- **TypeScript:** Strict mode on. Format with Prettier, lint with ESLint.
- **No one-letter variables** except tight loops (`i`, `j`).
- **Functions do one thing.** Split if exceeding ~50 lines.
- **Pure functions where possible.** Side effects (DB writes, API calls) isolated in thin layers.

### Naming

- Python files/modules: `snake_case.py`
- Python classes: `PascalCase`
- Python functions/variables: `snake_case`
- TypeScript files: `kebab-case.ts` or `PascalCase.tsx` for components
- Database tables: `snake_case`, plural (`clients`, `calls`, `messages`)
- Database columns: `snake_case`
- Environment variables: `SCREAMING_SNAKE_CASE`

### Documentation (Non-Negotiable)

Every substantive change updates documentation in the same commit.

- **New database table** → new file in `docs/schema/` with: purpose, columns, relationships, what populates it, what reads from it, example queries
- **New agent** → new file/folder under `docs/agents/` with: purpose, inputs, outputs, data dependencies, escalation rules, eval criteria
- **New ingestion pipeline** → runbook in `docs/runbooks/` covering: what it does, schedule, failure modes, debugging
- **Significant architectural decision** → new ADR in `docs/decisions/` using the standard template

Documentation is not optional and not written "later." It ships alongside the code.

### Commits

- Commit frequently — every meaningful unit of work, even if imperfect
- **One logical change per commit.** If you find yourself typing " and " or " also " in a commit message, split it.
- Commit messages: short, declarative, present tense (imperative mood)
- **Never commit with failing tests.** Run `pytest tests/` first.
- Never commit secrets. Run `git diff` before every commit to scan for keys.

**Commit policy:** At the end of each meaningful unit of work (a feature complete, a migration applied, a file fully refactored), commit with a clear message following our convention. Do not commit half-finished work. Do not commit if tests/validation fail. Push to remote at the end of each session.

### Client Identity Resolution (alternate emails / alternate names)

The Fathom classifier resolves call participants to `clients` rows by email first, then by display name. Both lookups consult `clients.metadata` jsonb arrays:

- `metadata.alternate_emails` — emails the client has used historically.
- `metadata.alternate_names` — display names the client has used historically.

Both arrays are consulted case-insensitively, whitespace-stripped. When you merge an auto-created duplicate client row into a canonical row, the auto row's email and full_name must be written into these arrays on the real row so future ingestion resolves cleanly without re-creating the duplicate. The canonical merge surface is the Gregory dashboard's "Merge into…" flow on the Clients detail page (migration `0015_merge_clients_function.sql` handles the alternates sync atomically as part of the merge). Any new ingestion path that resolves humans-to-clients should consult these fields before creating a new row.

### Error Handling

- External API calls always wrapped with retry + timeout + structured logging
- Database writes transactional when multiple tables are affected
- Agent failures escalate to HITL rather than silently failing
- Never swallow exceptions without logging them

## Critical Rules

### Never Do

- **Never commit `.env`, `.env.local`, or any file with credentials.**
- **Never install a new major dependency without asking first.**
- **Never write code without updating the corresponding documentation.** Code and docs ship together.
- **Never couple agent logic to a specific external tool.** Agents query the KB. If you find yourself writing `fathom_client.get_call(...)` inside an agent, stop — move the fetch into the ingestion layer, persist to Supabase, then query from the agent.
- **Never bypass the HITL pattern.** If an agent is uncertain, escalate. Do not guess confidently.
- **Never use `print()` for anything that should persist.** Use structured logging via `shared/logging.py`.
- **Never write to `documents` or `document_chunks` without running through the validator.** `shared.ingestion.validate.validate_document_metadata()` / `validate_chunk_metadata()` enforces the contract every chunk in the KB depends on.

### Always Do

- **Always ingest data through the ingestion layer, not from agents.**
- **Always run the metadata validator before inserting into `documents` / `document_chunks`.**
- **Always write an eval before considering an agent "done."** Target: minimum 20 golden examples per agent, 90% pass rate to ship.
- **Always ask before introducing new external services, libraries, or languages.**
- **Always read the relevant `docs/` files before editing a component.**

## Gregory (active focus)

Gregory is the CSM-facing agent: a Next.js dashboard backed by a deterministic brain (signals + scoring rubric + gated Claude-driven concerns) and three Airtable integration paths. Active development focus.

**Dashboard surfaces.** Routes: `/login`, `/clients`, `/clients/[id]`, `/calls`, `/calls/[id]`. The client detail page is a 7-section v3 layout (Identity & Contact / Lifecycle & Standing / Financials / Activity & Action Items / Profile & Background / Adoption & Programs / Notes) with full inline-edit. Status / journey_stage / csm_standing edits route through the migration-0018 RPC functions for atomic update + history-row writes. The `/clients` list page has a 9-dropdown filter bar (M5.5 → M5.7): 8 active multi-selects (Status / Primary CSM / CSM Standing / NPS Standing / Trustpilot / Country / Accountability / NPS toggle) + 1 single-value toggle (Needs review). Section 4 surfaces monthly-meetings tracker + inactivity flag (M5.7). Section 6 NPS Standing pill renders `clients.nps_standing` (M5.4). Auth via Supabase Auth (email/password, manually invited users) via the (authenticated) layout. Two Supabase clients by privilege: anon key + cookies for the auth gate, service role + `'server-only'` guard for data reads. Source: `app/`, `components/client-detail/`, `lib/db/clients.ts`, `lib/client-vocab.ts`. Spec + build log: `docs/agents/gregory.md`.

**Database (Supabase Postgres + pgvector).** Cloud project `sjjovsjcfffrftnraocu` (us-east-2, Ohio). Migration count, key tables, and RPC patterns documented in § Live System State below. Key tables: `clients` (with `metadata.alternate_emails`/`alternate_names` arrays for identity resolution), `calls`, `call_action_items`, `call_classification_history`, `client_status_history` + `client_journey_stage_history` + `client_standing_history` (history tables, application-layer write pattern), `client_health_scores` (Gregory brain output with `factors.concerns[]` jsonb), `nps_submissions`, `client_team_assignments`, `client_upsells`, `slack_channels`, `slack_messages` (local-only today), `documents` + `document_chunks` (Ella retrieval surface), `webhook_deliveries` (audit ledger for inbound webhooks), `agent_runs` + `agent_feedback` (agent telemetry). History-row RPC pattern (M4 Chunk B2): atomic update + history-row insert in one transaction, idempotent when value unchanged, attribute via `changed_by` UUID with structured note string. Cascade triggers on `clients` for status (M5.6) and csm_standing→happy (M5.7). Schema docs: `docs/schema/`.

**Ingestion paths.** Fathom transcripts land via two parallel paths: realtime webhook at `/api/fathom_events` (M4.1, signature-verified), and a daily Vercel cron at `/api/fathom_backfill` as the backstop. Both use the same `ingestion/fathom/` pipeline (classifier, chunker, pipeline) which writes `calls` + `call_participants` + `call_action_items` + `documents` (with `document_type='call_summary'` + `'call_transcript_chunk'`) + `document_chunks` with embeddings. Auto-creates a minimal `clients` row tagged `needs_review` when a participant doesn't match an existing client by email or name. Slack history (~2,914 messages across 8 channels) is local-only — cloud ingestion is sidelined Ella V2 work.

**CS visibility surfaces (M6.1, Batch A — shipped 2026-05-05).** Two Slack-channel surfaces give CSMs at-a-glance visibility into client-call activity and accountability submission gaps. Both reuse a shared `shared/slack_post.py` helper (factored out of Ella's `api/slack_events.py` two-token post path) and the `webhook_deliveries` audit pattern (with new source labels `cs_call_summary_slack_post` and `accountability_notification_cron`). Per-call CS summary fires inside the Fathom webhook pipeline whenever a `call_category='client'` call is ingested — posts a one-message summary (CSM / client / Fathom default_summary / deep-link to Gregory) to `SLACK_CS_CALL_SUMMARIES_CHANNEL_ID`; Slack-post failure NEVER fails the underlying Fathom delivery. Daily accountability notification cron runs at 12:00 UTC (7am EST / 8am EDT) — fetches yesterday's submissions from Airtable, queries Gregory for active accountability-enabled clients, computes the missing list, posts one Slack message per CSM to `SLACK_CS_ACCOUNTABILITY_CHANNEL_ID` (skipped entirely when no CSM has missing clients; loud `:warning:` Slack alert on Airtable failure so silent breakage isn't possible). See `docs/runbooks/cs_call_summary.md` and `docs/runbooks/accountability_notification_cron.md` for operational guides.

**External integrations (Make.com / Airtable).** Three paths bridging Gregory ↔ Airtable through Make.com:

- **Path 1 inbound** — `api/airtable_nps_webhook.py` (M5.4). Make.com fires this when an Airtable NPS Survey row changes Segment Classification. Receiver normalizes the segment, calls `update_client_from_nps_segment` RPC (migration 0021, replaced 0027) which mirrors `nps_standing` and **always** auto-derives `csm_standing` from the segment (NPS-is-gospel post-2026-05-08, flipped from override-sticky in 0027). Auth via `X-Webhook-Secret` header (`AIRTABLE_NPS_WEBHOOK_SECRET`).
- **Path 2 outbound** — `api/accountability_roster.py` (M5.7+). Make.com pulls this daily; replaces the Financial Master Sheet as the source of truth for Zain's accountability + NPS automation. Returns the actionable client roster with email / full_name / country / advisor_first_name / Slack identifiers / accountability + NPS toggles. Auth via `MAKE_OUTBOUND_ROSTER_SECRET`.
- **Path 3 inbound** — `api/airtable_onboarding_webhook.py` (M5.9). Make.com fires this once per new client when Zain's onboarding flow completes. 7-field payload, calls `create_or_update_client_from_onboarding` RPC (migration 0025) which match-or-creates on email + alternate_emails with three branches (created / updated / reactivated), seeds history rows attributed to Gregory Bot UUID, raises structured exceptions for Slack ID conflicts → HTTP 409. Auth via `AIRTABLE_ONBOARDING_WEBHOOK_SECRET`.

Future Path 4 outbound writeback (Gregory → Airtable for fields beyond accountability/NPS, e.g. csm_standing changes flowing back) is deferred until a concrete need surfaces.

**Hosting.** Single Vercel project at `https://ai-enablement-sigma.vercel.app`. Mixed-framework: Next.js 14 dashboard at repo root + 7 Python serverless functions. `vercel.json` declares `"framework": "nextjs"` (required to suppress framework auto-detection when `functions` is also explicit) plus per-file Python runtimes. Vercel Cron schedules: daily 08:00 UTC → fathom_backfill; daily 09:00 UTC → gregory_brain_cron (switched from weekly Mondays on 2026-05-08 paired with the AI-signal freshness filter).

## Live System State

As of 2026-05-07 (Call Review V1 shipped — agent + May 2026 backfill + Calls detail page surface):

- **Cloud Supabase** is the production target. Project ref `sjjovsjcfffrftnraocu` (region us-east-2, Ohio). **27 migrations applied** (`0001_core_entities` through `0027_nps_is_gospel`). Recent migrations: 0017 added 14 columns to `clients` + 1 column to `nps_submissions` + 4 history/upsell tables (M4 Chunk A). 0018 added 4 `security definer` Postgres functions for atomic update + history-row writes (M4 Chunk B2). 0019 (`status_add_leave`) added the first DB-level CHECK on `clients.status` and expanded the vocabulary to include `leave` (M5.3). 0020 (`trustpilot_rename_vocab`) renamed `clients.trustpilot_status` 1:1 to match Scott's master sheet (M5.3b). 0021 (`nps_standing_and_gregory_bot`) added `clients.nps_standing` + Gregory Bot sentinel team_member (UUID `cfcea32a-062d-4269-ae0f-959adac8f597`) + `update_client_from_nps_segment` RPC (M5.4 Path 1). 0022 (`status_cascade`) added `clients.accountability_enabled` + `clients.nps_enabled` + `team_members.is_csm` + Scott Chasing sentinel (UUID `ccea0921-7fc1-4375-bcc7-1ab91733be73`) + BEFORE/AFTER triggers for the negative-status cascade (M5.6). 0023 (`change_primary_csm_on_conflict`) replaced the 0014 RPC with an `ON CONFLICT DO UPDATE` variant (M5.6 hotfix). 0024 (`trustpilot_cascade_on_happy`) added a one-directional BEFORE UPDATE trigger that auto-flips `clients.trustpilot_status` to `'ask'` when `csm_standing` transitions to `'happy'` (M5.7). 0025 (`create_or_update_client_from_onboarding`) added the security-definer RPC for Path 3 inbound (M5.9). All applied via Studio + manual ledger registration + dual-verified (recent ones via psycopg2 since psql isn't installed in this environment, but the dual-verify pattern held). Accessed via the pooler URL stored in `supabase/.temp/pooler-url`; the DB password lives in `.env.local` as `SUPABASE_DB_PASSWORD` (quoted because it contains a `#`).
- **Vercel deployment** live at `https://ai-enablement-sigma.vercel.app`. Single project, mixed-framework: Next.js 14 dashboard at repo root + **eight** Python serverless functions in `api/`. `vercel.json` declares `"framework": "nextjs"` plus per-file Python runtimes for: `api/slack_events.py` (Ella's Slack handler, `maxDuration: 60`), `api/fathom_events.py` (Fathom webhook, `maxDuration: 60`), `api/fathom_backfill.py` (daily cron, `maxDuration: 300`), `api/gregory_brain_cron.py` (weekly cron, `maxDuration: 300`), `api/airtable_nps_webhook.py` (Path 1 inbound, `maxDuration: 60`), `api/accountability_roster.py` (Path 2 outbound GET, `maxDuration: 60`), `api/airtable_onboarding_webhook.py` (Path 3 inbound, `maxDuration: 60`), `api/accountability_notification_cron.py` (daily 7am EST CS-visibility cron, `maxDuration: 60` — added M6.1). Vercel Cron schedules: `0 8 * * *` daily → `/api/fathom_backfill`; `0 9 * * *` daily → `/api/gregory_brain_cron` (switched from weekly to daily 2026-05-08, paired with the freshness filter on `ai_call_signal` so each sweep only fires Sonnet for clients with new call_reviews since their last compute); `0 12 * * *` daily → `/api/accountability_notification_cron`. Env vars in production: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `SLACK_USER_TOKEN`, `FATHOM_WEBHOOK_SECRET`, `FATHOM_API_KEY`, `CRON_SECRET` (validated by all cron endpoints — fathom_backfill, gregory_brain_cron, accountability_notification_cron; consolidated to single-var pattern in M6.2), `AIRTABLE_NPS_WEBHOOK_SECRET`, `MAKE_OUTBOUND_ROSTER_SECRET`, `AIRTABLE_ONBOARDING_WEBHOOK_SECRET`, `SLACK_CS_CALL_SUMMARIES_CHANNEL_ID` (M6.1), `SLACK_CS_ACCOUNTABILITY_CHANNEL_ID` (M6.1), `AIRTABLE_ACCOUNTABILITY_PAT` (M6.1), `AIRTABLE_ACCOUNTABILITY_BASE_ID` (M6.1), `AIRTABLE_ACCOUNTABILITY_TABLE_ID` (M6.1). `GREGORY_CONCERNS_ENABLED` is intentionally unset — Gregory brain treats anything other than `true`/`1`/`yes` as off (Batch B activation).
- **Gregory dashboard** live with the V1 client page schema (M4) + M5 vocab updates + M5.5 filter bar + M5.6 cascade + M5.7 monthly-meetings/inactivity/country/accountability/NPS-toggle filters. 188 non-archived clients post-M5 cleanup, perfect 1:1 with the canonical master sheet.
- **`clients` table population (post-cleanup, 2026-05-05):** 188 non-archived clients. Every negative-status client has `csm_standing='at_risk'` + `accountability_enabled=false` + `nps_enabled=false` (M5.6 cascade); every active client has the toggles at default `true`. `country` populated USA/AUS for every CSV-matched client. `clients.nps_standing` populated for 61 active clients via Path 1 backfill + alternate-emails resync.
- **Gregory brain (M3.4):** agent code in `agents/gregory/`. First all-active sweep produced 133 `client_health_scores` rows (93 green / 40 yellow / 0 red). **Concerns generation gated** (`GREGORY_CONCERNS_ENABLED` unset; Batch B activates this). Weekly cron Mondays 09:00 UTC.
- **Path 2 outbound roster live count:** 128 actionable / 188 non-archived (60 filtered for missing slack_user_id / channel / email). Surfaces a Slack-identity coverage gap; followup logged.
- **CS visibility surfaces (M6.1):** `agents/gregory/cs_call_summary_post.py` hooks into `ingestion/fathom/pipeline.py:ingest_call` for client-category calls (audit trail via `webhook_deliveries.source='cs_call_summary_slack_post'`). `api/accountability_notification_cron.py` runs daily at 12:00 UTC (`webhook_deliveries.source='accountability_notification_cron'`); 91 active accountability-enabled clients in scope at ship, all with active primary_csm assignments (the cron's no-CSM silent-drop bucket is empty today). Two new harnesses: `scripts/test_cs_call_summary_locally.py` (28/28) and `scripts/test_accountability_notification_cron_locally.py` (31/31). Slack-post infrastructure factored to `shared/slack_post.py` (Ella's two-token logic stays in `api/slack_events.py` and imports the transport from there; 14/14 Ella post-tests still pass after the refactor).
- **Call Review V1 (2026-05-07).** New `call_reviewer` agent at `agents/call_reviewer/` (Sonnet-only, system prompt + `review_call` + `upsert_call_review`). Generates a four-section structured review per call (pain_points / wins / dodged_questions / sentiment_arc) stored as `documents` rows with `source='fathom'`, `document_type='call_review'`, `is_active=False` (retrieval-side safety net — never lands in `match_document_chunks` results). May 2026 backfill complete: 31/31 reviewed, $1.5349 total Sonnet cost. One-shot script at `scripts/backfill_call_reviews.py` with `--smoke` / `--apply` / `--limit` modes; smoke mode is the working norm for all future backfills (see `docs/claude-handoff.md`). Calls detail page surfaces the review as Section 4.5 between Summary and Action items — sentiment_arc paragraph + three list subsections + "Generated <timestamp>" header. The "Conversation pivots" subsection renders the underlying `dodged_questions` data (renamed user-facing only in V2 brain ship).
- **Fathom pipeline auto-review (2026-05-07).** `ingestion/fathom/pipeline.py:_ensure_call_review_document` fires after each successful summary write for client-category calls with a non-null `primary_client_id`. Three-layer idempotency (existence guard + persistence upsert + pipeline invariant) keeps Fathom retries free. Fail-soft try/except — review-generation failure never breaks Fathom delivery. The 30-day call_review lookback window the V2 brain reads now refills automatically as calls land. `review_call` gained optional `trigger_type` kwarg (default `manual_backfill`; pipeline passes `fathom_pipeline`).
- **Gregory brain V2 (2026-05-07).** New `ai_call_signal` at `agents/gregory/ai_call_signal.py` is the dominant contributor (weight **0.50**) — reads each client's last 30 days of call_review documents, sends to Sonnet, returns a 0-100 contribution + 1-3 sentence reasoning + 0-3 concerns matching the existing dashboard `{text, severity, source_call_ids}` shape. Rubric rebalanced: `ai_call_signal 0.50 + call_cadence 0.20 + overdue_action_items 0.10 + latest_nps 0.20`. `open_action_items` retired (double-counting with overdue + the AI signal's qualitative action-item read). `concerns.py` + `GREGORY_CONCERNS_ENABLED` gate retired — concerns flow directly from the AI signal. Never-called-clients-land-green (M3.4 known issue) fully resolved by the rebalance: never-called clients now land at score=55 yellow. SweepResult carries `duration_ms + avg_per_client_ms` for the cron-ceiling watchpoint.
- **Clients list V2 columns (2026-05-08).** 1-to-1 column swap on `app/(authenticated)/clients/clients-table.tsx`: out — Last call / Open action items / Tags. In — NPS standing / Trustpilot / Meetings this month. New `NpsStandingPill` + `TrustpilotPill` components with palettes matching the existing pill family (emerald/amber/rose/sky). Vocab labels in `lib/client-vocab.ts` updated so filter dropdown labels exactly match table pill labels: NPS_STANDING_OPTIONS now uses "Promoter" (was "Strong / Promoter" — Airtable-form artifact dropped); TRUSTPILOT_OPTIONS now uses "Given"/"Declined" (was "Yes"/"No"). Underlying enum values unchanged. Default sort flipped from `last_call_date desc` to `latest_health_score asc` (worst first) — surfaces attention-needing clients at the top now that V2 brain produces reliable scores; NULL-score clients sink to bottom via NULLS-LAST.
- **`latest_nps` signal source fix (2026-05-08).** `agents/gregory/signals.py:compute_latest_nps` now reads from `clients.nps_standing` (Airtable mirror via Path 1 + the 0027 NPS-is-gospel auto-derive) instead of `nps_submissions.score` (which stayed empty in production through M5). Mapping: promoter→100, neutral→50 (with distinct "(passive)" note), at_risk→0, NULL→neutral 50 with "no record" note. Defensive unexpected-value fallback past the 0021 CHECK. Score-shift on next sweep: at-risk clients drop ~10 points, promoter clients rise ~10 points — the rubric becomes appropriately discriminating; not a regression.
- **NPS-is-gospel auto-derive (2026-05-08, migration 0027).** Override-sticky semantics on `update_client_from_nps_segment` (M5.4 / 0021) flipped to "NPS is gospel" — every NPS Survey segment write now unconditionally auto-derives `csm_standing` via the existing `update_client_csm_standing_with_history` delegation. Override-sticky branches removed; `'problem'` stays manual-only because no segment maps to it. One-time backfill in the migration realigned 16 stale rows (14 master-sheet seeds + 2 stale Gregory Bot auto-derives, zero current CSM manual overrides per dry-run 2026-05-08). Receiver's `auto_derive_applied` flag is now always `true` on the 200 path; preserved for response-shape stability. NPS harness refactored to self-seeded fixture pattern (per-run RUN_TOKEN-suffixed unique email, hard-deleted on teardown) replacing the static-Branden fixture that broke when Branden was archived in M5 cleanup; 10 paths total (2 happy + 2 NPS-is-gospel + 6 negative).
- **Gregory brain V2 daily-cron + freshness filter (2026-05-08).** Cron schedule switched weekly→daily and `compute_ai_call_signal` gained a freshness check: before any LLM work, query `agent_runs` for the last successful compute timestamp for this client + max `documents.created_at` for `call_review` docs; if no new reviews since last compute, return the prior Signal verbatim (note rewritten to surface skip provenance + preserve original LLM-judged reasoning) and skip the Sonnet call. Skip-path opens an `agent_runs` row with `output_summary` starting with `"skipped"` so cost rollups split skip-rate from compute-rate. Each daily sweep now fires Sonnet for ~10 clients (typical new-review velocity) instead of all 188, fitting the 300s `maxDuration` ceiling. Trigger_type renamed `weekly_brain` → `scheduled_brain`. Defensive fallback: V1.1→V2 transition rows (no `ai_call_signal` entry in factors.signals[]) trigger recompute rather than returning malformed prior data. Freshness applies ONLY to `ai_call_signal`; deterministic signals (cadence, overdue, NPS) always recompute every sweep. Accepted 24h-max race: a Fathom auto-review landing AFTER the brain has read freshness for that client mid-sweep goes invisible until the next daily sweep — explicit trade-off of the architecture, not a bug.
- **Test suite:** 399 passing (up from 381 — +18 across `tests/agents/call_reviewer/` + `tests/shared/ingestion/test_validate.py`).

## Current Focus

**Batch A — CSM accountability visibility.** Shipped 2 of 4 chunks (per-call CS Slack summary + accountability notification cron, M6.1, 2026-05-05); cron auth refactored to single `CRON_SECRET` pattern (M6.2, 2026-05-06). Remaining: missed-call detection (tomorrow's session — Google Calendar diff against `calls`; gated on Drake's Fathom team-settings sweep closing the duplicate-recording bug), call tagging dashboard (depends on CSM ops adoption of a tagging convention). See `docs/future-ideas.md` § Batch A.

## Next Session Priorities

Pick these up in order. **Read this section first** when starting a new session — it's the single source of truth for where to start.

0. **🔍 ONE-TIME GATE — verify the 2026-05-08 09:00 UTC daily cron fired correctly.** Before any planned work. Run the verification query in `docs/followups.md` § "NEXT SESSION FIRST ACTION — verify daily cron fired" and follow the three-outcome decision tree. Remove that followups entry AND this priority bullet once the verification has run, regardless of outcome — this is a one-time gate added at session-close 2026-05-07, not a recurring routine.

1. **Batch A — CSM accountability visibility (2 of 4 shipped).** Per-call CS summary + daily accountability notification shipped M6.1 (2026-05-05); cron auth consolidated to single `CRON_SECRET` M6.2 (2026-05-06). **Tomorrow's slice:** missed/unrecorded call detection (Google Calendar diff against the `calls` table; gated on Drake's Fathom team-settings sweep closing the duplicate-recording bug). Then: call-tagging dashboard (gated on CSM ops adoption of a tagging convention). See `docs/future-ideas.md` § Batch A.

2. **Batch B — Call review + health score activation.** Queued. Activates Gregory concerns generation (currently gated), tunes it to run on Fathom summaries, rebalances the health score rubric so call data dominates, fixes the never-called-clients-land-green quirk. Adds NPS score piping (V1.5) to extend Path 1 to ingest score alongside segment.

3. **Batch C — Action item HITL flow (Nabeel's "transcript vision", V2 flagship).** Queued. AI drafts action item messages from transcripts → CSM reviews + edits in Gregory → CSM approves → Slack send to client channel + assigned-vs-completed tracking.

4. **Batch D — Classifier tuning.** Backstop only. Address only if titling discipline doesn't suppress the existing FP patterns (hiring-interview / spousal-rep / iMIP — see `docs/followups.md`). Otherwise leave.

5. **Batch E — Client business context vault.** Queued. Login credentials, brand assets, GHL snapshots, hosting/domain/email-setup info. Long-arc destination: a CSM-facing chatbot that queries the vault + brain for quick lookups.

**Deferred-decision pending Monday onboarding:** master-sheet-import seed treatment for auto-derive eligibility (137 clients with `changed_by=NULL` history rows are sticky against Path 1 NPS auto-derive). See `docs/followups.md` § "Master-sheet-import seed treatment for auto-derive eligibility."

## Ella (sidelined)

Ella V1 beta is in pilot mode (live in `#ella-test-drakeonly`, awaiting Nabeel feedback before pilot rollout to remaining 6 channels). V2 polish work and Ella-specific docs live in `docs/agents/ella/`. Active focus is Gregory; Ella resumes once V2 CS-focus pivot stabilizes.

## Other agents / future

- **CSM Co-Pilot V1** — Batch C territory. Lives at `agents/csm_copilot/` (placeholder). The action-item HITL flow + transcript-driven CSM-facing reasoning is its surface area.
- **Internal "Scout" assistant** — second agent on the shared Ella layer with team-wide retrieval scope. Sidelined; revisit-context in `docs/agents/ella/future-ideas.md`.

## Working With Claude Code — Prompting Tips

Give Claude Code context like you'd give a new senior engineer, not like a magic wish granter.

Bad:

> Build the Slack bot.

Good:

> We're building Slack Bot V1 per `docs/agents/ella/ella.md`. Ingest from the `documents` and `slack_messages` tables via `shared/kb_query.py`. Follow the HITL pattern in `shared/hitl.py`. Start with the incoming Slack event handler. Write code, update `docs/agents/ella/ella.md` as you go, add at least 10 golden examples to `evals/ella/`.

After Claude Code generates meaningful code, ask: **"Explain what this does and what could go wrong."** Catches most issues before they compound.

## Update Policy for This File

Update CLAUDE.md whenever:
- A core principle is clarified or extended
- A stack choice changes
- A new major convention is adopted
- The current focus shifts to a new phase / batch
- The "Live System State" snapshot drifts from reality

Treat it as living documentation. A stale CLAUDE.md is worse than no CLAUDE.md.
