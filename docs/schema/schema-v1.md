# Database Schema V1

First version of the schema. Oriented around what Ella (Slack Bot V1) and CSM Co-Pilot V1 need, with room to grow into CRM, marketing, and team-scoring data later without restructuring.

**Status:** Implemented by migrations 0001–0037. Cloud project (`sjjovsjcfffrftnraocu`) is the production target; all migrations applied + ledger-registered. Migration 0017 (`client_page_schema_v1`) added 14 columns to `clients`, 1 column to `nps_submissions`, and 4 new tables for the Gregory client detail page V1 — see `docs/archive/historical/client-page-schema-spec.md` for the design. Migration 0018 (`client_history_rpcs`) added four `security definer` Postgres functions that the dashboard's edit endpoints call for atomic update + history-row writes (status / journey_stage / csm_standing) and for manual NPS-score entry. Migration 0019 (`status_add_leave`) added the first DB-level check constraint on `clients.status` and expanded the vocabulary to include `leave`; the `update_client_status_with_history` RPC was replaced in the same migration to mirror the new allowlist. Migration 0020 (`trustpilot_rename_vocab`) renamed the `clients.trustpilot_status` vocabulary 1:1 to match the Financial Master Sheet column Scott uses (`given`→`yes`, `declined`→`no`, `not_asked`→`ask`, `pending`→`asked`) — V1 adoption path. Migration 0021 (`nps_standing_and_gregory_bot`) added `clients.nps_standing`, the `Gregory Bot` system_bot sentinel team_member row (pinned UUID `cfcea32a-062d-4269-ae0f-959adac8f597`), and the `update_client_from_nps_segment` RPC — Path 1 schema for the V1 Airtable NPS integration. Migrations 0022-0026 layered status cascade (M5.6), trustpilot-cascade-on-happy (M5.7), Path 3 onboarding RPC (M5.9), and the M6.x optional-slack relaxation. **Migration 0027 (`nps_is_gospel`, 2026-05-08)** flipped `update_client_from_nps_segment` from override-sticky to always-auto-derive `csm_standing` from segment + a 16-row backfill realigning stale rows. **Migration 0028 (`journey_stage_check`, 2026-05-08)** added a CHECK constraint pinning the six-value funnel taxonomy on `clients.journey_stage` (replaced the V1 free-text shape with zero backfill since all 192 active clients had `journey_stage IS NULL`). **Migration 0037 (`trustpilot_cascade_first_month_carve_out`, 2026-05-15)** extended the M5.7 trustpilot cascade WHEN clause with a first-month carve-out — clients with NULL `start_date` or `start_date > current_date - interval '30 days'` no longer get auto-flipped to `trustpilot_status='ask'` when `csm_standing` transitions to `'happy'`, per Scott's "don't ask new clients for reviews" intent.

**DB population (as of M4 Chunk C apply, 2026-05-01):**

