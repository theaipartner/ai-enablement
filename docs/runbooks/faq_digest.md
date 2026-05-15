# Runbook: FAQ digest cron

Operational guide for the weekly Friday FAQ digest cron at
`api/faq_digest_cron.py`. Covers what it does, how to verify a fire,
and the failure modes.

## What it is

Scott is building a client-facing FAQ. Every Friday afternoon the cron
DMs him the questions clients asked during the week's calls so he can
pick from them for blind-spot coverage.

Pipeline (one entry per fire):

1. **Auth.** Vercel Cron POSTs with `Authorization: Bearer <CRON_SECRET>`.
2. **Audit row.** Insert into `webhook_deliveries` with
   `source='faq_digest_cron'` and `processing_status='received'`.
3. **Window.** `now() - 7 days` to `now()`.
4. **Fetch.** SELECT `documents` rows with `source='fathom'`,
   `document_type='call_review'`, and `metadata->>'started_at'` in the
   window. Parse `content` JSON (defensive — malformed rows skip).
5. **Extract.** From each call_review's `questions_asked` array, keep
   entries where `asker='client'` and `question` is a non-empty string.
6. **Cluster.** Token-Jaccard similarity ≥ 0.5 against the longest
   member of each cluster. Greedy single-pass; no LLM (cost-down by
   design, per Scott). Representative = longest question in the cluster
   (typically most specific). Stop-word list drops "the/is/to/and"-class
   tokens so they don't inflate Jaccard scores.
7. **Sort.** Cluster count descending, then representative alpha asc
   for stability.
8. **Cap.** Top 50 clusters surface in the Slack message; an
   "...and N more" footer caps the bottom.
9. **Send.** Resolve Scott's `slack_user_id` dynamically from
   `team_members` (`full_name ILIKE 'Scott Wilson%'`); post via
   `shared.slack_post.post_message`. The user ID works as a `channel`
   value for `chat.postMessage` (Slack resolves it to the IM channel).
10. **Mark audit.** Final `processing_status='processed'` (or `'failed'`
    with `processing_error`) plus the full payload shape on the row.

The cron returns 200 regardless of Slack outcome — failed sends are
captured in the audit row but don't trigger Vercel Cron retries
(retries on Slack failures don't help and risk dup-DMs).

## Schedule

```
0 19 * * 5
```

Friday 19:00 UTC. Translates to:

- **DST window (mid-March → early November):** 15:00 EDT.
- **Standard window (early November → mid-March):** 14:00 EST.

Scott is in Europe, so 14-15:00 ET is a normal afternoon hour for him.
The seasonal drift is acceptable per the spec — locking on UTC keeps
the cron entry simple.

## How to verify a fire

### Quick audit

```sql
select webhook_id, processing_status, processed_at, processing_error,
       payload->>'total_questions' as total_questions,
       payload->>'total_clusters' as total_clusters,
       payload->>'slack_ok' as slack_ok
  from webhook_deliveries
 where source = 'faq_digest_cron'
 order by processed_at desc nulls last
 limit 5;
```

### What Scott sees in DM

```
:question: *FAQ digest — week of May 09–May 16*

23 unique client questions across 41 raised this week.

1. "How do I share GHL access with my VA?" (asked in 4 calls)
2. "What's the cold-call opener for dental ICPs?" (asked in 3 calls)
3. "Where do I find the offer-ladder lesson?" (asked in 2 calls)
...
```

When the week had zero client questions surfaced (rare — would imply
all calls produced empty `questions_asked` arrays), the message is
explicit:

```
:question: *FAQ digest — week of May 09–May 16*

No client questions surfaced this week.
```

This is deliberate. Sending "no questions" tells Scott the cron ran.
Silent skips would make a failure indistinguishable from a quiet week.

### "Which questions surfaced last week" — investigative SQL

```sql
select doc.metadata->>'started_at' as call_started,
       doc.title,
       qa->>'question' as question
  from documents doc,
       lateral jsonb_array_elements((doc.content::jsonb)->'questions_asked') qa
 where doc.source = 'fathom'
   and doc.document_type = 'call_review'
   and (doc.content::jsonb)->'questions_asked' is not null
   and qa->>'asker' = 'client'
   and doc.metadata->>'started_at' >= (now() - interval '7 days')::text
 order by doc.metadata->>'started_at' desc;
```

## Failure modes

### CRON_SECRET misconfigured

Symptom: cron returns 401; `webhook_deliveries` has no row for the fire.
Recovery: check Vercel env vars for `CRON_SECRET`; this is shared with
the other crons (single-var pattern per M6.2).

### Scott's team_members row not found / slack_user_id null

Symptom: `processing_status='failed'` with
`error='scott_slack_user_id_not_resolved'`. The cron didn't attempt a
Slack send. Recovery: confirm `select id, full_name, slack_user_id from
team_members where full_name ilike 'Scott Wilson%' and archived_at is
null;` returns a row with a non-null `slack_user_id`. If the lookup
needs to point at someone other than Scott Wilson (e.g., he's away and
a backup CSM owns the FAQ work), the filter at
`api/faq_digest_cron.py:_fetch_scott` is the surface to edit.

### Slack send failure

Symptom: `processing_status='failed'`,
`processing_error='slack_post_failed: <reason>'`. Common reasons:

- `channel_not_found` — the bot can't open a DM to Scott. Confirm Scott
  has interacted with the bot at least once (Slack requires this on
  some workspace configurations).
- Network / timeout — transient.

Recovery: no automatic retry. Manual re-run via curl:

```
curl -i -X POST -H "Authorization: Bearer $CRON_SECRET" \
     https://ai-enablement-sigma.vercel.app/api/faq_digest_cron
```

### Malformed call_review content

Symptom: cron returns `total_questions` lower than expected for the
week. Defensive parsing silently skips rows where `content` isn't
valid JSON or `questions_asked` isn't a list. Investigate by inspecting
the `documents.content` of suspect rows.

### Cron didn't fire

Symptom: no new `webhook_deliveries` row for the expected Friday window.
Recovery: Vercel dashboard → Crons tab → check the
`/api/faq_digest_cron` schedule registered and recent invocations.
Manual fire via the curl above is the smoke test.

## How to disable temporarily

Remove the cron entry from `vercel.json`:

```diff
- { "path": "/api/faq_digest_cron", "schedule": "0 19 * * 5" }
```

Redeploy. Re-add to resume. The function entry under `functions:` can
stay — only the `crons:` entry triggers the weekly fire.

## Tuning surfaces

The cron has three knobs in `api/faq_digest_cron.py` worth iterating
from production data:

- `_CLUSTER_JACCARD_THRESHOLD` (default `0.5`). Lower = more aggressive
  clustering (fewer top entries, more conflation). Higher = less
  clustering (more entries, more near-duplicates). Scott's verdict on
  the first few digests determines the right setting.
- `_MAX_CLUSTERS_IN_MESSAGE` (default `50`). The cap before the
  "...and N more" footer.
- `_WINDOW_DAYS` (default `7`). The look-back. Reduce if a week feels
  too noisy; increase if it feels thin.

`PROMPT_VERSION` and the call_reviewer prompt's `questions_asked` field
semantics are upstream — see `docs/agents/call_reviewer.md` and
`agents/call_reviewer/prompt.py`.
