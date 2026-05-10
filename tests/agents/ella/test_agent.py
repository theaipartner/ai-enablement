"""Happy-path wiring test for `agents.ella.agent` (post-Batch-1.5).

Verifies that `respond_to_mention` threads through all the right
collaborators: speaker resolution → start_agent_run → channel-client
lookup → retrieval → prompt build → Claude call → escalation
detection → end_agent_run → EllaResponse. Mocks every collaborator
so no DB / no OpenAI / no Claude.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agents.ella import agent
from agents.ella.identity import SpeakerIdentity
from agents.ella.retrieval import ContextBundle


_CLIENT = {
    "id": "c-1",
    "full_name": "Test Client",
    "slack_user_id": "U_CLIENT_1",
    "email": "tc@example.com",
}

_PRIMARY_CSM = {
    "id": "tm-lou",
    "full_name": "Lou Perez",
    "email": "lou@theaipartner.io",
    "slack_user_id": "U09HY5TG3NX",
}

_SPEAKER_CLIENT = SpeakerIdentity(
    slack_user_id="U_CLIENT_1",
    display_name="Test Client",
    role="client",
    client_id="c-1",
)


def _event(text: str = "how do I start with cold calling?", user: str = "U_CLIENT_1") -> dict:
    return {
        "type": "app_mention",
        "user": user,
        "channel": "C09TYEPLGBX",
        "text": f"<@UBOT> {text}",
        "ts": "1745000000.000100",
        "thread_ts": "1745000000.000100",
        "event_ts": "1745000000.000100",
    }


def _patch_common(
    mocker,
    *,
    response_text: str = "here's the answer",
    speaker: SpeakerIdentity = _SPEAKER_CLIENT,
    channel_client: dict | None = None,
):
    """Stub every external collaborator the agent uses."""
    if channel_client is None:
        channel_client = dict(_CLIENT)
    start = mocker.patch(
        "agents.ella.agent.start_agent_run", return_value="run-abc"
    )
    end = mocker.patch("agents.ella.agent.end_agent_run")
    resolve_speaker = mocker.patch(
        "agents.ella.agent.resolve_speaker_identity",
        return_value=speaker,
    )
    resolve_channel = mocker.patch(
        "agents.ella.agent._resolve_channel_client",
        return_value=channel_client,
    )
    retrieve = mocker.patch(
        "agents.ella.agent._retrieve_context",
        return_value=ContextBundle(
            chunks=[], client=dict(_CLIENT), primary_csm=dict(_PRIMARY_CSM)
        ),
    )
    build_prompt = mocker.patch(
        "agents.ella.agent.build_system_prompt",
        return_value="[stub prompt]",
    )
    confidence = 0.0 if agent._is_escalation(response_text) else 1.0
    call_claude = mocker.patch(
        "agents.ella.agent._call_claude",
        return_value=(response_text, confidence),
    )
    escalate = mocker.patch(
        "agents.ella.agent.escalate", return_value="esc-xyz"
    )
    return SimpleNamespace(
        start=start,
        end=end,
        resolve_speaker=resolve_speaker,
        resolve_channel=resolve_channel,
        retrieve=retrieve,
        build_prompt=build_prompt,
        call_claude=call_claude,
        escalate=escalate,
    )


# ---------------------------------------------------------------------------
# Happy path — confident direct answer
# ---------------------------------------------------------------------------


def test_respond_to_mention_direct_answer_returns_text(mocker):
    spies = _patch_common(mocker, response_text="here's the answer")

    result = agent.respond_to_mention(_event())

    assert isinstance(result, agent.EllaResponse)
    assert result.response_text == "here's the answer"
    assert result.confidence == 1.0
    assert result.escalated is False
    assert result.escalation_id is None
    assert result.agent_run_id == "run-abc"

    # start/end agent_run wired around the whole flow
    spies.start.assert_called_once()
    start_kwargs = spies.start.call_args.kwargs
    assert start_kwargs["agent_name"] == "ella"
    assert start_kwargs["trigger_type"] == "slack_mention"
    # Batch 1.5: trigger_metadata now carries the real_author_* fields.
    tm = start_kwargs["trigger_metadata"]
    assert tm["real_author_role"] == "client"
    assert tm["real_author_name"] == "Test Client"
    assert tm["real_author_id"] == "c-1"

    spies.end.assert_called_once()
    end_kwargs = spies.end.call_args.kwargs
    assert end_kwargs["status"] == "success"
    assert end_kwargs["confidence_score"] == 1.0

    # build_system_prompt got the client dict with primary_csm stitched on
    # AND the speaker keyword
    build_args = spies.build_prompt.call_args
    client_arg = build_args.args[0]
    assert client_arg["id"] == "c-1"
    assert client_arg["primary_csm"] == _PRIMARY_CSM
    assert build_args.kwargs["speaker"] is _SPEAKER_CLIENT

    # Retrieval is scoped to the CHANNEL's client id (not the speaker's).
    spies.retrieve.assert_called_once_with("c-1", "<@UBOT> how do I start with cold calling?")
    spies.escalate.assert_not_called()


def test_respond_to_mention_advisor_speaker_real_author_in_metadata(mocker):
    """Advisor speaker: trigger_metadata records real_author_role='advisor'."""
    advisor_speaker = SpeakerIdentity(
        slack_user_id="U_DRAKE",
        display_name="Drake",
        role="advisor",
        team_member_id="tm-drake",
    )
    spies = _patch_common(mocker, speaker=advisor_speaker)

    agent.respond_to_mention(_event(user="U_DRAKE"))

    tm = spies.start.call_args.kwargs["trigger_metadata"]
    assert tm["real_author_role"] == "advisor"
    assert tm["real_author_name"] == "Drake"
    assert tm["real_author_id"] == "tm-drake"
    # Retrieval still uses the CHANNEL's client, not the advisor.
    spies.retrieve.assert_called_once_with("c-1", "<@UBOT> how do I start with cold calling?")


# ---------------------------------------------------------------------------
# Escalation path — Ella's response starts with the [ESCALATE] marker
# ---------------------------------------------------------------------------


def test_respond_to_mention_escalates_when_response_starts_with_marker(mocker):
    ack_body = (
        "Good question — let me get Lou looped in so you can talk this "
        "through with your advisor directly."
    )
    marked_response = f"[ESCALATE]\n{ack_body}"
    spies = _patch_common(mocker, response_text=marked_response)

    result = agent.respond_to_mention(_event(text="should I fire this client?"))

    assert result.escalated is True
    assert result.escalation_reason == "ella_escalated"
    assert result.escalation_id == "esc-xyz"
    assert "[ESCALATE]" not in result.response_text
    assert result.response_text == ack_body
    assert result.confidence == 0.0
    assert result.agent_run_id == "run-abc"

    spies.escalate.assert_called_once()
    esc_kwargs = spies.escalate.call_args.kwargs
    assert esc_kwargs["context"]["ella_response"] == ack_body
    assert "[ESCALATE]" not in esc_kwargs["context"]["ella_response"]
    # Batch 1.5: speaker dict lands on escalations.context for the
    # CSM reviewing the row.
    assert esc_kwargs["context"]["speaker"]["role"] == "client"
    assert esc_kwargs["context"]["speaker"]["display_name"] == "Test Client"
    assert "proposed_action" not in esc_kwargs or esc_kwargs["proposed_action"] is None

    end_kwargs = spies.end.call_args.kwargs
    assert end_kwargs["status"] == "escalated"


# ---------------------------------------------------------------------------
# No channel-client mapped → skip rather than crash
# ---------------------------------------------------------------------------


def test_respond_to_mention_skips_when_channel_has_no_client(mocker):
    """V2 design: gate on channel mapping (was: gate on speaker→client lookup)."""
    mocker.patch("agents.ella.agent.start_agent_run", return_value="run-abc")
    end = mocker.patch("agents.ella.agent.end_agent_run")
    mocker.patch(
        "agents.ella.agent.resolve_speaker_identity", return_value=_SPEAKER_CLIENT
    )
    mocker.patch("agents.ella.agent._resolve_channel_client", return_value=None)
    retrieve = mocker.patch("agents.ella.agent._retrieve_context")
    claude = mocker.patch("agents.ella.agent._call_claude")
    esc = mocker.patch("agents.ella.agent.escalate")

    result = agent.respond_to_mention(_event())

    assert result.response_text == ""
    assert result.escalated is False
    retrieve.assert_not_called()
    claude.assert_not_called()
    esc.assert_not_called()
    end.assert_called_once()
    assert end.call_args.kwargs["status"] == "skipped"


# ---------------------------------------------------------------------------
# Exception path — end_agent_run with status='error', re-raise
# ---------------------------------------------------------------------------


def test_respond_to_mention_raises_and_closes_run_on_exception(mocker):
    mocker.patch("agents.ella.agent.start_agent_run", return_value="run-abc")
    end = mocker.patch("agents.ella.agent.end_agent_run")
    mocker.patch(
        "agents.ella.agent.resolve_speaker_identity", return_value=_SPEAKER_CLIENT
    )
    mocker.patch(
        "agents.ella.agent._resolve_channel_client",
        side_effect=RuntimeError("boom"),
    )

    with pytest.raises(RuntimeError, match="boom"):
        agent.respond_to_mention(_event())

    end.assert_called_once()
    assert end.call_args.kwargs["status"] == "error"
    assert "boom" in end.call_args.kwargs["error_message"]


# ---------------------------------------------------------------------------
# Escalation marker detection — direct unit coverage
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "text",
    [
        # Canonical shape: marker on its own line, ack below.
        "[ESCALATE]\nAbel, let me loop in your advisor on this one.",
        # Inline separator (space) instead of newline — still a valid prefix.
        "[ESCALATE] Short ack.",
        # Leading whitespace / newlines that Claude sometimes emits.
        "\n[ESCALATE]\nAbel, let me loop in your advisor.",
        "   [ESCALATE] short ack.",
    ],
)
def test_is_escalation_matches_marker_prefix(text):
    assert agent._is_escalation(text) is True


@pytest.mark.parametrize(
    "text",
    [
        # Escalation-style prose without the marker.
        "Let me loop in your advisor on this one.",
        "Let me get Lou looped in so you can talk this through.",
        # Non-escalation answer.
        "Your advisor is Lou — they cover that on the next call.",
        # Marker appears mid-string, not a handoff signal under the
        # start-only detector (Task 4 will loosen this — see test_agent_task4.py).
        "Here's my answer. If this doesn't resolve it, we can [ESCALATE] later.",
        # Case-sensitive: lowercase doesn't count.
        "[escalate]\nAbel, let me loop in your advisor.",
        "",
    ],
)
def test_is_escalation_misses_non_marked_text(text):
    assert agent._is_escalation(text) is False


# ---------------------------------------------------------------------------
# Marker stripping — direct unit coverage
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,expected",
    [
        (
            "[ESCALATE]\nAbel, let me loop in your advisor.",
            "Abel, let me loop in your advisor.",
        ),
        (
            "[ESCALATE] short ack.",
            "short ack.",
        ),
        (
            "[ESCALATE]\n\n\nSpacing varies.",
            "Spacing varies.",
        ),
        (
            "   [ESCALATE]\nLeading whitespace is tolerated.",
            "Leading whitespace is tolerated.",
        ),
        # Idempotent on unmarked text.
        (
            "No marker here — just an answer.",
            "No marker here — just an answer.",
        ),
        ("", ""),
    ],
)
def test_strip_escalation_marker(raw, expected):
    assert agent._strip_escalation_marker(raw) == expected
