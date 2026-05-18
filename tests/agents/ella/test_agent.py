"""Wiring tests for `agents.ella.agent` (unified-decision rewrite).

`respond_to_mention` now threads the @-mention through the same
decision Haiku as the passive path, then routes per decision. Sonnet
no longer self-escalates ([ESCALATE] detection is gone). Reactive
`digest_only` is the only real-time CSM-DM path. Every collaborator
is mocked — no DB / no OpenAI / no Claude / no Slack.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from agents.ella import agent
from agents.ella.identity import SpeakerIdentity
from agents.ella.passive_monitor import PassiveDecision
from agents.ella.retrieval import ContextBundle


_CLIENT = {
    "id": "c-1",
    "full_name": "Test Client",
    "slack_user_id": "U_CLIENT_1",
    "slack_channel_id": "C09TYEPLGBX",
}
_PRIMARY_CSM = {
    "id": "tm-lou",
    "full_name": "Lou Perez",
    "slack_user_id": "U09HY5TG3NX",
}
_SPEAKER_CLIENT = SpeakerIdentity(
    slack_user_id="U_CLIENT_1",
    display_name="Test Client",
    role="client",
    client_id="c-1",
)


def _event(text="how do I start with cold calling?", user="U_CLIENT_1"):
    return {
        "type": "app_mention",
        "user": user,
        "channel": "C09TYEPLGBX",
        "text": f"<@UBOT> {text}",
        "ts": "1745000000.000100",
        "event_ts": "1745000000.000100",
    }


def _decision(decision, digest_flag=False, digest_category=None):
    return PassiveDecision(
        decision=decision,
        digest_flag=digest_flag,
        digest_category=digest_category,
        reasoning=f"{decision} reasoning",
    )


def _patch_common(mocker, *, decision, sonnet_text="sonnet answer"):
    start = mocker.patch("agents.ella.agent.start_agent_run", return_value="run-abc")
    end = mocker.patch("agents.ella.agent.end_agent_run")
    mocker.patch(
        "agents.ella.agent.resolve_speaker_identity", return_value=_SPEAKER_CLIENT
    )
    mocker.patch(
        "agents.ella.agent._resolve_channel_client", return_value=dict(_CLIENT)
    )
    mocker.patch(
        "agents.ella.agent._retrieve_context",
        return_value=ContextBundle(
            chunks=[], client=dict(_CLIENT), primary_csm=dict(_PRIMARY_CSM)
        ),
    )
    mocker.patch("agents.ella.agent._fetch_recent_context_for_event", return_value="")
    mocker.patch("agents.ella.agent.build_system_prompt", return_value="[stub]")
    decide = mocker.patch(
        "agents.ella.agent.decide_passive_response", return_value=decision
    )
    call_claude = mocker.patch(
        "agents.ella.agent._call_claude", return_value=(sonnet_text, 1.0)
    )
    post = mocker.patch("agents.ella.agent._post", return_value={"ok": True})
    insert_digest = mocker.patch("agents.ella.agent.insert_digest_item")
    escalate = mocker.patch("agents.ella.agent.escalate", return_value="esc-1")
    mocker.patch(
        "agents.ella.agent.resolve_escalation_recipients",
        return_value=[{"slack_user_id": "U_S", "label": "Scott", "source": "scott"}],
    )
    fire = mocker.patch(
        "agents.ella.agent.fire_escalation_dms",
        return_value=[
            {
                "label": "Scott",
                "dm_ok": True,
                "source": "scott",
                "slack_user_id": "U_S",
                "slack_error": None,
                "delivery_id": "wd-1",
            }
        ],
    )
    return SimpleNamespace(
        start=start,
        end=end,
        decide=decide,
        call_claude=call_claude,
        post=post,
        insert_digest=insert_digest,
        escalate=escalate,
        fire=fire,
    )


# ---------------------------------------------------------------------------
# decision: skip
# ---------------------------------------------------------------------------


def test_mention_skip_posts_generic_ack_no_escalation(mocker):
    spies = _patch_common(mocker, decision=_decision("skip"))
    result = agent.respond_to_mention(_event())
    assert result.escalated is False
    spies.post.assert_called_once()
    posted_text = spies.post.call_args.args[2]
    assert "Lou" in posted_text  # advisor first name in the ack
    spies.escalate.assert_not_called()
    spies.fire.assert_not_called()
    assert spies.end.call_args.kwargs["status"] == "success"


def test_mention_skip_with_digest_flag_inserts_digest_item(mocker):
    spies = _patch_common(
        mocker, decision=_decision("skip", digest_flag=True, digest_category="other")
    )
    agent.respond_to_mention(_event())
    spies.insert_digest.assert_called_once()
    assert spies.insert_digest.call_args.kwargs["ella_responded"] is False


# ---------------------------------------------------------------------------
# decision: respond_haiku_self
# ---------------------------------------------------------------------------


def test_mention_respond_haiku_self_posts_haiku_response(mocker):
    spies = _patch_common(mocker, decision=_decision("respond_haiku_self"))
    mocker.patch(
        "agents.ella.digest_response.generate_response",
        return_value=SimpleNamespace(
            response_text="Haiku says hi",
            fallback_to_sonnet=False,
            cost_usd=0,
            input_tokens=1,
            output_tokens=1,
        ),
    )
    result = agent.respond_to_mention(_event())
    assert result.response_text == "Haiku says hi"
    assert result.escalated is False
    spies.call_claude.assert_not_called()


def test_mention_respond_haiku_self_fallback_uses_sonnet(mocker):
    spies = _patch_common(
        mocker, decision=_decision("respond_haiku_self"), sonnet_text="sonnet fallback"
    )
    mocker.patch(
        "agents.ella.digest_response.generate_response",
        return_value=SimpleNamespace(
            response_text="",
            fallback_to_sonnet=True,
            cost_usd=0,
            input_tokens=1,
            output_tokens=1,
        ),
    )
    result = agent.respond_to_mention(_event())
    assert result.response_text == "sonnet fallback"
    spies.call_claude.assert_called_once()


# ---------------------------------------------------------------------------
# decision: respond_via_sonnet
# ---------------------------------------------------------------------------


def test_mention_respond_via_sonnet_posts_sonnet(mocker):
    spies = _patch_common(
        mocker, decision=_decision("respond_via_sonnet"), sonnet_text="careful answer"
    )
    result = agent.respond_to_mention(_event())
    assert result.response_text == "careful answer"
    assert result.escalated is False
    spies.call_claude.assert_called_once()


def test_mention_respond_via_sonnet_digest_flag_responded_true(mocker):
    spies = _patch_common(
        mocker,
        decision=_decision("respond_via_sonnet", digest_flag=True),
    )
    agent.respond_to_mention(_event())
    spies.insert_digest.assert_called_once()
    assert spies.insert_digest.call_args.kwargs["ella_responded"] is True


# ---------------------------------------------------------------------------
# decision: digest_only  (the only reactive real-time CSM-DM path)
# ---------------------------------------------------------------------------


def test_mention_digest_only_acks_escalates_and_dms(mocker):
    spies = _patch_common(
        mocker,
        decision=_decision(
            "digest_only", digest_flag=True, digest_category="complaint"
        ),
    )
    result = agent.respond_to_mention(_event())
    assert result.escalated is True
    assert result.escalation_id == "esc-1"
    spies.escalate.assert_called_once()
    spies.fire.assert_called_once()
    # digest item always written for reactive digest_only
    spies.insert_digest.assert_called_once()
    assert spies.end.call_args.kwargs["status"] == "escalated"
    ack = spies.post.call_args.args[2]
    assert "advisor" in ack.lower()


# ---------------------------------------------------------------------------
# Sonnet no longer self-escalates
# ---------------------------------------------------------------------------


def test_escalate_detection_helpers_removed():
    assert not hasattr(agent, "_detect_and_strip_escalation")
    assert not hasattr(agent, "_ESCALATION_MARKER")


def test_call_claude_returns_text_without_escalate_processing(mocker):
    """_call_claude is pure generation now — no [ESCALATE] split."""
    mocker.patch(
        "agents.ella.agent.complete",
        return_value=SimpleNamespace(text="answer [ESCALATE] leftover"),
    )
    text, conf = agent._call_claude("sys", "q", SimpleNamespace(chunks=[]))
    assert text == "answer [ESCALATE] leftover"
    assert conf == 1.0


# ---------------------------------------------------------------------------
# real_author_* metadata still recorded
# ---------------------------------------------------------------------------


def test_trigger_metadata_records_real_author(mocker):
    spies = _patch_common(mocker, decision=_decision("skip"))
    agent.respond_to_mention(_event())
    tm = spies.start.call_args.kwargs["trigger_metadata"]
    assert tm["real_author_role"] == "client"
    assert tm["real_author_name"] == "Test Client"
    assert tm["real_author_id"] == "c-1"


# ---------------------------------------------------------------------------
# Bare-mention short-circuit (unchanged — before the decision Haiku)
# ---------------------------------------------------------------------------


def test_bare_mention_skips_llm(mocker):
    mocker.patch("agents.ella.agent.start_agent_run", return_value="run-bare")
    end = mocker.patch("agents.ella.agent.end_agent_run")
    mocker.patch(
        "agents.ella.agent.resolve_speaker_identity",
        return_value=SpeakerIdentity(
            slack_user_id="U_DRAKE", display_name="Drake", role="advisor"
        ),
    )
    decide = mocker.patch("agents.ella.agent.decide_passive_response")
    retrieve = mocker.patch("agents.ella.agent._retrieve_context")

    event = _event(text="hi")
    event["text"] = "hi"
    result = agent.respond_to_mention(event)

    assert result.escalated is False
    decide.assert_not_called()
    retrieve.assert_not_called()
    assert end.call_args.kwargs["status"] == "success"


def test_bare_mention_records_trigger_type(mocker):
    start = mocker.patch("agents.ella.agent.start_agent_run", return_value="run-bare")
    mocker.patch("agents.ella.agent.end_agent_run")
    mocker.patch(
        "agents.ella.agent.resolve_speaker_identity",
        return_value=SpeakerIdentity(
            slack_user_id="U_DRAKE", display_name="Drake", role="advisor"
        ),
    )
    event = _event(text="hi")
    event["text"] = "hi"
    agent.respond_to_mention(event)
    assert start.call_args.kwargs["trigger_type"] == "bare_mention"


# ---------------------------------------------------------------------------
# No channel client / exception paths (unchanged)
# ---------------------------------------------------------------------------


def test_mention_skips_when_channel_has_no_client(mocker):
    mocker.patch("agents.ella.agent.start_agent_run", return_value="run-abc")
    end = mocker.patch("agents.ella.agent.end_agent_run")
    mocker.patch(
        "agents.ella.agent.resolve_speaker_identity", return_value=_SPEAKER_CLIENT
    )
    mocker.patch("agents.ella.agent._resolve_channel_client", return_value=None)
    decide = mocker.patch("agents.ella.agent.decide_passive_response")

    result = agent.respond_to_mention(_event())

    assert result.response_text == ""
    assert result.escalated is False
    decide.assert_not_called()
    assert end.call_args.kwargs["status"] == "skipped"


def test_mention_raises_and_closes_run_on_exception(mocker):
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
    assert end.call_args.kwargs["status"] == "error"
