# Runbook: Re-run Fathom Backlog Ingest

**When to use.** A new Fathom TXT export arrives (old one replaced, or additional history fetched) and needs to land in cloud Supabase. The pipeline is idempotent, so re-running over calls already ingested is safe — it won't duplicate rows and won't re-embed existing chunks.

**When NOT to use.** Live (per-call) Fathom ingestion. That's a separate, still-deferred webhook path (see `docs/archive/historical/future-ideas.md` § "Fathom webhook integration"). This runbook is only for the batch/backlog export workflow.

First actual application of this runbook: session F1.4 on 2026-04-24, which landed 516 transcripts.

---

## Pre-flight (before `--apply`)

Do not skip the pre-flight steps even if the export "looks fine." The F1 series (F1.1–F1.4) only went clean because F1.2 preloaded alternates that would otherwise have produced pilot-client duplicates.

### 1. Hygiene on the drop

Drake typically drops the export under `data/fathom_backlog/` as a `.zip`. WSL can leave a `*:Zone.Identifier` NTFS sidecar — remove it before anything else:

```bash
rm -f data/fathom_backlog/*:Zone.Identifier
```

Confirm the zip is intact:

```bash
.venv/bin/python -c "import zipfile; z=zipfile.ZipFile('data/fathom_backlog/<export>.zip'); print('members:', len(z.namelist())); z.close()"
```

### 2. Confirm the DB target

Every ingestion path reads `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` from `.env.local`. Confirm explicitly that points at cloud, not local:

```bash
.venv/bin/python -c "
from dotenv import load_dotenv; load_dotenv('.env.local')
import os
print('host:', os.environ['SUPABASE_URL'].split('//')[-1])
print('is_cloud:', 'supabase.co' in os.environ['SUPABASE_URL'])
"
```

If `is_cloud` is False and you intended cloud, fix `.env.local` before proceeding. If you intended local, there's no reason to be running this — local backlog ingest is never the production path.

### 3. Quick inventory (zero-touch)

Read the extracted zip structure and the chronological range without running the pipeline. See `session F1.3` in git history for the script — key signals:

- Every file is `.txt`, zero empties, zero AppleDouble / hidden.
- `record.started_at` on the newest file is within ~1 day of "now" (export captured recent calls).
- Header shape matches: `Meeting:`, `Date:`, `Participants:`, `Recorded by:`, `--- TRANSCRIPT ---`.

If header shape has drifted from the above, stop — the parser may need updating before ingest.

### 4. Preload alternates on the roster (if a first-time cloud push or a new merge happened)

