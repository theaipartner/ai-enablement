# Runbook: Apply Database Migrations

> **Provisional, pending Phase 3.** The CLI workflow described below does not work in this environment — Supabase CLI commands silently route to local Docker instead of cloud Supabase. Until Phase 3 (which will either fix the CLI or build a `scripts/apply_migration.py` wrapper that Director can call), the canonical migration path is: Drake applies SQL via Supabase Studio SQL Editor, Drake registers the ledger row manually (`insert into supabase_migrations.schema_migrations ...`), Director dual-verifies (schema reality + ledger registration) against cloud explicitly. See `docs/known-issues.md` for the standing CLI-broken entry and the dual-verification discipline.

How to apply `supabase/migrations/*.sql` against a local or cloud Supabase project, and how to verify the result. Keep this current — every new migration sequence you run should leave behind a log entry at the bottom.

## Prerequisites

- Supabase CLI installed (`supabase --version` — we're on 2.90+)
- Docker Desktop running (required for local; WSL integration enabled)
- Shell access in the repo root (`/home/drake/projects/ai-enablement`)
- A way to run `psql`: either installed locally, or via `docker exec -i supabase_db_ai-enablement psql ...` against the local container

## Apply to Local

First-time apply on a fresh machine:

```bash
supabase init                          # creates supabase/config.toml if not present
supabase start                         # spins up Postgres + pgvector + all Supabase services
```

On first `supabase start`, the CLI pulls images (expect 2-5 minutes). Subsequent starts take ~15 seconds. **Migrations in `supabase/migrations/` are auto-applied** on `supabase start` against a fresh DB — no separate `db push` needed for the first run.

To re-apply migrations after changes (destructive — drops and recreates the local DB):

```bash
supabase db reset
```

To apply only new migrations without resetting:

```bash
supabase migration up
```

### Local connection info

`supabase status` prints everything. Shortcut: `postgresql://postgres:postgres@127.0.0.1:54322/postgres`. Studio UI at `http://127.0.0.1:54323`.

## Seed Data

Seed files live in `supabase/seed/*.sql` and are picked up by the CLI via `[db.seed].sql_paths = ["./seed/*.sql"]` in `supabase/config.toml`. Every seed file must be idempotent — use `ON CONFLICT DO NOTHING` (or a targeted update) so re-runs don't duplicate rows or overwrite manual edits.

**When seeds apply automatically.** `supabase db reset` runs migrations from scratch and then applies every matched seed file in order. This is destructive — it drops the local DB first.

**Applying seeds without a reset (local).** Pipe the seed file directly into the container:

```bash
docker exec -i supabase_db_ai-enablement psql -U postgres -d postgres \
  < supabase/seed/team_members.sql
```

Idempotent seeds can safely be re-piped any time. Use this when you've added new rows to a seed file and don't want to wipe the DB.

**Applying seeds to cloud.** `supabase db push` doesn't run seed files — it applies only migrations. For cloud, copy-paste the seed SQL into **Studio → SQL Editor** and run it there. Same idempotency guarantee means pasting the same file twice is safe. This is a temporary workflow until we either (a) move seed content into an ordinary migration or (b) build a tiny `scripts/apply_seeds_to_cloud.py` that reads `supabase/seed/*.sql` and pushes via the Postgres connection.

**Note on partial unique indexes.** Tables with partial unique indexes (e.g. `team_members.email` filtered on `archived_at is null`, from migration `0007_partial_unique_archival.sql`) require the predicate in the `ON CONFLICT` target: `ON CONFLICT (email) WHERE archived_at IS NULL DO NOTHING`. Without the predicate, Postgres can't match the index.

## Apply to Cloud

Prerequisites: Supabase cloud project created, project ref captured from the dashboard URL (`https://supabase.com/dashboard/project/<ref>`).

```bash
supabase link --project-ref <ref>      # one-time; writes link into supabase/.temp
supabase db push                       # applies any migrations not yet in remote
```

`supabase db push` is idempotent — it compares `supabase/migrations/` to the remote `supabase_migrations.schema_migrations` table and applies only what's missing. It will prompt for confirmation before executing DDL.

### Cloud-specific guardrails

- **Always push to a staging project first** if one exists. A fresh cloud project is cheap; an unintended migration against production is not.
- Before `db push`, run `supabase db diff` to preview what SQL will execute.
- Do not edit already-applied migrations. To change the schema, write a new migration with the next number.

## Verify After Apply

Run these against whichever environment you just touched. Against local use `docker exec -i supabase_db_ai-enablement psql -U postgres -d postgres -c '...'`; against cloud use `psql $SUPABASE_DB_URL -c '...'` or Studio SQL editor.

**1. Migration history.** All numbered migrations present.

```sql
select version, name from supabase_migrations.schema_migrations order by version;
```

Expected for schema v1: versions `0001` through `0007`.

**2. Table count.** V1 schema defines 16 public tables.

```sql
select count(*) from information_schema.tables where table_schema = 'public';
```

Expected: `16`.

**3. Extensions.** `pgcrypto` (for `gen_random_uuid()`) and `vector` (pgvector for embeddings).

```sql
select extname, extversion from pg_extension
where extname in ('vector', 'pgcrypto') order by extname;
```

Expected: both rows present.

**4. RLS enabled on every table.**

```sql
select relname, relrowsecurity from pg_class
where relnamespace = 'public'::regnamespace and relkind = 'r' order by relname;
```

Expected: every row shows `relrowsecurity = t`.

**5. `updated_at` triggers attached to the right tables.**

```sql
select event_object_table, trigger_name from information_schema.triggers
where trigger_schema = 'public' order by event_object_table;
```

Expected: one `set_updated_at` trigger each on `team_members`, `clients`, `slack_channels`, `documents` (four rows). Nothing on tables without `updated_at`.

**6. Partial unique indexes from 0007 in place.**

```sql
select indexname from pg_indexes
where tablename in ('team_members', 'clients')
  and (indexname like '%email%' or indexname like '%slack_user%')
order by indexname;
```

Expected: `clients_email_active_idx`, `clients_slack_user_id_active_idx`, `team_members_email_active_idx`, `team_members_slack_user_id_active_idx`.

**7. HNSW vector index on `document_chunks.embedding`.**

```sql
select indexdef from pg_indexes
where tablename = 'document_chunks' and indexname = 'document_chunks_embedding_hnsw_idx';
```

Expected: `... USING hnsw (embedding vector_cosine_ops)`.

## Failure Modes and Recovery

**`supabase status` reports "No such container".** The stack isn't running. Run `supabase start`. If that fails with a Docker connection error, Docker Desktop is off (start it) or WSL integration isn't enabled (fix in Docker Desktop settings → Resources → WSL integration).

**`supabase start` hangs on image pull.** Check network and Docker Desktop status. Images live in Docker Hub; a proxy or firewall may be intercepting. Retry `supabase start` after fixing.

**`supabase db push` fails with `DROP CONSTRAINT ... does not exist`.** Migration `0007` assumes Postgres auto-named the original unique constraints `<table>_<column>_key`. If a prior run used different names, the DROP fails. Inspect with `\d team_members` (via `psql`) to see real names, update `0007_partial_unique_archival.sql`, commit, retry. Do not skip the migration — the partial-unique semantics matter.

**Port conflict on `supabase start` (54321/54322/54323 etc.).** Another instance is already running, or another process is on those ports. `supabase stop` first, then `lsof -i :54322` to see what else is holding it.

**Apply succeeded but tables are missing.** Unlikely on a fresh DB; more likely on a cloud DB that had prior content. Check `select * from supabase_migrations.schema_migrations` — if versions are listed, the CLI thinks they succeeded. Inspect the actual DDL in each migration file for conditional logic that may have no-op'd.

**Need to start over locally.** `supabase db reset` drops and recreates the local DB, then re-runs all migrations from scratch. Fast and safe — local is throwaway by design. Do not run `supabase db reset` against a linked cloud project.

## First Apply Log

- **2026-04-20 — local apply against a fresh stack.** Ran `supabase init` → `supabase start` → all 7 migrations auto-applied on first boot. Total wall time ~3 minutes (dominated by first-run image pulls on `supabase start`). Verification queries all passed: 16 tables, both extensions present (pgvector 0.8.0, pgcrypto 1.3), RLS on every table, 4 triggers on the right tables, 4 partial unique indexes, HNSW index on `document_chunks.embedding`. One correction to note: the session prompt said "17 tables" but the schema defines 16 — inventory confirmed against `docs/schema/schema-v1.md` and every migration file. `psql` not installed on the WSL host; used `docker exec -i supabase_db_ai-enablement psql ...` throughout. Cloud apply not yet performed — to follow once local is exercised by the first ingestion pipeline.
