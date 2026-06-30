# Sales Bot — Build Plan (handoff spec for the next instance)

**Status:** BUILT (2026-06-29). The code shipped per this spec — see
`agents/sales_bot/`, the Slack branch in `api/slack_events.py`, migration
`0113_sales_bot_ro_role.sql`, agent doc `docs/agents/sales_bot.md`, and ops
runbook `docs/runbooks/sales_bot.md`. This doc is kept as the design record.
**Remaining Drake-gated go-live steps:** apply `0113` + set the `sales_bot_ro`
password + `SALES_BOT_DB_URL` (Vercel + `.env.local`), and create/set
`SALES_BOT_SLACK_CHANNEL` and invite the bot. See the runbook § Provisioning.

A Slack bot the sales team (esp. Nabeel) @-mentions to ask natural-language
questions about sales data; it writes **read-only SQL** against our Postgres,
runs it, and answers in plain English. Like Ella, but for *structured data* (not
docs) — so **no embeddings / RAG**.

---

## 0. Locked decisions (from Drake, do not re-litigate)

1. **Interface: Slack bot**, same pattern as Ella (`app_mention` in a designated
   sales channel). Not an in-dashboard chat.
2. **Engine: text-to-SQL over the RAW schema** (not curated tools, not curated
   views). Maximum flexibility — any question the data can answer.
