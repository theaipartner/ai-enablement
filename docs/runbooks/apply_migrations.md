# Runbook: Apply Database Migrations

How to apply `supabase/migrations/*.sql` against the cloud Supabase project, plus how to verify the result. The cloud path is canonical; local development with `supabase start` is a separate workflow and is currently incompatible with cloud apply (see § Preconditions).

## Flow

1. **Write the migration SQL** as a new numbered file in `supabase/migrations/<NNNN>_<name>.sql`. The numeric prefix continues from the latest existing migration.
2. **Review the SQL diff** before applying — confirm the schema change is what's intended (already-applied migrations are immutable, so this is the last chance to catch a mistake cheaply).
3. **Apply via the CLI** — `supabase db push --linked --dns-resolver https --password "$DB_PW" --yes` (see § Apply below).
4. **Dual-verify** post-apply: schema reality (`to_regclass`, `pg_proc`, `information_schema.columns` as appropriate to the migration) AND ledger registration (`supabase_migrations.schema_migrations`).

## Preconditions

**Docker WSL integration must be OFF on this machine.** Verify before any cloud apply:

```bash
docker ps
# Must return: "The command 'docker' could not be found in this WSL 2 distro."
# (Or any other "Docker not reachable" error.)
```

If `docker ps` succeeds and shows a running daemon, **STOP**. Disable Docker Desktop's WSL integration first (Docker Desktop → Settings → Resources → WSL Integration → toggle off the Ubuntu distro), then re-verify with `docker ps`.

Reason: Supabase CLI v2.90.0 silently misroutes `db push --linked` when both a linked-cloud project AND a reachable local Docker stack are present. The bug surfaced 2026-04-28 (every migration 0011–0028 then shipped via Studio + manual ledger as a workaround for ~10 days); Phase 3 discovery on 2026-05-08 confirmed the CLI works correctly when there's no reachable local Docker target. See `docs/archive/historical/known-issues.md` for the resolved entries documenting the era.

Other preconditions:

- `.env.local` exists with a valid `SUPABASE_DB_PASSWORD` (URL-quoted via the boilerplate below; the live password contains a `#`).
- `supabase/.temp/pooler-url` exists and points at the cloud pooler URL. Regenerate via `supabase link --project-ref sjjovsjcfffrftnraocu --dns-resolver https` if the file is missing or the password was rotated.
- `supabase --version` resolves to 2.90.0 or later. The system CLI is canonical; `npx supabase` invokes the latest published version (2.98.2 as of 2026-05-08) and is acceptable as a fallback if the system CLI ever drifts.

## Apply

Working command pattern:

```bash
DB_PW=$(.venv/bin/python -c "
from pathlib import Path
for ln in Path('.env.local').read_text().splitlines():
    if ln.startswith('SUPABASE_DB_PASSWORD='):
        print(ln.partition('=')[2].strip().strip('\"').strip(\"'\"))
        break
")
supabase db push --linked --dns-resolver https --password "$DB_PW" --yes
```

Expected output (verbatim, from the 2026-05-08 Phase 3 discovery test):

```
Connecting to remote database...
Do you want to push these migrations to the remote database?
 • <NNNN>_<name>.sql

 [Y/n] y
Applying migration <NNNN>_<name>.sql...
Finished supabase db push.
```

Notes:

- **"Connecting to remote database..."** is the canonical confirmation that the CLI is talking to cloud, not a local stack. If this line is missing, hard stop and surface — the routing may have drifted.
- **The interactive prompt is shown despite `--yes`.** Display quirk only — the auto-answer "y" runs. If the apply ever runs from a wrapper that doesn't connect stdin (e.g., a future `scripts/apply_migration.py`), the wrapper handles auth via `--password` and shouldn't need stdin at all.
- **Exit code 0** = success. Non-zero exit = failure; capture stderr verbatim and surface.

If the output deviates from this shape (no remote-connecting line, a `DROP CONSTRAINT` error, a DNS error), STOP. The documented fallback is psycopg2 direct against the pooler URL — see `cloud_supabase.md` § "If `supabase db push` fails with DNS errors".

## Dual-verify

