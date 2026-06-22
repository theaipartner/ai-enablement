# Ella — Slack agent

Ella answers client questions in Slack and flags messages that need a human, with CSM oversight. Since
the **2026-05-23 split** she runs two independent paths: a synchronous **reactive @-mention** responder
and an **observation-only passive** monitor. This doc covers agent behavior; for the surrounding crons,
channels, and digest plumbing see [`../fulfillment/architecture.md`](../fulfillment/architecture.md).

Code: `agents/ella/`. Reads from Supabase (KB + Slack mirror); posts to Slack via `shared/slack_post`.

## Reactive @-mention path (synchronous)

Entry: `agent.handle_at_mention(payload)`, dispatched from `api/slack_events.py` →
`ingestion/slack/realtime_ingest.py` when Ella is @-mentioned. Model `claude-sonnet-4-6`, max 1024 tokens,
**one** LLM call with the KB chunks visible — no classifier, no Haiku enum.

- **Bare mention** (under 5 chars after stripping the @-syntax) → a random canned warm opener, no LLM call.
- **System prompt** (`prompts.py:build_system_prompt`), assembled in order: base identity/scope/voice →
  WHO IS SPEAKING (audience-aware: client / advisor / unresolvable) → ABOUT THE CLIENT (name,
  journey_stage, advisor, tags) → RETRIEVED CONTEXT (up to 8 KB chunks) → PRIOR THREAD TURNS (last 3
  @-mention exchanges in the channel) → the @-mention extension (escalation rules + output contract).
- **Output (strict JSON, no fences):**
  ```json
  {"response_text": "<slack message>", "escalate": true|false, "handoff_reasoning": "<paragraph or null>"}
  ```
- **Four escalation categories** (decided inline by Sonnet with chunks in hand):
  1. **Judgment call** — a business decision (pricing, launch, firing a client).
  2. **Emotional** — client frustrated, stuck, or upset.
  3. **Money** — billing, refunds, contracts, account changes.
  4. **No good context** — the KB is thin/ambiguous and a wrong answer would matter.
- **On escalate:** writes an `escalations` row (routed to the client's primary CSM via `escalation.py` →
  `shared.hitl`) **and** mirrors a `pending_digest_items` row so the escalation also surfaces in the daily
  digest. Posts the answer or an in-channel acknowledgement either way. On LLM failure it posts a canned
  "let me get your advisor on this" and records the run as `status='error'` (no silent success).

Terminology: Ella says **"advisor"**, never "CSM", when speaking to clients. Slack mrkdwn only — single
`*` bold, single `_` italic, backticks for code, no headings, `<url|text>` links.

## Passive path (observation-only)

Entry: `passive_monitor.evaluate_passive_trigger(payload)` for every **non-mention** client message in a
channel with `slack_channels.passive_monitoring_enabled = true`. Decision model `claude-haiku-4-5`.

**Post-split this path does not post in channels or send DMs.** Its only output is feeding the daily
digest. Gates run cheapest-first:

1. **Kill switch** — `ELLA_PASSIVE_MONITORING_ENABLED` must be `'true'`, else a silent skip with **no** `agent_runs` row (audit-noise control).
2. **Author type** — client messages only; non-human authors (`ella`/`bot`/`workflow`/`unknown`) skip *with* an audit row.
3. **Routed-to-humans** — if the message @-mentions a non-Ella human, skip pre-LLM (a human already has it); a digest item is still written.

The decision Haiku returns one of `respond` / `acknowledge_and_escalate` / `skip` plus `digest_flag`,
`digest_category`, and an `open_ended` flag (true when a client message is awaiting a human reply — not a
closer/gratitude). `passive_dispatch.persist_passive_evaluation` writes the `agent_runs` row and, when
flagged, a `pending_digest_items` row. Nothing else. The `open_ended` flag is what the unanswered-channel
flagger keys on.

## Where Ella's signal surfaces

All flagging routes to Slack **channels, never DMs** (2026-05-28 redesign):

- **client channels** — reactive @ answers/acks (the only in-channel voice).
- **`#daily-digest`** — escalations + digest-flagged passive items, Haiku-ranked top 25 once a day.
- **`#unanswered-channels`** — `open_ended` client messages aging past 2h with no CSM reply.

(The crons that drive these live in `../fulfillment/architecture.md`.)

## Supporting modules

- `retrieval.py` — `retrieve_context_for_client(client_id, query, k=8)` returns a ContextBundle (KB chunks + client profile + primary CSM); plus recent-channel-context helpers and `build_kb_query_from_conversation`.
- `identity.py` — `resolve_speaker_identity(slack_user_id)` → role `client` / `advisor` / `unresolvable`.
- `escalation.py` — `escalate(...)` writes the `escalations` row routed to the primary CSM.
- `prompts.py` — system-prompt assembly for both paths (they converge on `build_system_prompt`).

## Persona

Warm, first-name basis, light emoji, honest when unsure. "FIRM AFTER FIRST" (don't re-escalate the same
thread) keys on prior *escalations*, not prior answers.

## Dead / legacy code (don't reintroduce)

- `agent.respond_to_passive_trigger(pending_row)` — a no-op since the split. It drains any stale
  `pending_ella_responses` rows silently (`skip_reason='passive_voice_removed'`); the passive path no longer
  queues in-channel responses.
- **Known gap:** `api/passive_ella_cron.py` references `handle_passive_general_inquiry()`, which does not
  exist in `agent.py` — a dead path that would throw if that decision ever landed. Tracked as a known issue,
  not load-bearing today (the queue it drains is empty).

## Tables

Reads `slack_messages`, `documents`/`document_chunks` (KB), `clients`, `slack_channels`. Writes
`escalations`, `pending_digest_items`, `pending_ella_responses` (legacy), `agent_runs`. See `../schema/`.