3. **Metric definitions live in the system prompt**, are **cited in the answer
   when relevant**, and every answer carries a short **disclaimer** ("for
   official numbers, verify on the dashboard").
4. **Read-only by construction** (non-negotiable): a dedicated read-only Postgres
   role, `SELECT`-only, statement timeout, row cap, **sales-tables allowlist** (no
   fulfillment/client/PII tables, no writes, no DDL).
5. **No embeddings.** Structured-data Q&A = SQL, not vector search.
6. **ONE CHANNEL ONLY — hard requirement (Drake, do not weaken).** The bot must
   answer sales questions in exactly **one dedicated sales channel** and **nowhere
   else**. Sales numbers must NEVER surface in a client channel.
   - **Strongly preferred: a SEPARATE Slack app/bot user (NOT @Ella),** invited to
     **only** the one sales channel. Ella lives in client channels — reusing her
     risks leaking sales data there. A separate bot that isn't in client channels
     *physically cannot* be @-mentioned in them. This is the safe design.
   - If (and only if) you must reuse Ella's Slack app, the channel-allowlist check
     below is the ONLY thing preventing leakage: the handler must hard-`return`
     unless `event.channel == SALES_BOT_SLACK_CHANNEL`, with NO fallback path, and
     Ella's normal client behavior must be untouched. Treat any other channel as a
     refusal. This is the fragile option — prefer the separate bot.

---

## 1. Architecture

```
Slack @mention (sales channel)
  → api/slack_events.py  (already receives app_mention; add a branch)
    → agents/sales_bot/agent.handle_question(payload)
       → Claude (Sonnet, tool-use loop) with a `run_sql` tool
            ↳ tool call: run_sql(query)
                 → execute via the READ-ONLY psycopg2 connection (allowlist + guards)
                 ↳ returns rows (or an error string Claude can self-correct on)
       → Claude composes the final answer (+ definitions used + disclaimer)
    → shared/slack_post.post_message(...)  (reply in-channel/thread)
  → log the run (agent_runs / a webhook_deliveries audit row)
```

Why tool-use (not a 2-call flow): Claude can **iterate** — if its SQL errors or
returns nothing, it sees the error and rewrites. That self-correction is what
makes raw-schema text-to-SQL actually work. (`shared/claude_client.complete()`
is text-only — for the tool loop, call the Anthropic SDK directly via
`shared.claude_client._anthropic_client()` or a fresh `Anthropic()` and pass
`tools=[RUN_SQL_TOOL]`, looping while `stop_reason == 'tool_use'`.)

Model: `DEFAULT_MODEL` from `shared/claude_client` (Sonnet, `claude-sonnet-4-6`).

---

## 2. One-time setup (do this FIRST, before code)

### 2a. Read-only Postgres role (the safety boundary)

Create a login role that can ONLY `SELECT` the sales allowlist, read-only, with a
statement timeout. Apply as a migration `supabase/migrations/0113_sales_bot_ro_role.sql`
**and** via the psycopg2 apply path (see `docs/sales/ingestion.md` § Ops traps —
Drake-gated; dual-verify). Generate a strong password, store it ONLY in
`.env.local` + Vercel env (never in code).

```sql
-- 0113_sales_bot_ro_role.sql  (password injected at apply time, NOT committed)
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'sales_bot_ro') then
    create role sales_bot_ro login password :'pw';
  end if;
end $$;
grant connect on database postgres to sales_bot_ro;
grant usage on schema public to sales_bot_ro;
alter role sales_bot_ro set default_transaction_read_only = on;
alter role sales_bot_ro set statement_timeout = '8000';      -- 8s hard cap
alter role sales_bot_ro set idle_in_transaction_session_timeout = '15000';
-- SELECT only on the ALLOWLIST (sales-owned + the shared tables sales reads):
grant select on
  close_leads, close_calls, close_sms, close_lead_status_changes,
  close_opportunities, close_custom_field_definitions, close_users,
  lead_cycles, lead_cycle_stages, lead_tag_runs, engagements,
  calendly_scheduled_events, calendly_invitees, calendly_event_types,
  airtable_setter_triage_calls, airtable_full_closer_report,
  airtable_digital_college_sales, airtable_rep_eods,
  sales_rep_candidates, sales_rep_verifications,
  typeform_responses, typeform_forms, typeform_form_insights_snapshots,
  landing_pages, landing_page_forms,
  meta_ad_daily, cortana_ad_daily, cortana_campaign_daily, cortana_adset_daily,
  clarity_metrics_daily, wistia_media_daily, wistia_medias,
  setter_call_reviews, setter_call_transcripts,
  outbound_campaigns, outbound_campaign_roster, outbound_lead_facts,
  team_members
to sales_bot_ro;
-- Deliberately NOT granted: clients, client_*, nps_submissions, slack_messages,
-- documents, document_chunks, agent_*, escalations, oauth_tokens, etc.
-- (fulfillment / client-PII / agent infra). Default-deny: anything not listed
-- above is invisible to the role.
```

> The role-level `default_transaction_read_only` + `statement_timeout` + the
> table-level grants are the real guardrails — even if the SQL guard in code is
> bypassed, the DB itself refuses writes and anything off-allowlist.

Connection: build a psycopg2 conn from `SALES_BOT_DB_URL` (the pooler URL with
`sales_bot_ro` creds). Mirror the pooler host used elsewhere
(`aws-1-us-east-2.pooler.supabase.com:5432`, db `postgres`, user
`sales_bot_ro` — NOTE: pooler usernames are usually `<role>.<project_ref>`; verify
the exact form against `supabase/.temp/pooler-url`). Add to `.env.example`,
`.env.local`, and Vercel env: `SALES_BOT_DB_URL` (or `SALES_BOT_DB_PASSWORD` +
reuse the host).

### 2b. Slack channel + env

- Decide the channel (a `#sales-bot` or reuse an existing sales channel). Add env
  `SALES_BOT_SLACK_CHANNEL` (channel id `C...`). The bot only answers
  `app_mention` events whose `channel == SALES_BOT_SLACK_CHANNEL`.
- The Slack app already receives `app_mention` (see `api/slack_events.py`, which
  already special-cases `SALES_FORM_NOTIFY_SLACK_CHANNEL`). Add a parallel branch
  for `SALES_BOT_SLACK_CHANNEL` → the new sales-bot handler (do NOT route it to
  Ella).
- Posting uses the existing bot token via `shared/slack_post.post_message`.

---

## 3. Files to create / modify

**Create**
- `supabase/migrations/0113_sales_bot_ro_role.sql` — the read-only role (§2a).
- `agents/sales_bot/__init__.py`
- `agents/sales_bot/agent.py` — `handle_question(payload) -> result`; the tool-use loop.
- `agents/sales_bot/prompt.py` — `build_system_prompt()` (the glossary + SQL rules, §5).
- `agents/sales_bot/sql_runner.py` — `run_sql(query) -> rows|error`; the read-only
  conn + the in-code guards (§4).
- `docs/agents/sales_bot.md` — the agent doc (per CLAUDE.md: new agent → docs/agents).
- `tests/agents/sales_bot/test_sql_guard.py` — guard unit tests (reject writes/DDL/
  multi-statement/off-allowlist; enforce LIMIT).

**Modify**
- `api/slack_events.py` — add the `SALES_BOT_SLACK_CHANNEL` app_mention branch.
- `.env.example` — `SALES_BOT_DB_URL` (or password), `SALES_BOT_SLACK_CHANNEL`.
- `docs/sales/README.md` doc map + `docs/sales/surfaces.md` (note the bot) +
  `docs/runbooks/` (a short runbook: how to operate/debug, env vars, the role).

---

## 4. `sql_runner.py` — the guards (defense in depth on top of the RO role)

```python
import re, psycopg2, os

_ALLOW = {  # keep in sync with the GRANT list in 0113
  "close_leads","close_calls","close_sms","close_lead_status_changes",
  "close_opportunities","close_custom_field_definitions","close_users",
  "lead_cycles","lead_cycle_stages","lead_tag_runs","engagements",
  "calendly_scheduled_events","calendly_invitees","calendly_event_types",
  "airtable_setter_triage_calls","airtable_full_closer_report",
  "airtable_digital_college_sales","airtable_rep_eods",
  "sales_rep_candidates","sales_rep_verifications",
  "typeform_responses","typeform_forms","typeform_form_insights_snapshots",
  "landing_pages","landing_page_forms",
  "meta_ad_daily","cortana_ad_daily","cortana_campaign_daily","cortana_adset_daily",
  "clarity_metrics_daily","wistia_media_daily","wistia_medias",
  "setter_call_reviews","setter_call_transcripts",
  "outbound_campaigns","outbound_campaign_roster","outbound_lead_facts",
  "team_members",
  # sales SQL functions the bot may call (read-only):
  "sales_funnel_counts","outbound_funnel","outbound_funnel_by_rep",
  "sales_speed_fmr","sales_rep_call_activity",
}
MAX_ROWS = 200
_FORBIDDEN = re.compile(r"\b(insert|update|delete|drop|alter|create|truncate|grant|"
                        r"revoke|copy|call|do|merge|comment|vacuum|reindex|"
                        r"refresh|set|reset)\b", re.I)

def guard(sql: str) -> str:
    s = sql.strip().rstrip(";")
    if ";" in s: raise ValueError("multiple statements not allowed")
    if not re.match(r"(?is)^\s*(select|with)\b", s): raise ValueError("only SELECT/WITH")
    if _FORBIDDEN.search(s): raise ValueError("forbidden keyword")
    # every identifier that looks like a table/function must be on the allowlist
    refs = set(re.findall(r"(?i)\b(?:from|join)\s+([a-z_][a-z0-9_]*)", s))
    bad = refs - _ALLOW
    if bad: raise ValueError(f"off-allowlist tables: {sorted(bad)}")
    # enforce a row cap (append LIMIT if absent)
    if not re.search(r"(?i)\blimit\s+\d+\s*$", s): s = f"{s}\nLIMIT {MAX_ROWS}"
    return s

def run_sql(query: str):
    safe = guard(query)                       # raises -> Claude sees the error, retries
    conn = psycopg2.connect(os.environ["SALES_BOT_DB_URL"])  # role=sales_bot_ro
    conn.set_session(readonly=True, autocommit=True)
    try:
        cur = conn.cursor()
        cur.execute(safe)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchmany(MAX_ROWS)
        return {"columns": cols, "rows": [list(r) for r in rows], "row_count": len(rows)}
    finally:
        conn.close()
```

- The guard is **belt** (in code) on top of the **suspenders** (RO role + grants).
  Both must hold.
- On a guard/exec error, return the error STRING to Claude (don't crash) so it can
  fix the query and retry. Cap retries (e.g. 4 tool calls) to bound cost.
- `psycopg2` (not PostgREST) → the 1000-row PostgREST cap does NOT apply; our
  `MAX_ROWS`/`LIMIT` is the cap.

---

## 5. `prompt.py` — the system prompt (THE make-or-break)

Raw-schema text-to-SQL only works if Claude knows our metric definitions. Build
the prompt from these parts. **Pull the live column comments** at build time (or
paste a condensed schema) so Claude joins correctly — see "schema feeding" below.

### 5a. Identity + rules
- You are the AI Partner sales analyst. You answer questions about sales
  performance by writing ONE read-only Postgres `SELECT` and reading the result.
- Use the `run_sql` tool. Postgres dialect. Timestamps are UTC in the DB; the
  business runs in **America/New_York (ET)** — convert when the user means
  calendar days ("today", "this week").
- If a query errors or returns nothing, read the error and try a corrected query
  (max ~4 attempts). If you still can't answer, say so plainly — never invent
  numbers.
- Every answer: (1) the number/answer, (2) one line on the **definition used**
  when a subtle metric is involved (e.g. "counting opt-in *cycles*, ≥90s =
  connected"), (3) a one-line disclaimer: _"Approximate — for official figures
  check the dashboard."_
- Slack mrkdwn only (single `*bold*`, `_italic_`, backticks). Be concise.

### 5b. Metric glossary (EMBED THIS — sourced from data-model.md + logic.md)
- **Unique lead / cohort:** a person in `lead_cycles`. The cohort = non-revival
  (`close_leads` where `REVIVAL_CF` empty), `excluded_at IS NULL`, high-ticket
  Typeform match, **first opted in on/after 2026-05-24**. `lead_cycles` IS the
  unique-leads list (one row per opt-in *cycle*).
- **Lead vs cycle (critical):** the **funnel counts cycles** (`count(*)` over
  `lead_cycles` rows = opt-in *events* — one person opting in twice counts
  twice). The **roster/people count is distinct people** (`count(distinct
  close_id)`). Verified: dashboard funnel optIns = cycle count, not people.
- **Funnel stages** (cumulative, monotonic): opt-ins → connected → booked →
  confirmed → showed → closed. Stage timestamps live in `lead_cycle_stages`.
- **Connected** = a call **≥ 90 seconds** in EITHER direction (`close_calls.duration
  >= 90`). NOT a form reach.
- **Qualified** = per opt-in cycle, from the Typeform investment answer; stored on
  `lead_cycles.qualified` (true/false/null=unknown). Per-form rule lives in
  `landing_page_forms.qualify_answers`; legacy ≥ $2,000 (invest field
  `5138f17b…`). Prefer `lead_cycles.qualified`.
- **Lead types** (from the tagger, on `lead_cycles` — NOT Close columns):
  **Direct** = self-booked a strategy call; **Setter** = not direct;
  **Reactivation** = a lead that went cold / lost its spot (`reactive_at` set).
  Direct+Setter partition; Reactivation cross-cuts.
- **HT vs DC:** routed by closer identity. DC (Digital College, low-ticket) priced
  a flat **$300 per plan unit** (`DC_PLAN_PRICE_USD`). `lead_cycles.dc_closed_at`,
  `digital_college_at`.
- **Per-landing-page:** each cycle has `lead_cycles.source_form_id` = which
  Typeform/LP it came through. Join `landing_page_forms`/`landing_pages` for LP
  names. Funnel scopes by `source_form_id`.
- **Cash:** upfront = `airtable_full_closer_report.amount_paid_today`; contract =
  `contract_amount_to_send` (NOT `total_contract_amount`); DC = $300 × plan units.
- **Reps:** `team_members` (`close_user_id`, `airtable_user_id`, `sales_role` ∈
  setter/closer/dc_closer). Dials/calls → `close_calls.user_id = close_user_id`;
  closer/setter forms → `*_record_ids` rec id = `airtable_user_id`. EODs →
  `airtable_rep_eods.rep_record_id = airtable_user_id`.
- **Revival vs Reactivation (don't confuse):** **Revival** = a separate OUTBOUND
  SMS campaign, materialized in `outbound_lead_facts`, **excluded from the main
  funnel** (use `outbound_funnel(p_campaign_key)` for it). **Reactivation** = a
  flag on a main-funnel `lead_cycles` row.
- **Ad attribution:** `close_leads` carries `campaign_id`/`adset_id`/`ad_id`;
  spend in `cortana_campaign_daily`/`cortana_adset_daily`/`cortana_ad_daily`
  (high-ticket adspend = `entity_name ILIKE '%closer funnel%'`). ROAS = cash ÷ spend.
- **Canonical helpers (optional but encouraged for the hard metrics):** the
  dashboard's own SQL functions are callable read-only and return exact
  dashboard numbers — `sales_funnel_counts(p_start, p_end, p_ad, p_campaign,
  p_adset, p_source_form_id)`, `outbound_funnel(key,start,end)`,
  `outbound_funnel_by_rep(...)`, `sales_speed_fmr(...)`,
  `sales_rep_call_activity(...)`. Prefer these when the question maps to them.

### 5c. Schema feeding
Give Claude the real schema so it joins correctly. Two options (do the first):
1. **At handler start, query the allowlist's columns + comments** from
   `information_schema.columns` + `pg_description` (the migrations have rich
   `comment on` text) and inline a compact `table(col type — comment)` listing in
   the prompt. Cache it (module-level, refreshed daily) — it's ~big but static.
2. Or paste a hand-maintained condensed schema. (More drift risk.)
Also paste **3–5 example question→SQL pairs** for the trickiest metrics (funnel
cycle count by stage; cash in range; per-rep dials+closes; per-LP opt-ins) — few-shot
massively improves accuracy.

---

## 6. `agent.py` — the loop (pseudocode)

```python
def handle_question(payload):
    question = strip_mention(payload.text)
    client = _anthropic_client()
    msgs = [{"role":"user","content": question}]
    for _ in range(6):  # bounded tool loop
        resp = client.messages.create(
            model=DEFAULT_MODEL, max_tokens=1200,
            system=build_system_prompt(), tools=[RUN_SQL_TOOL], messages=msgs)
        if resp.stop_reason != "tool_use":
            answer = "".join(b.text for b in resp.content if b.type=="text")
            post_message(channel=payload.channel, text=answer, thread_ts=payload.thread_ts)
            log_run(question, msgs, ok=True)
            return
        # execute each tool_use block, append tool_result
        msgs.append({"role":"assistant","content": resp.content})
        results = []
        for b in resp.content:
            if b.type == "tool_use" and b.name == "run_sql":
                try: out = run_sql(b.input["query"])
                except Exception as e: out = {"error": str(e)}
                results.append({"type":"tool_result","tool_use_id":b.id,
                                "content": json.dumps(out, default=str)[:6000]})
        msgs.append({"role":"user","content": results})
    # ran out of turns
    post_message(channel=payload.channel, text="I couldn't pin that down — try rephrasing, or check the dashboard.")
```
`RUN_SQL_TOOL = {"name":"run_sql","description":"Run ONE read-only SELECT and get rows.","input_schema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}`

Fail-soft: wrap everything; never crash the Slack webhook (return 200 fast, do work
async if needed — mirror how `api/slack_events.py` + Ella handle timing). Log each
run (model, tokens via `estimate_cost_usd`, the SQL, ok/error) to `agent_runs` or a
`webhook_deliveries` audit row.

---

## 7. Slack wiring (`api/slack_events.py`)

The receiver already verifies the signature and handles `app_mention`. Add, next
to the existing `SALES_FORM_NOTIFY_SLACK_CHANNEL` special-case:

```python
sales_bot_channel = os.environ.get("SALES_BOT_SLACK_CHANNEL","").strip()
if event.get("type")=="app_mention" and sales_bot_channel and event.get("channel")==sales_bot_channel:
    from agents.sales_bot.agent import handle_question
    handle_question(_payload_from(event))   # fail-soft inside
    return  # do NOT fall through to Ella
```
Restrict use to that channel (and optionally check the Slack user maps to a
sales-area `team_members` row). Respond 200 immediately; keep the LLM work within
the function's timeout budget (or ack-then-post).

---

## 8. Build sequence (each step verified before the next)

1. **RO role** (§2a): write `0113`, apply via psycopg2 (Drake-gated), **dual-verify**:
   connect AS `sales_bot_ro` and confirm (a) `select 1 from close_leads limit 1`
   works, (b) `insert`/`update` is rejected, (c) `select from clients` is denied,
   (d) `statement_timeout` fires on `select pg_sleep(20)`. Put creds in
   `.env.local` + Vercel.
2. **`sql_runner.py` + guard tests**: unit-test the guard (reject writes, DDL,
   `;`-multistatement, off-allowlist; auto-LIMIT). `pytest tests/agents/sales_bot/`.
3. **`prompt.py`**: build the schema-introspection + glossary + few-shot. Print it
   once and eyeball it.
4. **`agent.py`** loop: test locally against the real RO DB with ~10 questions
   (§9) — confirm correct SQL + sensible answers + the disclaimer. (Set the env,
   call `handle_question` with a fake payload; print instead of posting.)
5. **Slack wiring**: add the channel branch; deploy to a test channel; @-mention
   it live; confirm it replies. Restrict to the channel.
6. **Docs**: `docs/agents/sales_bot.md`, the runbook, README/surfaces notes.
   Commit/push (Drake's flow). `npx tsc`/`npm run build` unaffected (Python only);
   `pytest tests/` green.

---

## 9. Smoke questions (expected behavior)

Run these in step 4 and again live. The bot should produce correct, dashboard-
consistent answers (spot-check 2–3 against the dashboard):
- "How many leads opted in this week?" → cycle count in ET week, states it's cycles.
- "How many connected calls did Connor have last month?" → `close_calls` ≥90s for
  his `close_user_id`, ET month.
- "Cash collected in June?" → upfront + contract + $300/DC, names the components.
- "How many opt-ins came through the Training landing page?" → filter
  `source_form_id` for that LP's form.
- "Compare Connor vs Zach no-shows last week." → open-ended; should join the right
  tables. (This is the kind of question curated tools couldn't do — the reason we
  chose raw text-to-SQL.)
- A deliberately-unanswerable / off-allowlist one ("show me client churn") → must
  refuse cleanly (no fulfillment access), not hallucinate.

---

## 10. Gotchas / notes
- **The glossary is everything.** If answers drift from the dashboard, the fix is
  almost always tightening §5b (a definition) or adding a few-shot example — not
  changing the engine.
- **ET vs UTC.** The #1 SQL bug will be date-bucketing. Make the prompt emphatic
  and give a few-shot with `... at time zone 'America/New_York'`.
- **Cycles vs people.** The #2 bug. The glossary calls it out; reinforce in few-shot.
- **Never widen the allowlist to fulfillment/client/PII tables.** That's the whole
  safety model. `clients`, `client_*`, `nps_*`, `slack_messages`, `documents`,
  `document_chunks`, `oauth_tokens`, `agent_*`, `escalations` stay OFF.
- **Cost:** log tokens per run (`estimate_cost_usd`); a tool loop can be 3–6 calls.
- **Not needed:** embeddings, a new vector store, curated views. Raw schema +
  glossary + RO role is the whole thing.
- **Future (optional):** if a metric proves consistently wrong, add a curated VIEW
  that encodes it and tell the bot to prefer it — incremental, not a rewrite.

## 11. Key references (read these while building)
- Ella (the Slack-agent pattern to mirror): `agents/ella/agent.py`
  (`handle_at_mention`), `api/slack_events.py`, `shared/slack_post.py`,
  `docs/agents/ella.md`.
- LLM client: `shared/claude_client.py` (`complete`, `_anthropic_client`,
  `DEFAULT_MODEL`, `estimate_cost_usd`).
- DB: `shared/db.py` (`get_client`); pooler creds pattern in
  `docs/sales/ingestion.md` § Ops traps; `supabase/.temp/pooler-url`.
- Metric truth: `docs/sales/data-model.md`, `docs/sales/logic.md`,
  `docs/sales/surfaces.md`, and the table list in `data-model.md` § Table manifest.
- The callable SQL functions: `supabase/migrations/` (search `sales_funnel_counts`,
  `outbound_funnel`, `sales_speed_fmr`, `sales_rep_call_activity`).
```