The pipeline's `ClientResolver` consults `clients.metadata.alternate_emails` and `alternate_names`. If a dashboard merge has run and its output didn't propagate to cloud — or if new canonical rows were recently added that have alternate identifiers — preload those before `--apply` or the pipeline will produce auto-create duplicates that then need a cleanup merge pass. (Merges today happen via the Gregory dashboard's "Merge into…" flow; the historical one-shot at `scripts/archive/merge_client_duplicates.py` covered the original four pilot pairs.)

F1.2 did this by jsonb-merging the alternates onto the 4 pilot rows. For the next re-run, check whether the `alternate_emails` / `alternate_names` on cloud reflect the current state of the merge pairs:

```sql
select email, metadata->'alternate_emails', metadata->'alternate_names'
from clients
where metadata ? 'alternate_emails' or metadata ? 'alternate_names';
```

If it doesn't, run a jsonb-merge UPDATE keyed on each canonical email (`metadata = coalesce(metadata,'{}'::jsonb) || patch::jsonb`). See session F1.2 for the exact pattern.

---

## Run

### 5. Dry-run first

Always dry-run first. It's free (no DB writes, no embedding API calls), takes ~30 seconds, and surfaces the auto-create list that tells you whether the alternates preload was sufficient.

```bash
.venv/bin/python -m ingestion.fathom.cli --input data/fathom_backlog/<export>.zip > data/fathom_ingest/<yyyy-mm-dd>_dryrun.log 2>&1
```

From the log, pull:

- Classification distribution (`category × confidence` matrix). Expect `client` to dominate, most at high confidence, a fraction at medium.
- **Auto-create predictions.** Scan the list: `awk '/^AUTO-CREATE/,/^PARSE FAILURES/' <dryrun>.log`.
  - No pilot client email or name variant should appear. If one does, the alternates preload missed something — STOP and fix before `--apply`.
  - The count gives you a read on the eventual `needs_review` queue size. If it's dramatically different from prior runs, dig into why before committing embedding spend.
- Parse failures. Should be zero. A failure here is a parser bug — do not proceed.

### 6. Apply

This is the long-running step (~25 min for 516 calls, mostly bottlenecked on OpenAI embedding calls for ~4,300 chunks). The CLI does not print per-call progress; stdout buffers and flushes mostly at process exit.

```bash
.venv/bin/python -m ingestion.fathom.cli --input data/fathom_backlog/<export>.zip --apply > data/fathom_ingest/<yyyy-mm-dd>_apply.log 2>&1 &
```

Then track progress by polling cloud `calls` count (the pipeline writes in order, so count is a proxy for "how far through the 516 files"):

```bash
.venv/bin/python -c "
from shared.db import get_client
print(get_client().table('calls').select('id', count='exact', head=True).execute().count)
"
```

Pace to expect: roughly 4 seconds per client call (that's where embedding happens), faster on non-client calls which skip the chunk pass. If pace falls off a cliff, check `data/fathom_ingest/<yyyy-mm-dd>_apply.log` for stack traces (Python stdout buffering means tracebacks may not appear until the process exits).

On completion, the CLI prints an `APPLY SUMMARY` block and drops a JSON log at `data/fathom_ingest/run_<ts>.log`. The summary reports: `calls inserted/updated`, `documents created`, `document_chunks inserted` + `reused`, `clients auto-created`, `validation failures`, embedding cost estimate.

**Cost expectation.** ~$0.04 for a full 516-call batch (text-embedding-3-small at ~11 chunks/call, ~500 tokens/chunk, $0.02/1M tokens). The "$5–15" estimate that used to live in CLAUDE.md was off by 100×. Budget $0.10 and you'll have ample headroom.

---

## Post-ingest verification

### 7. Row counts + category split

```sql
select
  (select count(*) from calls)                                              as calls,
  (select count(*) from call_participants)                                  as participants,
  (select count(*) from documents where document_type='call_transcript_chunk') as transcript_docs,
  (select count(*) from document_chunks ch
     join documents d on d.id = ch.document_id
     where d.document_type='call_transcript_chunk')                         as transcript_chunks;

select call_category, count(*) from calls group by call_category order by 2 desc;
```

Expectations after a clean run on a typical 500-ish-call backlog:

- `calls` = number of TXT files in the zip, exactly.
- `client` >> everything else. Internal + external + unclassified + excluded together ~25% of total.
- Transcript docs count = number of `client`-category calls (the `_INDEXABLE_CATEGORIES` filter).

### 8. Retrievability + is_active check

```sql
select call_category, is_retrievable_by_client_agents, count(*)
from calls group by 1,2 order by 1,2;

select is_active, count(*) from documents
where document_type='call_transcript_chunk' group by is_active;
```

Invariants:
- `retrievable=true` only on `client` category.
- `is_active=false` transcript docs map 1:1 to medium-confidence client calls (auto-created participant, awaiting review).
- Every non-client category call has `retrievable=false` and no transcript doc.

### 9. Pilot client presence

Check the 7 pilot clients have calls landed + retrievable. `Art Nuno`, `Fernando G`, `Jenny Burnett`, `Dhamen Hothi`, `Javi Pena`, `Musa Elmaghrabi`, `Trevor Heck`:

```sql
select c.full_name, count(ca.id) as n_calls,
       sum((ca.is_retrievable_by_client_agents)::int) as n_retrievable
from clients c
left join calls ca on ca.primary_client_id = c.id
where c.full_name in (
  'Art Nuno','Fernando G','Jenny Burnett','Dhamen Hothi',
  'Javi Pena','Musa Elmaghrabi','Trevor Heck'
) and c.archived_at is null
group by c.full_name order by n_calls desc;
```

Each pilot should have at least 3 retrievable calls. If any has 0, the alternates preload missed and the pipeline likely auto-created a duplicate — go check the `needs_review` queue (step 10).

### 10. needs_review queue

```sql
select email, full_name, metadata->>'auto_created_at' as created
from clients
where 'needs_review' = any(tags)
  and (metadata->>'auto_created_from_call_ingestion')::boolean = true
order by created;
```

Grouped against the dry-run's auto-create prediction — count should match exactly. Any pilot-name/email collision in this list is a bug; see `docs/archive/historical/known-issues.md` § "Auto-created client review workflow" for the hand-merge process.

### 11. Retrieval spot-check via `shared/kb_query.py`

Confirm end-to-end that Ella can surface the new transcripts:

```bash
.venv/bin/python -c "
from shared.kb_query import search_for_client
chunks = search_for_client('what did we cover last call?',
                           client_id='<pilot-uuid>', k=6)
for ch in chunks:
    print(ch.document_type, ch.similarity, ch.document_title[:60])
    assert ch.document_type != 'call_transcript_chunk' or ch.metadata.get('client_id') == '<pilot-uuid>'
"
```

Any leakage (a call_transcript_chunk whose `metadata.client_id` doesn't match the requested `client_id`) is a retrieval-scoping bug. Migration 0010 is the enforcement layer; if this check fails, the migration was rolled back or the RPC was edited. Stop and investigate.

---

## Partial-failure recovery

The pipeline is non-atomic but idempotent. If `--apply` dies mid-batch (network drop, OpenAI rate-limit storm, etc.), re-run the same command. Every write is upsert-shaped:

- `calls` keyed on `(source='fathom', external_id)`
- `call_participants` keyed on `(call_id, email)`
- `documents` keyed on `(source, external_id)` with a metadata-level call_id match
- `document_chunks` keyed on `(document_id, chunk_index)` with `ignore_duplicates=True`

Re-running continues from where it left off without producing duplicates. The `APPLY SUMMARY` on re-run will show most calls as `updated` (not inserted) and chunks as `reused` rather than `inserted` — that's the signature of a clean re-run.

If you see a large `calls updated` count on what was supposed to be a first run, the input has calls that are already in the DB from a prior session — probably fine, but confirm with `select source, count(*) from calls group by source` that you're not accidentally commingling backlog and live-webhook data.

---

## Deferrals this runbook intentionally doesn't cover

- Live webhook ingestion — different payload shape, different entry point, documented in `docs/archive/historical/future-ideas.md`.
- `call_summary` document creation — TXT exports don't carry summaries; the webhook path will. Until then `call_summary` stays empty.
- `call_action_items` rows — same deferral reason.
- Fuzzy / cross-name client matching for the `needs_review` queue — manual review via the Gregory dashboard ("Merge into…" on each `needs_review` client's detail page) today.