| Table | Count | Source |
|---|---:|---|
| `team_members` | 9 | Manual seed (`supabase/seed/team_members.sql`); 7 have `slack_user_id` backfilled |
| `clients` (active) | 197 | 128 pre-M4 (post-merge state from M3) + 69 auto-created by `scripts/import_master_sheet.py` during M4 Chunk C (48 churned, 21 non-churn paused/active per Drake's triage amendment to the spec). The pre-M4 baseline came from the original Active++ sheet seed + Fathom-ingest `needs_review` rows minus M3.2 merges. |
| `clients` (archived) | 6 | Pre-M4 archives; the M4 Chunk C importer didn't archive anything |
| `client_upsells` | 24 | Inserted by `scripts/import_master_sheet.py` |
| `client_status_history` | 209 | 128 migration-0017 seed rows (one per non-archived client at migration time) + 81 import-seed rows (`note='import seed'`) from the M4 Chunk C importer |
| `client_journey_stage_history` | 0 | No non-archived client has a non-null `journey_stage`; importer sets none |
| `client_standing_history` | 137 | All from the M4 Chunk C importer (`note='import seed'`); migration 0017 didn't seed this table |
| `slack_channels` (active) | 101 | 100 client channels + `ella-test` |
| `slack_channels` (archived) | 21 | Cascaded from archived clients |
| `client_team_assignments` (active) | 100 | Primary CSM mappings |
| `client_team_assignments` (ended) | 24 | Cascaded from archived clients |
| `calls` | 389 | Fathom backlog `.txt` ingest, Feb–Apr 2026 |
| `call_participants` | 978 | Fathom backlog |
| `call_action_items` | 0 | Deferred — see conventions §5 |
| `documents` (`call_transcript_chunk`) | 319 | Fathom pipeline; 266 active + 53 inactive (retrievability floor) |
| `documents` (`course_lesson`) | 297 | Content pipeline; 276 active + 21 inactive (NOT IN USE) |
| `document_chunks` | 4,179 | ~3,528 from transcripts + ~651 from course content, all embedded |
| `slack_messages` | 2,914 | 90-day history across 8 pilot channels |
| `agent_runs` / `escalations` / `agent_feedback` | 0 | Populated by agent code (not built yet) |
| `nps_submissions` / `client_health_scores` / `alerts` | 0 | Populated by CSM Co-Pilot (not built yet) |

## Design Principles

1. **Core entities are stable.** `clients`, `team_members`, `documents`, `calls` — these tables' basic shape will outlast many agents. Design them well once.
2. **Agent infrastructure is standardized.** `agent_runs`, `escalations`, `agent_feedback` are shared across all agents. Every new agent plugs into these.
3. **Source-specific tables are isolated.** `slack_messages`, `fathom_calls` — one per external source. Swapping a source means rewriting its table and ingestion, not rebuilding core entities.
4. **Every table gets a `created_at`, `updated_at`.** For debugging, auditing, and freshness checks.
5. **Soft deletes via `archived_at` on core entities.** Preserve history; never hard-delete a client or document.
6. **UUIDs as primary keys** for easier cross-table references and future multi-tenant scenarios.
7. **RLS enabled on every table.** Policies default to deny; add permissive rules explicitly. For V1 most queries run as `service_role` which bypasses RLS.

## Table Inventory

### Core entities

| Table | Purpose |
|-------|---------|
| `team_members` | CSMs, leadership, anyone on the agency side |
| `clients` | Customers of the agency (people in the $9K program) |
| `client_team_assignments` | Which team members serve which clients |
| `client_upsells` | Upsell sales per client (added in 0017) |
| `client_status_history` | Append-only audit trail for `clients.status` changes (added in 0017) |
| `client_journey_stage_history` | Append-only audit trail for `clients.journey_stage` changes (added in 0017) |
| `client_standing_history` | Append-only audit trail for `clients.csm_standing` changes (added in 0017) |

### Slack ingestion

| Table | Purpose |
|-------|---------|
| `slack_channels` | Slack channel metadata, mapped to clients |
| `slack_messages` | Ingested message history from client channels |

### Call data (Fathom)

| Table | Purpose |
|-------|---------|
| `calls` | One row per recorded call |
| `call_participants` | Who attended each call |
| `call_action_items` | Action items extracted from call summaries |

### Knowledge content

| Table | Purpose |
|-------|---------|
| `documents` | Course content, SOPs, FAQs — anything Ella should know |
| `document_chunks` | Documents split for retrieval, with vector embeddings |

### Agent infrastructure

| Table | Purpose |
|-------|---------|
| `agent_runs` | Every execution of any agent, logged |
| `escalations` | HITL escalations and their resolutions |
| `agent_feedback` | When a human corrects an agent output (for eval data) |

### CSM Co-Pilot data (prep for week 4-5, table shells now)

| Table | Purpose |
|-------|---------|
| `nps_submissions` | NPS scores and feedback |
| `client_health_scores` | Computed health scores per client per day |
| `alerts` | Actionable alerts (churn risk, upsell, etc.) |

**Note:** accountability submissions are not a separate table. They're ingested as Slack messages with `message_subtype = 'accountability_submission'`. See `slack_messages` for detail.

---

## Detailed Design

### team_members

Agency-side humans. CSMs, leadership, anyone who operates *on behalf of* the company.

```
id                uuid PK
email             text UNIQUE NOT NULL
full_name         text NOT NULL
role              text NOT NULL  -- 'csm', 'leadership', 'engineering', 'ops'
slack_user_id     text UNIQUE    -- Slack's U... identifier for mentions and matching
is_active         boolean NOT NULL DEFAULT true
metadata          jsonb DEFAULT '{}'::jsonb  -- extensible
created_at        timestamptz NOT NULL DEFAULT now()
updated_at        timestamptz NOT NULL DEFAULT now()
archived_at       timestamptz
```

**Populated by:** manual seed initially (Scott, Lou, Nico, Drake, Nabeel, Zain), then programmatically as the team grows.

**Read by:** every agent (to identify who's doing what), CSM Co-Pilot (for scorecards), Slack bot (to know if a @mention is from a team member vs. a client).

---

### clients

Customers of the agency. One row per person, even if multiple people are from the same company (company-level aggregation can come later via a `companies` table).

```
id                uuid PK
email             text UNIQUE NOT NULL
full_name         text NOT NULL
slack_user_id     text UNIQUE
phone             text
timezone          text
journey_stage     text  -- 'onboarding', 'active', 'churning', 'churned', 'alumni'
status            text NOT NULL DEFAULT 'active'  -- 'active', 'paused', 'ghost', 'leave', 'churned' (CHECK clients_status_check from 0019)
nps_standing      text  -- 'promoter', 'neutral', 'at_risk' (or null) — added 0021; Airtable NPS Survey segment mirror
start_date        date
program_type      text  -- '9k_consumer', 'b2b_enterprise', etc.
tags              text[] NOT NULL DEFAULT '{}'::text[]  -- ad-hoc labels: 'beta_tester', 'high_value', 'at_risk', etc.
metadata          jsonb DEFAULT '{}'::jsonb  -- goals, SWOT, profession, age, etc.
created_at        timestamptz NOT NULL DEFAULT now()
updated_at        timestamptz NOT NULL DEFAULT now()
archived_at       timestamptz
```

**Populated by:** Drive ingestion (client list doc) initially, then CRM ingestion in Phase 2.

**Read by:** every agent that needs client context.

**Note:** we're keeping this deliberately lightweight for V1. The `metadata` jsonb field absorbs the long tail of "goals, SWOT, profession, age" etc. that would otherwise bloat the columns. When specific fields start getting queried often, we promote them to real columns.

**Columns added since the V1 baseline (see Changelog for the per-migration story):**

- `notes text` (0012) — free-text notes per client, edited by team members via the Gregory dashboard.
- 14 columns added in 0017 for the Gregory client detail page V1 — `country`, `birth_year`, `location`, `occupation`, `csm_standing`, `archetype`, `contracted_revenue`, `upfront_cash_collected`, `arrears` (not null, default 0), `arrears_note`, `trustpilot_status`, `ghl_adoption`, `sales_group_candidate`, `dfy_setting`. Three carry inline check constraints (`csm_standing`, `trustpilot_status`, `ghl_adoption`) limiting them to small enum sets; `birth_year` carries a 1900..current_year range check. Three carry partial indexes filtered on `archived_at is null` (`csm_standing`, `trustpilot_status`, `ghl_adoption`). Full design lives in `docs/archive/historical/client-page-schema-spec.md`; companion history tables (`client_status_history`, `client_journey_stage_history`, `client_standing_history`) record changes to `status` / `journey_stage` / `csm_standing` over time.
- `nps_standing text` (0021) — Airtable NPS Survey segment mirror (`promoter` / `neutral` / `at_risk` or null), inline check constraint. Always written by `update_client_from_nps_segment` RPC; the function also **always** auto-derives `csm_standing` from this column (NPS-is-gospel post-2026-05-08, migration 0027 — flipped from override-sticky shipped at M5.4).

---

### client_team_assignments

Which team members are assigned to which clients. Many-to-many because a client might have a primary CSM and a secondary coach.

```
id                uuid PK
client_id         uuid NOT NULL REFERENCES clients(id)
team_member_id    uuid NOT NULL REFERENCES team_members(id)
role              text NOT NULL  -- 'primary_csm', 'secondary_csm', 'coach'
assigned_at       timestamptz NOT NULL DEFAULT now()
unassigned_at     timestamptz
UNIQUE (client_id, team_member_id, role)
```

**Populated by:** manual seed for V1; CRM ingestion later.

**Read by:** Ella (to know which CSM to escalate to), CSM Co-Pilot.

---

### slack_channels

Channel metadata, mapped to clients where applicable.

```
id                uuid PK
slack_channel_id  text UNIQUE NOT NULL  -- Slack's C... identifier
name              text NOT NULL
client_id         uuid REFERENCES clients(id)  -- null if not a client channel
is_private        boolean NOT NULL
is_archived       boolean NOT NULL DEFAULT false
ella_enabled      boolean NOT NULL DEFAULT false  -- beta gating
metadata          jsonb DEFAULT '{}'::jsonb
created_at        timestamptz NOT NULL DEFAULT now()
updated_at        timestamptz NOT NULL DEFAULT now()
```

**Populated by:** Slack ingestion on bot install + periodic refresh.

**Read by:** Ella (to gate which channels she responds in), dashboards.

**Note on `ella_enabled`:** this is the beta gate. For the 2-3 pilot clients, set this to `true` on their channel. Ella only responds in channels where this is true.

---

### slack_messages

Ingested message history. We store the raw message plus a normalized version for retrieval.

```
id                uuid PK
slack_channel_id  text NOT NULL  -- matches slack_channels.slack_channel_id
slack_ts          text NOT NULL  -- Slack's timestamp, unique per message
slack_thread_ts   text           -- null if not in a thread
slack_user_id     text NOT NULL  -- author's Slack ID
author_type       text NOT NULL  -- 'client', 'team_member', 'bot', 'workflow', 'unknown'
text              text NOT NULL
message_type      text NOT NULL DEFAULT 'message'  -- 'message', 'thread_reply', 'bot_message', 'workflow_submission'
message_subtype   text           -- 'accountability_submission', 'nps_submission', etc. Tagged during ingestion.
raw_payload       jsonb NOT NULL  -- full original event for future extraction
sent_at           timestamptz NOT NULL
ingested_at       timestamptz NOT NULL DEFAULT now()
UNIQUE (slack_channel_id, slack_ts)
```

**Populated by:** Slack ingestion — historical backfill + real-time events going forward.

**Read by:** Ella (for retrieval: "has this client asked this before"), CSM Co-Pilot (for sentiment/activity signals, accountability submissions, NPS submissions).

**Note on accountability submissions:** clients submit accountability via a Slack Workflow form. The form submission posts back to the channel as a structured message. The ingestion pipeline tags these with `message_subtype = 'accountability_submission'` so CSM Co-Pilot can query them without re-parsing. The structured form fields are preserved in `raw_payload` and can be extracted into `metadata` during ingestion if we want fast access to specific fields.

---

### calls

One row per Fathom call.

```
id                uuid PK
external_id       text UNIQUE NOT NULL  -- Fathom's call ID
source            text NOT NULL DEFAULT 'fathom'  -- allows adding other sources later
title             text
call_category     text NOT NULL  -- 'client', 'internal', 'external', 'unclassified', 'excluded'
call_type         text  -- 'sales', 'onboarding', 'csm_check_in', 'coaching', 'team_sync', 'leadership', 'unknown'
classification_confidence float  -- 0-1, how sure we are of the category
classification_method text  -- 'participant_match', 'title_pattern', 'llm_classified', 'manual'
primary_client_id uuid REFERENCES clients(id)  -- for client calls, the primary client
started_at        timestamptz NOT NULL
duration_seconds  integer
recording_url     text
transcript        text  -- full transcript
summary           text  -- Fathom's or our generated summary
is_retrievable_by_client_agents boolean NOT NULL DEFAULT false  -- safety flag: can Ella retrieve context from this?
raw_payload       jsonb NOT NULL  -- full Fathom API response
ingested_at       timestamptz NOT NULL DEFAULT now()
```

**Call categories explained:**
- `client` — call with one or more known clients. Safe to index for client-facing agents, scoped to those clients.
- `internal` — team-only meeting. Indexed for internal agents (CSM Co-Pilot, Exec Briefing) only. Never retrievable by Ella or other client-facing agents.
- `external` — non-client external parties (vendors, unconverted prospects). Not indexed for retrieval by default.
- `unclassified` — couldn't determine. Held for human review; no retrieval allowed until classified.
- `excluded` — personal or irrelevant, tagged to skip future ingestion attempts.

**Safety:** `is_retrievable_by_client_agents` is the hard gate. Ella's retrieval queries MUST filter on this flag. Defaults to false. Only flipped to true after confident classification as a `client` call.

**Populated by:** Fathom ingestion (webhook + periodic pull). Classification runs at ingestion time using participant matching first, title patterns second, LLM classification as fallback.

**Read by:** Ella (only `client` category, only for the matched client), CSM Co-Pilot (`client` + `internal`), Sales Call Analysis Agent later, Executive Briefing (`internal` + `client` summaries).

**Note on `call_type`:** finer-grained sub-type within the category. For client calls: sales, onboarding, csm_check_in, coaching. For internal: team_sync, leadership, strategy. Inferred via rules + LLM classification.

---

### call_participants

Who was on each call. Supports both internal team and clients.

```
id                uuid PK
call_id           uuid NOT NULL REFERENCES calls(id)
email             text NOT NULL
display_name      text
client_id         uuid REFERENCES clients(id)        -- null if not a client or not matched
team_member_id    uuid REFERENCES team_members(id)   -- null if not team or not matched
participant_role  text  -- 'host', 'attendee'
UNIQUE (call_id, email)
```

**Populated by:** Fathom ingestion — matches emails to known clients/team.

**Read by:** CSM Co-Pilot (to attribute calls to the right client), Ella.

---

### call_action_items

Action items extracted from call summaries.

```
id                uuid PK
call_id           uuid NOT NULL REFERENCES calls(id)
owner_type        text  -- 'client', 'team_member', 'unknown'
owner_client_id   uuid REFERENCES clients(id)
owner_team_member_id uuid REFERENCES team_members(id)
description       text NOT NULL
due_date          date
status            text NOT NULL DEFAULT 'open'  -- 'open', 'done', 'cancelled'
extracted_at      timestamptz NOT NULL DEFAULT now()
completed_at      timestamptz
```

**Populated by:** Fathom ingestion (Fathom provides action items in its API) + later by Claude extraction on raw transcripts for higher quality.

**Read by:** CSM Co-Pilot (for accountability tracking), later a Task Management Agent.

---

### documents

Anything Ella should know: course lessons, FAQs, SOPs, onboarding docs, methodology documents.

```
id                uuid PK
source            text NOT NULL  -- 'drive', 'manual', 'notion', etc.
external_id       text           -- source-specific ID for re-sync
title             text NOT NULL
content           text NOT NULL  -- full text
document_type     text NOT NULL  -- 'course_lesson', 'faq', 'sop', 'methodology', 'onboarding'
tags              text[] NOT NULL DEFAULT '{}'::text[]  -- ad-hoc labels: 'module_1', 'sales', 'onboarding', etc.
metadata          jsonb DEFAULT '{}'::jsonb  -- source-specific (Drive URL, author, tags)
is_active         boolean NOT NULL DEFAULT true  -- soft archive for Ella's retrieval
created_at        timestamptz NOT NULL DEFAULT now()
updated_at        timestamptz NOT NULL DEFAULT now()
archived_at       timestamptz
UNIQUE (source, external_id)
```

**Populated by:** Drive ingestion + manual seed for FAQs + call ingestion (call summaries are created as documents with `document_type = 'call_summary'` and `metadata.call_id` linking back to `calls`).

**Read by:** Ella (via `document_chunks` for retrieval).

**Retrieval pattern:** course content, FAQs, and SOPs are globally retrievable by any client. Call summaries are filtered by client — Ella only retrieves a client's own call summaries when answering that client's questions. The filter is `metadata->>'client_id' = <asking_client_id>` for `document_type = 'call_summary'` rows.

**On raw transcripts vs. summaries:** full transcripts are stored in `calls.transcript` but not indexed for retrieval. Only the summary + extracted key points land in `documents` / `document_chunks`. Raw transcripts are too noisy for retrieval; summaries give Ella clean, high-signal context.

---

### document_chunks

Documents split into retrievable chunks with vector embeddings.

```
id                uuid PK
document_id       uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE
chunk_index       integer NOT NULL  -- position within the document
content           text NOT NULL
embedding         vector(1536)      -- OpenAI text-embedding-3-small dimension; adjust if we use another model
token_count       integer
metadata          jsonb DEFAULT '{}'::jsonb
created_at        timestamptz NOT NULL DEFAULT now()
UNIQUE (document_id, chunk_index)
```

**Populated by:** document ingestion pipeline (chunk + embed on new/updated documents).

**Read by:** Ella's retrieval via `shared/kb_query.py`.

**Note:** embedding model choice is a small ADR we need. I'd recommend OpenAI `text-embedding-3-small` (1536 dim) for V1 — good quality, cheap, well-supported. We can switch to Voyage or Cohere later; changing models means re-embedding, not schema change.

---

### agent_runs

Every agent execution, logged. Universal across all agents.

```
id                uuid PK
agent_name        text NOT NULL  -- 'ella', 'csm_copilot', 'sales_call_analysis', etc.
trigger_type      text NOT NULL  -- 'slack_mention', 'schedule', 'webhook', 'manual'
trigger_metadata  jsonb          -- what triggered it (e.g. Slack event payload)
input_summary     text           -- short human-readable description of the input
output_summary    text           -- short human-readable description of the output
status            text NOT NULL  -- 'success', 'escalated', 'error', 'skipped'
confidence_score  float          -- if the agent computes one
llm_model         text           -- e.g. 'claude-sonnet-4-5', 'claude-opus-4-7'
llm_input_tokens  integer
llm_output_tokens integer
llm_cost_usd      numeric(10, 4)
duration_ms       integer
error_message     text
metadata          jsonb DEFAULT '{}'::jsonb
started_at        timestamptz NOT NULL DEFAULT now()
ended_at          timestamptz
```

**Populated by:** every agent, via `shared/logging.py`.

**Read by:** analytics dashboards, eval runner, debugging.

---

### escalations

HITL escalations. When an agent isn't confident or an action requires human approval.

```
id                uuid PK
agent_run_id      uuid NOT NULL REFERENCES agent_runs(id)
agent_name        text NOT NULL
reason            text NOT NULL  -- why it escalated
context           jsonb NOT NULL  -- full context the human needs to decide
proposed_action   jsonb           -- what the agent wanted to do
assigned_to       uuid REFERENCES team_members(id)
status            text NOT NULL DEFAULT 'open'  -- 'open', 'approved', 'rejected', 'edited', 'expired'
resolution        jsonb           -- what the human actually decided
resolution_note   text            -- free-text explanation if provided
resolved_by       uuid REFERENCES team_members(id)
resolved_at       timestamptz
created_at        timestamptz NOT NULL DEFAULT now()
```

**Populated by:** any agent via `shared/hitl.py`.

**Read by:** HITL approval UI, eval dataset builders (rejected/edited escalations are gold for evals).

---

### agent_feedback

When a human corrects an agent — either explicitly (clicks "this was wrong") or implicitly (edits the output before sending). This is the source of truth for eval golden datasets.

```
id                uuid PK
agent_run_id      uuid NOT NULL REFERENCES agent_runs(id)
feedback_type     text NOT NULL  -- 'correction', 'thumbs_up', 'thumbs_down', 'edit', 'override'
original_output   jsonb          -- what the agent produced
corrected_output  jsonb          -- what the human thinks it should have been
note              text
provided_by       uuid REFERENCES team_members(id)
created_at        timestamptz NOT NULL DEFAULT now()
```

**Populated by:** HITL flows, Zain's QA work, CSM thumbs-up/down actions in Slack.

**Read by:** eval harness, agent improvement workflows.

---

### nps_submissions

```
id                uuid PK
client_id         uuid NOT NULL REFERENCES clients(id)
score             integer NOT NULL CHECK (score >= 0 AND score <= 10)
feedback          text
survey_source     text
submitted_at      timestamptz NOT NULL
ingested_at       timestamptz NOT NULL DEFAULT now()
recorded_by       uuid REFERENCES team_members(id)  -- added 0017
```

**Note on `recorded_by`:** added in 0017. Identifies which team member entered an NPS score manually via the Gregory dashboard. Null for entries from automated sources (Slack workflow, future Airtable webhook).

---

### client_health_scores

Computed periodically by CSM Co-Pilot.

```
id                uuid PK
client_id         uuid NOT NULL REFERENCES clients(id)
score             integer NOT NULL CHECK (score >= 0 AND score <= 100)
tier              text NOT NULL  -- 'green', 'yellow', 'red'
factors           jsonb NOT NULL  -- what went into the score
computed_at       timestamptz NOT NULL DEFAULT now()
computed_by_run_id uuid REFERENCES agent_runs(id)
```

**Note:** one row per client per computation run, so we keep history.

---

### alerts

Actionable alerts generated by CSM Co-Pilot or other agents.

```
id                uuid PK
client_id         uuid REFERENCES clients(id)
team_member_id    uuid REFERENCES team_members(id)  -- who should act on it
alert_type        text NOT NULL  -- 'churn_risk', 'upsell_opportunity', 'referral_opportunity', 'refund_risk', 'nps_detractor', 'stalled_progress'
severity          text NOT NULL  -- 'low', 'medium', 'high', 'critical'
title             text NOT NULL
description       text NOT NULL
context           jsonb          -- evidence / reasoning
status            text NOT NULL DEFAULT 'open'  -- 'open', 'acknowledged', 'resolved', 'dismissed'
created_by_run_id uuid REFERENCES agent_runs(id)
acknowledged_at   timestamptz
resolved_at       timestamptz
created_at        timestamptz NOT NULL DEFAULT now()
```

---

### client_upsells

Added in `0017_client_page_schema_v1.sql` for the Gregory client detail page Financials section.

```
id                uuid PK
client_id         uuid NOT NULL REFERENCES clients(id) ON DELETE CASCADE
amount            numeric(10, 2)
product           text
sold_at           date
notes             text
recorded_by       uuid REFERENCES team_members(id)
created_at        timestamptz NOT NULL DEFAULT now()
updated_at        timestamptz NOT NULL DEFAULT now()
```

**Populated by:** master sheet importer (legacy upsells from the Active++ sheet) and the Gregory dashboard (going forward — `recorded_by` set to the acting team member).

**Read by:** Gregory dashboard's Financials section on `/clients/[id]`. Future CSM Co-Pilot for revenue-aware reasoning.

**Note on cascade-delete:** `client_id` cascades because upsells are owned by their client (same pattern as `call_participants` / `call_action_items`). `amount` and `sold_at` are nullable to accommodate legacy master sheet rows that have free-text descriptions without parseable amounts. Per-table doc: `docs/schema/client_upsells.md`.

---

### client_status_history

Added in `0017_client_page_schema_v1.sql`. Append-only audit trail for `clients.status` changes.

```
id          uuid PK
client_id   uuid NOT NULL REFERENCES clients(id)
status      text NOT NULL
changed_at  timestamptz NOT NULL DEFAULT now()
changed_by  uuid REFERENCES team_members(id)
note        text
```

**Populated by:** migration seed at apply time (one row per non-archived client with non-null status; 128 rows on first apply against cloud) + the Gregory dashboard's status-edit endpoint. Application-layer writes — pattern mirrors `client_team_assignments`, NOT trigger-based, so the audit logic stays visible in dashboard code.

**Read by:** Gregory dashboard's Lifecycle & Standing section on `/clients/[id]` (status timeline). Future churn analysis.

**Note on no-cascade:** `client_id` does not cascade — preserves history if a client is ever hard-deleted (which the project doesn't do today; soft-delete via `archived_at` is the convention). Mirrors `client_team_assignments`. Per-table doc: `docs/schema/client_status_history.md`.

---

### client_journey_stage_history

Added in `0017_client_page_schema_v1.sql`. Same shape and write pattern as `client_status_history` but for `clients.journey_stage`.

```
id              uuid PK
client_id       uuid NOT NULL REFERENCES clients(id)
journey_stage   text                                          -- nullable, mirrors clients.journey_stage
changed_at      timestamptz NOT NULL DEFAULT now()
changed_by      uuid REFERENCES team_members(id)
note            text
```

**Populated by:** migration seed at apply time (one row per non-archived client with non-null journey_stage; 0 rows on first apply because no current non-archived client has a non-null journey_stage) + Gregory dashboard's journey-stage-edit endpoint.

**Read by:** Gregory dashboard's Lifecycle & Standing section. Future cohort reporting (e.g. time spent in onboarding).

Per-table doc: `docs/schema/client_journey_stage_history.md`.

---

### client_standing_history

Added in `0017_client_page_schema_v1.sql`. Same shape and write pattern as `client_status_history` but for `clients.csm_standing`. Carries the same 4-value check constraint as the `clients` column it mirrors.

```
id              uuid PK
client_id       uuid NOT NULL REFERENCES clients(id)
csm_standing    text NOT NULL CHECK (csm_standing IN ('happy', 'content', 'at_risk', 'problem'))
changed_at      timestamptz NOT NULL DEFAULT now()
changed_by      uuid REFERENCES team_members(id)
note            text
```

**Populated by:** **NOT seeded at migration time** — `clients.csm_standing` has no values when 0017 applies. First rows land via the master sheet importer (Chunk C, `scripts/import_master_sheet.py`) which writes one history row per non-null `csm_standing` it sets. Going forward, the Gregory dashboard's standing-edit endpoint also writes here.

**Read by:** Gregory dashboard's Lifecycle & Standing section (standing timeline). Future CSM Co-Pilot for trajectory-aware reasoning.

Per-table doc: `docs/schema/client_standing_history.md`.

---

## Postgres Functions (RPCs)

The dashboard invokes Postgres functions for operations that must be atomic — typically a write to a primary table plus a history-row insert or a multi-row reattribution. All functions follow the same pattern: `language plpgsql security definer`, single transaction, idempotent-when-unchanged where applicable, with `grant execute ... to service_role` on the M4-era ones. Each function's full source lives in its migration file; this section is a one-line summary.

| Function | Migration | Purpose |
|---|---|---|
| `change_primary_csm(p_client_id uuid, p_new_team_member_id uuid) → void` | 0014 | Atomic primary-CSM swap. Archives the existing active assignment (`unassigned_at = now()`) and inserts a new one. |
| `match_document_chunks(...) → setof match_result` | 0008, 0010 | Filtered vector-search retrieval primitive used by Ella. Excludes `call_summary` and `call_transcript_chunk` from global-mode results (safety invariant). |
| `merge_clients(p_source_id uuid, p_target_id uuid) → jsonb` | 0015 | Atomic merge of an auto-created (`needs_review`-tagged) client into a canonical client. Reattributes calls + participants + transcript chunks; idempotent via `metadata.merged_into`. |
| `update_call_classification(p_call_id uuid, p_changes jsonb, p_changed_by uuid) → jsonb` | 0016 | Atomic edit of `calls.call_category / call_type / primary_client_id` with per-field rows in `call_classification_history`. Auto-clears `primary_client_id` on non-client category. |
| `update_client_status_with_history(p_client_id uuid, p_new_status text, p_changed_by uuid default null, p_note text default null) → clients` | 0018 / replaced in 0019 | Atomic `clients.status` update + `client_status_history` insert. Validates enum (`active`/`paused`/`ghost`/`leave`/`churned` — allowlist expanded in 0019 to mirror the new check constraint). Idempotent no-op when `current = new` (no history row written). Called by the Gregory dashboard from Section 1 (Identity & Contact). |
| `update_client_journey_stage_with_history(p_client_id uuid, p_new_journey_stage text, p_changed_by uuid default null, p_note text default null) → clients` | 0018 | Atomic `clients.journey_stage` update + `client_journey_stage_history` insert. No enum validation (free-text in V1). Allows null (clears the field). Idempotent via `IS NOT DISTINCT FROM`. |
| `update_client_csm_standing_with_history(p_client_id uuid, p_new_csm_standing text, p_changed_by uuid default null, p_note text default null) → clients` | 0018 | Atomic `clients.csm_standing` update + `client_standing_history` insert. Validates enum (`happy`/`content`/`at_risk`/`problem`) or null. **Clearing-to-null skips the history insert** because `client_standing_history.csm_standing` is NOT NULL by design. |
| `insert_nps_submission(p_client_id uuid, p_score integer, p_feedback text default null, p_recorded_by uuid default null) → nps_submissions` | 0018 | Manual NPS-score entry from the Gregory dashboard. Stamps `survey_source = 'manual_dashboard_entry'` and `submitted_at = now()`. Validates 0-10 score range. |
| `update_client_from_nps_segment(p_client_email text, p_segment text) → clients` | 0021 (replaced 0027) | Combined NPS-segment update for the V1 Airtable webhook receiver. Always writes `clients.nps_standing` AND always auto-derives `clients.csm_standing` from the segment via `update_client_csm_standing_with_history` (NPS-is-gospel — flipped from override-sticky in 0027). Looks up the client by `p_client_email` against `clients.email` primary + `clients.metadata.alternate_emails` fallback (case-insensitive, whitespace-stripped, `archived_at IS NULL`, `LIMIT 1`). Segment → csm_standing mapping is encoded only inside this function: `promoter`→`happy`, `neutral`→`content`, `at_risk`→`at_risk`. `'problem'` has no auto-derive path — manual-only. Idempotency on csm_standing writes is handled by the underlying 0018 RPC's `IS NOT DISTINCT FROM` check (no history row when value unchanged). Attribution flows through Gregory Bot UUID with note `'auto-derived from NPS segment <segment> (NPS-is-gospel)'`. Raises with descriptive hints on invalid segment, missing email, or no client match. |

`p_changed_by` and `p_recorded_by` on the M4-era functions are nullable. Auth context isn't wired through Server Actions in V1; every history row currently records `changed_by = null`. Followup logged in `docs/archive/historical/known-issues.md` to wire `auth.users → team_members` resolution.

## What's Deliberately NOT in V1

- **`companies` table.** If/when we need to group clients by company (for B2B), we add this. For the consumer $9K program, clients are individuals.
- **CRM tables.** No `crm_contacts`, `pipeline_stages`, etc. yet. Phase 2.
- **Marketing tables.** Ad spend, landing page data, etc. Phase 3.
- **Team scorecard tables.** CSM performance metrics. Phase 3.
- **Multi-tenant tables.** When we deploy to B2B clients, each gets their own Supabase project — no multi-tenancy in the schema itself.
- **Sensitive PII we don't need yet.** Addresses, SSNs, payment info — we don't ingest what we don't need.

## Open Questions for Review

1. **Embedding model:** OpenAI `text-embedding-3-small` (1536 dim) vs. Voyage vs. Cohere. My rec: OpenAI for V1, revisit when we hit scale.
2. **Soft-delete policy:** archived_at on core entities only, or everywhere? My rec: core only. Ingested source data (messages, calls) is cheap to retain; deletion is rare.
3. **`accountability_submissions.content` shape:** depends on your current form. Can you send me an example submission so we pin the jsonb structure?
4. **Ella's beta gating:** is the `slack_channels.ella_enabled` flag the right model, or should it be a separate `ella_enabled_channels` table? My rec: flag is fine for V1; we promote to its own table if behavior diverges per channel.
5. **Timezone handling:** all timestamps as `timestamptz` (UTC). Client-facing displays convert to their local timezone. Agreed?

## What Comes Next

Once you review and we agree on the shape:

1. I draft the actual SQL migration files — one per logical unit (core entities, slack, calls, documents, agent infrastructure, co-pilot prep), numbered
2. I draft `docs/schema/` markdown — one file per table, in the format specified in CLAUDE.md
3. You take both into Claude Code with a prompt like: "Implement the migrations in `supabase/migrations/` and the docs in `docs/schema/`, per the design in this file. Follow CLAUDE.md conventions."
4. Claude Code generates the files, you review, run migrations against Supabase, commit.

Let me know what to adjust.

## Changelog

Post-review constraint tweaks applied after the initial implementation, before migrations were first run against Supabase:

- **Source-scoped `calls.external_id` uniqueness.** Replaced the standalone unique on `external_id` with a composite `UNIQUE (source, external_id)`. Prevents a future Gong / Zoom id collision with an existing Fathom id. Captured in migration `0003_calls.sql`.
- **Non-null `call_action_items.owner_type`.** Added `not null default 'unknown'` so every action item has an owner classification, even when extraction cannot resolve one. Captured in migration `0003_calls.sql`.
- **Partial unique indexes on `team_members` and `clients`.** Replaced the full-table unique constraints on `email` / `slack_user_id` with partial unique indexes filtered on `archived_at is null`, so soft-archived records do not block re-enrollment / re-hire. Captured in migration `0007_partial_unique_archival.sql`. `slack_channels` left unchanged (uses `is_archived` boolean, not `archived_at`, and Slack channel id reuse is not a real scenario).
- **`match_document_chunks` Postgres function.** Retrieval primitive wrapping filtered vector search, with the hard safety property that `call_summary` documents are excluded in global mode and scoped to a single client in client mode. Captured in migration `0008_kb_search.sql`; full contract documented in `document_chunks.md`.
- **`client_team_assignments.metadata` column.** Added to preserve provenance when assignment rows come from heuristic parsing — primarily the clients importer's `raw_owner` string for messy Owner values. `not null default '{}'::jsonb`; no new index. Captured in migration `0009_add_assignments_metadata.sql`; documented in `client_team_assignments.md`.
- **`match_document_chunks` global-mode exclusion extended.** Previously only `call_summary` was excluded in global mode; `call_transcript_chunk` (which also carries `metadata.client_id`) is now covered by the same gate. Safety invariant is now "no client-scoped call content in global results," with both types enforced inside the Postgres function. Captured in migration `0010_kb_search_exclude_transcript_chunks.sql`; documented in `document_chunks.md` and `docs/fulfillment/metadata-conventions.md` §7.
- **Client page schema V1 — 14 columns + 4 tables (M4 Chunk A).** Captured in migration `0017_client_page_schema_v1.sql`. 14 nullable columns added to `clients` (the only `not null` is `arrears` with `default 0`); three carry small enum check constraints (`csm_standing`, `trustpilot_status`, `ghl_adoption`), one carries a year-range check (`birth_year`); three carry partial indexes filtered on `archived_at is null`. `nps_submissions.recorded_by` added (FK → `team_members(id)`, nullable for automated sources). Four new tables: `client_upsells` (cascade-delete on client_id, mirroring owned-by-parent precedent), and three append-only history tables (`client_status_history`, `client_journey_stage_history`, `client_standing_history`) with no-cascade FK to clients (mirroring `client_team_assignments`). History writes are application-layer, not trigger-based — pattern keeps audit logic visible in dashboard code. Migration seeds `client_status_history` (128 rows from non-archived clients with non-null status) and `client_journey_stage_history` (0 rows — no non-archived client currently has a non-null `journey_stage`). `client_standing_history` is seeded later by the master sheet importer (Chunk C). Full design lives in `docs/archive/historical/client-page-schema-spec.md`.
- **Client history-write RPCs + NPS-entry helper (M4 Chunk B2).** Captured in migration `0018_client_history_rpcs.sql`. Four `language plpgsql security definer` functions with explicit `grant execute ... to service_role`: `update_client_status_with_history`, `update_client_journey_stage_with_history`, `update_client_csm_standing_with_history`, and `insert_nps_submission`. The first three are atomic update + history-row inserts that the dashboard's edit endpoints invoke; `csm_standing` clear-to-null skips the history insert because `client_standing_history.csm_standing` is NOT NULL. The fourth handles manual NPS-score entry from Section 2 of the detail page. All four idempotent or validating per their contracts; smoke-tested end-to-end against cloud (real change → history-row → revert; invalid score raises). `p_changed_by` / `p_recorded_by` are nullable — auth context isn't wired through Server Actions in V1, so every history row currently records `changed_by = null` (followup logged).
- **Status vocabulary expansion + first DB-level CHECK on `clients.status` (M5.3).** Captured in migration `0019_status_add_leave.sql`. Added the constraint `clients_status_check` permitting `('active', 'paused', 'ghost', 'leave', 'churned')`; the column had no DB-level constraint until now (vocabulary was enforced only application-side). `leave` is a CSM decision to let a client go without chasing — distinct from `churned` (post-program). `update_client_status_with_history` from 0018 was replaced (same signature, same body shape) so its allowlist + hint string mirror the new five-value vocabulary; without this the dashboard's status-edit path would reject `'leave'` even with the DB constraint accepting it. No data migration: `'churned'` stays as the value, history is immutable. The `/clients` list page default-hides `'churned'` and `'leave'` and surfaces them via a "Show churned & leave" toggle chip — explicit status filter wins over the default-hide.
- **Trustpilot vocabulary rename to match the Financial Master Sheet (M5.3b).** Captured in migration `0020_trustpilot_rename_vocab.sql`. Pure structural rename — no logic changes, no auto-set rules, no history table. Drops `clients_trustpilot_status_check`, runs an in-place 1:1 UPDATE (`given`→`yes`, `declined`→`no`, `not_asked`→`ask`, `pending`→`asked`; ELSE preserves any unexpected value so the new constraint fails loudly rather than silently nulling), then re-adds `clients_trustpilot_status_check` with the new four-value allowlist. Pre/post-apply distribution unchanged at 203 rows total: 88 NULL + 21 yes + 69 no + 21 ask + 4 asked. Semantic shift on `'ask'` is intentional — it's imperative ("you should ask") rather than descriptive ("we have not asked"); `'asked'` (past tense) is the in-progress state. The importer's `TRUSTPILOT_MAP` in `scripts/import_master_sheet.py` collapsed to identity in the same chunk so a re-run writes the new vocab. Cleanup of clients who land in `'ask'` based on Scott's tenure-and-standing rule (clients who shouldn't be asked yet) is a separate manual pass.
- **NPS standing column + Gregory Bot sentinel + combined NPS-segment RPC (M5.4 Path 1).** Captured in migration `0021_nps_standing_and_gregory_bot.sql`. Three changes bundled because they ship together as the foundation the Airtable webhook receiver (next chunk) calls into. Adds nullable `clients.nps_standing` text column with inline check constraint allowing null or `('promoter', 'neutral', 'at_risk')` — Airtable NPS Survey segment mirror, normalized lowercase at the receiver boundary. Inserts the `Gregory Bot` `system_bot` sentinel team_members row with pinned UUID `cfcea32a-062d-4269-ae0f-959adac8f597` (hardcoded literal in both the INSERT and the RPC body — grep the UUID to find both call sites; metadata carries `sentinel: true` so listings can exclude it). Creates `update_client_from_nps_segment(p_client_email text, p_segment text) → clients` with override-sticky semantics: always writes `nps_standing`; auto-derives `csm_standing` only when current value is null OR the most recent `client_standing_history` row's `changed_by = Gregory Bot UUID` (clients edited manually via the dashboard or master sheet importer carry the sticky win). Auto-write delegates to `update_client_csm_standing_with_history` (0018) for audit consistency + idempotency. Email lookup: case-insensitive, whitespace-stripped, primary `clients.email` then `clients.metadata.alternate_emails` fallback, `archived_at IS NULL`, `LIMIT 1`. End-to-end probe against Grayson Carpenter exercised every branch (auto-derive null path, auto-derive Gregory-Bot-history path, sticky-on-manual skip path, both error paths) and reverted clean.