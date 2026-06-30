# Runbook: Cloud Supabase Operations

How to operate against the cloud Supabase project that backs Ella in production. Covers auth, migrations, seeds, ingestion, Vercel env swap, and redeploy. Written after the first cloud push landed — treat this as the primary reference going forward.

## Project identity

- **Project ref:** `sjjovsjcfffrftnraocu`
- **Region:** us-east-2 (Ohio) — close to Vercel's iad1 for low webhook→DB latency
- **Dashboard:** `https://supabase.com/dashboard/project/sjjovsjcfffrftnraocu`
- **Pooler URL template** (password-less, stored locally): `supabase/.temp/pooler-url`. Produced by `supabase link`; used by ops scripts that connect directly via psycopg2.

## Env vars on this machine

`.env.local` carries all six keys needed for the webhook plus the ops-only DB password:

```
SUPABASE_URL                  = https://sjjovsjcfffrftnraocu.supabase.co
SUPABASE_SERVICE_ROLE_KEY     = <JWT, ~219 chars>
SUPABASE_DB_PASSWORD          = "<password — quoted because it contains #>"
ANTHROPIC_API_KEY             = sk-ant-...
OPENAI_API_KEY                = sk-proj-...
SLACK_BOT_TOKEN               = xoxb-...
SLACK_SIGNING_SECRET          = <webhook HMAC secret>
```

`SUPABASE_DB_PASSWORD` is ops-only — the webhook and the agent runtime use PostgREST via `SUPABASE_SERVICE_ROLE_KEY` and don't need the DB password. Direct-Postgres scripts (migrations, seeds, data copies) read `SUPABASE_DB_PASSWORD` and build a URL from `supabase/.temp/pooler-url`.

Reminder: `.env.local` is gitignored. Never commit. `.env.example` documents the key names.

## Resetting the DB password

Dashboard → Project Settings → Database → Database password → **Reset database password**. Copy the new value immediately (the dashboard won't show it again). Then:

1. Update `.env.local` — `SUPABASE_DB_PASSWORD="<new value in double quotes if it contains #>"`.
2. Re-run `supabase link --project-ref sjjovsjcfffrftnraocu --dns-resolver https` to refresh `supabase/.temp/pooler-url`.
3. Verify direct connection:

```bash
.venv/bin/python - <<'PY'
from pathlib import Path
import re, urllib.parse, psycopg2
env = {}
for ln in Path(".env.local").read_text().splitlines():
    if ln.strip() and not ln.startswith("#") and "=" in ln:
        k, _, v = ln.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")
pw = urllib.parse.quote(env["SUPABASE_DB_PASSWORD"], safe="")
m = re.match(r"^(postgresql://[^@]+)@(.+)$", Path("supabase/.temp/pooler-url").read_text().strip())
url = f"{m.group(1)}:{pw}@{m.group(2)}"
c = psycopg2.connect(url, sslmode="require", connect_timeout=10)
c.cursor().execute("select current_database(), current_user")
print(c.cursor().fetchone())
PY
```

## Applying migrations to cloud

Migrations live in `supabase/migrations/`. **`supabase db push` is the canonical tool — see `docs/runbooks/apply_migrations.md` § Flow and § Preconditions.** On WSL2 specifically, the default system DNS drops AAAA-only records from Supabase's pooler, so always pass `--dns-resolver https`:

```bash
DB_PW=$(.venv/bin/python -c "
from pathlib import Path
for ln in Path('.env.local').read_text().splitlines():
    if ln.startswith('SUPABASE_DB_PASSWORD='):
        print(ln.partition('=')[2].strip().strip('\"').strip(\"'\"))
        break
")
supabase db push --dns-resolver https --yes --password "$DB_PW"
```

`supabase db push` is idempotent — it compares `supabase/migrations/` to the remote `supabase_migrations.schema_migrations` table and applies only what's missing. Run with `--dry-run` first if you want to preview.

### If `supabase db push` fails with DNS errors

The Go pgx client bundled in the CLI uses the system resolver (not `--dns-resolver https`) for the Postgres connection specifically. If it fails with `lookup aws-X-us-east-Y.pooler.supabase.com on 10.255.255.254:53: no such host`, fall back to applying migrations directly via psycopg2:

```python
# ops script shape — iterate supabase/migrations/*.sql in order,
# execute each against the pooler URL, and insert a row into
# supabase_migrations.schema_migrations with version = numeric
# prefix and name = remainder of the filename.
```

This path bypasses the Go pgx resolver entirely. psycopg2 uses libpq, which resolves cleanly on this box. The cloud push on 2026-04-24 used the CLI path successfully after the first attempt; keep this fallback documented in case the DNS flake resurfaces.

## Applying seeds

Only `supabase/seed/team_members.sql` today. It's idempotent via `on conflict (email) where archived_at is null do nothing`. Apply via psycopg2 (no separate CLI tool for seeds):

```python
# Connect to cloud via the same pooler URL + SUPABASE_DB_PASSWORD
# pattern as the "Resetting the DB password" snippet above, then:
sql = Path("supabase/seed/team_members.sql").read_text()
conn.cursor().execute(sql)
conn.commit()
```

Then populate `team_members.slack_user_id` for the subset that has them. These are normally populated via Slack backfill ingestion; if that's deferred (as it was on the first cloud push), copy the mappings from local:

```python
# Pull from local: select email, slack_user_id from team_members
#   where slack_user_id is not null
# Push to cloud: update team_members set slack_user_id = %s where email = %s
```

## Running ingestion pipelines against cloud

All four pipelines read `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` from `.env.local` via `shared.db.get_client()`. To run against cloud, just have cloud values in `.env.local` (current state).

```bash
# 1. Active++ clients (seeds clients + slack_channels + assignments)
.venv/bin/python scripts/seed_clients.py --apply

# 2. Course content (course_lesson documents + chunks + embeddings)
.venv/bin/python -m ingestion.content.cli --apply

# 3. Fathom backlog (calls + call_participants + call_transcript_chunk documents + chunks)
.venv/bin/python -m ingestion.fathom.cli --apply

# 4. Slack 90-day backfill (slack_messages + slack_channels materialization for non-client channels)
.venv/bin/python -m ingestion.slack.cli --apply
```

Each CLI has a dry-run default; review before applying. Runbook-level detail on each: `docs/runbooks/seed_clients.md` for #1, `docs/runbooks/inspect_ingestion.md` for post-run verification queries. The content and Fathom pipelines write OpenAI embedding API calls — budget accordingly (course content was ~$0.01 on the first push; Fathom backlog is forecast at ~$5–15 for 389 transcripts).

### Skipping what you don't need

- For a smoke-test-ready cloud: migrations + team_members seed + `seed_clients.py --apply` + content ingestion is enough. That's the minimum path the 2026-04-24 push took.
- Fathom and Slack backfill enable richer retrieval but aren't required for course-content Q&A. Defer either if scope / cost is tight.

## Swapping Vercel env vars

After changing `.env.local` values, mirror the relevant ones to Vercel. The webhook needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` at minimum; `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` as well if those rotate.

Via the Vercel API (fast; reuses the local CLI auth token):

```python
import json, os, urllib.request
from pathlib import Path

token = json.load(open(os.path.expanduser("~/.local/share/com.vercel.cli/auth.json")))["token"]
team = "team_j92ibBgghEOBz30AWJeEE1ap"
project = "prj_EeWPd4k8agIsq90BILpxnTX24JB8"

def api(method, path, body=None):
    url = f"https://api.vercel.com{path}?teamId={team}"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode() if body else None,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method=method,
    )
    with urllib.request.urlopen(req) as r:
        return json.loads(r.read())

