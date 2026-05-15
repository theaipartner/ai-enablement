"""Unit tests for api.faq_digest_cron.run_faq_digest_cron.

Mocks the supabase client and shared.slack_post.post_message. No
real DB, no real Slack send."""

from __future__ import annotations

import json
from types import SimpleNamespace
from typing import Any
from unittest.mock import patch

import pytest

from api import faq_digest_cron as cron


# ---------------------------------------------------------------------------
# Fake DB harness — mimics the supabase-py chain shape
# ---------------------------------------------------------------------------


class _Chain:
    def __init__(self, table, fake):
        self.table = table
        self.fake = fake
        self._mode = None
        self._payload: Any = None
        self._filters = []

    def select(self, *_a, **_kw):
        self._mode = "select"
        return self

    def insert(self, payload):
        self._mode = "insert"
        self._payload = payload
        return self

    def update(self, payload):
        self._mode = "update"
        self._payload = payload
        return self

    def eq(self, k, v):
        self._filters.append(("eq", k, v))
        return self

    def gte(self, k, v):
        self._filters.append(("gte", k, v))
        return self

    def lt(self, k, v):
        self._filters.append(("lt", k, v))
        return self

    def ilike(self, k, v):
        self._filters.append(("ilike", k, v))
        return self

    def is_(self, k, v):
        self._filters.append(("is", k, v))
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, *_a, **_kw):
        return self

    def execute(self):
        if self._mode == "select" and self.table == "documents":
            return SimpleNamespace(data=self.fake.documents_rows)
        if self._mode == "select" and self.table == "team_members":
            return SimpleNamespace(data=self.fake.team_members_rows)
        if self._mode == "insert" and self.table == "webhook_deliveries":
            self.fake.audit_inserts.append(self._payload)
            return SimpleNamespace(data=[self._payload])
        if self._mode == "update" and self.table == "webhook_deliveries":
            self.fake.audit_updates.append((self._filters, self._payload))
            return SimpleNamespace(data=[self._payload])
        raise AssertionError(
            f"unexpected execute table={self.table} mode={self._mode}"
        )


class _FakeDb:
    def __init__(self):
        self.documents_rows: list[dict[str, Any]] = []
        self.team_members_rows: list[dict[str, Any]] = []
        self.audit_inserts: list[Any] = []
        self.audit_updates: list[Any] = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("api.faq_digest_cron.get_client", lambda: db)
    return db


@pytest.fixture
def stub_slack(monkeypatch):
    """Capture every post_message call. Default ok=True."""
    calls: list[tuple[str, str]] = []

    def _fake_post(channel_id, text, **_kw):
        calls.append((channel_id, text))
        return {"ok": True, "slack_error": None}

    monkeypatch.setattr("api.faq_digest_cron.post_message", _fake_post)
    return calls


