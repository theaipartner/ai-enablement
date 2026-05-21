"""Unit tests for api.ella_unanswered_flagger_cron.

Mocks the supabase client + shared.slack_post.post_message. No real
DB / Slack. The fake pending_digest_items select genuinely applies the
`unanswered_posted_at IS NULL` + [2h, 7d] window filters so the
ignored-by-query cases (too new / too old / already posted) are real
assertions, not no-ops."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from typing import Any

import pytest

from api import ella_unanswered_flagger_cron as cron


def _iso(dt: datetime) -> str:
    return dt.isoformat()


_NOW = datetime.now(timezone.utc)


class _Chain:
    def __init__(self, table, fake):
        self.table = table
        self.fake = fake
        self._mode = None
        self._payload: Any = None
        self._is_null: set[str] = set()
        self._lte: tuple[str, Any] | None = None
        self._gte: tuple[str, Any] | None = None
        self._gt: tuple[str, Any] | None = None
        self._eq: dict[str, Any] = {}
        self._limit: int | None = None

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

    def eq(self, col, val):
        self._eq[col] = val
        return self

    def gt(self, col, val):
        self._gt = (col, val)
        return self

    def gte(self, col, val):
        self._gte = (col, val)
        return self

    def lte(self, col, val):
        self._lte = (col, val)
        return self

    def is_(self, col, _val):
        self._is_null.add(col)
        return self

    def in_(self, col, vals):
        self._eq[col] = ("in", set(vals))
        return self

    def order(self, *_a, **_kw):
        return self

    def limit(self, n):
        self._limit = n
        return self

    def execute(self):
        t, m = self.table, self._mode
        if m == "select" and t == "pending_digest_items":
            rows = []
            for r in self.fake.items:
                if "unanswered_posted_at" in self._is_null and r.get(
                    "unanswered_posted_at"
                ):
                    continue
                ca = r["created_at"]
                if self._lte and ca > self._lte[1]:
                    continue
                if self._gte and ca < self._gte[1]:
                    continue
                rows.append(r)
            rows.sort(key=lambda x: x["created_at"])
            if self._limit is not None:
                rows = rows[: self._limit]
            return SimpleNamespace(data=rows)
        if m == "select" and t == "slack_messages":
            ch = self._eq.get("slack_channel_id")
            author = self._eq.get("author_type")
            after = self._gt[1] if self._gt else None
            # Two query shapes hit this table:
            #   - _has_human_intervention: eq channel + eq
            #     author_type='team_member' + gt sent_at; returns up to 1.
            #   - _filter_to_client_authored: eq channel + in_ slack_ts;
            #     returns rows projected to (channel, ts, author_type).
            slack_ts_filter = self._eq.get("slack_ts")
            if isinstance(slack_ts_filter, tuple) and slack_ts_filter[0] == "in":
                wanted_tses = slack_ts_filter[1]
                hits = [
                    msg
                    for msg in self.fake.slack_messages
                    if msg["slack_channel_id"] == ch
                    and msg.get("slack_ts") in wanted_tses
                ]
                return SimpleNamespace(data=hits)
            hits = [
                msg
                for msg in self.fake.slack_messages
                if msg["slack_channel_id"] == ch
                and msg["author_type"] == author
                and (after is None or msg["sent_at"] > after)
            ]
            return SimpleNamespace(data=hits[:1])
        if m == "select" and t == "clients":
            want = self._eq.get("id")
            ids = want[1] if isinstance(want, tuple) else None
            data = [c for c in self.fake.clients if ids is None or c["id"] in ids]
            return SimpleNamespace(data=data)
        if m == "select" and t == "team_members":
            return SimpleNamespace(data=self.fake.team_members)
        if m == "update" and t == "pending_digest_items":
            self.fake.item_updates.append(
                {"id": self._eq.get("id"), "payload": self._payload}
            )
            return SimpleNamespace(data=[{}])
        if m == "insert" and t == "webhook_deliveries":
            self.fake.audit_inserts.append(self._payload)
            return SimpleNamespace(data=[self._payload])
        raise AssertionError(f"unexpected execute table={t} mode={m}")


class _FakeDb:
    def __init__(self):
        self.items: list[dict] = []
        self.slack_messages: list[dict] = []
        self.clients: list[dict] = []
        self.team_members: list[dict] = []
        self.item_updates: list[dict] = []
        self.audit_inserts: list[dict] = []

    def table(self, name):
        return _Chain(name, self)


@pytest.fixture
def fake_db(monkeypatch):
    db = _FakeDb()
    monkeypatch.setattr("api.ella_unanswered_flagger_cron.get_client", lambda: db)
    return db


@pytest.fixture(autouse=True)
def _channel_set(monkeypatch):
    monkeypatch.setenv("ELLA_UNANSWERED_CHANNEL_SLACK_ID", "C_UNANSWERED")
    monkeypatch.delenv("ELLA_UNANSWERED_FLAGGER_ENABLED", raising=False)


@pytest.fixture
def slack_calls(monkeypatch):
    calls: list[tuple[str, str]] = []

    def _post(channel, text, **kw):
        calls.append((channel, text))
        return {"ok": True, "slack_error": None, "ts": "1745.0001"}

    monkeypatch.setattr("api.ella_unanswered_flagger_cron.post_message", _post)
    return calls


def _item(
    item_id="dg-1",
    client_id="cli-1",
    channel="C1",
    age=timedelta(hours=3),
    posted=False,
):
    return {
        "id": item_id,
        "client_id": client_id,
        "slack_channel_id": channel,
        "triggering_message_ts": "1745500100.000100",
        "message_text": "Where's my booking link? It's been a while.",
        "haiku_decision": "acknowledge_and_escalate",
        "haiku_reasoning": "client asking for booking link, no advisor in thread",
        "digest_category": "question_program",
        "ella_responded": False,
        "unanswered_posted_at": _iso(_NOW) if posted else None,
        "created_at": _iso(_NOW - age),
    }


def _client(cid="cli-1", name="Acme Co", advisor="U_ADVISOR"):
    assignments = []
    if advisor is not None:
        assignments = [
            {
                "role": "primary_csm",
                "unassigned_at": None,
                "team_members": {"slack_user_id": advisor},
            }
        ]
    return {
        "id": cid,
        "full_name": name,
        "client_team_assignments": assignments,
    }


def _scott(uid="U_SCOTT"):
    return {
        "slack_user_id": uid,
        "access_tier": "head_csm",
        "archived_at": None,
    }


def _backing_message(item: dict, author_type: str = "client") -> dict:
    """Seed a `slack_messages` row matching `item`'s
    (slack_channel_id, triggering_message_ts) with the given
    `author_type`. The post-2026-05-21 client-only filter in
    `_filter_to_client_authored` looks for this row; without it the
    candidate gets dropped pre-intervention-check."""
    return {
        "slack_channel_id": item["slack_channel_id"],
        "slack_ts": item["triggering_message_ts"],
        "author_type": author_type,
        # sent_at not consulted by the client-only filter (only the
        # intervention check reads sent_at). Set to anything past
        # epoch for completeness.
        "sent_at": item["created_at"],
    }


# ---------------------------------------------------------------------------


def test_happy_path_posts_and_marks(fake_db, slack_calls):
    item = _item()
    fake_db.items = [item]
    fake_db.slack_messages = [_backing_message(item)]
    fake_db.clients = [_client()]
    fake_db.team_members = [_scott()]

    result = cron.run_ella_unanswered_flagger_cron()

    assert result["status"] == "ok"
    assert result["checked"] == 1
    assert result["posted"] == 1
    assert result["resolved_before_post"] == 0
    assert len(slack_calls) == 1
    ch, body = slack_calls[0]
    assert ch == "C_UNANSWERED"
    assert "<@U_SCOTT>" in body and "<@U_ADVISOR>" in body
    assert "Acme Co" in body
    # Row stamped as posted (channel + ts non-null).
    upd = fake_db.item_updates[0]["payload"]
    assert upd["unanswered_posted_at"] is not None
    assert upd["unanswered_post_slack_channel_id"] == "C_UNANSWERED"
    assert upd["unanswered_post_slack_ts"] == "1745.0001"
    assert any(a["processing_status"] == "processed" for a in fake_db.audit_inserts)


def test_human_response_after_marks_resolved_no_post(fake_db, slack_calls):
    item = _item()
    fake_db.items = [item]
    fake_db.clients = [_client()]
    fake_db.team_members = [_scott()]
    fake_db.slack_messages = [
        # Seed the client-authored backing row so the candidate passes
        # the post-2026-05-21 client-only filter.
        _backing_message(item),
        # team_member follow-up message that the intervention check
        # detects.
        {
            "slack_channel_id": "C1",
            "slack_ts": "1745500200.000001",
            "author_type": "team_member",
            "sent_at": _iso(_NOW - timedelta(hours=1)),  # after created_at
        },
    ]

    result = cron.run_ella_unanswered_flagger_cron()

    assert result["resolved_before_post"] == 1
    assert result["posted"] == 0
    assert len(slack_calls) == 0
    upd = fake_db.item_updates[0]["payload"]
    assert upd["unanswered_posted_at"] is not None
    assert upd["unanswered_post_slack_channel_id"] is None
    assert upd["unanswered_post_slack_ts"] is None


def test_human_response_before_created_at_still_posts(fake_db, slack_calls):
    item = _item(age=timedelta(hours=3))
    fake_db.items = [item]
    fake_db.clients = [_client()]
    fake_db.team_members = [_scott()]
    # team_member message BEFORE the flagged message landed. The
    # backing client message lets the candidate pass the
    # post-2026-05-21 client-only filter.
    fake_db.slack_messages = [
        _backing_message(item),
        {
            "slack_channel_id": "C1",
            "slack_ts": "1745500050.000001",
            "author_type": "team_member",
            "sent_at": _iso(_NOW - timedelta(hours=5)),
        },
    ]

    result = cron.run_ella_unanswered_flagger_cron()
    assert result["posted"] == 1
    assert len(slack_calls) == 1


def test_item_under_2h_ignored(fake_db, slack_calls):
    fake_db.items = [_item(age=timedelta(minutes=30))]
    fake_db.clients = [_client()]
    fake_db.team_members = [_scott()]
    result = cron.run_ella_unanswered_flagger_cron()
    assert result["checked"] == 0
    assert result["posted"] == 0
    assert len(slack_calls) == 0


def test_item_already_posted_ignored(fake_db, slack_calls):
    fake_db.items = [_item(posted=True)]
    fake_db.clients = [_client()]
    fake_db.team_members = [_scott()]
    result = cron.run_ella_unanswered_flagger_cron()
    assert result["checked"] == 0
    assert len(slack_calls) == 0


def test_item_older_than_7d_ignored(fake_db, slack_calls):
    fake_db.items = [_item(age=timedelta(days=8))]
    fake_db.clients = [_client()]
    fake_db.team_members = [_scott()]
    result = cron.run_ella_unanswered_flagger_cron()
    assert result["checked"] == 0
    assert len(slack_calls) == 0


def test_kill_switch_off(fake_db, slack_calls, monkeypatch):
    monkeypatch.setenv("ELLA_UNANSWERED_FLAGGER_ENABLED", "false")
    fake_db.items = [_item()]
    result = cron.run_ella_unanswered_flagger_cron()
    assert result["status"] == "ok"
    assert result["disabled"] is True
    assert len(slack_calls) == 0
    assert any(a["payload"].get("disabled") for a in fake_db.audit_inserts)


def test_multiple_items_one_failure_isolated(fake_db, monkeypatch):
    items = [
        _item("dg-1", "cli-1", "C1"),
        _item("dg-2", "cli-2", "C2"),
        _item("dg-3", "cli-3", "C3"),
    ]
    fake_db.items = items
    fake_db.slack_messages = [_backing_message(i) for i in items]
    fake_db.clients = [
        _client("cli-1", "Acme", "U_A1"),
        _client("cli-2", "Beta", "U_A2"),
        _client("cli-3", "Gamma", "U_A3"),
    ]
    fake_db.team_members = [_scott()]

    def _post(channel, text, **kw):
        if "Beta" in text:
            return {"ok": False, "slack_error": "not_in_channel", "ts": None}
        return {"ok": True, "slack_error": None, "ts": "1.1"}

    monkeypatch.setattr("api.ella_unanswered_flagger_cron.post_message", _post)
    result = cron.run_ella_unanswered_flagger_cron()
    assert result["checked"] == 3
    assert result["posted"] == 2
    assert result["post_failures"] == 1
    # The two successes were stamped; the failure was not.
    assert len(fake_db.item_updates) == 2
    assert any(a["processing_status"] == "failed" for a in fake_db.audit_inserts)


def test_scott_is_primary_advisor_dedup(fake_db, slack_calls):
    item = _item()
    fake_db.items = [item]
    fake_db.slack_messages = [_backing_message(item)]
    fake_db.clients = [_client(advisor="U_SCOTT")]  # advisor == Scott
    fake_db.team_members = [_scott("U_SCOTT")]
    cron.run_ella_unanswered_flagger_cron()
    body = slack_calls[0][1]
    assert body.count("<@U_SCOTT>") == 1


def test_no_primary_advisor_only_scott(fake_db, slack_calls):
    item = _item()
    fake_db.items = [item]
    fake_db.slack_messages = [_backing_message(item)]
    fake_db.clients = [_client(advisor=None)]
    fake_db.team_members = [_scott()]
    cron.run_ella_unanswered_flagger_cron()
    body = slack_calls[0][1]
    assert "<@U_SCOTT>" in body
    assert "<@U_ADVISOR>" not in body


def test_no_scott_posts_without_scott_mention(fake_db, slack_calls):
    item = _item()
    fake_db.items = [item]
    fake_db.slack_messages = [_backing_message(item)]
    fake_db.clients = [_client(advisor="U_ADVISOR")]
    fake_db.team_members = []  # zero head_csm
    result = cron.run_ella_unanswered_flagger_cron()
    assert result["posted"] == 1
    body = slack_calls[0][1]
    assert "<@U_ADVISOR>" in body
    assert "<@U_SCOTT>" not in body


def test_channel_unset_500_and_audit(fake_db, monkeypatch):
    monkeypatch.delenv("ELLA_UNANSWERED_CHANNEL_SLACK_ID", raising=False)
    fake_db.items = [_item()]
    result = cron.run_ella_unanswered_flagger_cron()
    assert result["status"] == "failed"
    assert "ELLA_UNANSWERED_CHANNEL_SLACK_ID" in result["error"]
    assert any(
        a["processing_status"] == "failed" and a["payload"].get("config_gap")
        for a in fake_db.audit_inserts
    )


def test_auth_rejects_bad_secret(monkeypatch):
    monkeypatch.setenv("CRON_SECRET", "right")
    h = SimpleNamespace(get=lambda k, d=None: "Bearer wrong")
    assert cron._verify_auth(h) is False
    h2 = SimpleNamespace(get=lambda k, d=None: "Bearer right")
    assert cron._verify_auth(h2) is True
    h3 = SimpleNamespace(get=lambda k, d=None: "")
    assert cron._verify_auth(h3) is False


def test_auth_no_secret_configured_rejects(monkeypatch):
    monkeypatch.delenv("CRON_SECRET", raising=False)
    h = SimpleNamespace(get=lambda k, d=None: "Bearer anything")
    assert cron._verify_auth(h) is False


def test_no_candidates_clean_exit(fake_db, slack_calls):
    fake_db.items = []
    result = cron.run_ella_unanswered_flagger_cron()
    assert result["status"] == "ok"
    assert result["checked"] == 0
    assert result["posted"] == 0
    assert len(slack_calls) == 0


# ---------------------------------------------------------------------------
# Client-only filter (post-2026-05-21 — see
# docs/specs/ella-unanswered-flagger-client-only-and-terse-post.md)
# ---------------------------------------------------------------------------


def test_filter_drops_team_member_authored_candidates(fake_db, slack_calls):
    """The primary bug fix: a team_member's question that doesn't get
    a follow-up within 2h should NOT be flagged to #unanswered-channels.
    Only client-authored messages should surface there."""
    client_item = _item("dg-client", "cli-1", "C1")
    team_item = _item("dg-team", "cli-1", "C1")
    team_item["triggering_message_ts"] = "1745500200.000200"
    fake_db.items = [client_item, team_item]
    fake_db.slack_messages = [
        _backing_message(client_item, author_type="client"),
        _backing_message(team_item, author_type="team_member"),
    ]
    fake_db.clients = [_client()]
    fake_db.team_members = [_scott()]

    result = cron.run_ella_unanswered_flagger_cron()

    assert result["checked"] == 1  # only the client-authored row survived the filter
    assert result["posted"] == 1
    assert len(slack_calls) == 1
    # The surviving item is the client-authored one.
    upd = fake_db.item_updates[0]
    assert upd["id"] == "dg-client"


def test_filter_drops_bot_authored_candidates(fake_db, slack_calls):
    """Side benefit of the client-only filter: the open
    `author_type='bot'` known issue (Ella's posts misclassifying as
    bot) is also handled. Bot-tagged candidates fail the
    `== 'client'` check and never get flagged. Pins this defensive
    behavior so a future relaxation of the filter doesn't accidentally
    surface Ella's own posts as 'unanswered'."""
    item = _item()
    fake_db.items = [item]
    fake_db.slack_messages = [_backing_message(item, author_type="bot")]
    fake_db.clients = [_client()]
    fake_db.team_members = [_scott()]

    result = cron.run_ella_unanswered_flagger_cron()

    assert result["checked"] == 0
    assert result["posted"] == 0
    assert len(slack_calls) == 0


