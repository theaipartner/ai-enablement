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
    mocker.patch(
        "agents.ella.agent._fetch_recent_context_for_event",
        return_value="",
    )
    build_prompt = mocker.patch(
        "agents.ella.agent.build_system_prompt",
        return_value="[stub prompt]",
    )
    confidence = 0.0 if "[ESCALATE]" in response_text else 1.0
    call_claude = mocker.patch(
        "agents.ella.agent._call_claude",
        return_value=(response_text, confidence),
    )
    escalate = mocker.patch(
        "agents.ella.agent.escalate", return_value="esc-xyz"
    )
    # Reactive escalations now fan DMs to Scott + primary CSM through
    # the shared helper. Mock it so tests don't need to mock the
    # transport layer underneath.
    resolve_recipients = mocker.patch(
        "agents.ella.agent.resolve_escalation_recipients",
        return_value=[
            {
                "slack_user_id": "U_SCOTT",
                "label": "Scott",
                "source": "scott",
            },
            {
                "slack_user_id": "U09HY5TG3NX",
                "label": "Lou Perez",
                "source": "primary_csm",
            },
        ],
    )
    fire_dms = mocker.patch(
        "agents.ella.agent.fire_escalation_dms",
        return_value=[
            {
                "slack_user_id": "U_SCOTT",
                "label": "Scott",
                "source": "scott",
                "dm_ok": True,
                "slack_error": None,
                "delivery_id": "wd-1",
            },
            {
                "slack_user_id": "U09HY5TG3NX",
                "label": "Lou Perez",
                "source": "primary_csm",
                "dm_ok": True,
                "slack_error": None,
                "delivery_id": "wd-2",
            },
        ],
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
        resolve_recipients=resolve_recipients,
        fire_dms=fire_dms,
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


def test_respond_to_mention_preserves_mentions_in_non_escalation_response(mocker):
    """The 2026-05-14 prompt edit removed `<@...>` from escalation acks,
    but Ella may still legitimately mention the advisor by name in
    non-escalation conversational replies. Verify no postprocessor
    strips mentions when there's no [ESCALATE] marker.
    """
    response_with_mention = (
        "Good question — <@U09JYRAENPJ> covered something similar last "
        "week, but the short answer is yes."
    )
    _patch_common(mocker, response_text=response_with_mention)

    result = agent.respond_to_mention(_event())

    assert result.escalated is False
    # Mention flows back to the Slack handler untouched.
    assert result.response_text == response_with_mention
    assert "<@U09JYRAENPJ>" in result.response_text


def test_respond_to_mention_plumbs_recent_channel_context_into_prompt(mocker):
    """Task 5: recent-channel-context string reaches build_system_prompt."""
    spies = _patch_common(mocker)
    mocker.patch(
        "agents.ella.agent._fetch_recent_context_for_event",
        return_value="[14:23] team_member Drake: prior turn\n[14:24] ella Ella: prior reply",
    )

    agent.respond_to_mention(_event())

    build_kwargs = spies.build_prompt.call_args.kwargs
    assert "prior turn" in build_kwargs["recent_channel_context"]
    assert "prior reply" in build_kwargs["recent_channel_context"]


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


def test_respond_to_mention_escalates_when_marker_at_end(mocker):
    """V2 convention: marker at END of response, handoff note after it.

    Post-2026-05-14 unification: reactive escalations also fan DMs to
    Scott + primary CSM via fire_escalation_dms(..., path="reactive").
    """
    ack = (
        "That's a hard place to be — let me make sure the right person "
        "sees this. Someone will follow up with you directly."
    )
    handoff = (
        "Client is feeling stuck on a personal-judgment call. Worth a "
        "direct conversation."
    )
    marked_response = f"{ack}\n\n[ESCALATE]\n{handoff}"
    spies = _patch_common(mocker, response_text=marked_response)

    result = agent.respond_to_mention(_event(text="should I fire this client?"))

    assert result.escalated is True
    assert result.escalation_reason == "ella_escalated"
    assert result.escalation_id == "esc-xyz"
    assert "[ESCALATE]" not in result.response_text
    # Client-facing ack flows back untouched (no postprocessing that
    # strips mentions — there are none to strip post-prompt-edit).
    assert result.response_text == ack
    # And the post-2026-05-14 prompt edit instructs Sonnet to not
    # write `<@...>` mentions in escalation acks; pin this in the test
    # by asserting the canonical example doesn't carry one.
    assert "<@" not in result.response_text
    assert result.confidence == 0.0
    assert result.agent_run_id == "run-abc"

    spies.escalate.assert_called_once()
    esc_kwargs = spies.escalate.call_args.kwargs
    assert esc_kwargs["context"]["ella_response"] == ack
    assert "[ESCALATE]" not in esc_kwargs["context"]["ella_response"]
    # Batch 1.5: handoff note from after the marker lands on the row.
    assert esc_kwargs["context"]["handoff_reasoning"] == handoff
    # speaker dict on the row for the reviewing CSM.
    assert esc_kwargs["context"]["speaker"]["role"] == "client"
    assert esc_kwargs["context"]["speaker"]["display_name"] == "Test Client"

    # Post-unification: fire_escalation_dms is called with path="reactive"
    # and the handoff context as the reasoning.
    spies.fire_dms.assert_called_once()
    fire_kwargs = spies.fire_dms.call_args.kwargs
    assert fire_kwargs["path"] == "reactive"
    assert fire_kwargs["reasoning"] == handoff
    assert fire_kwargs["channel_client_id"] == "c-1"
    assert len(fire_kwargs["recipients"]) == 2

    end_kwargs = spies.end.call_args.kwargs
    assert end_kwargs["status"] == "escalated"
    # output_summary shape matches the passive escalate branch so the
    # /ella/runs Output column renders identically.
    assert end_kwargs["output_summary"].startswith("escalated via DM")
    assert "Scott=ok" in end_kwargs["output_summary"]


def test_respond_to_mention_escalates_when_marker_at_start(mocker):
    """Legacy V1 shape still triggers — marker anywhere works."""
    marked = "[ESCALATE]\nLegacy V1 handoff note."
    spies = _patch_common(mocker, response_text=marked)

    result = agent.respond_to_mention(_event())

    assert result.escalated is True
    assert result.response_text == ""  # nothing before the marker
    esc_kwargs = spies.escalate.call_args.kwargs
    assert esc_kwargs["context"]["handoff_reasoning"] == "Legacy V1 handoff note."


def test_respond_to_mention_escalates_when_marker_mid_response(mocker):
    """The exact audit-flagged leak shape — Ella generated client-facing
    text + [ESCALATE] + handoff text mid-response. V1 detector missed
    this; V2 catches it and strips correctly."""
    leak = (
        "This one's worth a direct conversation with Scott.\n\n"
        "[ESCALATE]\n"
        "Javi asked about repurposing call recordings into curriculum."
    )
    spies = _patch_common(mocker, response_text=leak)

    result = agent.respond_to_mention(_event())

    assert result.escalated is True
    assert "[ESCALATE]" not in result.response_text
    assert "repurposing call recordings" not in result.response_text
    assert result.response_text == "This one's worth a direct conversation with Scott."
    esc_kwargs = spies.escalate.call_args.kwargs
    assert "repurposing call recordings" in esc_kwargs["context"]["handoff_reasoning"]


# ---------------------------------------------------------------------------
# No channel-client mapped → skip rather than crash
# ---------------------------------------------------------------------------


def test_bare_mention_skips_llm_and_returns_canned_response(mocker):
    """Task 6: stripped text <5 chars → no Claude call, canned warm opener."""
    mocker.patch("agents.ella.agent.start_agent_run", return_value="run-bare")
    end = mocker.patch("agents.ella.agent.end_agent_run")
    mocker.patch(
        "agents.ella.agent.resolve_speaker_identity",
        return_value=SpeakerIdentity(
            slack_user_id="U_DRAKE", display_name="Drake", role="advisor"
        ),
    )
    retrieve = mocker.patch("agents.ella.agent._retrieve_context")
    claude = mocker.patch("agents.ella.agent._call_claude")

    event = _event(text="hi")  # event text becomes "<@UBOT> hi" → stripped → "<@UBOT> hi"
    # Override directly so the stripped form is short.
    event["text"] = "hi"
    result = agent.respond_to_mention(event)

    assert result.escalated is False
    assert "Drake" in result.response_text or "Hi" in result.response_text or "Hey" in result.response_text
    assert result.agent_run_id == "run-bare"

    # No retrieval, no Claude call.
    retrieve.assert_not_called()
    claude.assert_not_called()

    # agent_runs logged with trigger_type='bare_mention'.
    end.assert_called_once()
    assert end.call_args.kwargs["status"] == "success"


def test_bare_mention_empty_text_uses_no_name_opener(mocker):
    mocker.patch("agents.ella.agent.start_agent_run", return_value="run-bare")
    mocker.patch("agents.ella.agent.end_agent_run")
    mocker.patch(
        "agents.ella.agent.resolve_speaker_identity",
        return_value=SpeakerIdentity(
            slack_user_id="U_X", display_name="(unverified)", role="unresolvable"
        ),
    )
    claude = mocker.patch("agents.ella.agent._call_claude")

    event = _event(text="")
    event["text"] = ""
    result = agent.respond_to_mention(event)

    # No name in any of the no-name openers.
    assert "unverified" not in result.response_text
    assert "(" not in result.response_text
    claude.assert_not_called()


def test_bare_mention_records_trigger_type_bare_mention(mocker):
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

    start.assert_called_once()
    assert start.call_args.kwargs["trigger_type"] == "bare_mention"


def test_substantive_mention_uses_normal_path(mocker):
    """Threshold is <5 chars; 5 chars goes through the LLM path."""
    spies = _patch_common(mocker)
    event = _event(text="<@UBOT> what's up there pal")

    agent.respond_to_mention(event)

    # Reached the LLM call, not the bare path.
    spies.call_claude.assert_called_once()


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
# `_detect_and_strip_escalation` — direct unit coverage
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,client_text,handoff",
    [
        # V2 canonical: ack first, then [ESCALATE], then handoff.
        (
            "Quick ack here.\n\n[ESCALATE]\nHandoff note for advisor.",
            "Quick ack here.",
            "Handoff note for advisor.",
        ),
        # V1 legacy shape: marker at start.
        (
            "[ESCALATE]\nLegacy handoff.",
            "",
            "Legacy handoff.",
        ),
        # Audit-flagged mid-response leak shape — V1 detector missed this.
        (
            "Client-facing text.\n[ESCALATE]\nLeaked handoff note.",
            "Client-facing text.",
            "Leaked handoff note.",
        ),
        # Inline marker (space separator instead of newline).
        (
            "ack [ESCALATE] handoff",
            "ack",
            "handoff",
        ),
        # Marker at end with no handoff after it.
        (
            "Just an ack.\n[ESCALATE]",
            "Just an ack.",
            "",
        ),
        # No marker — return verbatim with None.
        (
            "Plain answer, no marker.",
            "Plain answer, no marker.",
            None,
        ),
        # Empty input.
        ("", "", None),
    ],
)
def test_detect_and_strip_escalation(raw, client_text, handoff):
    ct, hf = agent._detect_and_strip_escalation(raw)
    assert ct == client_text
    assert hf == handoff


def test_detect_and_strip_escalation_lowercase_not_matched():
    """Case-sensitive: lowercase doesn't count."""
    ct, hf = agent._detect_and_strip_escalation("[escalate]\nlowercase doesn't trigger")
    assert ct == "[escalate]\nlowercase doesn't trigger"
    assert hf is None
