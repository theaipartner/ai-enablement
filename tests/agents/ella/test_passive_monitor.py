"""Unit tests for `agents.ella.passive_monitor` (unified-path rewrite).

Two gates (kill switch + author type) then one decision Haiku call
returning `respond` / `acknowledge_and_escalate` / `skip` plus the
independent digest flag. @-mention is a payload signal, not a path.
"""

from __future__ import annotations

import json
from decimal import Decimal
from types import SimpleNamespace

import pytest

from agents.ella.passive_monitor import (
    _HAIKU_SYSTEM_PROMPT,
    PassiveTriggerPayload,
    evaluate_passive_trigger,
)


class _Chain:
    def __init__(self, table, fake):
        self.table = table
        self.fake = fake

    def select(self, *_a, **_kw):
        return self

    def eq(self, *_a, **_kw):
        return self

    def is_(self, *_a, **_kw):
        return self

    def execute(self):
        if self.table == "client_team_assignments":
            return SimpleNamespace(data=self.fake.assignments)
        if self.table == "team_members":
            return SimpleNamespace(data=self.fake.team_members)
        raise AssertionError(f"unexpected table {self.table}")


class _FakeDb:
    def __init__(self):
        self.assignments = []
        self.team_members = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("shared.db.get_client", lambda: db)
    monkeypatch.setattr("agents.ella.passive_monitor.get_client", lambda: db)
    return db


@pytest.fixture(autouse=True)
def _env(monkeypatch):
    monkeypatch.setenv("ELLA_PASSIVE_MONITORING_ENABLED", "true")


@pytest.fixture(autouse=True)
def _stub_retrieval_and_speaker(monkeypatch):
    monkeypatch.setattr(
        "agents.ella.passive_monitor.fetch_recent_channel_messages",
        lambda *a, **kw: [],
    )
    monkeypatch.setattr(
        "agents.ella.passive_monitor.fetch_recent_channel_context",
        lambda *a, **kw: "",
    )
    monkeypatch.setattr(
        "agents.ella.passive_monitor.build_kb_query_from_conversation",
        lambda *a, **kw: "kbq",
    )
    monkeypatch.setattr(
        "agents.ella.passive_monitor.search_for_client",
        lambda *a, **kw: [],
    )
    monkeypatch.setattr(
        "agents.ella.passive_monitor.resolve_speaker_identity",
        lambda uid: SimpleNamespace(
            display_name="Catrina Reeves",
            role="client",
            slack_user_id=uid,
            client_id="c1",
            team_member_id=None,
        ),
    )


def _payload(text="hello", author_type="client", mentioned=False):
    return PassiveTriggerPayload(
        slack_channel_id="C1",
        triggering_message_ts="1745500100.000100",
        triggering_message_slack_user_id="UCLIENT1",
        triggering_message_text=text,
        author_type=author_type,
        channel_client_id="client-uuid-1",
        is_ella_mentioned=mentioned,
    )


def _stub_haiku(monkeypatch, obj, tokens=(10, 5), cost="0.00001"):
    text = obj if isinstance(obj, str) else json.dumps(obj)
    monkeypatch.setattr(
        "agents.ella.passive_monitor.complete",
        lambda **kw: SimpleNamespace(
            text=text,
            input_tokens=tokens[0],
            output_tokens=tokens[1],
            cost_usd=Decimal(cost),
            model="haiku",
            raw=None,
        ),
    )


# --- gates ---------------------------------------------------------------


def test_kill_switch_off_no_row(fake_db, monkeypatch):
    monkeypatch.setenv("ELLA_PASSIVE_MONITORING_ENABLED", "false")
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "kill_switch"


@pytest.mark.parametrize("atype", ["ella", "bot", "workflow", "unknown"])
def test_non_human_author_skips_with_audit(fake_db, atype):
    ev = evaluate_passive_trigger(_payload(author_type=atype))
    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "non_human_author"