def test_filter_drops_candidate_with_missing_backing_slack_messages_row(
    fake_db, slack_calls
):
    """A digest item whose source slack_messages row doesn't exist is
    treated as NOT client-authored and filtered out. Defensive: the
    cron is a safety net, not a backstop for ingestion gaps. Could
    happen during a partial-failure window in the realtime pipeline."""
    item = _item()
    fake_db.items = [item]
    # Intentionally NO backing slack_messages row.
    fake_db.slack_messages = []
    fake_db.clients = [_client()]
    fake_db.team_members = [_scott()]

    result = cron.run_ella_unanswered_flagger_cron()

    assert result["checked"] == 0
    assert result["posted"] == 0
    assert len(slack_calls) == 0


def test_filter_skips_channel_on_author_lookup_failure(
    fake_db, slack_calls, monkeypatch
):
    """If the per-channel author_type lookup raises, all candidates in
    that channel are skipped THIS tick (better to under-flag than
    over-flag during a transient DB blip). Candidates in OTHER
    channels in the same tick still process normally — failure
    isolation per channel, not whole-tick."""
    good_item = _item("dg-good", "cli-1", "C_GOOD")
    bad_item = _item("dg-bad", "cli-2", "C_BAD")
    fake_db.items = [good_item, bad_item]
    fake_db.slack_messages = [
        _backing_message(good_item),
        _backing_message(bad_item),
    ]
    fake_db.clients = [
        _client("cli-1", "GoodCo"),
        _client("cli-2", "BadCo"),
    ]
    fake_db.team_members = [_scott()]

    # Monkeypatch the table() factory to raise selectively for the
    # bad channel's slack_messages lookup. Wrap the original.
    original_table = fake_db.table

    def _selective_table(name):
        chain = original_table(name)
        original_execute = chain.execute

        def _maybe_raise():
            if (
                name == "slack_messages"
                and chain._eq.get("slack_channel_id") == "C_BAD"
                and isinstance(chain._eq.get("slack_ts"), tuple)
            ):
                raise RuntimeError("transient DB blip on this channel")
            return original_execute()

        chain.execute = _maybe_raise
        return chain

    monkeypatch.setattr(fake_db, "table", _selective_table)

    result = cron.run_ella_unanswered_flagger_cron()

    # Only the good-channel candidate survived — bad-channel one was
    # filtered out due to the lookup failure (missing key in
    # author_types dict → False on the `== 'client'` check).
    assert result["checked"] == 1
    assert result["posted"] == 1


