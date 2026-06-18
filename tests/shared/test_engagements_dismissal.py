"""Unit tests for the engagement-dismissal path (shared.engagements).

A rep @-mentions Ella in a missing-form ping's Slack thread when the form is
genuinely not needed. `handle_dismissal_mention` resolves the reply's
`thread_ts` to the engagement via its recorded ping ts, stamps `dismissed_at`,
and acks in-thread.

Pinned coverage:
  - _strip_mentions: drops <@U...> tokens, keeps free text, handles bare/empty.
  - handle_dismissal_mention: a matching ping thread -> dismiss + ack.
  - handle_dismissal_mention: no matching ping -> no dismiss, no ack.
  - handle_dismissal_mention: non-thread mention -> ignored early.
"""

from __future__ import annotations

import shared.engagements as eng


# ---------------------------------------------------------------------------
# _strip_mentions
# ---------------------------------------------------------------------------


def test_strip_mentions_removes_token_keeps_text():
    assert eng._strip_mentions("<@U0ELLA> not needed") == "not needed"


def test_strip_mentions_bare_mention_is_empty():
    assert eng._strip_mentions("<@U0ELLA>") == ""


def test_strip_mentions_handles_none_and_blank():
    assert eng._strip_mentions(None) == ""
    assert eng._strip_mentions("   ") == ""


# ---------------------------------------------------------------------------
# handle_dismissal_mention — fake cursor/conn + post capture
# ---------------------------------------------------------------------------


class _FakeCursor:
    def __init__(self, select_row):
        self._select_row = select_row
        self.executed: list[tuple] = []

    def execute(self, sql, params=None):
        self.executed.append((sql, params))
        self._last_is_select = sql.strip().lower().startswith("select")

    def fetchone(self):
        return self._select_row if self._last_is_select else None


class _FakeConn:
    def __init__(self, cur):
        self._cur = cur
        self.committed = False

    def cursor(self):
        return self._cur

    def commit(self):
        self.committed = True

    def close(self):
        pass


def _patch(monkeypatch, select_row):
    cur = _FakeCursor(select_row)
    conn = _FakeConn(cur)
    monkeypatch.setattr(eng, "_connect", lambda: conn)
    posted: list[dict] = []
    monkeypatch.setattr(
        "shared.slack_post.post_message",
        lambda channel, text, *, thread_ts=None, **kw: posted.append(
            {"channel": channel, "text": text, "thread_ts": thread_ts}
        )
        or {"ok": True, "ts": "9.9"},
    )
    return cur, conn, posted


def test_dismissal_matches_ping_thread(monkeypatch):
    cur, conn, posted = _patch(monkeypatch, select_row=("eng-123", "Acme Co"))
    event = {
        "type": "app_mention",
        "channel": "C0SALES",
        "user": "U0REP",
        "thread_ts": "111.222",
        "text": "<@U0ELLA> not needed, tech support call",
    }
    result = eng.handle_dismissal_mention(event)

    assert result["dismissed"] is True
    assert result["engagement"] == "eng-123"
    # An UPDATE that sets dismissed_at + reason ran, with the stripped text.
    update = [e for e in cur.executed if "dismissed_at=now()" in e[0]]
    assert update, "expected a dismissed_at update"
    assert update[0][1] == ("U0REP", "not needed, tech support call", "eng-123")
    assert conn.committed is True
    # Acked in-thread on the same ping ts.
    assert posted and posted[0]["thread_ts"] == "111.222"
    assert "Acme Co" in posted[0]["text"]


def test_dismissal_bare_mention_stores_null_reason(monkeypatch):
    cur, conn, posted = _patch(monkeypatch, select_row=("eng-7", "Lead 7"))
    event = {
        "channel": "C0SALES",
        "user": "U0REP",
        "thread_ts": "5.5",
        "text": "<@U0ELLA>",
    }
    eng.handle_dismissal_mention(event)
    update = [e for e in cur.executed if "dismissed_at=now()" in e[0]][0]
    # Empty reason normalizes to None, not "".
    assert update[1] == ("U0REP", None, "eng-7")


def test_no_matching_ping_does_not_dismiss(monkeypatch):
    cur, conn, posted = _patch(monkeypatch, select_row=None)
    event = {
        "channel": "C0SALES",
        "user": "U0REP",
        "thread_ts": "999.999",
        "text": "<@U0ELLA> not needed",
    }
    result = eng.handle_dismissal_mention(event)

    assert result["dismissed"] is False
    assert result["reason"] == "no_matching_ping"
    assert not any("dismissed_at=now()" in e[0] for e in cur.executed)
    assert conn.committed is False
    assert posted == []  # no ack when nothing matched


def test_non_thread_mention_ignored_before_db(monkeypatch):
    # A top-level @Ella (no thread_ts) isn't a ping reply — ignored early.
    called = {"connected": False}
    monkeypatch.setattr(
        eng, "_connect", lambda: called.__setitem__("connected", True)
    )
    result = eng.handle_dismissal_mention(
        {"channel": "C0SALES", "user": "U0REP", "text": "<@U0ELLA> hi"}
    )
    assert result["dismissed"] is False
    assert result["reason"] == "not_a_thread_reply"
    assert called["connected"] is False
