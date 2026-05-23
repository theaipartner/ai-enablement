"""Unit tests for `agents.ella.agent` after the 2026-05-23 path split.

Covers:
- `handle_at_mention` — the restored synchronous @-mention handler.
- `respond_to_mention` — legacy adapter (now routes through
  handle_at_mention).
- `respond_to_passive_trigger` — post-split no-op for the Sonnet cron.

The realtime-ingest fork (which decides BOT-vs-HUMAN @-mention routing
based on `is_ella_mentioned`) is covered in test_realtime_ingest_at_mention.
"""

from __future__ import annotations

import json
from decimal import Decimal
from types import SimpleNamespace

import pytest

from agents.ella import agent
from agents.ella.identity import SpeakerIdentity
from agents.ella.passive_monitor import PassiveTriggerPayload
from agents.ella.retrieval import ContextBundle


_CLIENT = {
    "id": "c-1",
    "full_name": "Test Client",
    "slack_channel_id": "C09",
}

_CLIENT_SPEAKER = SpeakerIdentity(
    slack_user_id="U1",
    display_name="Test Client",
    role="client",
    client_id="c-1",
)

_ADVISOR_SPEAKER = SpeakerIdentity(
    slack_user_id="U_AD",
    display_name="Lou Perez",
    role="advisor",
    team_member_id="tm-lou",
)


def _payload(text="<@UBOT0001> what's covered in module 3?", **overrides):
    base = dict(
        slack_channel_id="C09",
        triggering_message_ts="1745500100.000100",
        triggering_message_slack_user_id="U1",
        triggering_message_text=text,
        author_type="client",
        channel_client_id="c-1",
        is_ella_mentioned=True,
    )
    base.update(overrides)
    return PassiveTriggerPayload(**base)


def _patch_common(mocker, *, speaker=_CLIENT_SPEAKER, channel_client=None):
    """Stub the side-effecting seams used by handle_at_mention.

    Returns a dict of useful captures: `posted` (list of (channel, text)
    tuples), `runs` (list of (status, kwargs) for end_agent_run).
    """
    if channel_client is None:
        channel_client = dict(_CLIENT)
    posted: list[tuple[str, str]] = []
    runs: list[tuple[str, dict]] = []
    started: list[dict] = []

    mocker.patch("agents.ella.agent.resolve_speaker_identity", return_value=speaker)
    mocker.patch(
        "agents.ella.agent._resolve_channel_client", return_value=channel_client
    )
    mocker.patch(
        "agents.ella.agent._retrieve_context",
        return_value=ContextBundle(
            chunks=[], client=channel_client or {}, primary_csm=None
        ),
    )
    mocker.patch(
        "agents.ella.agent.fetch_recent_channel_context", return_value=""
    )
    mocker.patch(
        "agents.ella.agent.build_system_prompt", return_value="[base_prompt]"
    )

    def _fake_start(**kwargs):
        started.append(kwargs)
        return f"run-{len(started)}"

    def _fake_end(run_id, **kwargs):
        runs.append((kwargs.get("status"), kwargs))

    mocker.patch("agents.ella.agent.start_agent_run", side_effect=_fake_start)
    mocker.patch("agents.ella.agent.end_agent_run", side_effect=_fake_end)
    mocker.patch(
        "agents.ella.agent.post_message",
        side_effect=lambda ch, txt, **kw: (
            posted.append((ch, txt))
            or {"ok": True, "slack_error": None, "ts": "1.0"}
        ),
    )
    mocker.patch("agents.ella.agent.insert_digest_item", return_value="dg-1")
    return {"posted": posted, "runs": runs, "started": started}


def _stub_sonnet(mocker, payload):
    """Make `complete` return text encoding the structured JSON the @
    handler expects."""
    mocker.patch(
        "agents.ella.agent.complete",
        return_value=SimpleNamespace(
            text=json.dumps(payload),
            input_tokens=50,
            output_tokens=20,
            cost_usd=Decimal("0.0001"),
            model="claude-sonnet-4-6",
            raw=None,
        ),
    )


# ---------------------------------------------------------------------------
# handle_at_mention — substantive response (curriculum content)
# ---------------------------------------------------------------------------


def test_curriculum_content_question_responds_not_escalates(mocker):
    """Spec acceptance case (c): "what's covered in module 3" — the
    classifier used to escalate this as a navigation question. The
    restored @ handler must respond, not escalate."""
    capture = _patch_common(mocker)
    _stub_sonnet(
        mocker,
        {
            "response_text": "Module 3 covers the sales fundamentals — discovery, qualification, and the close.",
            "escalate": False,
            "handoff_reasoning": None,
        },
    )

    result = agent.handle_at_mention(_payload())

    assert result.status == "success"
    assert result.escalated is False
    assert "Module 3 covers" in result.response_text
    assert result.posted is True
    # Posted once, to the channel
    assert len(capture["posted"]) == 1
    assert capture["posted"][0][0] == "C09"
    # agent_run ended success
    end_status = [r[0] for r in capture["runs"]]
    assert end_status == ["success"]