# Find the env var's id, then PATCH the value
envs = api("GET", f"/v9/projects/{project}/env")["envs"]
env_id = next(e["id"] for e in envs if e["key"] == "SUPABASE_URL")
api("PATCH", f"/v10/projects/{project}/env/{env_id}", {"value": "<new value>"})
```

Or via the dashboard: Project Settings → Environment Variables → edit → save.

**Env var changes do not propagate to running deployments.** You must redeploy.

## Redeploying Vercel

Any `git push` to `main` auto-deploys (GitHub integration is linked). For env-var-only changes or to iterate without pushing, use the CLI:

```bash
npx -y vercel deploy --prod --yes
```

Production URL stays stable: `https://ai-enablement-sigma.vercel.app/api/slack_events`. The alias tracks whichever deployment is currently production.

Verify the redeploy:

```bash
curl -sS -o /dev/null -w "HTTP %{http_code}\n" https://ai-enablement-sigma.vercel.app/api/slack_events
# expect: HTTP 200

npx -y vercel logs --no-follow --since 5m --expand --limit 20
# look for: POST /api/slack_events 200, processing app_mention, slack.postMessage ok
```

## The WSL2 IPv6 gotcha

On the WSL2 dev box, the Supabase Go CLI's default `native` DNS resolver prefers IPv6 AAAA records that don't route, making most CLI commands fail with "network is unreachable." Always pass `--dns-resolver https` when invoking `supabase` on this box (this runbook's commands already do). Python libpq via psycopg2 doesn't have this problem — it uses glibc's resolver which handles IPv4 fine. Stock WSL distros won't need this flag, so don't push it into repo config as a default.

## Known quirks

- **PostgREST page cap at 1000 rows.** `db.table("x").select("id").execute()` silently returns at most 1000 rows. For accurate counts, use `db.table("x").select("id", count="exact", head=True).execute().count`. See `docs/archive/historical/known-issues.md` for the writeup.
- **`supabase/.temp/`** is regenerated by `supabase link` and contains the pooler URL template plus version info. `.gitignore` covers it; don't commit.
- **Migrations are one-way.** Don't edit an already-applied migration — write a new one with the next numeric prefix.
