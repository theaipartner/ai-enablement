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


def _payload(
    text="hello",
    author_type="client",
    mentioned=False,
    routed_to_others=False,
):
    return PassiveTriggerPayload(
        slack_channel_id="C1",
        triggering_message_ts="1745500100.000100",
        triggering_message_slack_user_id="UCLIENT1",
        triggering_message_text=text,
        author_type=author_type,
        channel_client_id="client-uuid-1",
        is_ella_mentioned=mentioned,
        is_routed_to_others=routed_to_others,
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


def test_team_member_skips_as_non_client(fake_db):
    # Passive eval is client-only: an advisor talking in a client
    # channel is excluded from the digest / unanswered-channel path. The
    # decision Haiku is never consulted (no stub needed — if it were
    # called the test DB's missing stub would surface).
    ev = evaluate_passive_trigger(_payload(author_type="team_member"))
    assert ev.decision.decision == "skip"
    assert ev.skip_reason == "non_client_author"
    assert ev.decision.digest_flag is False


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
    # Non-mention path → exercises the decision Haiku. @-mentions are
    # routed upstream to the dedicated @ handler and never reach this
    # module post-2026-05-23 split.
    ev = evaluate_passive_trigger(_payload(mentioned=False))
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


def test_prompt_time_decay_bands_present():
    # The time-decay section survives the structural-override surgery
    # (it's still useful for non-@-mention judgment). The
    # @-mention-specific sentence that v1/v2 added was removed —
    # asserted absent in test_prompt_has_no_mention_residue.
    p = _HAIKU_SYSTEM_PROMPT
    assert "# READING TIME-STAMPED CONTEXT" in p
    assert "0-4 hours ago" in p
    assert "4-24 hours ago" in p
    assert "24+ hours ago" in p
    assert "7+ days ago" in p


# --- structural-override spec: @-mention sections stripped from prompt --


def test_prompt_has_no_at_mention_overlay():
    """Per `ella-at-mention-structural-override`: the v1 + v2 @-mention
    sections were moved to the classifier. Decision Haiku only runs for
    non-@-mention messages now; those overlay sections must be absent
    from this prompt (no rationalization surface)."""
    p = _HAIKU_SYSTEM_PROMPT
    # Removed sections / headers
    assert "# THE @-MENTION OVERRIDE" not in p
    assert "# WORKED EXAMPLE — RESOLVED-THREAD BARE MENTION" not in p
    # v1/v2 overlay language is gone
    assert "Skip is FORBIDDEN" not in p
    assert "absolute structural override" not in p
    assert "are NEVER skip when is_ella_mentioned=true" not in p
    assert "Strongly lean toward respond" not in p
    # Skip bullet is unconditional (no more "AND only when is_ella_mentioned: false")
    assert "AND only when" not in p
    # New preamble scopes the prompt to passive observation
    assert p.startswith("You are Ella's decision brain for PASSIVE OBSERVATION")
    assert "@-mention messages are routed separately" in p


# --- Gate 3: routed-to-humans pre-LLM skip ------------------------------


def test_routed_to_humans_skip_no_haiku_call(fake_db, monkeypatch):
    """When `is_routed_to_others=True`, Gate 3 fires BEFORE any Haiku
    call. The skip carries digest_flag=True so the dispatch layer
    writes the digest item, and skip_reason='routed_to_humans' so
    downstream queries can filter on it."""
    called = {"haiku": 0}

    def _spy(**kw):
        called["haiku"] += 1
        return SimpleNamespace(
            text="{}",
            input_tokens=1,
            output_tokens=1,
            cost_usd=Decimal("0"),
            model="h",
            raw=None,
        )

    monkeypatch.setattr("agents.ella.passive_monitor.complete", _spy)
    ev = evaluate_passive_trigger(_payload(routed_to_others=True))
    assert ev.skip_reason == "routed_to_humans"
    assert ev.decision.decision == "skip"
    assert ev.decision.digest_flag is True
    assert ev.decision.digest_category == "other"
    assert called["haiku"] == 0  # Pre-LLM skip — no Haiku call made.


def test_routed_to_humans_skip_no_db_fetch(monkeypatch):
    """The routing gate must not touch the DB — primary_csm fetch /
    KB search are wasted work for a routing-deferral skip. Verifies
    that no DB call is made by failing the db fetcher hard if hit."""
    monkeypatch.setenv("ELLA_PASSIVE_MONITORING_ENABLED", "true")

    def _explode(*a, **kw):
        raise AssertionError("Gate 3 must not call get_client()")

    monkeypatch.setattr("shared.db.get_client", _explode)
    monkeypatch.setattr("agents.ella.passive_monitor.get_client", _explode)

    ev = evaluate_passive_trigger(_payload(routed_to_others=True))
    # Got here without the assertion firing — gate 3 truly bypassed the DB.
    assert ev.skip_reason == "routed_to_humans"


def test_routed_path_takes_gate3_skip(fake_db, monkeypatch):
    """Gate 3 fires when `is_routed_to_others=True` and
    `is_ella_mentioned=False` — pre-LLM skip, no Haiku call. Post the
    2026-05-23 split, @-mentioned messages never reach this module
    (they're routed upstream in realtime_ingest), so we only need to
    verify Gate 3's behavior here."""

    # Stub `complete` so that if anything DID reach the decision Haiku,
    # we'd see it in the test failure rather than a real API call.
    called = {"complete": 0}

    def _track(*a, **kw):
        called["complete"] += 1
        return SimpleNamespace(
            text="{}",
            input_tokens=0,
            output_tokens=0,
            cost_usd=Decimal("0"),
            model="h",
            raw=None,
        )

    monkeypatch.setattr("agents.ella.passive_monitor.complete", _track)

    ev = evaluate_passive_trigger(_payload(routed_to_others=True))
    assert ev.skip_reason == "routed_to_humans"
    # Gate 3 is pre-LLM by construction; no Haiku call.
    assert called["complete"] == 0


def test_regular_path_still_works_when_no_flags_set(fake_db, monkeypatch):
    """The vanilla decision-Haiku path is unaffected by Gate 3 plumbing."""
    _stub_haiku(
        monkeypatch,
        {
            "decision": "respond",
            "response_model": "sonnet",
            "digest_flag": False,
            "digest_category": None,
            "reasoning": "ok",
        },
    )
    ev = evaluate_passive_trigger(_payload())
    assert ev.skip_reason is None
    assert ev.decision.decision == "respond"


# --- # ASSIGNED ADVISOR FOR THIS CLIENT prompt section ------------------


def test_assigned_advisor_section_renders_full_name(fake_db, monkeypatch):
    """When the client has a primary_csm row with full_name, that name
    lands in the # ASSIGNED ADVISOR FOR THIS CLIENT section of the
    prompt."""
    fake_db.assignments = [{"team_member_id": "tm-1"}]
    fake_db.team_members = [
        {"id": "tm-1", "full_name": "Lou Perez", "display_name": None}
    ]

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
    evaluate_passive_trigger(_payload())
    assert "# ASSIGNED ADVISOR FOR THIS CLIENT" in captured["user"]
    assert "Lou Perez" in captured["user"]


def test_assigned_advisor_section_falls_back_when_no_primary_csm(
    fake_db, monkeypatch
):
    """When there's no primary_csm row, the section renders the
    documented fallback string."""
    # assignments + team_members already empty by default.
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
    evaluate_passive_trigger(_payload())
    assert "# ASSIGNED ADVISOR FOR THIS CLIENT" in captured["user"]
    assert "(no primary advisor assigned)" in captured["user"]


def test_assigned_advisor_section_uses_display_name_when_full_name_missing(
    fake_db, monkeypatch
):
    """display_name is the documented fallback when full_name is null."""
    fake_db.assignments = [{"team_member_id": "tm-1"}]
    fake_db.team_members = [
        {"id": "tm-1", "full_name": None, "display_name": "Nico"}
    ]

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
    evaluate_passive_trigger(_payload())
    assert "Nico" in captured["user"]


def test_decide_passive_response_accepts_primary_advisor_name_kwarg(monkeypatch):
    """The standalone callable accepts the kwarg and threads it into
    the prompt — pins the public-API surface so dispatch / agent-side
    callers can pass it explicitly."""
    from agents.ella.passive_monitor import decide_passive_response

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
    decide_passive_response(
        triggering_message="hello",
        recent_context="",
        kb_results=[],
        speaker_role="client",
        speaker_name="Test Client",
        is_ella_mentioned=False,
        primary_advisor_name="Scott Wilson",
    )
    assert "# ASSIGNED ADVISOR FOR THIS CLIENT" in captured["user"]
    assert "Scott Wilson" in captured["user"]


def test_haiku_system_prompt_includes_advisor_grounding_line():
    """The advisor-grounding instruction lives in the
    acknowledge_and_escalate section so Haiku names the assigned
    advisor instead of a random coach pulled from channel context."""
    p = _HAIKU_SYSTEM_PROMPT
    assert (
        "use the name from the ASSIGNED ADVISOR FOR THIS CLIENT section" in p
    )
    # The advisor-grounding rule must sit AFTER the existing no-@-mention
    # rule so it modifies the same paragraph rather than a different one.
    no_mention_idx = p.find(
        "Do NOT include an @-mention of the advisor — the backend handles notifying."
    )
    grounding_idx = p.find(
        "use the name from the ASSIGNED ADVISOR FOR THIS CLIENT section"
    )
    assert no_mention_idx > 0 and grounding_idx > no_mention_idx
