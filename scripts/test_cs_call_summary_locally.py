"""Local test loop for agents/gregory/cs_call_summary_post.py.

Mocks Slack at `shared.slack_post.post_message` (so no real chat.postMessage
fires) and seeds a synthetic test client with a known primary_csm + slack
channel mapping. Exercises:

  1. Happy path — client call with summary text → 200 ok, audit row
     processed, message text matches the expected format with the right
     CSM + client + summary + deep link.
  2. Non-client category — internal/external call → silent skip, no
     audit row.
  3. No summary text — client call but empty summary → audit row
     marked malformed, no Slack post attempted.
  4. Channel env var missing — returns failed result without raising,
     audit row marked failed.
  5. Slack returns ok=false — audit row marked failed; pipeline doesn't
     raise.
  6. Sentinel labels — primary_csm None + client_name None → message
     renders [unassigned] / [unknown client].
  7. Review-found populated — call_review document with all four
     sections populated → review-shaped message posted, content_source
     audit field set to 'call_review', `markdown_to_mrkdwn` cleanup
     pass produces mrkdwn (no `**` or `###` in output).
  8. Review-found empty arrays — call_review with sentiment_arc only
     and empty pain/wins/dodged → message contains only the Sentiment
     section + header + deeplink. Empty sections omitted.
  9. Review-found malformed JSON — call_review row exists but content
     isn't parseable → fallback path, content_source='fathom_summary_fallback'.
 10. Review missing — no call_review row for the external_id → fallback
     path, content_source='fathom_summary_fallback'.
 11. Cleanup-pass safety net — fallback summary contains raw `###`
     headers and `**bold**` Markdown → `markdown_to_mrkdwn` strips
     them so neither `###` nor `**` appears in the posted text.

Self-seeded fixture per the M5.9 pattern: per-run unique email,
hard-deleted in cleanup.
"""

from __future__ import annotations

import os
import sys
import traceback
import uuid
from pathlib import Path
from unittest.mock import patch

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

from agents.gregory.cs_call_summary_post import (  # noqa: E402
    maybe_post_cs_call_summary,
)
from shared.db import get_client  # noqa: E402

RUN_TOKEN = uuid.uuid4().hex[:10]
TEST_CLIENT_EMAIL = f"cs-summary-test-{RUN_TOKEN}@nowhere.invalid"
TEST_CSM_NAME = "Test CSM"


def _pg_conn():
    """Direct psycopg2 connection mirroring the existing harness pattern."""
    import psycopg2
    from urllib.parse import quote
    from dotenv import load_dotenv

    load_dotenv(".env.local")
    with open(_REPO / "supabase/.temp/pooler-url") as f:
        pooler = f.read().strip()
    pw = os.environ["SUPABASE_DB_PASSWORD"]
    at = pooler.index("@")
    dsn = f"{pooler[:at]}:{quote(pw, safe='')}{pooler[at:]}"
    return psycopg2.connect(dsn, connect_timeout=15)


# ---------------------------------------------------------------------------
# Self-seeded fixture
# ---------------------------------------------------------------------------


_FIXTURE_CLIENT_ID: str | None = None
_FIXTURE_CSM_ID: str | None = None
_FIXTURE_ASSIGNMENT_ID: str | None = None
_AUDIT_DELIVERY_IDS: list[str] = []
_SEEDED_DOC_IDS: list[str] = []


