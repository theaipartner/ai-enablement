"""Setter-call AI review.

Reads a transcript from `setter_call_transcripts`, runs the Sonnet
system prompt, parses the JSON response, computes talk-time from the
diarized words, and persists everything to `setter_call_reviews`.

Public surface:

    from agents.setter_call_reviewer import review_call, find_pending_reviews

    # Process one transcript
    review_call(close_call_id="acti_xxx")

    # Find transcripts that don't have a review yet
    for close_id in find_pending_reviews():
        review_call(close_call_id=close_id)

Hard isolation from CS surfaces:
  - Writes ONLY to setter_call_reviews.
  - Does NOT touch the documents table, agent_runs, or any Ella-readable
    surface. Sales-only.
  - Cost telemetry lives inline on the row (sonnet_*_tokens,
    sonnet_cost_usd), not in agent_runs.
"""

from agents.setter_call_reviewer.reviewer import (  # noqa: F401
    ReviewError,
    find_pending_reviews,
    review_call,
)
