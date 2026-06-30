# Fulfillment architecture

How the CSM-side pieces fit together. Read this before working on any fulfillment component. For the
goal and principles, see [README.md](README.md); for the rules, [conventions.md](conventions.md).

## One-sentence summary

External tools (Fathom, Slack, Google Calendar, Airtable) feed data into Supabase through dedicated
ingestion paths; agents read from Supabase, reason with Claude, and either write derived data (health
scores, call reviews) or assist in Slack (Ella); the Next.js dashboard and Slack are thin surfaces over
that data.

## The layers (durable shape)

```
INTERFACES        Next.js dashboard + Slack. Thin. Trigger agents, render output.
     ▲
AGENTS            gregory (health), ella (Slack), call_reviewer. Read the KB, call Claude,
     │            write derived data or post to Slack. Escalate when uncertain.
     ▼
KNOWLEDGE BASE    Supabase (Postgres + pgvector). Source of truth. Everything mirrored here.
     ▲
INGESTION         One module per source. Pulls from the external tool, writes canonical rows.
     ▼
EXTERNAL TOOLS    Fathom, Slack, Google Calendar, Airtable. Accessed only by ingestion. Replaceable.
```

## Subsystems (what the code actually does today)

### 1. Call ingestion — `ingestion/fathom/`
Fathom calls land two ways, both converging on `pipeline.ingest_call()`:
- **Live webhook** `api/fathom_events.py` — Fathom fires `new-meeting-content-ready`; the handler
  verifies the HMAC signature, dedupes via `webhook_deliveries`, adapts the payload, and ingests.
- **Daily backfill cron** `api/fathom_backfill.py` (`0 8 * * *`) — safety net that pages recent
  meetings from the Fathom API and ingests any the webhook missed. Idempotent on `(source, external_id)`.

Ingestion runs a **classification cascade** (`classifier.py`) to set `call_category` /
`primary_client_id` / `is_retrievable_by_client_agents`, then writes `calls`, `call_participants`,
`documents` (summary + transcript chunks), `document_chunks` (embedded), and `call_action_items`. The
cascade and the retrievability gate are specified in [metadata-conventions.md](metadata-conventions.md)
§5–7. Unmatched 1:1-with-Scott participants get an auto-created `clients` row tagged `needs_review`.