def _seed_fixture() -> None:
    """Insert a fresh test client + assign a synthetic CSM via
    client_team_assignments. Hard-deleted in teardown."""
    global _FIXTURE_CLIENT_ID, _FIXTURE_CSM_ID, _FIXTURE_ASSIGNMENT_ID
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO clients (
              full_name, email, status, csm_standing, tags, metadata
            ) VALUES (%s, %s, 'active', 'content', '{}'::text[],
              jsonb_build_object('seeded_by', 'test_cs_call_summary_locally'))
            RETURNING id;
            """,
            (f"CS Summary Test {RUN_TOKEN}", TEST_CLIENT_EMAIL),
        )
        _FIXTURE_CLIENT_ID = str(cur.fetchone()[0])

        # Synthetic CSM team_member. is_csm=true so it parallels real CSMs.
        cur.execute(
            """
            INSERT INTO team_members (
              email, full_name, role, is_active, is_csm, metadata
            ) VALUES (%s, %s, 'csm', true, true,
              jsonb_build_object('seeded_by', 'test_cs_call_summary_locally'))
            RETURNING id;
            """,
            (
                f"cs-summary-csm-{RUN_TOKEN}@theaipartner.io",
                TEST_CSM_NAME,
            ),
        )
        _FIXTURE_CSM_ID = str(cur.fetchone()[0])

        cur.execute(
            """
            INSERT INTO client_team_assignments (
              client_id, team_member_id, role, assigned_at
            ) VALUES (%s, %s, 'primary_csm', now())
            RETURNING id;
            """,
            (_FIXTURE_CLIENT_ID, _FIXTURE_CSM_ID),
        )
        _FIXTURE_ASSIGNMENT_ID = str(cur.fetchone()[0])
        conn.commit()
    finally:
        conn.close()


def _seed_review_document(
    *,
    external_id: str,
    content: str,
    metadata: dict | None = None,
) -> str:
    """Insert a documents row carrying a synthetic call_review.

    `content` is taken verbatim — pass valid JSON for review-shape tests
    or a deliberately broken string for the malformed-JSON test. Returns
    the documents.id; tracked in `_SEEDED_DOC_IDS` for teardown.
    """
    import json
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        md = metadata or {
            "client_id": _FIXTURE_CLIENT_ID,
            "call_id": "00000000-0000-0000-0000-000000000777",
            "call_category": "client",
            "started_at": "2026-05-01T12:00:00+00:00",
            "prompt_version": "v1",
            "model": "claude-sonnet-4-6",
        }
        cur.execute(
            """
            INSERT INTO documents (
              source, external_id, title, content, document_type,
              metadata, is_active
            ) VALUES (
              'fathom', %s, %s, %s, 'call_review', %s::jsonb, false
            )
            RETURNING id;
            """,
            (
                external_id,
                f"Test review {external_id}",
                content,
                json.dumps(md),
            ),
        )
        doc_id = str(cur.fetchone()[0])
        conn.commit()
        _SEEDED_DOC_IDS.append(doc_id)
        return doc_id
    finally:
        conn.close()


def _teardown_fixture() -> None:
    """Hard-delete fixture rows + any audit rows we wrote."""
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        for doc_id in _SEEDED_DOC_IDS:
            cur.execute(
                "DELETE FROM documents WHERE id = %s",
                (doc_id,),
            )
        for delivery_id in _AUDIT_DELIVERY_IDS:
            cur.execute(
                "DELETE FROM webhook_deliveries WHERE webhook_id = %s",
                (delivery_id,),
            )
        if _FIXTURE_ASSIGNMENT_ID:
            cur.execute(
                "DELETE FROM client_team_assignments WHERE id = %s",
                (_FIXTURE_ASSIGNMENT_ID,),
            )
        if _FIXTURE_CLIENT_ID:
            cur.execute(
                "DELETE FROM client_status_history WHERE client_id = %s",
                (_FIXTURE_CLIENT_ID,),
            )
            cur.execute(
                "DELETE FROM client_standing_history WHERE client_id = %s",
                (_FIXTURE_CLIENT_ID,),
            )
            cur.execute(
                "DELETE FROM clients WHERE id = %s", (_FIXTURE_CLIENT_ID,)
            )
        if _FIXTURE_CSM_ID:
            cur.execute(
                "DELETE FROM team_members WHERE id = %s", (_FIXTURE_CSM_ID,)
            )
        conn.commit()
    finally:
        conn.close()


def _delivery_status(delivery_id: str) -> dict | None:
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT webhook_id, source, processing_status, processing_error,
                   call_external_id, payload
            FROM webhook_deliveries WHERE webhook_id = %s;
            """,
            (delivery_id,),
        )
        row = cur.fetchone()
        if not row:
            return None
        return {
            "webhook_id": row[0],
            "source": row[1],
            "processing_status": row[2],
            "processing_error": row[3],
            "call_external_id": row[4],
            "payload": row[5],
        }
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Test cases
# ---------------------------------------------------------------------------


_RESULTS: list[tuple[str, bool, str]] = []


def _check(name: str, condition: bool, detail: str) -> None:
    _RESULTS.append((name, condition, detail))
    marker = "✅" if condition else "❌"
    print(f"  {marker} {name}: {detail}")