def _document_row(*, doc_id="d1", started_at="2026-05-15T12:00:00+00:00",
                  questions: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    content = json.dumps({
        "pain_points": [],
        "wins": [],
        "dodged_questions": [],
        "sentiment_arc": "flat",
        "questions_asked": questions or [],
    })
    return {
        "id": doc_id,
        "content": content,
        "metadata": {"started_at": started_at},
    }


def _scott_row(slack_user_id="USCOTT1"):
    return {
        "id": "tm-scott",
        "full_name": "Scott Wilson",
        "slack_user_id": slack_user_id,
        "is_csm": True,
        "archived_at": None,
    }


# ---------------------------------------------------------------------------
# Happy path
# ---------------------------------------------------------------------------


def test_happy_path_sends_digest_with_questions(fake_db, stub_slack):
    fake_db.documents_rows = [
        _document_row(
            doc_id="d1",
            questions=[
                {"question": "How do I share GHL access with my VA?",
                 "asker": "client", "evidence": "..."},
                {"question": "What's the cold-call opener for dentists?",
                 "asker": "client", "evidence": "..."},
            ],
        ),
        _document_row(
            doc_id="d2",
            questions=[
                {"question": "Is dental a good ICP for cold outreach?",
                 "asker": "client", "evidence": "..."},
            ],
        ),
    ]
    fake_db.team_members_rows = [_scott_row()]

    result = cron.run_faq_digest_cron()

    assert result["status"] == "ok"
    assert result["total_questions"] == 3
    assert result["total_clusters"] >= 1
    assert len(stub_slack) == 1
    channel, body = stub_slack[0]
    assert channel == "USCOTT1"
    assert "FAQ digest" in body
    assert "GHL" in body or "dentists" in body or "dental" in body


def test_zero_questions_sends_explicit_no_questions(fake_db, stub_slack):
    """When the week is empty, still send a message — Scott needs to
    know the cron ran. Don't silently skip."""
    fake_db.documents_rows = []
    fake_db.team_members_rows = [_scott_row()]

    result = cron.run_faq_digest_cron()

    assert result["status"] == "ok"
    assert result["total_questions"] == 0
    assert result["total_clusters"] == 0
    assert len(stub_slack) == 1
    _, body = stub_slack[0]
    assert "No client questions surfaced this week" in body


# ---------------------------------------------------------------------------
# Filtering
# ---------------------------------------------------------------------------


def test_csm_asked_questions_excluded(fake_db, stub_slack):
    """asker='csm' entries are filtered out — Scott only wants
    client-asked questions for FAQ purposes."""
    fake_db.documents_rows = [
        _document_row(
            questions=[
                {"question": "What's blocking you?",
                 "asker": "csm", "evidence": "..."},
                {"question": "How do I import contacts?",
                 "asker": "client", "evidence": "..."},
            ],
        ),
    ]
    fake_db.team_members_rows = [_scott_row()]

    result = cron.run_faq_digest_cron()

    assert result["total_questions"] == 1
    _, body = stub_slack[0]
    assert "blocking" not in body
    assert "import" in body


def test_malformed_questions_skipped_silently(fake_db, stub_slack):
    """Defensive: missing question key, non-string question, empty
    string — all skipped without crashing the cron."""
    fake_db.documents_rows = [
        _document_row(
            questions=[
                {"asker": "client", "evidence": "..."},  # missing question
                {"question": None, "asker": "client", "evidence": "..."},
                {"question": "", "asker": "client", "evidence": "..."},
                {"question": "How do I check accountability?",
                 "asker": "client", "evidence": "..."},
            ],
        ),
    ]
    fake_db.team_members_rows = [_scott_row()]

    result = cron.run_faq_digest_cron()

    assert result["status"] == "ok"
    assert result["total_questions"] == 1


def test_non_json_content_skipped(fake_db, stub_slack):
    """A documents row whose content isn't parseable JSON shouldn't
    crash the cron."""
    fake_db.documents_rows = [
        {"id": "bad", "content": "{not json", "metadata": {"started_at": "..."}},
        _document_row(
            doc_id="good",
            questions=[
                {"question": "Real question?",
                 "asker": "client", "evidence": "..."},
            ],
        ),
    ]
    fake_db.team_members_rows = [_scott_row()]

    result = cron.run_faq_digest_cron()

    assert result["status"] == "ok"
    assert result["total_questions"] == 1


# ---------------------------------------------------------------------------
# Clustering
# ---------------------------------------------------------------------------


def test_cluster_dedup_collapses_near_identical_questions(fake_db, stub_slack):
    """Two close-phrasing questions about the same thing cluster to
    one entry. Two clearly different questions don't."""
    fake_db.documents_rows = [
        _document_row(
            doc_id="d1",
            questions=[
                {"question": "How do I share GHL access with my VA?",
                 "asker": "client", "evidence": "..."},
                {"question": "How do I share my GHL access with the VA?",
                 "asker": "client", "evidence": "..."},
                {"question": "What's the cold-call opener for dentists?",
                 "asker": "client", "evidence": "..."},
            ],
        ),
    ]
    fake_db.team_members_rows = [_scott_row()]

    result = cron.run_faq_digest_cron()

    # Two clusters: the GHL/VA pair + the dentist opener.
    assert result["total_questions"] == 3
    assert result["total_clusters"] == 2


def test_cluster_unrelated_questions_stay_separate(fake_db, stub_slack):
    """Questions with disjoint content words don't cluster."""
    fake_db.documents_rows = [
        _document_row(
            questions=[
                {"question": "How does scheduling work?",
                 "asker": "client", "evidence": "..."},
                {"question": "What is the billing schedule?",
                 "asker": "client", "evidence": "..."},
                {"question": "Where do I find the offer-ladder lesson?",
                 "asker": "client", "evidence": "..."},
            ],
        ),
    ]
    fake_db.team_members_rows = [_scott_row()]

    result = cron.run_faq_digest_cron()

    assert result["total_questions"] == 3
    assert result["total_clusters"] >= 2  # at minimum, the lesson question stands alone


def test_cluster_count_surfaces_in_message(fake_db, stub_slack):
    """When the same question shows up in multiple calls, the message
    annotates with `(asked in N calls)`."""
    fake_db.documents_rows = [
        _document_row(
            doc_id="d1",
            questions=[{"question": "How do I import contacts to the CRM?",
                        "asker": "client", "evidence": "..."}],
        ),
        _document_row(
            doc_id="d2",
            questions=[{"question": "How do I import contacts into the CRM?",
                        "asker": "client", "evidence": "..."}],
        ),
        _document_row(
            doc_id="d3",
            questions=[{"question": "How do I import my contacts into the CRM?",
                        "asker": "client", "evidence": "..."}],
        ),
    ]
    fake_db.team_members_rows = [_scott_row()]

    result = cron.run_faq_digest_cron()

    _, body = stub_slack[0]
    assert result["total_clusters"] == 1
    assert "(asked in 3 calls)" in body


# ---------------------------------------------------------------------------
# Auth + missing dependencies
# ---------------------------------------------------------------------------


def test_scott_lookup_missing_marks_failed(fake_db, stub_slack):
    fake_db.documents_rows = []
    fake_db.team_members_rows = []  # no Scott row

    result = cron.run_faq_digest_cron()

    assert result["status"] == "failed"
    assert "scott" in result["error"].lower()
    assert len(stub_slack) == 0


def test_verify_auth_rejects_missing_bearer(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "abc123")

    class _FakeHeaders:
        def get(self, k, default=None):
            return None

    assert cron._verify_auth(_FakeHeaders()) is False


def test_verify_auth_accepts_matching_bearer(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "abc123")

    class _FakeHeaders:
        def get(self, k, default=None):
            if k.lower() == "authorization":
                return "Bearer abc123"
            return None

    assert cron._verify_auth(_FakeHeaders()) is True


def test_verify_auth_rejects_wrong_bearer(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "abc123")

    class _FakeHeaders:
        def get(self, k, default=None):
            if k.lower() == "authorization":
                return "Bearer wrong"
            return None

    assert cron._verify_auth(_FakeHeaders()) is False


def test_verify_auth_rejects_when_secret_unset(monkeypatch):
    monkeypatch.delenv("CRON_SECRET", raising=False)

    class _FakeHeaders:
        def get(self, k, default=None):
            return "Bearer anything"

    assert cron._verify_auth(_FakeHeaders()) is False


# ---------------------------------------------------------------------------
# Slack failure isolation
# ---------------------------------------------------------------------------


def test_slack_failure_records_audit_returns_status(fake_db, monkeypatch):
    """Slack post failures don't fail the cron — they're logged in
    the audit row and the cron returns 200-equivalent status."""
    fake_db.documents_rows = [
        _document_row(
            questions=[{"question": "Real question?",
                        "asker": "client", "evidence": "..."}],
        ),
    ]
    fake_db.team_members_rows = [_scott_row()]

    monkeypatch.setattr(
        "api.faq_digest_cron.post_message",
        lambda *a, **kw: {"ok": False, "slack_error": "channel_not_found"},
    )

    result = cron.run_faq_digest_cron()

    assert result["status"] == "slack_post_failed"
    assert result["slack_ok"] is False
    assert result["slack_error"] == "channel_not_found"
    # Audit row was marked failed with the slack_error.
    assert any(
        any(isinstance(v, dict) and v.get("slack_error") == "channel_not_found"
            for v in (payload if isinstance(payload, dict) else {}).values())
        or (isinstance(payload, dict) and payload.get("slack_error") == "channel_not_found")
        for _, payload in fake_db.audit_updates
    )


# ---------------------------------------------------------------------------
# CC recipient (FAQ_DIGEST_CC_SLACK_USER_ID)
# ---------------------------------------------------------------------------


def _seed_one_question_with_scott(fake_db):
    """Common fixture for the CC tests — one client question + Scott row."""
    fake_db.documents_rows = [
        _document_row(
            questions=[
                {"question": "How do I export contacts?",
                 "asker": "client", "evidence": "..."}
            ],
        ),
    ]
    fake_db.team_members_rows = [_scott_row()]


def test_cc_env_unset_scott_only(fake_db, stub_slack, monkeypatch):
    """Regression: with CC env var unset, the cron still DMs only Scott
    — the pre-CC behavior is preserved."""
    monkeypatch.delenv("FAQ_DIGEST_CC_SLACK_USER_ID", raising=False)
    _seed_one_question_with_scott(fake_db)

    result = cron.run_faq_digest_cron()

    assert result["status"] == "ok"
    assert result["cc_present"] is False
    assert result["cc_slack_ok"] is None
    assert result["cc_slack_error"] is None
    assert len(result["recipients"]) == 1
    assert result["recipients"][0]["source"] == "scott"
    # Exactly one Slack post, to Scott.
    assert len(stub_slack) == 1
    channel, _ = stub_slack[0]
    assert channel == "USCOTT1"


def test_cc_env_valid_uid_both_recipients_dmed(fake_db, stub_slack, monkeypatch):
    """CC set to a valid Slack user_id → both Scott and CC get DMed,
    each with its own webhook_deliveries audit row."""
    monkeypatch.setenv("FAQ_DIGEST_CC_SLACK_USER_ID", "U0AMC23G1SM")
    _seed_one_question_with_scott(fake_db)

    result = cron.run_faq_digest_cron()

    assert result["status"] == "ok"
    assert result["cc_present"] is True
    assert result["cc_slack_ok"] is True
    assert result["cc_slack_error"] is None
    assert len(result["recipients"]) == 2

    sources = {r["source"] for r in result["recipients"]}
    assert sources == {"scott", "cc"}
    cc_recipient = next(r for r in result["recipients"] if r["source"] == "cc")
    assert cc_recipient["slack_user_id"] == "U0AMC23G1SM"
    assert cc_recipient["slack_ok"] is True

    # Both Slack posts fired, both to the correct channels.
    assert len(stub_slack) == 2
    channels = {channel for channel, _ in stub_slack}
    assert channels == {"USCOTT1", "U0AMC23G1SM"}
    # Both bodies identical (same message text, different recipient).
    bodies = {body for _, body in stub_slack}
    assert len(bodies) == 1

    # Two per-recipient audit rows inserted, two final-state updates.
    assert len(fake_db.audit_inserts) == 2
    assert len(fake_db.audit_updates) == 2


def test_cc_env_malformed_value_scott_only_warning_logged(
    fake_db, stub_slack, monkeypatch, caplog
):
    """CC set to a value that doesn't match ^U[A-Z0-9]+$ degrades to
    Scott-only with a logged warning. Doesn't crash the cron."""
    import logging
    monkeypatch.setenv("FAQ_DIGEST_CC_SLACK_USER_ID", "drake@example.com")
    _seed_one_question_with_scott(fake_db)

    with caplog.at_level(logging.WARNING, logger="ai_enablement.faq_digest_cron"):
        result = cron.run_faq_digest_cron()

    assert result["status"] == "ok"
    assert result["cc_present"] is False
    assert len(result["recipients"]) == 1
    assert result["recipients"][0]["source"] == "scott"
    assert len(stub_slack) == 1
    # Warning surfaces in logs with the offending env var value.
    assert any(
        "FAQ_DIGEST_CC_SLACK_USER_ID" in r.message and "malformed" in r.message
        for r in caplog.records
    )


def test_cc_env_valid_but_cc_slack_send_fails_scott_still_ok(
    fake_db, monkeypatch
):
    """CC's Slack send fails (e.g., channel_not_found) but Scott's
    succeeds. Cron returns 200/ok at top level (Scott is the
    source-of-truth recipient); CC's failure lands in the recipients
    list + its own audit row carries the error."""
    monkeypatch.setenv("FAQ_DIGEST_CC_SLACK_USER_ID", "U0AMC23G1SM")
    _seed_one_question_with_scott(fake_db)

    calls: list[tuple[str, str]] = []

    def _selective_post(channel_id, text, **_kw):
        calls.append((channel_id, text))
        # Scott ok; CC fails.
        if channel_id == "USCOTT1":
            return {"ok": True, "slack_error": None}
        return {"ok": False, "slack_error": "channel_not_found"}

    monkeypatch.setattr("api.faq_digest_cron.post_message", _selective_post)

    result = cron.run_faq_digest_cron()

    assert result["status"] == "ok"
    assert result["slack_ok"] is True
    assert result["cc_present"] is True
    assert result["cc_slack_ok"] is False
    assert result["cc_slack_error"] == "channel_not_found"
    # Both attempts fired.
    assert len(calls) == 2
    # CC's audit row carries the slack_post_failed error. The recorded
    # `payload` is the full update dict written via
    # webhook_deliveries.update(...); the inner final_payload is nested
    # under the "payload" key. Find the update whose inner payload has
    # recipient_source='cc'.
    cc_update = next(
        update for _, update in fake_db.audit_updates
        if isinstance(update, dict)
        and isinstance(update.get("payload"), dict)
        and update["payload"].get("recipient_source") == "cc"
    )
    assert cc_update["processing_status"] == "failed"
    assert "channel_not_found" in cc_update["processing_error"]
    assert cc_update["payload"]["slack_ok"] is False
    assert cc_update["payload"]["slack_error"] == "channel_not_found"


def test_cc_env_equal_to_scott_uid_deduplicated_to_one_recipient(
    fake_db, stub_slack, monkeypatch
):
    """Edge case: CC env set to Scott's own slack_user_id. Don't
    double-DM. Scott wins; CC is dropped."""
    monkeypatch.setenv("FAQ_DIGEST_CC_SLACK_USER_ID", "USCOTT1")
    _seed_one_question_with_scott(fake_db)

    result = cron.run_faq_digest_cron()

    assert result["status"] == "ok"
    assert result["cc_present"] is False
    assert len(result["recipients"]) == 1
    assert result["recipients"][0]["source"] == "scott"
    assert len(stub_slack) == 1
