"""Tests for `agents.ella.prompts.build_system_prompt`."""

from __future__ import annotations

import pytest

from agents.ella.identity import SpeakerIdentity
from agents.ella.prompts import build_system_prompt


_CLIENT = {
    "id": "c-1",
    "full_name": "Javi Pena",
    "journey_stage": "first_closing_call_taken",
    "primary_csm": {
        "id": "tm-scott",
        "full_name": "Scott Wilson",
        "slack_user_id": "U09JYRAENPJ",
    },
    "metadata": {"tags": ["beta_tester"]},
}


def test_prompt_includes_who_is_speaking_section_for_client():
    speaker = SpeakerIdentity(
        slack_user_id="U_CLIENT_1",
        display_name="Javi Pena",
        role="client",
        client_id="c-1",
    )
    out = build_system_prompt(dict(_CLIENT), retrieved_chunks=[], speaker=speaker)
    assert "# WHO IS SPEAKING" in out
    assert "Speaker: Javi Pena" in out
    assert "Role: client" in out
    assert "This channel is mapped to client: Javi Pena" in out
    assert "That client's advisor: Scott Wilson" in out
    assert "Advisor Slack mention syntax: <@U09JYRAENPJ>" in out
    assert "use the name Scott" in out  # advisor first name
    # The "you are speaking to Javi" client-branch wording
    assert "speaking to Javi" in out


def test_prompt_advisor_branch_says_dont_escalate():
    advisor = SpeakerIdentity(
        slack_user_id="U_DRAKE",
        display_name="Drake",
        role="advisor",
        team_member_id="tm-drake",
    )
    out = build_system_prompt(dict(_CLIENT), retrieved_chunks=[], speaker=advisor)
    assert "Role: advisor" in out
    assert "Speaker: Drake" in out
    # Explicit DON'T escalate
    assert "Do NOT escalate" in out
    assert "Do NOT emit the [FALLBACK_TO_SONNET] token" in out
    # NOT the channel-mapped client
    assert "NOT the channel's mapped client (Javi Pena)" in out


def test_prompt_unresolvable_branch_safer_fallback():
    unresolvable = SpeakerIdentity(
        slack_user_id="U_RANDOM",
        display_name="(unverified)",
        role="unresolvable",
    )
    out = build_system_prompt(dict(_CLIENT), retrieved_chunks=[], speaker=unresolvable)
    assert "Role: unresolvable" in out
    assert "don't have a verified identity" in out
    assert "Avoid using a name" in out
    assert "Do NOT emit the [FALLBACK_TO_SONNET] token" in out


def test_prompt_no_speaker_kwarg_defaults_to_client_persona():
    """Backwards-compat: omitting `speaker=` still produces a working prompt."""
    out = build_system_prompt(dict(_CLIENT), retrieved_chunks=[])
    assert "Role: client" in out
    # Channel-mapped client treated as speaker for the default branch.
    assert "Speaker: Javi Pena" in out


def test_base_prompt_drops_escalate_token_and_firm_after_first():
    """The [ESCALATE] token + FIRM AFTER FIRST section are gone; the
    new 'needs a human' section + [FALLBACK_TO_SONNET] are present."""
    out = build_system_prompt(dict(_CLIENT), retrieved_chunks=[])
    assert "[ESCALATE]" not in out
    assert "# WHAT YOU ESCALATE" not in out
    assert "# FIRM AFTER FIRST" not in out
    assert "# WHAT YOU DO WHEN THE CONVERSATION NEEDS A HUMAN" in out
    assert "[FALLBACK_TO_SONNET]" in out


def test_prompt_unassigned_advisor_renders_cleanly():
    """If primary_csm has no full_name, the advisor section says (unassigned)."""
    client = dict(_CLIENT)
    client["primary_csm"] = {}
    out = build_system_prompt(
        client,
        retrieved_chunks=[],
        speaker=SpeakerIdentity(
            slack_user_id="U_X",
            display_name="Tester",
            role="client",
        ),
    )
    assert "That client's advisor: (unassigned)" in out
    # No advisor mention syntax line when slack_user_id is missing
    assert "Advisor Slack mention syntax" not in out