def test_substantive_with_advisor_speaker_still_responds(mocker):
    """Acceptance: an advisor @-mentions Ella (team_member author_type)
    — still routes through the @ handler and gets a real answer."""
    capture = _patch_common(mocker, speaker=_ADVISOR_SPEAKER)
    _stub_sonnet(
        mocker,
        {
            "response_text": "The 4-Layer Framework lives in Section 3.",
            "escalate": False,
            "handoff_reasoning": None,
        },
    )
    payload = _payload(text="<@UBOT0001> what's the 4-layer framework", author_type="team_member")
    result = agent.handle_at_mention(payload)
    assert result.status == "success"
    assert result.escalated is False
    assert capture["posted"][0][1] == "The 4-Layer Framework lives in Section 3."


# ---------------------------------------------------------------------------
# handle_at_mention — escalate-worthy
# ---------------------------------------------------------------------------


def test_escalate_worthy_message_acks_and_escalates(mocker):
    """Spec acceptance case (d): an escalate-worthy question (money /
    emotional) — Sonnet returns escalate=true, handler posts the ack,
    writes escalations row, fires DMs."""
    capture = _patch_common(mocker)
    _stub_sonnet(
        mocker,
        {
            "response_text": "Hey — let me get your advisor on this one. They'll follow up directly.",
            "escalate": True,
            "handoff_reasoning": "Client asking about a refund.",
        },
    )

    escalate_mock = mocker.patch(
        "agents.ella.agent.ella_escalate", return_value="esc-42"
    )
    dms_mock = mocker.patch(
        "agents.ella.agent.fire_escalation_dms",
        return_value=[{"label": "Scott Wilson", "dm_ok": True}],
    )
    mocker.patch(
        "agents.ella.agent.resolve_escalation_recipients",
        return_value=[{"label": "Scott Wilson"}],
    )

    result = agent.handle_at_mention(
        _payload(text="<@UBOT0001> I want a refund")
    )

    assert result.status == "escalated"
    assert result.escalated is True
    assert result.escalation_id == "esc-42"
    # Ack posted in-channel
    assert len(capture["posted"]) == 1
    assert "advisor" in capture["posted"][0][1].lower()
    # escalate() called with handoff_reasoning
    assert escalate_mock.called
    ctx = escalate_mock.call_args.kwargs["context"]
    assert ctx["handoff_reasoning"] == "Client asking about a refund."
    # DMs fired with path='reactive'
    assert dms_mock.called
    assert dms_mock.call_args.kwargs["path"] == "reactive"
    # agent_run ended 'escalated'
    end_status = [r[0] for r in capture["runs"]]
    assert end_status == ["escalated"]


# ---------------------------------------------------------------------------
# handle_at_mention — bare mention short-circuit
# ---------------------------------------------------------------------------


def test_bare_mention_short_circuits_no_llm(mocker):
    """Bare @-mention (text reduces to nothing after stripping mention
    syntax) → canned warm opener, no LLM call, trigger_type='bare_mention'."""
    capture = _patch_common(mocker)
    sonnet = mocker.patch("agents.ella.agent.complete")
    payload = _payload(text="<@UBOT0001>")
    result = agent.handle_at_mention(payload)
    assert result.status == "success"
    assert result.trigger_type == "bare_mention"
    sonnet.assert_not_called()
    # Did post the canned opener
    assert len(capture["posted"]) == 1
    # trigger_type captured on start_agent_run
    assert capture["started"][0]["trigger_type"] == "bare_mention"


# ---------------------------------------------------------------------------
# handle_at_mention — status honesty on failed Sonnet call
# ---------------------------------------------------------------------------


def test_sonnet_failure_lands_as_status_error(mocker):
    """Spec acceptance case (f): when the Sonnet call raises, the
    agent_runs row must end as status='error' (not silent success),
    with the error captured in error_message. User-facing fallback
    posts a graceful canned line."""
    capture = _patch_common(mocker)
    mocker.patch(
        "agents.ella.agent.complete",
        side_effect=RuntimeError("anthropic transient"),
    )

    result = agent.handle_at_mention(_payload())

    assert result.status == "error"
    assert result.posted is True
    # Fallback canned line went to channel
    assert "hiccup" in capture["posted"][0][1].lower()
    # end_agent_run called with status='error' + error_message captured
    end_status = [r[0] for r in capture["runs"]]
    assert end_status == ["error"]
    end_kwargs = capture["runs"][0][1]
    assert "anthropic transient" in end_kwargs["error_message"]


