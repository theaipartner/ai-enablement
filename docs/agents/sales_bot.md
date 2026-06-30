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

> ⚠️ **This bot is not fully done.** Raw text-to-SQL works well for the
> aggregate/funnel metrics defined in the glossary, but it is **unreliable for
> rep-level "who did what" questions** (bookings, sales, shows, cash by a named
> rep) — exactly the questions a salesperson is most likely to ask. See
> [§ Known limitation & what a full build needs](#known-limitation--what-a-full-build-needs)
> before extending it.

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

## Known limitation & what a full build needs

**Status: works for glossary-defined aggregates; not reliable for rep-level
questions.** Questions like *"how many bookings did Connor secure Jun 1–20"* or
*"how has Connor's sales been trending"* currently fail — the bot burns its turn
budget on the wrong tables and returns the `_FALLBACK_ANSWER` ("I couldn't pin
that down…"). This is a **data-shape problem, not a prompt-wording problem** —
adding more glossary definitions one metric at a time does not durably fix it,
because the underlying sources are a swamp:

- **Bookings** live only in `airtable_setter_triage_calls`, signalled by a
  `call_status` enum (`'High Ticket booking'`, `'Digital College booking'`,
  `'Confirmed Booking'`) — while the column literally named `booking_status` is
  100% NULL (a decoy the bot gravitates to).
- **The closer report has multiple form versions with different schemas.** "HT
  close" = `Call Outcome='High Ticket Closed'` **OR** legacy `Closed?='Yes'`;
  "show" = `Showed?='Yes'` **OR** a non-no-show `Call Outcome`. No single column
  answers it.
- **DC closes appear in two tables that disagree.** A rep can have DC closes in
  `airtable_full_closer_report` and **zero** in the dedicated
  `airtable_digital_college_sales` table (which is sparse — ~57 rows, partial
  closer coverage). Whichever a naive query picks is wrong for half the reps.
- **Cash** is `coalesce(amount_paid_today_number, amount_paid_today_currency)`;
  DC cash isn't stored — it's `$300 × plan units` parsed from a free-text
  multi-select inside `fields_raw`.
- **Attribution is array-contains on record-id columns**
  (`setter_record_ids` / `closer_record_ids` ∋ `team_members.airtable_user_id`),
  and **a rep is often both a setter and a closer** — so `sales_role` alone does
  not tell you where their numbers live.

### The durable fix: a semantic layer

Don't keep patching the prompt. Normalize the mess **once, in SQL**, into a
tidy/long view the bot queries instead of the raw tables:

```
rep_activity_daily(
  rep_member_id uuid,   -- team_members.id
  rep_name      text,
  activity_date date,   -- bucketed in America/New_York
  metric_key    text,   -- 'bookings' | 'dc_closes' | 'connects' | ...
  value         numeric
)
```

Built as a `UNION ALL` of one normalized subquery per metric — each encoding
exactly one rule below, once, tested against the dashboard. Adding a metric is
one more branch, never a schema change. The bot's prompt then carries the
**metric vocabulary** (synonyms → `metric_key`) and points at this one view; the
LLM only has to map everyday language ("deals he set", "his numbers") onto a
small, finite, honest surface, and ask **one clarifying question** on true
ambiguity (e.g. a setter who also closes DC: "bookings or DC closes?").

**The metric grid to implement:**

| metric_key | Source + rule | Attribution |
|---|---|---|
| `dials` | `close_calls` count | `user_id = close_user_id` |
| `connects` | `close_calls` where `duration >= 90` | `user_id = close_user_id` |
| `bookings` | `airtable_setter_triage_calls`, `call_status IN ('High Ticket booking','Digital College booking','Confirmed Booking')` | `setter_record_ids ∋ airtable_user_id` |
| `shows` / `no_shows` | closer report: `Showed?='Yes'` OR non-no-show `Call Outcome` | `closer_record_ids ∋ id` |
| `ht_closes` | closer report: `Call Outcome='High Ticket Closed'` OR `Closed?='Yes'` | `closer_record_ids ∋ id` |
| `dc_closes` | closer report: `Digital College Closed='Yes'` OR `Call Outcome IN ('Digital College','Digital College Closed')` | `closer_record_ids ∋ id` |
| `upfront_cash` | `coalesce(amount_paid_today_number, amount_paid_today_currency)` | `closer_record_ids ∋ id` |
| `contract_cash` | `contract_amount_to_send` | `closer_record_ids ∋ id` |

**Verified anchors** (turn these into tests — they're confirmed against the data):

- `bookings`, Connor (`airtable_user_id=reclS9rriHREFJucs`), Jun 1–20 → **56**
- `dc_closes`, Connor, since Jun 22 → **14**
- `ht_closes` / `upfront_cash`: anchor on an actual HT closer (Connor has none)
  and reconcile to the dashboard cash figure before trusting them.

### Scope & effort

- **Full grid = a small project with a maintenance tail.** The view DDL is ~an
  afternoon; the cost is reconciling each metric to the dashboard and re-fixing
  the view whenever the Airtable forms change versions again (they already have,
  ≥twice). Centralizes that maintenance — doesn't remove it.
- **Thin slice ≈ half a day, high value.** `bookings` + `dc_closes` (both already
  verified) plus `dials`/`connects` (clean from `close_calls`) covers the
  questions that actually fail today. Defer `shows` / cash / channel until
  someone asks and hits a wall.

### Open questions before building

1. **DC source conflict** — recommend treating `airtable_full_closer_report` as
   canonical for DC closes (it has full rep coverage; `airtable_digital_college_sales`
   is sparse) and ignoring the DC-sales table until someone explains why it's
   partial.
2. **Channel (inbound vs outbound)** — a likely v2 dimension; needs a
   lead→`outbound_lead_facts` join. Left out of the v1 grid above.

## Evals / smoke

Spot-check 2–3 answers against the live dashboard after any glossary change,
using questions like the ones under § Purpose. The two recurring bug classes to
watch: **ET vs UTC** date bucketing and **cycles vs people** counting.