def test_1_happy_path() -> None:
    print("\n[1] Happy path — client call + summary → posted, audit row processed")
    if _FIXTURE_CLIENT_ID is None:
        _check("1.skipped", False, "no fixture")
        return

    db = get_client()
    captured = {}

    def fake_post(channel_id, text, **kwargs):
        captured["channel_id"] = channel_id
        captured["text"] = text
        captured["kwargs"] = kwargs
        return {"ok": True, "slack_error": None}

    os.environ["SLACK_CS_CALL_SUMMARIES_CHANNEL_ID"] = "C_TEST_CHANNEL_HAPPY"

    with patch(
        "agents.gregory.cs_call_summary_post.post_message",
        side_effect=fake_post,
    ):
        result = maybe_post_cs_call_summary(
            db,
            call_id="00000000-0000-0000-0000-000000000001",
            call_category="client",
            primary_client_id=_FIXTURE_CLIENT_ID,
            summary_text="Client wants to launch next month. Three blockers: payment, asset review, GHL setup.",
            fathom_external_id=f"fathom-test-{RUN_TOKEN}",
        )

    _AUDIT_DELIVERY_IDS.append(result["delivery_id"])
    _check("1.posted", result["posted"] is True, f"posted={result['posted']}")
    _check("1.slack_ok", result["slack_ok"] is True, f"slack_ok={result['slack_ok']}")
    _check(
        "1.channel",
        captured.get("channel_id") == "C_TEST_CHANNEL_HAPPY",
        f"channel_id={captured.get('channel_id')!r}",
    )
    text = captured.get("text") or ""
    _check("1.text.csm_name", TEST_CSM_NAME in text, f"missing CSM name in text")
    _check(
        "1.text.client_name",
        f"CS Summary Test {RUN_TOKEN}" in text,
        "missing client name",
    )
    _check(
        "1.text.summary",
        "launch next month" in text,
        "missing summary text",
    )
    _check(
        "1.text.deep_link",
        "<https://ai-enablement-sigma.vercel.app/calls/00000000-0000-0000-0000-000000000001|View in Gregory>"
        in text,
        f"missing deep link in text",
    )

    delivery = _delivery_status(result["delivery_id"])
    _check(
        "1.audit.row",
        delivery is not None
        and delivery["processing_status"] == "processed",
        f"audit={delivery}",
    )
    _check(
        "1.audit.source",
        delivery is not None and delivery["source"] == "cs_call_summary_slack_post",
        f"source={delivery['source'] if delivery else None}",
    )


def test_2_non_client_category() -> None:
    print("\n[2] Non-client category → silent skip, no audit row")
    db = get_client()
    with patch(
        "agents.gregory.cs_call_summary_post.post_message"
    ) as mock_post:
        result = maybe_post_cs_call_summary(
            db,
            call_id="00000000-0000-0000-0000-000000000002",
            call_category="internal",
            primary_client_id=None,
            summary_text="some summary",
            fathom_external_id=f"fathom-internal-{RUN_TOKEN}",
        )
    _check("2.posted", result["posted"] is False, f"posted={result['posted']}")
    _check(
        "2.skipped_reason",
        result["skipped_reason"] == "non_client_category",
        f"skipped_reason={result['skipped_reason']!r}",
    )
    _check(
        "2.slack_not_called",
        not mock_post.called,
        f"called={mock_post.called}",
    )

    delivery = _delivery_status(result["delivery_id"])
    _check(
        "2.no_audit_row",
        delivery is None,
        f"unexpected audit row={delivery}",
    )


def test_3_no_summary_text() -> None:
    print("\n[3] Client call but no summary → audit row malformed, no Slack call")
    db = get_client()
    with patch(
        "agents.gregory.cs_call_summary_post.post_message"
    ) as mock_post:
        result = maybe_post_cs_call_summary(
            db,
            call_id="00000000-0000-0000-0000-000000000003",
            call_category="client",
            primary_client_id=_FIXTURE_CLIENT_ID,
            summary_text="",
            fathom_external_id=f"fathom-no-summary-{RUN_TOKEN}",
        )
    _AUDIT_DELIVERY_IDS.append(result["delivery_id"])
    _check("3.posted", result["posted"] is False, f"posted={result['posted']}")
    _check(
        "3.skipped_reason",
        result["skipped_reason"] == "no_summary_text",
        f"skipped_reason={result['skipped_reason']!r}",
    )
    _check(
        "3.slack_not_called",
        not mock_post.called,
        f"called={mock_post.called}",
    )

    delivery = _delivery_status(result["delivery_id"])
    _check(
        "3.audit_malformed",
        delivery is not None and delivery["processing_status"] == "malformed",
        f"audit={delivery}",
    )


