# Sales — Ingestion & Ops Traps

How sales data gets into Supabase, and the landmines that cost real time. The core
principle (CLAUDE.md) still holds: **agents and the dashboard read Supabase, never the
external tool directly.** Each source below is a replaceable adapter under `ingestion/`.

---

## Sources

### Close CRM — `ingestion/close/`
Mirrors leads, calls, SMS, status changes, opportunities → `close_leads`, `close_calls`,
`close_sms`, `close_lead_status_changes`, `close_opportunities`,
`close_custom_field_definitions`. Webhook (`api/close_events.py`) + user sync cron
(`close_users_sync_cron`, `30 11 * * *`). Connected = `close_calls.duration >= 90`.
**`status_label` is unreliable — never use it** for DQ/funnel state.

### Airtable — `ingestion/airtable/` (base `appCWa6TV6p7EBarC`, PAT `AIRTABLE_SALES_PAT`)
One base-wide **webhook receiver** (`api/airtable_events.py`) **+ 15-min cron**
(`airtable_sync_cron`), one parser, three mirrors:
- `airtable_setter_triage_calls` (table `tblaoMsiE3FSkHjQt`) — ONE table, two
  `form_type`s: `Setter Triage Form` (triage) and `Closer Triage Form` (confirmation,
  ≈ Aman). **No stored timestamp field → the webhook is load-bearing for edits.**
- `airtable_full_closer_report` (US `tblYsh3fxTpXuPdIW` + AUS `tblcC25y6lMrtgcty`,
  unioned via `region`) — the closer EOC, redesigned ~05-30 around `call_outcome` +
  `form_type` (New|Old); migration 0062 promoted ~23 typed columns.
- `airtable_digital_college_sales` (table `tbljmzRoMoE5B26lt`) — Robby's dedicated DC
  form; migration 0066.

Read the live field options via `AirtableClient.from_env().get_base_schema()` (scope
`schema.bases:read`) — don't guess option values.

### Calendly — `ingestion/calendly/`
Webhook `api/calendly_events.py` (fetches the parent event per invitee tick) + 7-day
backfill → `calendly_scheduled_events`, `calendly_invitees`, `calendly_event_types`.
Filter closer bookings by **event `name` ILIKE** `CLOSER_EVENT_TYPE_NAMES` — **don't**
join `event_type_uri` (retired URIs). See `logic.md` § call typing.

### Typeform — `ingestion/typeform/`
Webhook (real-time primary) + cron backstop (`typeform_sync_cron`, `*/15`) + insights
cron + full backfill → `typeform_responses`, `typeform_forms`. **Active HT opt-in gate =
form `SFedWelr`.** `PWSNd0h2` is the dormant Setter Funnel.

### Meta / Cortana ads — `ingestion/cortana/`
`api/cortana_sync_cron.py`, **3-hour cron** (`0 */3 * * *`). **Source changed
2026-05-29:** `meta_ad_daily` now comes from the **Cortana Attribution API**
(`groupBy=source`); `cortana_campaign_daily` (`groupBy=campaign`) and `cortana_ad_daily`
(`groupBy=ad`). The old `ingestion/meta/` Google-Sheet pipeline is **retired**. HT
adspend = **`Closer Funnel`-token campaigns only** (excludes other funnels and Meta noise
rows like `Bot Traffic`, `facebook.com`, `calendly.com`).

### Clarity — `ingestion/clarity/`
Daily cron (`clarity_sync_cron`, `0 10 * * *`), **no backfill possible**.
`clarity_metrics_daily` rows are rolling-3-day snapshots — read the **latest snapshot per
path**; aggregating across snapshots double-counts.

### Wistia — `ingestion/wistia/`
Cron `wistia_sync_cron` (`30 * * * *`). `wistia_media_daily` (post-2026-05-24 cutover,
migration 0046 — use the **timeseries** columns, NOT the deprecated `load_count` /
`play_count` / `hours_watched`) + `wistia_medias` (inventory). VSL = `i1173gx76b` +
`nbump1crwb`; confirm/TYP video = `fbgjxwe62y`.

### Fathom calls — `ingestion/fathom/`
Populates the shared `calls` table. Sales uses `call_category='client'` rows for
meeting-duration metrics.

### Setter-calls sweep
`setter_calls_sweep_cron` (`*/15`) — keeps setter call activity current.

### Engagement pinger (missing-form notifier) — ⏸ PAUSED (2026-06-16)

> **STATUS: PAUSED.** The `*/5` cron schedule was removed from `vercel.json` (commit
> `0b0f4de`) after the first live fire (10am ET 2026-06-16) surfaced issues still being
> worked through — so **no pings go out**. Engagement **tracking is still live** (the
> Close- and Airtable-webhook hooks are untouched): engagements keep opening / growing /
> closing in real time; only overdue-flip + Slack pinging are off.
>
> **To resume:** re-add `{ "path": "/api/engagement_ping_cron", "schedule": "*/5 * * * *" }`
> to the `crons` array in `vercel.json`, **and reset `ENGAGEMENT_PING_FLOOR` to the resume
> moment** (so it doesn't fire a backlog burst for everything that went overdue while
> paused), then push. The function, its `functions`-block config, and all env vars are
> left in place — resume is just those two changes.

