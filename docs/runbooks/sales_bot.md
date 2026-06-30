# Runbook — Sales bot (read-only text-to-SQL Slack agent)

How to provision, operate, and debug the sales bot. Agent doc:
`docs/agents/sales_bot.md`.

## What it is

A Slack agent the sales team @-mentions to ask NL questions about sales data; it
writes read-only SQL and answers. No cron — it's event-driven off Slack
`app_mention` in `SALES_BOT_SLACK_CHANNEL`. Synchronous handling (Vercel kills
threads after the response returns; Slack's retry-dedup covers the >3s
roundtrip — same model as Ella's webhook).

## Env vars

| Var | Where | Purpose |
|-----|-------|---------|
| `SALES_BOT_SLACK_CHANNEL` | Vercel + `.env.local` | Channel id (`C…`) the bot answers in. UNSET ⇒ bot off (mentions fall through to Ella's deduped no-op). |
| `SALES_BOT_DB_URL` | Vercel + `.env.local` | psycopg2 DSN for the `sales_bot_ro` role. |
| `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY` | already set | Shared with Ella's webhook. |

## Provisioning the RO role (one-time)

> **Status: DONE 2026-06-29.** `0113` applied to cloud + ledgered; the
> `sales_bot_ro` password is set; `SALES_BOT_DB_URL` + `SALES_BOT_SLACK_CHANNEL`
> are in `.env.local` and Vercel (Production). Confirmed pooler username form:
> `sales_bot_ro.sjjovsjcfffrftnraocu`. Two facts worth keeping:
> - **RLS was the gotcha.** Every public table has RLS *enabled with no
>   policies*; the service role bypasses it but `sales_bot_ro` does not, so the
>   SELECT grants alone returned **zero rows**. `0113` therefore also creates a
>   `sales_bot_ro_read` (`FOR SELECT USING (true)`) policy per allowlisted table.
>   Any NEW allowlist table needs the same policy added there.
> - `postgres` (the migration role) has `createrole` but **not** superuser, so
>   `BYPASSRLS` wasn't an option — the per-table read policy is the right fix.

The migration `supabase/migrations/0113_sales_bot_ro_role.sql` creates the role
**locked** (no password committed) with read-only defaults + the SELECT
allowlist + the RLS read policies. The original bring-up sequence (kept for
reference / re-provisioning):

1. **Apply the migration** via the careful psycopg2 path (NOT `supabase db push`
   with local Docker up — see `docs/sales/ingestion.md` § Ops traps and
   `docs/runbooks/apply_migrations.md`). Insert the ledger row into
   `supabase_migrations.schema_migrations`.
2. **Set the password out of band** (never committed). Generate a strong one and,
   connected as a superuser/owner against **cloud**:
   ```sql
   alter role sales_bot_ro login password '<strong-generated-password>';
   ```
3. **Store creds** in `.env.local` and Vercel env as `SALES_BOT_DB_URL`:
   ```
   postgresql://sales_bot_ro:<pw>@aws-1-us-east-2.pooler.supabase.com:5432/postgres
   ```
   Verify the exact pooler username form against `supabase/.temp/pooler-url`
   (pooler usernames are often `<role>.<project_ref>`).
4. **Dual-verify against cloud** (connect AS `sales_bot_ro`):
   - `select 1 from close_leads limit 1;` → works.
   - `insert into close_leads (close_id) values ('x');` → **rejected** (read-only).
   - `select * from clients limit 1;` → **denied** (off-allowlist).
   - `select pg_sleep(20);` → **cancelled** by `statement_timeout` (~8s).
5. **Confirm ledger + role exist on cloud** (`select 1 from pg_roles where
   rolname='sales_bot_ro'`; ledger max = 0113).

## Slack setup

- Create a dedicated **internal, non-client** channel; put its id in
  `SALES_BOT_SLACK_CHANNEL`.
- The bot reuses **Ella's Slack app** (same bot identity). Its Event
  Subscription already receives `app_mention`; the branch in
  `api/slack_events.py` routes mentions in this channel to the sales bot and
  **not** to Ella. Invite the (Ella) bot to the channel.

## Who can use it — the audience gate

Two layers keep clients from ever getting a SQL answer (the channel reuses
Ella's app, so this gate — not a separate bot — is the wall):

1. **Channel** — only mentions in `SALES_BOT_SLACK_CHANNEL` reach the bot.
2. **User** — `agent._authorize` only answers a Slack user who maps to a
   non-archived `team_members` row with `'sales'` in `areas`, and **fails
   closed**. Unknown users (possible clients) get silence; internal non-sales
   users get a polite refusal.

**To grant a rep access:** ensure their `team_members` row has their
`slack_user_id` set and `'sales'` in `areas` (same gate as the sales dashboard —
see `docs/runbooks/` access notes / migration 0112). No deploy needed:
```sql
update team_members set areas = array_append(areas, 'sales')
where slack_user_id = 'U…' and not ('sales' = any(areas));
```

## Operating

- **Turn off fast:** unset `SALES_BOT_SLACK_CHANNEL` in Vercel (mentions then
  fall through to Ella's deduped no-op). No deploy needed for the env flip.
- **Tighten an answer:** the engine is rarely the problem. Edit the glossary or
  add a few-shot in `agents/sales_bot/prompt.py`, redeploy. The live schema block
  refreshes on each new serverless process (no manual step).

## Debugging

- **Every run logs to `agent_runs`** (`agent_name='sales_bot'`): the question
  (`input_summary`), the answer (`output_summary`), `llm_*` cost, and
  `metadata.tool_calls`. `status='error'` rows carry `error_message`.
- **No reply at all:** check the bot is in the channel and `SALES_BOT_SLACK_CHANNEL`
  matches; check Vercel logs for the `slack_webhook: sales_bot -> status=…` line.
- **"off-allowlist table" / permission errors in the loop:** expected guardrail
  output — Claude should self-correct. Persistent failures on a legit table mean
  the allowlist needs the table added in **all three** places (the `0113` GRANT,
  `_ALLOW` in `sql_runner.py`, `SCHEMA_TABLES` in `prompt.py`) — and re-granting
  SELECT to the role on cloud.
- **Wrong numbers:** almost always ET-vs-UTC bucketing or cycles-vs-people. Spot
  check against the dashboard; tighten the glossary/few-shot.

## Gotchas

- **Never widen the allowlist to fulfillment/client/PII tables** — that
  default-deny is the safety model.
- **psycopg2, not PostgREST** — the 1000-row PostgREST cap does not apply; the
  cap is `MAX_ROWS` (200) enforced in `sql_runner.guard`.
- **Cost:** a tool loop is typically 2–4 Claude calls; bounded at 6 turns.
