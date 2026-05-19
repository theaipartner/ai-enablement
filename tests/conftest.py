"""Pytest conftest — autouse fixtures applied to every test in `tests/`.

Currently registers a single fixture: a no-op for shared.slack_post.post_message
so that test code which flows through any Slack-posting path (cs_call_summary_post,
the Ella handler, future agents) cannot accidentally hit Slack's chat.postMessage.

Why this exists: as of 2026-05-08, tests in tests/ingestion/fathom/test_pipeline.py
were posting to the production cs-call-summaries Slack channel because the pipeline
runs maybe_post_cs_call_summary as a side-effect of ingest_call. After the M6.1
Round-2 spec lands ("skip when no review"), the current pollution stops at its
root because the fake-test mock DB returns no review and the new code skips. This
fixture is belt-and-suspenders for future regressions — if a future test ever
seeds a review document, the post path would re-engage and the live Slack channel
would receive test traffic again. The autouse mock prevents that.

Import-time-binding gotcha (load-bearing — do NOT simplify away):

  Any module that does `from shared.slack_post import post_message` binds the
  function as a *local* name at import time. Patching only
  `shared.slack_post.post_message` would NOT intercept those callers — the local
  name binding inside the importing module still points at the original function.
  We must patch each live local re-export too.

  Today the live re-exports with current pytest exposure are:
    - `agents.gregory.cs_call_summary_post.post_message` (hit via the Fathom
      pipeline test's `_record_with_summary` helper).
    - `agents.ella.passive_dispatch.post_message` (hit by Batch 2.3 passive
      monitor tests that flow through `persist_passive_evaluation`).

  Other re-exports exist but no pytest test imports them today:
    - `api.accountability_notification_cron.post_message` — cron handler is a
      Vercel HTTP entry point, exercised only via
      `scripts/test_accountability_notification_cron_locally.py` (lives outside
      `tests/` so unaffected by this conftest).

  When a new pytest test imports a module that re-exports `post_message`, add
  the dotted path to the monkeypatch list below.
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def _block_real_slack_posts(monkeypatch):
    """No-op shared.slack_post.post_message for every test.

    Tests that want to verify post wiring should monkeypatch
    `agents.gregory.cs_call_summary_post.post_message` (or the relevant
    other re-export) in their own scope — pytest applies test-local
    patches AFTER autouse, so they take precedence for the wrapped
    scope.
    """

    def _noop(*args, **kwargs):
        return {"ok": True, "slack_error": None, "ts": None}

    # Canonical safety net for any caller that does
    # `shared.slack_post.post_message(...)` directly via the source
    # module attribute (e.g. `import shared.slack_post; shared.slack_post.post_message(...)`).
    monkeypatch.setattr("shared.slack_post.post_message", _noop)
    # Live local re-export bound at import time inside cs_call_summary_post.
    # See the module docstring above for the import-time-binding rationale.
    monkeypatch.setattr("agents.gregory.cs_call_summary_post.post_message", _noop)
    # Live local re-export bound at import time inside the unified
    # escalation-routing fan-out (2026-05-14 ella-escalation-unify spec).
    # Reactive + passive escalation paths both route their DM sends
    # through this module; tests that flow through either path must
    # not hit real Slack DMs.
    monkeypatch.setattr("agents.ella.escalation_routing.post_message", _noop)
    # Live local re-export bound at import time inside the unanswered-
    # message flagger cron (ella-unanswered-message-flagger spec). The
    # cron's test patches this locally too; this is the belt-and-
    # suspenders safety net per the convention above.
    monkeypatch.setattr("api.ella_unanswered_flagger_cron.post_message", _noop)