def test_malformed_json_falls_through_to_safe_response(mocker):
    """The structured-JSON parser's safe fallback: malformed JSON →
    use the raw text as response_text, do NOT escalate. Matches the
    pre-2026-05-18 no-token behavior."""
    capture = _patch_common(mocker)
    mocker.patch(
        "agents.ella.agent.complete",
        return_value=SimpleNamespace(
            text="just some prose, not JSON at all",
            input_tokens=10,
            output_tokens=5,
            cost_usd=Decimal("0"),
            model="claude-sonnet-4-6",
            raw=None,
        ),
    )
    result = agent.handle_at_mention(_payload())
    assert result.status == "success"
    assert result.escalated is False
    assert capture["posted"][0][1] == "just some prose, not JSON at all"


# ---------------------------------------------------------------------------
# handle_at_mention — no channel client
# ---------------------------------------------------------------------------


def test_no_channel_client_skips(mocker):
    capture = _patch_common(mocker, channel_client=None)
    # Override the channel_client mock back to None
    mocker.patch("agents.ella.agent._resolve_channel_client", return_value=None)
    result = agent.handle_at_mention(_payload())
    assert result.status == "skipped"
    assert result.posted is False
    assert capture["posted"] == []


# ---------------------------------------------------------------------------
# Legacy respond_to_mention adapter — routes through handle_at_mention
# ---------------------------------------------------------------------------


def test_respond_to_mention_legacy_adapter_routes_through_at_handler(mocker):
    handle = mocker.patch(
        "agents.ella.agent.handle_at_mention",
        return_value=agent.AtMentionResult(
            agent_run_id="run-z",
            trigger_type="slack_mention",
            response_text="ok",
            escalated=False,
            escalation_id=None,
            posted=True,
            status="success",
        ),
    )
    mocker.patch(
        "agents.ella.agent.resolve_speaker_identity", return_value=_CLIENT_SPEAKER
    )
    mocker.patch(
        "agents.ella.agent._resolve_channel_client", return_value=dict(_CLIENT)
    )
    event = {
        "type": "app_mention",
        "user": "U1",
        "channel": "C09",
        "text": "<@UBOT0001> hi",
        "ts": "1.0",
    }
    resp = agent.respond_to_mention(event)
    assert resp.agent_run_id == "run-z"
    assert resp.escalated is False
    handle.assert_called_once()
    # is_ella_mentioned forced True by the legacy entry
    payload = handle.call_args.args[0]
    assert payload.is_ella_mentioned is True


# ---------------------------------------------------------------------------
# respond_to_passive_trigger — post-split no-op
# ---------------------------------------------------------------------------


def test_passive_trigger_is_a_skip_no_post(mocker):
    """After the split, passive monitoring does not respond in client
    channels. Any stale rows in pending_ella_responses drain via this
    function which is now a recorded no-op."""
    started = []
    runs = []

    def _fake_start(**kwargs):
        started.append(kwargs)
        return "run-stale"

    def _fake_end(run_id, **kwargs):
        runs.append(kwargs)

    mocker.patch("agents.ella.agent.start_agent_run", side_effect=_fake_start)
    mocker.patch("agents.ella.agent.end_agent_run", side_effect=_fake_end)
    posted = mocker.patch("agents.ella.agent.post_message")
    sonnet = mocker.patch("agents.ella.agent.complete")

    result = agent.respond_to_passive_trigger(
        {
            "id": "pend-7",
            "slack_channel_id": "C09",
            "triggering_message_ts": "1.0",
            "triggering_message_slack_user_id": "U1",
        }
    )

    assert result.posted is False
    assert result.slack_error == "passive_voice_removed"
    # No LLM call, no Slack post
    sonnet.assert_not_called()
    posted.assert_not_called()
    # agent_run recorded as skipped (status honesty)
    assert runs[0]["status"] == "skipped"
    assert "passive_voice_removed" in runs[0]["output_summary"]


# ---------------------------------------------------------------------------
# Mention-syntax stripper
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        ("<@UBOT0001>", ""),
        ("<@UBOT0001> ", ""),
        ("<@UBOT0001> how does this work", "how does this work"),
        ("<@UBOT0001> <@UHUMAN001> chained", "chained"),
        ("plain text no mention", "plain text no mention"),
    ],
)
def test_mention_syntax_stripper(raw, expected):
    assert agent._strip_mention_syntax(raw) == expected