Pings a rep in Slack (as **Ella**) every 15 min until they file the form for a phone call.
Logic + lifecycle: [`logic.md`](./logic.md) § Engagements; table: `docs/schema/engagements.md`
(migration 0086). Three writers:
- **Open/grow** — fail-soft hook in `api/close_events.py` (every ≥90s outbound call).
- **Final** — fail-soft hook in `api/airtable_events.py` (a landed triage form closes
  its oldest open engagement, guarded against re-using an already-linked form).
- **Overdue + ping** — `api/engagement_ping_cron.py` (`*/5` when scheduled, `CRON_SECRET`-auth).
  Flips overdue every tick; pings only inside **10am–10pm ET** (gate in code, DST-safe).

**Env (Vercel):** `SALES_FORM_NOTIFY_SLACK_CHANNEL` (the channel — currently `C0BBQAE7BA4`),
`ENGAGEMENT_PING_FLOOR` (go-live timestamp — only engagements overdue at/after it are pinged;
keeps backfilled rows silent), `SETTER_TRIAGE_FORM_URL` / `CLOSER_TRIAGE_FORM_URL` (the
form-fill links — Airtable form-PAGE URLs `…/pag…/form`, not the table id; both forms write
the same table `tblaoMsiE3FSkHjQt`). Reuses `SLACK_BOT_TOKEN` (Ella) — she must be **in the
channel**. A rep is pingable only with a `team_members.slack_user_id` (and `close_user_id`
for the call→rep match).

**Two kill switches** (both need a redeploy to take effect): (a) **remove the cron line**
from `vercel.json` — the current pause; stops the cron entirely (overdue-flip + pings). (b)
**unset `SALES_FORM_NOTIFY_SLACK_CHANNEL`** — cron keeps running and flipping overdue, but
posts nothing (dry-run). Env-var changes do **not** affect the running deployment until the
next deploy.

**⚠ Deploy gotcha — the 250 MB function cap.** Every Python function in `vercel.json`'s
`functions` block carries `"excludeFiles": "{.next,node_modules}/**"`. Without it, Vercel's
tracer bundles the built `.next/` (~246 MB) into the function and the deploy fails entirely
with *"1 function exceeded the uncompressed maximum size of 250 MB."* `engagement_ping_cron`
has its entry — **don't remove it**, and any NEW `api/*.py` you add needs the same line.

**Backfill:** `scripts/backfill_engagements.py --days N` replays calls+forms into the table
(no pinging — there's no Slack in the backfill; 2-day backfill already run). **Re-point a
mislinked form:** clear the engagement's `final_at` / `form_id`, set the correct form's link
(the engagement page is the human surface for this).

---

## Ops traps (read before touching data or migrations)

### The env-var gotcha — `.env.local` points at LOCAL Supabase
The active `SUPABASE_URL` is `http://127.0.0.1:54321` — a **stale local Docker snapshot
that lies** (missing columns, fewer rows). The cloud project
(`sjjovsjcfffrftnraocu.supabase.co`) is on the **`#`-commented** lines. To probe cloud
from a script, grab the `https://` URL and the commented service-role key. The deployed
Vercel app always runs against cloud — only **local diagnostics** are at risk of hitting
the wrong DB. Use `.venv/bin/python` for DB ops (psycopg2 isn't in system python), and
`os.environ.setdefault` the vars first (`.env.local` isn't auto-loaded into the shell).

### Migrations — the one careful, Drake-gated path
Local Docker being up makes the Supabase CLI silently **misroute** `db push --linked`.
Apply migrations via **psycopg2 against the pooler** (`supabase/.temp/pooler-url` +
`SUPABASE_DB_PASSWORD`), then **manually insert the ledger row** into
`supabase_migrations.schema_migrations`. **Dual-verify against CLOUD explicitly** (never a
single query): schema reality (`to_regclass` / `information_schema.columns` / `pg_proc`)
**and** ledger registration, plus a pre/post `count(*)` drift check.

- **Drake reviews the SQL diff before apply** (the permanent migration gate).
- **The "applied but wasn't" trap:** migration 0066 was claimed applied but had only been
  verified against LOCAL (cloud `to_regclass = None`, ledger max = 0065). The canonical
  apply path is `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes`
  — verify it actually hit cloud.
- **Airtable parser sequencing:** `_upsert_batch` upserts the full parsed dict (no column
  whitelist) → apply the column migration to **cloud BEFORE deploying** the parser that
  writes it. `fields_raw` jsonb always holds the complete field set.

### The 1000-row PostgREST cap
`.range(0, 9999)` silently truncates to 1000. See `logic.md` § The 1000-row cap.

### Soft-hide `excluded_at`
Creator-only, survives re-sync (parsers never write it). Lives on `close_leads`,
`calendly_scheduled_events`, `airtable_setter_triage_calls`. **Not every surface filters
it — check.** Test rows: filter on the **backing lead** (`close_leads.display_name =
'test'`), not the form's `prospect_name` (a test form can carry "testr" while its lead is
"test"; this once inflated Cash upfront by a $2,122 test deposit).

### HTTP/2 `ConnectionTerminated` (python diagnostics only)
The python supabase/httpx client drops the pooler connection after a few sequential
queries — transient, retry with a fresh client. The production TS client over fetch does
**not** hit this.
</content>