def test_4_channel_env_missing() -> None:
    print("\n[4] Channel env var missing → failed result, no Slack call")
    db = get_client()
    saved = os.environ.pop("SLACK_CS_CALL_SUMMARIES_CHANNEL_ID", None)
    try:
        with patch(
            "agents.gregory.cs_call_summary_post.post_message"
        ) as mock_post:
            result = maybe_post_cs_call_summary(
                db,
                call_id="00000000-0000-0000-0000-000000000004",
                call_category="client",
                primary_client_id=_FIXTURE_CLIENT_ID,
                summary_text="Some summary",
                fathom_external_id=f"fathom-no-chan-{RUN_TOKEN}",
            )
        _AUDIT_DELIVERY_IDS.append(result["delivery_id"])
        _check("4.posted", result["posted"] is False, f"posted={result['posted']}")
        _check(
            "4.skipped_reason",
            result["skipped_reason"] == "channel_not_configured",
            f"skipped_reason={result['skipped_reason']!r}",
        )
        _check(
            "4.slack_not_called",
            not mock_post.called,
            f"called={mock_post.called}",
        )

        delivery = _delivery_status(result["delivery_id"])
        _check(
            "4.audit_failed",
            delivery is not None and delivery["processing_status"] == "failed",
            f"audit={delivery}",
        )
    finally:
        if saved:
            os.environ["SLACK_CS_CALL_SUMMARIES_CHANNEL_ID"] = saved


def test_5_slack_ok_false() -> None:
    print("\n[5] Slack returns ok=false → audit row failed, no exception")
    db = get_client()
    os.environ["SLACK_CS_CALL_SUMMARIES_CHANNEL_ID"] = "C_TEST_CHANNEL_FAIL"
    with patch(
        "agents.gregory.cs_call_summary_post.post_message",
        return_value={"ok": False, "slack_error": "channel_not_found"},
    ):
        result = maybe_post_cs_call_summary(
            db,
            call_id="00000000-0000-0000-0000-000000000005",
            call_category="client",
            primary_client_id=_FIXTURE_CLIENT_ID,
            summary_text="Some summary text",
            fathom_external_id=f"fathom-okfalse-{RUN_TOKEN}",
        )
    _AUDIT_DELIVERY_IDS.append(result["delivery_id"])
    _check("5.posted", result["posted"] is False, f"posted={result['posted']}")
    _check(
        "5.skipped_reason",
        result["skipped_reason"] == "slack_post_failed",
        f"skipped_reason={result['skipped_reason']!r}",
    )
    _check(
        "5.slack_error",
        result["slack_error"] == "channel_not_found",
        f"slack_error={result['slack_error']!r}",
    )

    delivery = _delivery_status(result["delivery_id"])
    _check(
        "5.audit_failed",
        delivery is not None and delivery["processing_status"] == "failed",
        f"audit={delivery}",
    )


def test_6_sentinel_labels() -> None:
    print("\n[6] No primary_csm + missing client → [unassigned] / [unknown client]")
    db = get_client()
    captured_text = {}
    os.environ["SLACK_CS_CALL_SUMMARIES_CHANNEL_ID"] = "C_TEST_CHANNEL_SENTINEL"

    def fake_post(channel_id, text, **kwargs):
        captured_text["text"] = text
        return {"ok": True, "slack_error": None}

    # Use a UUID that doesn't match any client → client lookup returns
    # None → "[unknown client]" sentinel. Since there's no client, the
    # CSM lookup also returns None → "[unassigned]" sentinel.
    bogus_client_id = "00000000-0000-0000-0000-deadbeef0000"

    with patch(
        "agents.gregory.cs_call_summary_post.post_message",
        side_effect=fake_post,
    ):
        result = maybe_post_cs_call_summary(
            db,
            call_id="00000000-0000-0000-0000-000000000006",
            call_category="client",
            primary_client_id=bogus_client_id,
            summary_text="A summary",
            fathom_external_id=f"fathom-sentinel-{RUN_TOKEN}",
        )
    _AUDIT_DELIVERY_IDS.append(result["delivery_id"])
    _check("6.posted", result["posted"] is True, f"posted={result['posted']}")
    text = captured_text.get("text") or ""
    _check(
        "6.unassigned_label",
        "[unassigned]" in text,
        f"missing [unassigned] in text",
    )
    _check(
        "6.unknown_client_label",
        "[unknown client]" in text,
        f"missing [unknown client] in text",
    )