# ---------------------------------------------------------------------------
# Terse channel-post format (post-2026-05-21)
# ---------------------------------------------------------------------------


def test_format_terse_one_line_happy_path():
    """The new format is one line: mentions + 'unanswered in
    {client}'s channel ({time_ago}): {permalink}'."""
    row = {
        "slack_channel_id": "C1",
        "triggering_message_ts": "1745500100.000100",
        "created_at": _iso(_NOW - timedelta(hours=3)),
    }
    body = cron._format_channel_post(
        row,
        client_name="Acme Co",
        mention_ids=["U_SCOTT", "U_ADVISOR"],
    )

    # One line, no newlines.
    assert "\n" not in body
    # Mentions at the start.
    assert body.startswith("<@U_SCOTT> <@U_ADVISOR> ")
    # Anchor copy.
    assert "unanswered in Acme Co's channel" in body
    # Time-ago in parens.
    assert "(3h ago)" in body
    # Permalink trailing.
    assert "slack.com/archives/C1/p1745500100000100" in body


def test_format_terse_drops_legacy_fields():
    """Documents removal: snippet, category, reasoning, alert-bell
    prefix, posted-by line are all gone."""
    row = {
        "slack_channel_id": "C1",
        "triggering_message_ts": "1745500100.000100",
        "message_text": "Where is the booking link?",
        "digest_category": "question_program",
        "haiku_reasoning": "client asking for booking link",
        "created_at": _iso(_NOW - timedelta(hours=2)),
    }
    body = cron._format_channel_post(row, "Acme Co", ["U_SCOTT"])

    # None of the V1 multi-line fields appear.
    assert "🔔" not in body and ":bell:" not in body
    assert "Ella's read" not in body
    assert "Posted:" not in body
    assert "this message has been sitting" not in body
    # Snippet and reasoning text don't leak into the channel post.
    assert "Where is the booking link" not in body
    assert "question_program" not in body
    assert "client asking for booking link" not in body


