# sales_bot

A Slack agent the sales team @-mentions to ask natural-language questions about
**sales data**. It writes **read-only SQL** against our Postgres, runs it, and
answers in plain English. Like Ella, but for *structured data* — so **no
embeddings / RAG**; the "retrieval" is SQL.

Code lives in `agents/sales_bot/`; Slack wiring in `api/slack_events.py`; ops in
`docs/runbooks/sales_bot.md`.

## Purpose

Answer questions like "how many leads opted in this week?", "how many connected
calls did Connor have last month?", "cash collected in June?", "compare Connor
vs Zach no-shows last week" — anything the sales tables can answer. Raw
text-to-SQL over the schema (not curated tools/views) is deliberate: maximum
flexibility, any question the data supports.

## Inputs / outputs

- **Input:** a Slack `app_mention` in `SALES_BOT_SLACK_CHANNEL`. The mention
  text (mention syntax stripped) is the question.
- **Output:** a threaded reply with (1) the answer, (2) one line naming the
  metric definition when subtle, (3) the disclaimer _"Approximate — for official
  figures check the dashboard."_ Slack mrkdwn.

## How it works (the tool-use loop)

`agents/sales_bot/agent.py:handle_question(payload)`:

1. Strip the mention; open an `agent_runs` row (`agent_name='sales_bot'`).
2. Call Claude (Sonnet, `DEFAULT_MODEL`) with the `run_sql` tool and the system
   prompt. Loop while `stop_reason == 'tool_use'`, bounded to `_MAX_TURNS` (6).
3. Each `run_sql` call goes through `sql_runner.run_sql` → `guard()` →
   the read-only connection. Errors come back as a string Claude self-corrects on.
4. On a non-tool stop, post the final text. Token cost is accumulated across the
   loop and written to the run on close.

Fail-soft throughout: any internal failure posts a short apology and logs
`status='error'` — the Slack webhook still acks 200.

## Data dependencies / access

- **Read-only by construction.** A dedicated Postgres role `sales_bot_ro`
  (migration `0113`): `default_transaction_read_only`, 8s statement timeout,
  `SELECT` on a **sales-tables allowlist only**. Connection via
  `SALES_BOT_DB_URL`. The role is the real boundary; the in-code `guard()` is
  defense-in-depth (rejects writes/DDL/multi-statement/off-allowlist, auto-LIMIT
  at 200 rows).
- **Allowlist** (kept in sync in three places — the `0113` GRANT, the `_ALLOW`
  set in `sql_runner.py`, and `SCHEMA_TABLES` in `prompt.py`): the Close / lead /
  Calendly / Airtable-form / Typeform / landing-page / ad-spend / setter-call /
  outbound sales tables + `team_members`, plus the callable sales SQL functions
  (`sales_funnel_counts`, `outbound_funnel`, …). **Never** widened to
  fulfillment / client / PII tables (`clients`, `nps_*`, `slack_messages`,
  `documents`, `agent_*`, …).
- **The system prompt is the make-or-break** (`prompt.py`): identity + SQL/ET
  rules + the **metric glossary** (cycles-vs-people, ≥90s connected, qualified,
  lead types, HT/DC, cash fields, revival-vs-reactivation — sourced from
  `docs/sales/data-model.md` + `logic.md`) + the **live schema** (introspected
  from the DB, cached per process) + few-shot question→SQL pairs. If answers
  drift from the dashboard, the fix is almost always tightening the glossary or
  adding a few-shot — not changing the engine.

## Escalation / guardrails

No HITL escalation (it's an analytics bot, not a client-facing one). Three
layers keep it safe:

1. **Channel gate** (`api/slack_events.py`) — only an `app_mention` whose channel
   == `SALES_BOT_SLACK_CHANNEL` reaches the bot; everything else falls through
   to Ella (KB only, no SQL).
2. **Audience gate** (`agent._authorize`) — defense in depth: the bot only
   answers an internal team member whose `team_members.areas` includes `'sales'`,
   and **fails closed**. This is the *"clients can never get a SQL answer"*
   guarantee — a client's Slack user id never maps to a sales-area `team_members`
   row, so even a misconfigured channel can't leak. Unknown users (possible
   clients) get **total silence**; internal non-sales users get a polite refusal.
3. **Read-only role + SQL guard** — see Data dependencies. Off-allowlist /
   out-of-scope questions (client churn, NPS) are refused, not guessed — by the
   prompt and, structurally, by the role having no access.

Note the bot reuses Ella's Slack app (same bot identity), so the channel + the
audience gate — not a separate bot — are what wall sales answers off from client
channels.

## Telemetry

One `agent_runs` row per mention: `agent_name='sales_bot'`,
`trigger_type='slack_mention'`, the question in `input_summary`, the answer in
`output_summary`, `llm_*` token/cost fields, and `metadata.tool_calls`. Cost per
run scales with the tool loop (typically 2–4 Claude calls).

## Evals / smoke

Spot-check 2–3 answers against the live dashboard after any glossary change,
using questions like the ones under § Purpose. The two recurring bug classes to
watch: **ET vs UTC** date bucketing and **cycles vs people** counting.