def test_7_review_found_populated() -> None:
    print("\n[7] Review found, all sections populated → review-shaped message")
    if _FIXTURE_CLIENT_ID is None:
        _check("7.skipped", False, "no fixture")
        return

    import json
    ext_id = f"fathom-review-full-{RUN_TOKEN}"
    review = {
        "pain_points": [
            {
                "description": "GHL setup is blocking launch",
                "evidence": "We can't get the funnel published",
            }
        ],
        "wins": [
            {
                "description": "Closed first paying client",
                "evidence": "Just signed Acme yesterday",
            }
        ],
        "dodged_questions": [
            {
                "description": "Sidestepped the revenue question",
                "who": "client",
                "evidence": "Pivoted to talking about marketing",
            }
        ],
        "sentiment_arc": "Started anxious; ended energized after we mapped next steps.",
    }
    _seed_review_document(external_id=ext_id, content=json.dumps(review))

    db = get_client()
    captured = {}
    os.environ["SLACK_CS_CALL_SUMMARIES_CHANNEL_ID"] = "C_TEST_CHANNEL_REVIEW"

    def fake_post(channel_id, text, **kwargs):
        captured["text"] = text
        return {"ok": True, "slack_error": None}

    with patch(
        "agents.gregory.cs_call_summary_post.post_message",
        side_effect=fake_post,
    ):
        result = maybe_post_cs_call_summary(
            db,
            call_id="00000000-0000-0000-0000-000000000007",
            call_category="client",
            primary_client_id=_FIXTURE_CLIENT_ID,
            summary_text="(unused — review path takes over)",
            fathom_external_id=ext_id,
        )

    _AUDIT_DELIVERY_IDS.append(result["delivery_id"])
    _check("7.posted", result["posted"] is True, f"posted={result['posted']}")
    _check(
        "7.content_source",
        result["content_source"] == "call_review",
        f"content_source={result['content_source']!r}",
    )

    text = captured.get("text") or ""
    _check("7.text.sentiment_header", "*Sentiment*" in text, "missing *Sentiment* header")
    _check("7.text.pain_header", "*Pain points*" in text, "missing *Pain points* header")
    _check("7.text.wins_header", "*Wins*" in text, "missing *Wins* header")
    _check(
        "7.text.pivots_header",
        "*Conversation pivots*" in text,
        "missing *Conversation pivots* header",
    )
    _check(
        "7.text.evidence_italic",
        "_We can't get the funnel published_" in text,
        f"missing italic-wrapped evidence in text",
    )
    _check(
        "7.text.who_inline",
        "(who: client)" in text,
        "missing (who: client) inline marker on pivot",
    )
    _check(
        "7.text.no_double_star",
        "**" not in text,
        f"output still contains ** Markdown bold (converter didn't run)",
    )
    _check(
        "7.text.no_triple_hash",
        "###" not in text,
        f"output still contains ### Markdown header",
    )

    delivery = _delivery_status(result["delivery_id"])
    _check(
        "7.audit.content_source",
        delivery is not None
        and (delivery.get("payload") or {}).get("content_source") == "call_review",
        f"audit payload content_source mismatch: {delivery}",
    )


