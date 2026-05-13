# documents

Everything Ella and other agents should know: course lessons, FAQs, SOPs, methodology docs, and generated call summaries.

## Purpose

The retrieval-friendly layer of the knowledge base. Raw sources (Drive files, call transcripts) feed into this table as cleanly-typed documents; `document_chunks` then splits and embeds them.

## Columns

| Column | Type | Notes |
|--------|------|-------|
| `id` | `uuid` | PK |
| `source` | `text` | Not null. `drive`, `manual`, `notion`, `call_summary`, ... |
| `external_id` | `text` | Source-system id for re-sync. Null for manually authored |
| `title` | `text` | Not null |
| `content` | `text` | Not null. Full text |
| `document_type` | `text` | Not null. `course_lesson`, `faq`, `sop`, `methodology`, `onboarding`, `call_summary`, `call_review` |
| `tags` | `text[]` | Ad-hoc labels (`module_1`, `sales`, `onboarding`, ...). GIN-indexed |
| `metadata` | `jsonb` | Source-specific. For `call_summary` rows: `metadata.client_id` identifies the client. For `call_review` rows: also carries `sentiment_tier` (`green` \| `yellow` \| `red`, optional — written by the Haiku-backed classifier in `agents/call_reviewer/sentiment_classifier.py`; display-only, never load-bearing). |
| `is_active` | `boolean` | Default `true`. Soft archive for retrieval |
| `created_at` | `timestamptz` | |
| `updated_at` | `timestamptz` | Bumped by trigger |
| `archived_at` | `timestamptz` | |

`UNIQUE (source, external_id)` lets ingestion upsert safely.

## Retrieval Semantics

- Course content, FAQs, methodology, SOPs → globally retrievable by any client-facing agent
- `document_type = 'call_summary'` → client-scoped; Ella retrieves only where `metadata->>'client_id'` matches the asking client. A partial index on `(metadata->>'client_id')` makes that filter cheap.
- Full call transcripts live on `calls.transcript` and are **not** indexed into documents — they are too noisy. Only summaries land here.

## Relationships

- `document_chunks.document_id` → `documents.id` (cascade delete)
- Logical reference from `calls.id` → `documents.metadata.call_id` for `call_summary` docs

## Populated By

- Drive ingestion (course content, SOPs)
- Manual seed (FAQs, onboarding docs)
- Fathom ingestion (call summaries written as `document_type = 'call_summary'`)

## Read By

- Ella via `shared/kb_query.py` (joins to `document_chunks` for semantic retrieval)
- Any future agent that needs the agency's shared knowledge

## Example Queries

All active FAQs:

```sql
select id, title
from documents
where document_type = 'faq'
  and is_active = true
order by updated_at desc;
```

Call summaries for a specific client (safety-filtered retrieval):

```sql
select id, title, created_at
from documents
where document_type = 'call_summary'
  and metadata->>'client_id' = $1
  and is_active = true
order by created_at desc;
```