def test_team_member_always_evaluated(fake_db, monkeypatch):
    _stub_haiku(
        monkeypatch,
        {
            "decision": "skip",
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "advisor work",
        },
    )
    ev = evaluate_passive_trigger(_payload(author_type="team_member"))
    assert ev.skip_reason != "non_human_author"


# --- three decisions -----------------------------------------------------


def test_respond_with_haiku_model(fake_db, monkeypatch):
    _stub_haiku(
        monkeypatch,
        {
            "decision": "respond",
            "response_model": "haiku",
            "ack_text": None,
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "clean factual",
        },
    )
    ev = evaluate_passive_trigger(_payload(mentioned=True))
    assert ev.decision.decision == "respond"
    assert ev.decision.response_model == "haiku"
    assert ev.decision.ack_text is None
    assert ev.skip_reason is None


def test_respond_missing_model_defaults_sonnet(fake_db, monkeypatch):
    _stub_haiku(
        monkeypatch,
        {
            "decision": "respond",
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "x",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.response_model == "sonnet"


def test_acknowledge_and_escalate_ack_text(fake_db, monkeypatch):
    _stub_haiku(
        monkeypatch,
        {
            "decision": "acknowledge_and_escalate",
            "ack_text": "Hey — I'll get Scott on this.",
            "digest_flag": True,
            "digest_category": "emotional_human_needed",
            "reasoning": "frustrated",
        },
    )
    ev = evaluate_passive_trigger(_payload(text="I'm so frustrated"))
    assert ev.decision.decision == "acknowledge_and_escalate"
    assert ev.decision.ack_text == "Hey — I'll get Scott on this."
    assert ev.decision.digest_flag is True


def test_ack_escalate_missing_ack_text_falls_back(fake_db, monkeypatch):
    _stub_haiku(
        monkeypatch,
        {
            "decision": "acknowledge_and_escalate",
            "digest_flag": True,
            "digest_category": "complaint",
            "reasoning": "x",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.ack_text  # canned fallback, non-empty
    assert "advisor" in ev.decision.ack_text


def test_ack_escalate_always_flags(fake_db, monkeypatch):
    _stub_haiku(
        monkeypatch,
        {
            "decision": "acknowledge_and_escalate",
            "ack_text": "ok",
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "x",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.digest_flag is True
    assert ev.decision.digest_category == "other"


def test_skip_with_digest_flag(fake_db, monkeypatch):
    _stub_haiku(
        monkeypatch,
        {
            "decision": "skip",
            "digest_flag": True,
            "digest_category": "money_commitment",
            "reasoning": "refund buried in chitchat",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "haiku_skip"
    assert ev.decision.digest_flag is True
    assert ev.decision.digest_category == "money_commitment"


# --- parsing robustness --------------------------------------------------


def test_malformed_json_defaults_skip(fake_db, monkeypatch):
    _stub_haiku(monkeypatch, "not json at all")
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "skip"
    assert "unparseable" in ev.decision.reasoning


def test_out_of_enum_defaults_skip(fake_db, monkeypatch):
    _stub_haiku(
        monkeypatch,
        {
            "decision": "explode",
            "digest_flag": True,
            "digest_category": "other",
            "reasoning": "x",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "skip"
    assert ev.decision.digest_flag is False


def test_code_fence_parsed(fake_db, monkeypatch):
    fenced = (
        '```json\n{"decision":"respond","response_model":"sonnet",'
        '"ack_text":null,"digest_flag":false,"digest_category":null,'
        '"reasoning":"ok"}\n```'
    )
    _stub_haiku(monkeypatch, fenced)
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "respond"
    assert ev.decision.response_model == "sonnet"


def test_cost_captured(fake_db, monkeypatch):
    _stub_haiku(
        monkeypatch,
        {
            "decision": "skip",
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "x",
        },
        tokens=(99, 11),
        cost="0.00033",
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.haiku_input_tokens == 99
    assert ev.decision.haiku_output_tokens == 11
    assert ev.decision.haiku_cost_usd == Decimal("0.00033")


def test_haiku_call_failure_skips(fake_db, monkeypatch):
    def _boom(**kw):
        raise RuntimeError("anthropic down")

    monkeypatch.setattr("agents.ella.passive_monitor.complete", _boom)
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "skip"
    assert "haiku_call_failed" in ev.decision.reasoning


def test_exception_fail_soft(fake_db, monkeypatch):
    def _boom(*a, **kw):
        raise RuntimeError("kb exploded")

    monkeypatch.setattr("agents.ella.passive_monitor.search_for_client", _boom)
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "exception"


def test_mention_flag_threads_into_prompt(fake_db, monkeypatch):
    captured = {}

    def _cap(**kw):
        captured["user"] = kw["messages"][0]["content"]
        return SimpleNamespace(
            text=json.dumps(
                {
                    "decision": "respond",
                    "response_model": "haiku",
                    "ack_text": None,
                    "digest_flag": False,
                    "digest_category": None,
                    "reasoning": "ok",
                }
            ),
            input_tokens=1,
            output_tokens=1,
            cost_usd=Decimal("0"),
            model="h",
            raw=None,
        )

    monkeypatch.setattr("agents.ella.passive_monitor.complete", _cap)
    evaluate_passive_trigger(_payload(mentioned=True))
    assert "IS THIS AN @-MENTION OF ELLA?" in captured["user"]
    assert "true" in captured["user"].split("@-MENTION OF ELLA?")[1][:40]


def test_not_mentioned_renders_false(fake_db, monkeypatch):
    captured = {}

    def _cap(**kw):
        captured["user"] = kw["messages"][0]["content"]
        return SimpleNamespace(
            text=json.dumps(
                {
                    "decision": "skip",
                    "digest_flag": False,
                    "digest_category": None,
                    "reasoning": "ok",
                }
            ),
            input_tokens=1,
            output_tokens=1,
            cost_usd=Decimal("0"),
            model="h",
            raw=None,
        )

    monkeypatch.setattr("agents.ella.passive_monitor.complete", _cap)
    evaluate_passive_trigger(_payload(mentioned=False))
    seg = captured["user"].split("@-MENTION OF ELLA?")[1][:40]
    assert "false" in seg


def test_speaker_role_and_name_in_prompt(fake_db, monkeypatch):
    captured = {}

    def _cap(**kw):
        captured["u"] = kw["messages"][0]["content"]
        return SimpleNamespace(
            text=json.dumps(
                {
                    "decision": "skip",
                    "digest_flag": False,
                    "digest_category": None,
                    "reasoning": "ok",
                }
            ),
            input_tokens=1,
            output_tokens=1,
            cost_usd=Decimal("0"),
            model="h",
            raw=None,
        )

    monkeypatch.setattr("agents.ella.passive_monitor.complete", _cap)
    evaluate_passive_trigger(_payload())
    assert "client (Catrina Reeves)" in captured["u"]


def test_team_member_speaker_role_is_advisor(fake_db, monkeypatch):
    captured = {}

    def _cap(**kw):
        captured["u"] = kw["messages"][0]["content"]
        return SimpleNamespace(
            text=json.dumps(
                {
                    "decision": "skip",
                    "digest_flag": False,
                    "digest_category": None,
                    "reasoning": "ok",
                }
            ),
            input_tokens=1,
            output_tokens=1,
            cost_usd=Decimal("0"),
            model="h",
            raw=None,
        )

    monkeypatch.setattr("agents.ella.passive_monitor.complete", _cap)
    evaluate_passive_trigger(_payload(author_type="team_member"))
    assert "advisor (Catrina Reeves)" in captured["u"]


def test_digest_flag_false_nulls_category(fake_db, monkeypatch):
    _stub_haiku(
        monkeypatch,
        {
            "decision": "respond",
            "response_model": "sonnet",
            "digest_flag": False,
            "digest_category": "confusion",
            "reasoning": "x",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.digest_flag is False
    assert ev.decision.digest_category is None


def test_flag_true_invalid_category_defaults_other(fake_db, monkeypatch):
    _stub_haiku(
        monkeypatch,
        {
            "decision": "skip",
            "digest_flag": True,
            "digest_category": "nonsense",
            "reasoning": "x",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.decision.digest_flag is True
    assert ev.decision.digest_category == "other"


def test_kb_block_renders_chunks(fake_db, monkeypatch):
    captured = {}

    def _cap(**kw):
        captured["u"] = kw["messages"][0]["content"]
        return SimpleNamespace(
            text=json.dumps(
                {
                    "decision": "skip",
                    "digest_flag": False,
                    "digest_category": None,
                    "reasoning": "ok",
                }
            ),
            input_tokens=1,
            output_tokens=1,
            cost_usd=Decimal("0"),
            model="h",
            raw=None,
        )

    monkeypatch.setattr(
        "agents.ella.passive_monitor.search_for_client",
        lambda *a, **kw: [
            SimpleNamespace(
                similarity=0.81,
                content="discovery covers framing",
                document_type="course_lesson",
                document_title="Discovery",
                chunk_index=0,
            )
        ],
    )
    monkeypatch.setattr("agents.ella.passive_monitor.complete", _cap)
    evaluate_passive_trigger(_payload())
    assert "Discovery" in captured["u"]
    assert "sim=0.81" in captured["u"]


# --- prompt-sharpening spec: prompt structure ---------------------------


def test_prompt_mention_override_section_before_three_decisions():
    p = _HAIKU_SYSTEM_PROMPT
    i_override = p.index("# THE @-MENTION OVERRIDE (READ THIS FIRST)")
    i_three = p.index("# THE THREE DECISIONS")
    assert i_override < i_three, "override section must precede THE THREE DECISIONS"


def test_prompt_mention_override_is_absolute_not_weighted():
    p = _HAIKU_SYSTEM_PROMPT
    assert "absolute structural override" in p
    assert "Skip is FORBIDDEN" in p
    assert "Advisor speakers do not bypass this." in p
    # The old soft language is gone.
    assert "Strongly lean toward respond" not in p


def test_prompt_time_decay_bands_present():
    p = _HAIKU_SYSTEM_PROMPT
    assert "# READING TIME-STAMPED CONTEXT" in p
    assert "0-4 hours ago" in p
    assert "4-24 hours ago" in p
    assert "24+ hours ago" in p
    assert "7+ days ago" in p
    assert "do not skip a current @-mention because of a stale prior escalation" in p


def test_prompt_bare_mention_threading_non_negotiable():
    p = _HAIKU_SYSTEM_PROMPT
    assert "not chitchat when prior context contains a question" in p
    assert "answer THAT question" in p


def test_prompt_skip_gated_on_not_mentioned():
    p = _HAIKU_SYSTEM_PROMPT
    assert "AND only when `is_ella_mentioned: false`" in p
    assert "Every other rule is conditional on `is_ella_mentioned: false`." in p


def test_mentioned_true_plumbs_and_parses_respond(fake_db, monkeypatch):
    """Behavioral: @-mention true + mocked Haiku 'respond' → the
    evaluation surfaces respond (dispatch-shape sanity for the path the
    spec hardens)."""
    _stub_haiku(
        monkeypatch,
        {
            "decision": "respond",
            "response_model": "haiku",
            "ack_text": None,
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "user @-mentioned Ella — override applies",
        },
    )
    ev = evaluate_passive_trigger(
        _payload(text="<@U0B03PTJD3P>", author_type="team_member", mentioned=True)
    )
    assert ev.decision.decision == "respond"
    assert ev.skip_reason is None
