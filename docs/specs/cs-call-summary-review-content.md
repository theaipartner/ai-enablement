# Spec — CS call summary content swap (review primary, Fathom fallback)

## Goal

Switch the per-call Slack post in `cs-call-summaries` from raw Fathom `default_summary` to formatted call-review content. Fathom summaries render badly in Slack (`###` headers and similar Markdown that Slack mrkdwn doesn't honor); call reviews are more digestible and the formatting is fully ours. Fall back to a *cleaned* Fathom summary when the review isn't available, so we never lose visibility on a call.

## Files touched

- `agents/gregory/cs_call_summary_post.py` — fetch review, format new message, fallback path, audit-row enrichment
- `agents/call_reviewer/persistence.py` — add a public reader (e.g., `find_review_by_call_external_id`) that returns the parsed-JSON dict or `None`
- `scripts/test_cs_call_summary_locally.py` — extend the existing harness with new fixtures (review-found populated / review-found empty arrays / malformed JSON / review-missing). Per CLAUDE.md the harness today is 28/28; the new tests stack on top
- `docs/runbooks/cs_call_summary.md` — content shape + fallback rules + audit `content_source` field documentation
- `CLAUDE.md` § Live System State — update the M6.1 paragraph that currently mentions "posts a one-message summary (CSM / client / Fathom default_summary / deep-link)" to reflect the new content shape + fallback

## Current behavior

`maybe_post_cs_call_summary` receives `summary_text` (Fathom's `default_summary`) from the pipeline caller and posts:

```
*[CSM Name] / [Client Name]*
[summary_text raw — no mrkdwn conversion]
<deeplink|View in Gregory>
```

Audit-row `source = 'cs_call_summary_slack_post'`. Fail-soft: never raises, always returns the result dict. The pipeline already passes `fathom_external_id` (= `calls.external_id`) which is the key we need for the review lookup.

## Target behavior

Same function entry point, same audit-row `source`, same fail-soft contract. Internally:

1. Fetch the call_review document by `fathom_external_id` from `documents` (source='fathom', document_type='call_review'). Use a new public reader in `agents/call_reviewer/persistence.py` so the data-access concern stays with the call_reviewer module.
2. If found and the JSON parses cleanly, format as the *Review-shaped* message below, run through `markdown_to_mrkdwn`, post.
3. If not found OR JSON malformed OR missing required fields, format the *Fallback* message using the existing `summary_text` argument, run through `markdown_to_mrkdwn`, post.
4. Audit-row payload gets a new field `content_source: 'call_review' | 'fathom_summary_fallback'` so future debugging / dashboards can split the two paths.

### Review-shaped message

```
*[CSM Name] / [Client Name]*

*Sentiment*
[sentiment_arc]

*Pain points*
• [description] — _[evidence]_
• ...

*Wins*
• [description] — _[evidence]_
• ...

*Conversation pivots*
• [description] (who: [who]) — _[evidence]_
• ...

<deeplink|View in Gregory>
```

Rules:
- **Empty sections omitted entirely.** No "None" filler — keeps the message tight.
- **Sentiment is always present** per the reviewer prompt; include the section unconditionally as long as the field is a non-empty string.
- **Evidence quotes wrapped in `_..._`** (mrkdwn italic).
- **Section headers as `*bold*`** (mrkdwn) — emit directly rather than relying on the converter to translate `###`.
- **Pivots subsection labeled "Conversation pivots"** to match the dashboard's user-facing rename of `dodged_questions` (per CLAUDE.md § Call Review V1, V2 brain rename note).
- **Pivots include `(who: [who])` inline.**
- **Whole message passed through `markdown_to_mrkdwn`** as the safety net — review-content is unlikely to contain raw Markdown, but the reviewer is an LLM and the safety net costs nothing.

### Fallback message

```
*[CSM Name] / [Client Name]*
[summary_text, after markdown_to_mrkdwn]
<deeplink|View in Gregory>
```

Same shape as today, just with the cleanup pass applied so `###`-laden Fathom output renders cleanly.

## Test scenarios (extend `scripts/test_cs_call_summary_locally.py`)

Existing 28 must continue to pass. Add at minimum:

1. Review found, all four sections populated → review-shaped message posted, mrkdwn correct, audit `content_source='call_review'`
2. Review found, `pain_points` and `wins` and `dodged_questions` all empty arrays → message has only the `*Sentiment*` section + header + deeplink
3. Review found, JSON malformed (string not parseable as JSON, or missing required keys) → fallback path, audit `content_source='fathom_summary_fallback'`
4. Review NOT found in the documents table → fallback path, audit `content_source='fathom_summary_fallback'`
5. Verify `markdown_to_mrkdwn` is invoked on both paths — at minimum, assert `'###'` does not appear in the text passed to `post_message`
6. Existing scenarios (non-client category skip, no summary text, channel not configured, Slack post failure non-fatal, etc.) continue passing unchanged

## Doc updates (mandatory; explicit "no change needed" if you decide one isn't applicable)

- `docs/runbooks/cs_call_summary.md` — message-format section rewrite to show both shapes; new "Audit row: content_source field" note; clarify the cleanup-pass safety net
- `CLAUDE.md` § Live System State — update the M6.1 sentence that mentions "Fathom default_summary" to reflect the new content + fallback. Keep the rest of the paragraph intact (audit-trail source label, channel env var, fail-soft semantics all unchanged)
- `agents/gregory/cs_call_summary_post.py` module docstring — refresh the "Message format" example block to show the new review-shape and fallback

## Out of scope

- Audit-row `source` label change (stays `cs_call_summary_slack_post`)
- Backfilling missing reviews for old calls (separate concern; not needed since fallback covers it)
- Truncation logic (V1 reviews are short — the reviewer prompt asks for terse output. Address only if real calls hit Slack's 40K limit)
- Daily accountability cron (`api/accountability_notification_cron.py` — different surface, untouched)
- Fathom pipeline ordering (review-gen already runs before this post per `ingestion/fathom/pipeline.py:_ensure_call_review_document` at line 268, then post at line 307 — ordering is correct and stays)
- Review-side schema or generation prompt changes