Run BOTH checks after every apply. Single-query verification is forbidden — it can pass against the wrong database.

**Schema reality** — confirm the migration's intended objects actually exist. Adjust the queries to match what the migration was supposed to create.

```python
# Boilerplate: build the cloud connection from .env.local + supabase/.temp/pooler-url.
# (Same shape as scripts/*.py; reproduced inline here for reference.)
import re, urllib.parse
from pathlib import Path
import psycopg2

env = {}
for ln in Path(".env.local").read_text().splitlines():
    if ln.strip() and not ln.startswith("#") and "=" in ln:
        k, _, v = ln.partition("=")
        env[k.strip()] = v.strip().strip('"').strip("'")

pw = urllib.parse.quote(env["SUPABASE_DB_PASSWORD"], safe="")
m = re.match(r"^(postgresql://[^@]+)@(.+)$", Path("supabase/.temp/pooler-url").read_text().strip())
url = f"{m.group(1)}:{pw}@{m.group(2)}"
conn = psycopg2.connect(url, sslmode="require", connect_timeout=15)
cur = conn.cursor()

# Examples — pick whichever matches the migration:
cur.execute("select to_regclass('public.<new_table>')")            # new tables
cur.execute("select * from pg_proc where proname = '<new_func>'")  # new functions / RPCs
cur.execute("""
    select column_name, data_type, is_nullable
    from information_schema.columns
    where table_schema='public' and table_name='<table>'
    order by ordinal_position
""")                                                                # new columns
cur.execute("""
    select conname from pg_constraint
    where conrelid = '<table>'::regclass and contype = 'c'
""")                                                                # new CHECK constraints
```

**Ledger registration** — confirm the version landed in the migrations table:

```python
cur.execute("""
    select version, name
    from supabase_migrations.schema_migrations
    where version = '<NNNN>'
""")
# Expect exactly 1 row.
```

If either returns 0 rows (or unexpected results), the migration didn't fully apply. Recover before declaring done.

**Drift sanity check.** For migrations that should NOT change the public table count (everything except CREATE TABLE / DROP TABLE), run a pre/post snapshot:

```python
cur.execute("select count(*) from information_schema.tables where table_schema = 'public'")
```

Pre and post counts should match. This catches accidental schema drift.

## Failure modes

**"Connecting to remote database" missing from output, but apply seems to succeed.** The CLI may have routed elsewhere (see the Docker precondition above). HARD STOP. Verify against cloud's ledger via psycopg2 BEFORE assuming success. If cloud's ledger doesn't have the version, the apply went somewhere unexpected — recover via Studio + manual ledger insert.

**`DROP CONSTRAINT ... does not exist`.** Migration 0007's pattern. Inspect with psycopg2 to see actual constraint names; update the migration file; retry. Do not skip the migration.

**DNS resolution error during apply.** The Go pgx client bundled in the CLI uses the system resolver, separate from `--dns-resolver https`. Fall back to psycopg2 direct apply — see `cloud_supabase.md` § "If `supabase db push` fails with DNS errors".

**CLI prompts interactively despite `--yes`.** Display quirk — auto-answer "y" runs. If running from a non-interactive wrapper that doesn't connect stdin, the wrapper handles auth via `--password` and shouldn't need stdin at all. Not a real failure.

**Migration file numeric prefix already exists in cloud's ledger.** The CLI will report "Remote database is up to date" and skip. Verify the local file matches the cloud-applied version (cloud-applied SQL is canonical — never edit an already-applied migration).

## Local development workflow (separate, not cloud-relevant)

This runbook describes the cloud-apply path, which is canonical. Local dev via `supabase start` / `supabase db reset` / `supabase migration up` is not used today and would re-trigger the routing bug if combined with cloud apply.

If local dev becomes relevant again:

- `supabase init` is already done (`supabase/config.toml` exists).
- `supabase start` requires Docker WSL integration enabled — which re-introduces the routing-bug risk.
- Treat local and cloud workflows as fully separate. Never run `supabase db push --linked` while a local stack is reachable. Disable WSL integration before any cloud apply.

The local-apply commands themselves still work as documented in the Supabase docs; they're just not part of the canonical cloud-apply path.