### 2. Call reviews — `agents/call_reviewer/`
On each client-category call, `reviewer.py` makes a single Sonnet (`claude-sonnet-4-6`) pass over the
transcript and produces a structured review (`pain_points`, `wins`, `dodged_questions`, `sentiment_arc`,
`questions_asked`). Stored as a `documents` row (`document_type='call_review'`, **`is_active=false`** so
it never enters retrieval — it's a display artifact). A sentiment tier (green/yellow/red) is derived and
shown on call-adjacent surfaces. The review feeds two things: the Gregory health brain and the Calls
detail page.

### 3. Health scoring — `agents/gregory/`
`api/gregory_brain_cron.py` (`0 9 * * *`, daily) sweeps active clients and writes one
`client_health_scores` row each. The score is a transparent weighted sum of signals (`scoring.py`,
`signals.py`):

| Signal | Weight | Source |
|---|---|---|
| `ai_call_signal` | 0.50 | Sonnet over the client's recent `call_review` documents — dominant signal; also emits the qualitative concerns |
| `call_cadence` | 0.20 | deterministic, from call recency |
| `overdue_action_items` | 0.10 | deterministic, from `call_action_items` |
| `latest_nps` | 0.20 | deterministic, from `clients.nps_standing` |

Final score is `0–100`; tiers are `green ≥70`, `yellow 40–69`, `red <40`. If every signal returns its
neutral value (no data), the client lands at 50/yellow — never green by accident. Concerns are not a
separate gate; they flow out of `ai_call_signal`.

### 4. Ella — `agents/ella/` (split-path since 2026-05-23)
Two independent paths:
- **Reactive @-mention** (`agent.handle_at_mention`) — synchronous. One Sonnet (`claude-sonnet-4-6`)
  call with KB chunks + recent channel context visible; returns structured JSON
  `{response_text, escalate, handoff_reasoning}`; posts the answer, or an in-channel acknowledgement plus
  an escalation when one of the four categories fires (judgment-call / emotional / money / no-good-context).
  No classifier, no Haiku enum. Triggered by `api/slack_events.py`.
- **Passive observation** (`passive_monitor.evaluate_passive_trigger`) — **observation-only**. For every
  non-mention client message in a `passive_monitoring_enabled` channel, a decision Haiku
  (`claude-haiku-4-5`) picks `respond` / `acknowledge_and_escalate` / `skip` and tags a digest category.
  Post-split it **does not post in channels or send DMs** — its only output is feeding the daily digest
  (`pending_digest_items`). `api/passive_ella_cron.py` (`* * * * *`) drains the legacy
  `pending_ella_responses` queue, which nothing new enters (effectively a no-op kept for safety).

Ella's surfacing is three Slack channels (no DMs, per the 2026-05-28 redesign):
- `#cs-call-summaries` — per-call summary + sentiment pill on ingest (`cs_call_summary_post.py`); plus
  `api/cs_missed_recording_cron.py` (`*/15`) posts "recording not available" for calendar meetings with
  no matching call.
- `#daily-digest` — `api/ella_daily_digest_cron.py` (`30 20 * * *`) drains 24h of digest items, Haiku-ranks
  the top 25, posts a numbered list.
- `#unanswered-channels` — `api/ella_unanswered_flagger_cron.py` (`*/15`) flags `open_ended` client
  messages aging past 2h with no CSM reply.

### 5. Client data + ops
- **Clients** (`clients` table) — Active++ from the master sheet is canonical; see
  [conventions.md](conventions.md) § Data hygiene. State changes are audited in `client_status_history`,
  `client_journey_stage_history`, `client_standing_history`.
- **NPS** — Airtable → Make.com → `api/airtable_nps_webhook.py`; the latest segment auto-derives
  `clients.csm_standing` via an RPC.
- **Client meetings** — `api/client_meetings_sync_cron.py` (`30 4 * * *`) reads CSM Google Calendars
  through one OAuth token, matches client emails to external-attendee events, and upserts `client_meetings`
  on a rolling 14-day window (older months frozen). Drives "meetings this month" on the client list.
  *(The `/teams` Meeting Tracker page reads the same Google Calendars via `teams_calendar_sync_cron`;
  `client_meetings_sync_cron` is the separate per-client feed. Both are live.)*
- **Accountability** — `api/accountability_notification_cron.py` (`0 12 * * *`) compares yesterday's
  Airtable accountability submissions against active clients and posts the missing list per CSM.
- **FAQ digest** — `api/faq_digest_cron.py` (`0 19 * * 5`, Fridays) extracts `questions_asked` from the
  week's call reviews and DMs Scott a deduped digest.

### 6. Dashboard surfaces (`app/`)
| Route | Shows | Backed by |
|---|---|---|
| `/dashboard` | notification hub: sentiment flags, missed recordings, needs-review/ghost clients, digest flags | `lib/db/fulfillment-dashboard.ts` |
| `/clients`, `/clients/[id]` | client list (inline-editable) + per-client detail | `lib/db/clients.ts` |
| `/calls`, `/calls/[id]` | call list + per-call transcript/summary/review/classification | `lib/db/calls.ts` |
| `/teams` | per-CSM meeting tracker for the week | `lib/db/teams.ts` |
| `/cost-hub` | Anthropic LLM spend by bucket + subscriptions (admin) | `lib/db/cost-hub.ts` |

### 7. Cost hub
`/cost-hub` rolls up `agent_runs` LLM cost/token columns into five buckets — Ella Sonnet, Ella Haiku,
Call review Sonnet, Call review Haiku, and Gregory brain Sonnet (each keyed on `agent_name` + a model
prefix; see `lib/db/cost-hub.ts`) — across recent periods, plus manually-entered subscriptions.

## Cron inventory (fulfillment, from `vercel.json`)

| Cron | Schedule (UTC) | Purpose |
|---|---|---|
| `fathom_backfill` | `0 8 * * *` | safety-net Fathom ingest |
| `gregory_brain_cron` | `0 9 * * *` | recompute health scores |
| `accountability_notification_cron` | `0 12 * * *` | missing-accountability post (7am EST) |
| `client_meetings_sync_cron` | `30 4 * * *` | Google Calendar → client_meetings |
| `teams_calendar_sync_cron` | `*/30 * * * *` | /teams calendar sync |
| `passive_ella_cron` | `* * * * *` | drain legacy passive queue (no-op) |
| `ella_daily_digest_cron` | `30 20 * * *` | post #daily-digest |
| `ella_unanswered_flagger_cron` | `*/15 * * * *` | post #unanswered-channels |
| `cs_missed_recording_cron` | `*/15 * * * *` | post missing-recording notices |
| `faq_digest_cron` | `0 19 * * 5` | Friday FAQ digest to Scott |

Webhooks: `fathom_events` (Fathom), `slack_events` (Slack — message ingest + Ella @), `airtable_nps_webhook`
and `airtable_onboarding_webhook` (Make.com).

## Two data-flow examples

**A client asks Ella a question.** Slack delivers the `app_mention` to `api/slack_events.py` →
`agent.handle_at_mention` retrieves client-scoped KB chunks + recent channel context → one Sonnet call →
posts the answer, or an ack + escalation if a category fires. Every step is logged to `agent_runs`.

**Nightly health recompute.** `gregory_brain_cron` fires at 09:00 UTC → for each active client,
`ai_call_signal` reads recent `call_review` docs and calls Sonnet, the deterministic signals read
cadence/overdue/NPS → `scoring.py` combines them → a `client_health_scores` row is written → the
`/clients` list and `/clients/[id]` detail render it.

## What lives where

| Thing | Location |
|---|---|
| Migrations | `supabase/migrations/` |
| Per-table schema docs | `docs/schema/` |
| Agent code / per-agent docs | `agents/<name>/` · `docs/agents/<name>.md` |
| Ingestion code | `ingestion/<source>/` |
| Runbooks | `docs/runbooks/` |
| Conventions | `docs/fulfillment/conventions.md` + `metadata-conventions.md` |
| ADRs | `docs/decisions/` |

This doc describes current behavior. For the history of what shipped when, use git history and
`docs/archive/`.