def test_8_review_found_empty_arrays() -> None:
    print("\n[8] Review found, only sentiment populated → only Sentiment section")
    if _FIXTURE_CLIENT_ID is None:
        _check("8.skipped", False, "no fixture")
        return

    import json
    ext_id = f"fathom-review-sparse-{RUN_TOKEN}"
    review = {
        "pain_points": [],
        "wins": [],
        "dodged_questions": [],
        "sentiment_arc": "Calm coasting call; nothing flagged either way.",
    }
    _seed_review_document(external_id=ext_id, content=json.dumps(review))

    db = get_client()
    captured = {}
    os.environ["SLACK_CS_CALL_SUMMARIES_CHANNEL_ID"] = "C_TEST_CHANNEL_SPARSE"

    def fake_post(channel_id, text, **kwargs):
        captured["text"] = text
        return {"ok": True, "slack_error": None}

    with patch(
        "agents.gregory.cs_call_summary_post.post_message",
        side_effect=fake_post,
    ):
        result = maybe_post_cs_call_summary(
            db,
            call_id="00000000-0000-0000-0000-000000000008",
            call_category="client",
            primary_client_id=_FIXTURE_CLIENT_ID,
            summary_text="(unused — review path takes over)",
            fathom_external_id=ext_id,
        )

    _AUDIT_DELIVERY_IDS.append(result["delivery_id"])
    _check("8.posted", result["posted"] is True, f"posted={result['posted']}")
    _check(
        "8.content_source",
        result["content_source"] == "call_review",
        f"content_source={result['content_source']!r}",
    )

    text = captured.get("text") or ""
    _check("8.has_sentiment", "*Sentiment*" in text, "missing *Sentiment* header")
    _check(
        "8.no_pain_header",
        "*Pain points*" not in text,
        "*Pain points* header rendered for empty array",
    )
    _check(
        "8.no_wins_header",
        "*Wins*" not in text,
        "*Wins* header rendered for empty array",
    )
    _check(
        "8.no_pivots_header",
        "*Conversation pivots*" not in text,
        "*Conversation pivots* header rendered for empty array",
    )


def test_9_review_malformed_json() -> None:
    print("\n[9] Review present but JSON malformed → fallback path")
    if _FIXTURE_CLIENT_ID is None:
        _check("9.skipped", False, "no fixture")
        return

    ext_id = f"fathom-review-malformed-{RUN_TOKEN}"
    _seed_review_document(external_id=ext_id, content="{ this is not valid json")

    db = get_client()
    captured = {}
    os.environ["SLACK_CS_CALL_SUMMARIES_CHANNEL_ID"] = "C_TEST_CHANNEL_MALFORMED"

    def fake_post(channel_id, text, **kwargs):
        captured["text"] = text
        return {"ok": True, "slack_error": None}

    with patch(
        "agents.gregory.cs_call_summary_post.post_message",
        side_effect=fake_post,
    ):
        result = maybe_post_cs_call_summary(
            db,
            call_id="00000000-0000-0000-0000-000000000009",
            call_category="client",
            primary_client_id=_FIXTURE_CLIENT_ID,
            summary_text="Fathom summary text used as fallback.",
            fathom_external_id=ext_id,
        )

    _AUDIT_DELIVERY_IDS.append(result["delivery_id"])
    _check("9.posted", result["posted"] is True, f"posted={result['posted']}")
    _check(
        "9.content_source",
        result["content_source"] == "fathom_summary_fallback",
        f"content_source={result['content_source']!r}",
    )

    text = captured.get("text") or ""
    _check(
        "9.fallback_text_present",
        "Fathom summary text used as fallback." in text,
        "fallback summary missing from text",
    )
    _check(
        "9.no_review_headers",
        "*Sentiment*" not in text and "*Pain points*" not in text,
        "review-shape headers rendered on fallback path",
    )

    delivery = _delivery_status(result["delivery_id"])
    _check(
        "9.audit.content_source",
        delivery is not None
        and (delivery.get("payload") or {}).get("content_source")
        == "fathom_summary_fallback",
        f"audit payload content_source mismatch: {delivery}",
    )


def test_10_review_missing() -> None:
    print("\n[10] No review row for external_id → fallback path")
    if _FIXTURE_CLIENT_ID is None:
        _check("10.skipped", False, "no fixture")
        return

    ext_id = f"fathom-review-absent-{RUN_TOKEN}"
    # Deliberately do NOT seed a documents row.

    db = get_client()
    captured = {}
    os.environ["SLACK_CS_CALL_SUMMARIES_CHANNEL_ID"] = "C_TEST_CHANNEL_ABSENT"

    def fake_post(channel_id, text, **kwargs):
        captured["text"] = text
        return {"ok": True, "slack_error": None}

    with patch(
        "agents.gregory.cs_call_summary_post.post_message",
        side_effect=fake_post,
    ):
        result = maybe_post_cs_call_summary(
            db,
            call_id="00000000-0000-0000-0000-00000000000a",
            call_category="client",
            primary_client_id=_FIXTURE_CLIENT_ID,
            summary_text="Original Fathom summary; the review never landed.",
            fathom_external_id=ext_id,
        )

    _AUDIT_DELIVERY_IDS.append(result["delivery_id"])
    _check("10.posted", result["posted"] is True, f"posted={result['posted']}")
    _check(
        "10.content_source",
        result["content_source"] == "fathom_summary_fallback",
        f"content_source={result['content_source']!r}",
    )

    text = captured.get("text") or ""
    _check(
        "10.fallback_summary",
        "Original Fathom summary" in text,
        "fallback summary missing",
    )

    delivery = _delivery_status(result["delivery_id"])
    _check(
        "10.audit.content_source",
        delivery is not None
        and (delivery.get("payload") or {}).get("content_source")
        == "fathom_summary_fallback",
        f"audit payload content_source mismatch: {delivery}",
    )


