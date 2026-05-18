"""Wiring tests for `agents.ella.agent` (unified-path rewrite).

`respond_to_mention` is now a thin adapter over the ONE pipeline
(evaluate_passive_trigger + persist_passive_evaluation). The bare-
mention short-circuit and general-inquiry helpers are gone.
`respond_to_passive_trigger` is still the Sonnet drain for the cron.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agents.ella import agent
from agents.ella.identity import SpeakerIdentity
from agents.ella.passive_monitor import PassiveDecision, PassiveEvaluation
from agents.ella.retrieval import ContextBundle


_CLIENT = {"id": "c-1", "full_name": "Test Client", "slack_channel_id": "C09"}
_SPEAKER = SpeakerIdentity(
    slack_user_id="U1", display_name="Test Client", role="client", client_id="c-1"
)


def _event(text="@Ella how does the offer framework work?"):
    return {
        "type": "app_mention",
        "user": "U1",
        "channel": "C09",
        "text": text,
        "ts": "1745000000.000100",
        "event_ts": "1745000000.000100",
    }


# --- respond_to_mention adapter -----------------------------------------


def test_removed_helpers_gone():
    assert not hasattr(agent, "_handle_bare_mention")
    assert not hasattr(agent, "_pick_bare_response")
    assert not hasattr(agent, "handle_passive_general_inquiry")
    assert not hasattr(agent, "_run")


def test_respond_to_mention_routes_through_one_path(mocker):
    mocker.patch("agents.ella.agent.resolve_speaker_identity", return_value=_SPEAKER)
    mocker.patch(
        "agents.ella.agent._resolve_channel_client", return_value=dict(_CLIENT)
    )
    decision = PassiveDecision(decision="respond", response_model="haiku")
    ev = PassiveEvaluation(payload=SimpleNamespace(), decision=decision)
    evaluate = mocker.patch(
        "agents.ella.agent.evaluate_passive_trigger", return_value=ev
    )
    persist = mocker.patch(
        "agents.ella.agent.persist_passive_evaluation",
        return_value={"agent_run_id": "run-1", "decision": "respond"},
    )

    result = agent.respond_to_mention(_event())

    evaluate.assert_called_once()
    # is_ella_mentioned is forced True for this legacy entry point
    payload = evaluate.call_args.args[0]
    assert payload.is_ella_mentioned is True
    persist.assert_called_once()
    assert result.escalated is False
    assert result.agent_run_id == "run-1"


def test_respond_to_mention_escalation_surfaces_ack(mocker):
    mocker.patch("agents.ella.agent.resolve_speaker_identity", return_value=_SPEAKER)
    mocker.patch(
        "agents.ella.agent._resolve_channel_client", return_value=dict(_CLIENT)
    )
    decision = PassiveDecision(
        decision="acknowledge_and_escalate",
        ack_text="Hey — I'll get Scott on this.",
        digest_flag=True,
        digest_category="emotional_human_needed",
    )
    ev = PassiveEvaluation(payload=SimpleNamespace(), decision=decision)
    mocker.patch("agents.ella.agent.evaluate_passive_trigger", return_value=ev)
    mocker.patch(
        "agents.ella.agent.persist_passive_evaluation",
        return_value={"agent_run_id": "r", "escalation_id": "esc-9"},
    )

    result = agent.respond_to_mention(_event("@Ella I'm so frustrated"))

    assert result.escalated is True
    assert result.response_text == "Hey — I'll get Scott on this."
    assert result.escalation_id == "esc-9"


def test_respond_to_mention_no_channel_client(mocker):
    mocker.patch("agents.ella.agent.resolve_speaker_identity", return_value=_SPEAKER)
    mocker.patch("agents.ella.agent._resolve_channel_client", return_value=None)
    evaluate = mocker.patch("agents.ella.agent.evaluate_passive_trigger")
    result = agent.respond_to_mention(_event())
    assert result.response_text == ""
    assert result.escalated is False
    evaluate.assert_not_called()


def test_advisor_speaker_maps_to_team_member(mocker):
    advisor = SpeakerIdentity(
        slack_user_id="U_D",
        display_name="Drake",
        role="advisor",
        team_member_id="tm-d",
    )
    mocker.patch("agents.ella.agent.resolve_speaker_identity", return_value=advisor)
    mocker.patch(
        "agents.ella.agent._resolve_channel_client", return_value=dict(_CLIENT)
    )
    ev = PassiveEvaluation(
        payload=SimpleNamespace(),
        decision=PassiveDecision(decision="skip"),
    )
    evaluate = mocker.patch(
        "agents.ella.agent.evaluate_passive_trigger", return_value=ev
    )
    mocker.patch(
        "agents.ella.agent.persist_passive_evaluation",
        return_value={"agent_run_id": "r"},
    )
    agent.respond_to_mention(_event())
    assert evaluate.call_args.args[0].author_type == "team_member"


# --- respond_to_passive_trigger (cron Sonnet drain) ---------------------


def _pending():
    return {
        "id": "pend-1",
        "slack_channel_id": "C09",
        "triggering_message_ts": "1745000000.000100",
        "triggering_message_slack_user_id": "U1",
    }


def test_passive_trigger_generates_and_posts(mocker):
    mocker.patch("agents.ella.agent.resolve_speaker_identity", return_value=_SPEAKER)
    mocker.patch(
        "agents.ella.agent._resolve_channel_client", return_value=dict(_CLIENT)
    )
    mocker.patch(
        "agents.ella.agent._fetch_message_text", return_value="what's module 3"
    )
    mocker.patch("agents.ella.agent.start_agent_run", return_value="run-7")
    mocker.patch("agents.ella.agent.end_agent_run")
    mocker.patch(
        "agents.ella.agent._retrieve_context",
        return_value=ContextBundle(chunks=[], client=dict(_CLIENT), primary_csm=None),
    )
    mocker.patch("agents.ella.agent.build_system_prompt", return_value="[sys]")
    mocker.patch("agents.ella.agent.fetch_recent_channel_context", return_value="")
    mocker.patch(
        "agents.ella.agent._call_claude", return_value=("Module 3 covers X.", 1.0)
    )
    posted = mocker.patch(
        "shared.slack_post.post_message",
        return_value={"ok": True, "slack_error": None},
    )
    result = agent.respond_to_passive_trigger(_pending())
    assert result.posted is True
    assert result.response_text == "Module 3 covers X."
    posted.assert_called_once()


def test_passive_trigger_no_client_skips(mocker):
    mocker.patch("agents.ella.agent.resolve_speaker_identity", return_value=_SPEAKER)
    mocker.patch("agents.ella.agent._resolve_channel_client", return_value=None)
    mocker.patch("agents.ella.agent.start_agent_run", return_value="run-x")
    end = mocker.patch("agents.ella.agent.end_agent_run")
    result = agent.respond_to_passive_trigger(_pending())
    assert result.posted is False
    assert result.slack_error == "no_client_for_channel"
    assert end.call_args.kwargs["status"] == "skipped"


def test_call_claude_pure_generation(mocker):
    mocker.patch(
        "agents.ella.agent.complete",
        return_value=SimpleNamespace(text="answer [ESCALATE] leftover"),
    )
    text, conf = agent._call_claude("s", "q", SimpleNamespace(chunks=[]))
    # No token processing — text passes through verbatim.
    assert text == "answer [ESCALATE] leftover"
    assert conf == 1.0


def test_passive_trigger_raises_propagate_after_run_closed(mocker):
    mocker.patch("agents.ella.agent.resolve_speaker_identity", return_value=_SPEAKER)
    mocker.patch(
        "agents.ella.agent._resolve_channel_client", return_value=dict(_CLIENT)
    )
    mocker.patch("agents.ella.agent._fetch_message_text", return_value="q")
    mocker.patch("agents.ella.agent.start_agent_run", return_value="run-9")
    end = mocker.patch("agents.ella.agent.end_agent_run")
    mocker.patch(
        "agents.ella.agent._retrieve_context",
        side_effect=RuntimeError("kb boom"),
    )
    with pytest.raises(RuntimeError, match="kb boom"):
        agent.respond_to_passive_trigger(_pending())
    assert end.call_args.kwargs["status"] == "error"


def test_respond_to_mention_skip_decision_returns_unescalated(mocker):
    mocker.patch("agents.ella.agent.resolve_speaker_identity", return_value=_SPEAKER)
    mocker.patch(
        "agents.ella.agent._resolve_channel_client", return_value=dict(_CLIENT)
    )
    ev = PassiveEvaluation(
        payload=SimpleNamespace(),
        decision=PassiveDecision(decision="skip"),
    )
    mocker.patch("agents.ella.agent.evaluate_passive_trigger", return_value=ev)
    mocker.patch(
        "agents.ella.agent.persist_passive_evaluation",
        return_value={"agent_run_id": "r2"},
    )
    result = agent.respond_to_mention(_event())
    assert result.escalated is False
    assert result.response_text == ""
    assert result.agent_run_id == "r2"
