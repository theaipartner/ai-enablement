# call_reviewer

Generates a structured per-call review (pain points, wins, dodged
questions, sentiment arc, questions asked) from the call transcript and
persists it as a `documents` row of type `call_review`.

The review is a display-only artifact for the Gregory dashboard's
Calls detail page; it's never retrieved by other agents (`is_active`
is forced to `false` at write time so the row stays out of
`match_document_chunks` results).

The `questions_asked` field (added in prompt v2, 2026-05-15) feeds the
weekly Friday FAQ digest cron at `api/faq_digest_cron.py` — see
`docs/runbooks/faq_digest.md`. Captures both client-asked and CSM-asked
questions with an `asker` field; downstream consumers (the digest cron
today) filter by `asker='client'`.

## Surface area

- `agents/call_reviewer/reviewer.py` — `review_call(db, call_id, ...)`
  pulls the transcript, runs the Sonnet system prompt, parses JSON.
- `agents/call_reviewer/persistence.py` — `upsert_call_review(...)`
  is the single chokepoint that builds `documents.metadata` and
  writes the row. Idempotent on `(source='fathom', external_id,
  document_type='call_review')`.
- `agents/call_reviewer/sentiment_classifier.py` —
  `classify_sentiment_tier(sentiment_arc) -> 'green' | 'yellow' | 'red'`.
  Haiku-backed (max_tokens=10), called from inside `upsert_call_review`
  before `validate_document_metadata`. Output is merged into
  `metadata.sentiment_tier`. Display-only and never load-bearing —
  classifier failures log a warning and proceed without the field.
- `scripts/backfill_call_reviews.py` — one-shot bulk reviewer for a
  date window.
- `scripts/backfill_sentiment_tiers.py` — one-shot bulk sentiment
  classifier for existing `call_review` rows missing
  `metadata.sentiment_tier`. Idempotent via `IS NULL` filter.

## Metadata shape

`documents.metadata` for `call_review` rows. Required + optional
sets are pinned in `shared/ingestion/validate.py` against
`('fathom', 'call_review')`.

| Key | Required | Notes |
|-----|----------|-------|
| `client_id` | ✓ | The call's `primary_client_id`. Asserted non-null at write time. |
| `call_id` | ✓ | The call's UUID. |
| `call_category` | ✓ | Denormalized from `calls.call_category`. |
| `started_at` | ✓ | Denormalized from `calls.started_at`. |
| `prompt_version` | optional | The reviewer-prompt version that produced the review. Currently `"v2"` — bumped from `"v1"` on 2026-05-15 when `questions_asked` was added to the JSON shape. |
| `model` | optional | The Claude model id used. |
| `sentiment_tier` | optional | `green` \| `yellow` \| `red`. Written by the Haiku classifier; absent when the classifier failed or the source review lacked a `sentiment_arc`. |

## Retrieval rules

- `is_active = false` at write time. `match_document_chunks` skips
  inactive rows, so the V1 retrieval-side invariant is enforced
  defensively even though the function's exclusion list doesn't name
  `call_review` explicitly. Tracked in `docs/known-issues.md` for a
  follow-up that promotes the exclusion into the SQL function.

## Telemetry

- `review_call` opens an `agent_runs` row keyed by
  `agent_name='call_reviewer'`, threads its `run_id` through the
  Sonnet `complete` call so token + cost columns auto-populate, and
  closes via `end_agent_run` on both success and exception paths.
- `classify_sentiment_tier` is utility-scoped — no `run_id`, no
  `agent_runs` write. Per spec § A: cost is rolled into the
  call-review pipeline's existing cost-attribution path if it
  cares, or accepted as untracked otherwise.