def test_format_no_mentions_renders_without_leading_prefix():
    """Zero mentions → no leading prefix, no orphan space."""
    row = {
        "slack_channel_id": "C1",
        "triggering_message_ts": "1745500100.000100",
        "created_at": _iso(_NOW - timedelta(hours=2)),
    }
    body = cron._format_channel_post(row, "Acme Co", mention_ids=[])
    assert not body.startswith(" ")
    assert body.startswith("unanswered in Acme Co's channel")


def test_format_missing_client_name_renders_unknown():
    row = {
        "slack_channel_id": "C1",
        "triggering_message_ts": "1745500100.000100",
        "created_at": _iso(_NOW - timedelta(hours=2)),
    }
    body = cron._format_channel_post(row, client_name=None, mention_ids=["U_X"])
    assert "(unknown client)'s channel" in body


def test_format_missing_permalink_inputs_renders_degenerate_url():
    """Missing channel/ts → permalink builder returns an empty-channel
    URL with no ts. The format still renders one clean line (no
    crash, no orphan whitespace). Operationally fine — the row was
    malformed enough that we wouldn't expect a real permalink."""
    row = {
        "created_at": _iso(_NOW - timedelta(hours=2)),
        # No slack_channel_id, no triggering_message_ts
    }
    body = cron._format_channel_post(row, "Acme Co", ["U_X"])
    assert "\n" not in body
    assert body.endswith("https://slack.com/archives//p")
    assert ": https://" in body  # single space after colon, no double-space