def test_11_mrkdwn_safety_net_on_fallback() -> None:
    print("\n[11] Fallback summary with `###` and `**bold**` → cleaned by mrkdwn pass")
    if _FIXTURE_CLIENT_ID is None:
        _check("11.skipped", False, "no fixture")
        return

    ext_id = f"fathom-mrkdwn-cleanup-{RUN_TOKEN}"
    raw_summary = (
        "### Summary\n"
        "Client wants to launch next month. Three blockers: payment, "
        "asset review, **GHL setup**.\n\n"
        "## Action items\n"
        "- Payment review by Friday\n"
    )

    db = get_client()
    captured = {}
    os.environ["SLACK_CS_CALL_SUMMARIES_CHANNEL_ID"] = "C_TEST_CHANNEL_CLEANUP"

    def fake_post(channel_id, text, **kwargs):
        captured["text"] = text
        return {"ok": True, "slack_error": None}

    with patch(
        "agents.gregory.cs_call_summary_post.post_message",
        side_effect=fake_post,
    ):
        result = maybe_post_cs_call_summary(
            db,
            call_id="00000000-0000-0000-0000-00000000000b",
            call_category="client",
            primary_client_id=_FIXTURE_CLIENT_ID,
            summary_text=raw_summary,
            fathom_external_id=ext_id,
        )

    _AUDIT_DELIVERY_IDS.append(result["delivery_id"])
    _check("11.posted", result["posted"] is True, f"posted={result['posted']}")
    text = captured.get("text") or ""
    _check(
        "11.no_triple_hash",
        "###" not in text,
        f"`###` survived the mrkdwn cleanup pass",
    )
    _check(
        "11.no_double_star",
        "**" not in text,
        "`**bold**` survived the mrkdwn cleanup pass",
    )
    _check(
        "11.bold_normalized",
        "*Summary*" in text,
        "expected `*Summary*` mrkdwn header after `### Summary` conversion",
    )
    _check(
        "11.inline_bold_normalized",
        "*GHL setup*" in text,
        "expected `*GHL setup*` mrkdwn after `**GHL setup**` conversion",
    )


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main() -> int:
    print("=" * 72)
    print("CS call summary post — local test harness")
    print(f"Run token: {RUN_TOKEN}")
    print("=" * 72)

    print("\nSeeding fixture client + CSM...")
    _seed_fixture()
    print(f"  client_id={_FIXTURE_CLIENT_ID} csm_id={_FIXTURE_CSM_ID}")

    try:
        test_1_happy_path()
        test_2_non_client_category()
        test_3_no_summary_text()
        test_4_channel_env_missing()
        test_5_slack_ok_false()
        test_6_sentinel_labels()
        test_7_review_found_populated()
        test_8_review_found_empty_arrays()
        test_9_review_malformed_json()
        test_10_review_missing()
        test_11_mrkdwn_safety_net_on_fallback()
    finally:
        print("\n" + "=" * 72)
        print("Cleanup")
        print("=" * 72)
        try:
            _teardown_fixture()
            print(
                f"  Hard-deleted fixture (client + csm + assignment), "
                f"{len(_SEEDED_DOC_IDS)} review doc(s), and "
                f"{len(_AUDIT_DELIVERY_IDS)} audit row(s)"
            )
        except Exception:
            traceback.print_exc()

    print("\n" + "=" * 72)
    passed = sum(1 for _, ok, _ in _RESULTS if ok)
    total = len(_RESULTS)
    print(f"Results: {passed}/{total} checks passed")
    failures = [name for name, ok, _ in _RESULTS if not ok]
    if failures:
        print(f"Failed: {failures}")
        return 1
    print("All checks green.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
