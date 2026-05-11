"""Local test loop for api/airtable_onboarding_webhook.py.

Stands up the real `handler` class in a background thread via
http.server.HTTPServer (same class Vercel instantiates in prod). Runs
14 paths covering the three branches (create / update / reactivate),
idempotency, the 4 required-field validations, optional-field omission
+ re-fire flow (5b/5c/5d — depend on migration 0026), type errors,
JSON parse, auth, and the 3 conflict cases. Mirrors
scripts/test_airtable_nps_webhook_locally.py.

Test fixtures:

  - All tests use per-run unique emails. No reliance on prod data.
  - 'created' tests use `onboarding-test-create-<token>@...`.
  - 'updated' / 'idempotent' / 'conflict' tests share a self-seeded
    fixture (`onboarding-test-update-<token>@...`) created at harness
    start with known non-null phone/country/start_date so backfill
    assertions can verify "no overwrite" behavior. The fixture client
    + its slack_channels rows are soft-archived / deleted in cleanup.
  - 'reactivate' test creates its own per-run client, archives it,
    then fires the webhook to reactivate.

Earlier versions of this harness used Branden Bledsoe as a stable fixture
(mirroring the NPS harness). Branden was archived 2026-05-05 in the M5
misclassified-client cleanup, so that pattern broke. Self-managed
fixtures are more robust against future prod-state shifts.

Uses a TEST webhook secret (NOT production). Sets the secret itself
if AIRTABLE_ONBOARDING_WEBHOOK_SECRET is unset, so you can run:

    .venv/bin/python scripts/test_airtable_onboarding_webhook_locally.py

Reads SUPABASE_DB_PASSWORD from .env.local for direct psycopg2 DB
verification (bypasses PostgREST quirks per the existing harness pattern).
"""
from __future__ import annotations

import json
import os
import secrets
import sys
import threading
import time
import traceback
import urllib.request
import urllib.error
import uuid
from http.server import HTTPServer
from pathlib import Path

_REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(_REPO))

# Set the test secret BEFORE importing the handler so the env var is
# present at first os.environ.get() call.
_TEST_SECRET = "test_secret_" + secrets.token_urlsafe(32)
os.environ.setdefault("AIRTABLE_ONBOARDING_WEBHOOK_SECRET", _TEST_SECRET)
_RESOLVED_SECRET = os.environ["AIRTABLE_ONBOARDING_WEBHOOK_SECRET"]

from api.airtable_onboarding_webhook import handler  # noqa: E402 — env-first
from shared.db import get_client  # noqa: E402


# Per-run unique tokens scoped to this harness invocation.
RUN_TOKEN = uuid.uuid4().hex[:10]
GREGORY_BOT = "cfcea32a-062d-4269-ae0f-959adac8f597"

# Self-seeded fixture for update / idempotent / conflict tests. Email is
# per-run unique so concurrent harness runs don't collide.
TEST_UPDATE_EMAIL = f"onboarding-test-update-{RUN_TOKEN}@nowhere.invalid"
TEST_UPDATE_PHONE_PRE = "+1 555-PRESEEDED"
TEST_UPDATE_COUNTRY_PRE = "USA"
TEST_UPDATE_START_DATE_PRE = "2025-01-15"  # distinct from any payload value
TEST_UPDATE_SLACK_USER_PRE = f"UPRE{RUN_TOKEN.upper()[:8]}"
TEST_UPDATE_SLACK_CHAN_PRE = f"CPRE{RUN_TOKEN.upper()[:8]}"


def _pg_conn():
    """Direct psycopg2 connection — same pattern as the NPS / Fathom
    harnesses."""
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
# Server lifecycle
# ---------------------------------------------------------------------------


_server: HTTPServer | None = None
_server_thread: threading.Thread | None = None
_PORT = 0


def _start_server() -> str:
    global _server, _server_thread, _PORT
    _server = HTTPServer(("127.0.0.1", 0), handler)
    _PORT = _server.server_port
    _server_thread = threading.Thread(target=_server.serve_forever, daemon=True)
    _server_thread.start()
    time.sleep(0.1)
    return f"http://127.0.0.1:{_PORT}/api/airtable_onboarding_webhook"


def _stop_server() -> None:
    if _server is not None:
        _server.shutdown()
        _server.server_close()


# ---------------------------------------------------------------------------
# Request helpers
# ---------------------------------------------------------------------------


def _post(
    url: str,
    body: bytes | str,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict | None]:
    if isinstance(body, str):
        body_bytes = body.encode("utf-8")
    else:
        body_bytes = body
    req_headers = {"Content-Type": "application/json"}
    if headers:
        req_headers.update(headers)
    req = urllib.request.Request(
        url, data=body_bytes, headers=req_headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8"))
        except Exception:
            return exc.code, None


def _post_with_secret(
    url: str, payload: dict, secret: str = _RESOLVED_SECRET
) -> tuple[int, dict | None]:
    return _post(
        url,
        json.dumps(payload),
        {"X-Webhook-Secret": secret},
    )


def _full_payload(
    *,
    email: str,
    full_name: str = "Test Client",
    phone: str = "+1 555-000-0000",
    country: str = "USA",
    date_joined: str = "2026-05-05",
    slack_user_id: str | None = None,
    slack_channel_id: str | None = None,
) -> dict:
    """Build a complete 7-field payload with sensible defaults."""
    return {
        "full_name": full_name,
        "email": email,
        "phone": phone,
        "country": country,
        "date_joined": date_joined,
        "slack_user_id": slack_user_id or f"UTEST{RUN_TOKEN.upper()[:8]}",
        "slack_channel_id": slack_channel_id or f"CTEST{RUN_TOKEN.upper()[:8]}",
    }


# ---------------------------------------------------------------------------
# DB-state helpers
# ---------------------------------------------------------------------------


def _client_state(email: str) -> dict:
    """Return current state of a client matched by primary email
    (case-insensitive)."""
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT id, full_name, phone, country, start_date, slack_user_id,
                   status, csm_standing, tags, archived_at, metadata
            FROM clients
            WHERE lower(trim(email)) = lower(trim(%s))
            ORDER BY archived_at DESC NULLS FIRST
            LIMIT 1;
            """,
            (email,),
        )
        row = cur.fetchone()
        if not row:
            return {"id": None}
        return {
            "id": row[0],
            "full_name": row[1],
            "phone": row[2],
            "country": row[3],
            "start_date": row[4],
            "slack_user_id": row[5],
            "status": row[6],
            "csm_standing": row[7],
            "tags": list(row[8] or []),
            "archived_at": row[9],
            "metadata": row[10],
        }
    finally:
        conn.close()


def _slack_channels_for(client_id: str) -> list[dict]:
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT slack_channel_id, is_archived, name, client_id
            FROM slack_channels
            WHERE client_id = %s OR slack_channel_id IN (
              SELECT slack_channel_id FROM slack_channels WHERE client_id = %s
            );
            """,
            (client_id, client_id),
        )
        rows = cur.fetchall()
        return [
            {
                "slack_channel_id": r[0],
                "is_archived": r[1],
                "name": r[2],
                "client_id": str(r[3]) if r[3] else None,
            }
            for r in rows
        ]
    finally:
        conn.close()


def _delivery_status(delivery_id: str) -> dict | None:
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT webhook_id, source, processing_status, processing_error
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
        }
    finally:
        conn.close()


def _count_history_rows_since(
    client_id: str, since_iso: str, kind: str
) -> int:
    table = (
        "client_status_history"
        if kind == "status"
        else "client_standing_history"
    )
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            f"""
            SELECT count(*) FROM {table}
            WHERE client_id = %s AND changed_at >= %s::timestamptz;
            """,
            (client_id, since_iso),
        )
        return int(cur.fetchone()[0])
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Cleanup tracking
# ---------------------------------------------------------------------------


_CREATED_CLIENT_IDS: list[str] = []
_SEEDED_SLACK_CHANNEL_IDS: list[str] = []
_UPDATE_FIXTURE_ID: str | None = None


def _seed_update_fixture() -> None:
    """Create a fresh test client with KNOWN non-null phone / country /
    start_date / slack_user_id and one active slack_channels row. Tests
    2/3/10/11 read from this fixture. Per-run unique email so concurrent
    runs don't collide."""
    global _UPDATE_FIXTURE_ID
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            INSERT INTO clients (
              full_name, email, phone, country, start_date,
              slack_user_id, status, csm_standing, tags, metadata
            ) VALUES (
              %s, %s, %s, %s, %s::date,
              %s, 'active', 'content', '{}'::text[],
              jsonb_build_object('seeded_by', 'test_airtable_onboarding_webhook_locally')
            ) RETURNING id;
            """,
            (
                "Onboarding Update Fixture",
                TEST_UPDATE_EMAIL,
                TEST_UPDATE_PHONE_PRE,
                TEST_UPDATE_COUNTRY_PRE,
                TEST_UPDATE_START_DATE_PRE,
                TEST_UPDATE_SLACK_USER_PRE,
            ),
        )
        _UPDATE_FIXTURE_ID = str(cur.fetchone()[0])
        cur.execute(
            """
            INSERT INTO slack_channels (
              slack_channel_id, name, is_private, is_archived,
              client_id, passive_monitoring_enabled, metadata
            ) VALUES (%s, %s, false, false, %s, false,
              jsonb_build_object('seeded_by', 'test_airtable_onboarding_webhook_locally'));
            """,
            (
                TEST_UPDATE_SLACK_CHAN_PRE,
                "Onboarding Update Fixture",
                _UPDATE_FIXTURE_ID,
            ),
        )
        conn.commit()
    finally:
        conn.close()


def _teardown_update_fixture() -> None:
    """Hard-delete the update fixture + its associated rows. We hard-
    delete (not soft-archive) because the fixture is purely synthetic;
    leaving an archived row + history rows is just clutter."""
    if _UPDATE_FIXTURE_ID is None:
        return
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        # Delete dependent rows first (slack_channels FK + history tables).
        cur.execute(
            "DELETE FROM slack_channels WHERE client_id = %s",
            (_UPDATE_FIXTURE_ID,),
        )
        cur.execute(
            "DELETE FROM client_status_history WHERE client_id = %s",
            (_UPDATE_FIXTURE_ID,),
        )
        cur.execute(
            "DELETE FROM client_standing_history WHERE client_id = %s",
            (_UPDATE_FIXTURE_ID,),
        )
        cur.execute(
            "DELETE FROM clients WHERE id = %s",
            (_UPDATE_FIXTURE_ID,),
        )
        conn.commit()
    finally:
        conn.close()


def _archive_test_clients() -> None:
    """Soft-archive the per-run created clients (test 1 + test 4)."""
    if not _CREATED_CLIENT_IDS:
        return
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        for cid in _CREATED_CLIENT_IDS:
            cur.execute(
                "UPDATE clients SET archived_at = now() WHERE id = %s "
                "AND archived_at IS NULL",
                (cid,),
            )
        for ch in _SEEDED_SLACK_CHANNEL_IDS:
            cur.execute(
                "DELETE FROM slack_channels WHERE slack_channel_id = %s",
                (ch,),
            )
        conn.commit()
    finally:
        conn.close()


def _db_now_iso() -> str:
    """Read the DB's clock so test history-row counts don't suffer from
    Python-vs-DB clock skew. SELECT now() gives us a tz-aware timestamp
    in the same frame the RPC will use."""
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        cur.execute("SELECT now()")
        return cur.fetchone()[0].isoformat()
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


def test_1_happy_create(url: str) -> None:
    print("\n[1] Happy create — full 7-field payload, new email → 200, action=created")
    email = f"onboarding-test-create-{RUN_TOKEN}@nowhere.invalid"
    slack_user = f"UCREATE{RUN_TOKEN.upper()[:8]}"
    slack_chan = f"CCREATE{RUN_TOKEN.upper()[:8]}"
    _SEEDED_SLACK_CHANNEL_IDS.append(slack_chan)

    status, body = _post_with_secret(
        url,
        _full_payload(
            email=email,
            full_name="Onboarding Test Create",
            phone="+1 555-111-2222",
            country="USA",
            date_joined="2026-05-05",
            slack_user_id=slack_user,
            slack_channel_id=slack_chan,
        ),
    )
    _check("1.status", status == 200, f"got HTTP {status}, body={body}")
    if not body:
        return
    _check("1.action", body.get("action") == "created", f"got {body.get('action')!r}")
    _check("1.has_client_id", isinstance(body.get("client_id"), str), f"client_id={body.get('client_id')!r}")
    _check(
        "1.delivery_id_prefix",
        isinstance(body.get("delivery_id"), str)
        and body["delivery_id"].startswith("airtable_onboarding_"),
        f"delivery_id={body.get('delivery_id')!r}",
    )

    if not body.get("client_id"):
        return
    _CREATED_CLIENT_IDS.append(body["client_id"])

    state = _client_state(email)
    _check("1.db.email_lowercased", state["id"] is not None, f"client found: {state['id']}")
    _check("1.db.full_name", state.get("full_name") == "Onboarding Test Create", f"full_name={state.get('full_name')!r}")
    _check("1.db.phone", state.get("phone") == "+1 555-111-2222", f"phone={state.get('phone')!r}")
    _check("1.db.country", state.get("country") == "USA", f"country={state.get('country')!r}")
    _check(
        "1.db.start_date",
        state.get("start_date") is not None and str(state["start_date"]) == "2026-05-05",
        f"start_date={state.get('start_date')!r}",
    )
    _check("1.db.slack_user_id", state.get("slack_user_id") == slack_user, f"slack_user_id={state.get('slack_user_id')!r}")
    _check("1.db.status", state.get("status") == "active", f"status={state.get('status')!r}")
    _check("1.db.csm_standing", state.get("csm_standing") == "content", f"csm_standing={state.get('csm_standing')!r}")
    _check("1.db.tags", "needs_review" in state.get("tags", []), f"tags={state.get('tags')}")
    metadata = state.get("metadata") or {}
    _check(
        "1.db.metadata.auto_created",
        metadata.get("auto_created_from_onboarding_webhook") is True,
        f"auto_created={metadata.get('auto_created_from_onboarding_webhook')}",
    )
    _check(
        "1.db.metadata.delivery_id",
        metadata.get("auto_created_from_delivery_id") == body.get("delivery_id"),
        f"metadata.delivery_id={metadata.get('auto_created_from_delivery_id')!r}",
    )

    channels = _slack_channels_for(state["id"])
    _check("1.db.slack_channels", any(c["slack_channel_id"] == slack_chan for c in channels), f"channels={channels}")

    delivery = _delivery_status(body["delivery_id"])
    _check(
        "1.delivery.processed",
        delivery is not None and delivery["processing_status"] == "processed",
        f"delivery={delivery}",
    )


def test_2_happy_update(url: str) -> None:
    print("\n[2] Happy update — self-seeded active fixture with non-null phone/country/start_date → 200, action=updated, no overwrite")
    if _UPDATE_FIXTURE_ID is None:
        _check("2.skipped", False, "no update fixture")
        return

    # Use DB's clock for the history-row threshold to avoid Python-vs-DB
    # skew filtering out just-written rows.
    pre_request_iso = _db_now_iso()

    # Send DIFFERENT non-null values for phone/country/start_date than
    # the seeded fixture. Backfill semantics: existing-non-null wins,
    # so the post-state should still match TEST_UPDATE_*_PRE.
    status, body = _post_with_secret(
        url,
        _full_payload(
            email=TEST_UPDATE_EMAIL,
            full_name="Onboarding Update Fixture",
            phone="+1 555-WRONG",
            country="GBR",
            date_joined="2026-05-05",
            slack_user_id=TEST_UPDATE_SLACK_USER_PRE,  # match → no conflict
            slack_channel_id=TEST_UPDATE_SLACK_CHAN_PRE,  # match → no conflict
        ),
    )
    _check("2.status", status == 200, f"got HTTP {status}, body={body}")
    if not body:
        return
    _check("2.action", body.get("action") == "updated", f"got {body.get('action')!r}")
    _check("2.client_id", body.get("client_id") == _UPDATE_FIXTURE_ID, f"client_id={body.get('client_id')!r}")

    post_state = _client_state(TEST_UPDATE_EMAIL)
    _check("2.db.status", post_state.get("status") == "active", f"status={post_state.get('status')!r}")
    _check("2.db.csm_standing", post_state.get("csm_standing") == "content", f"csm_standing={post_state.get('csm_standing')!r}")
    _check("2.db.needs_review", "needs_review" in post_state.get("tags", []), f"tags={post_state.get('tags')}")

    # No-overwrite checks: pre-seeded values stay.
    _check(
        "2.db.phone_not_overwritten",
        post_state.get("phone") == TEST_UPDATE_PHONE_PRE,
        f"expected {TEST_UPDATE_PHONE_PRE!r}, got {post_state.get('phone')!r}",
    )
    _check(
        "2.db.country_not_overwritten",
        post_state.get("country") == TEST_UPDATE_COUNTRY_PRE,
        f"expected {TEST_UPDATE_COUNTRY_PRE!r}, got {post_state.get('country')!r}",
    )
    _check(
        "2.db.start_date_not_overwritten",
        str(post_state.get("start_date")) == TEST_UPDATE_START_DATE_PRE,
        f"expected {TEST_UPDATE_START_DATE_PRE!r}, got {post_state.get('start_date')!r}",
    )

    # Fixture was seeded with status='active' + csm_standing='content'.
    # Both RPCs idempotent → 0 history rows from this call.
    actual_status_rows = _count_history_rows_since(_UPDATE_FIXTURE_ID, pre_request_iso, "status")
    actual_standing_rows = _count_history_rows_since(_UPDATE_FIXTURE_ID, pre_request_iso, "standing")
    _check(
        "2.db.status_history_idempotent",
        actual_status_rows == 0,
        f"expected 0 rows (fixture already active), got {actual_status_rows}",
    )
    _check(
        "2.db.standing_history_idempotent",
        actual_standing_rows == 0,
        f"expected 0 rows (fixture already content), got {actual_standing_rows}",
    )


def test_3_idempotent_update(url: str) -> None:
    print("\n[3] Idempotent — fire test 2's call again. No duplicate needs_review, no new history rows.")
    if _UPDATE_FIXTURE_ID is None:
        _check("3.skipped", False, "no update fixture")
        return

    pre_request_iso = _db_now_iso()

    status, body = _post_with_secret(
        url,
        _full_payload(
            email=TEST_UPDATE_EMAIL,
            full_name="Onboarding Update Fixture",
            slack_user_id=TEST_UPDATE_SLACK_USER_PRE,
            slack_channel_id=TEST_UPDATE_SLACK_CHAN_PRE,
        ),
    )
    _check("3.status", status == 200, f"got HTTP {status}")
    _check("3.action", body and body.get("action") == "updated", f"got {body.get('action') if body else None}")

    state = _client_state(TEST_UPDATE_EMAIL)
    tag_count = sum(1 for t in state.get("tags", []) if t == "needs_review")
    _check("3.tags_no_dup", tag_count == 1, f"needs_review count={tag_count}, tags={state.get('tags')}")

    new_status = _count_history_rows_since(_UPDATE_FIXTURE_ID, pre_request_iso, "status")
    new_standing = _count_history_rows_since(_UPDATE_FIXTURE_ID, pre_request_iso, "standing")
    _check("3.status_history_no_new", new_status == 0, f"got {new_status}")
    _check("3.standing_history_no_new", new_standing == 0, f"got {new_standing}")


def test_4_happy_reactivate(url: str) -> None:
    print("\n[4] Happy reactivate — soft-archive a fresh client, fire webhook, expect action=reactivated, archived_at=null")
    email = f"onboarding-test-react-{RUN_TOKEN}@nowhere.invalid"
    slack_user = f"UREACT{RUN_TOKEN.upper()[:8]}"
    slack_chan = f"CREACT{RUN_TOKEN.upper()[:8]}"
    _SEEDED_SLACK_CHANNEL_IDS.append(slack_chan)

    # Step 1: create then archive.
    s1, b1 = _post_with_secret(
        url,
        _full_payload(
            email=email,
            full_name="Reactivate Subject",
            slack_user_id=slack_user,
            slack_channel_id=slack_chan,
        ),
    )
    if s1 != 200 or not b1 or not b1.get("client_id"):
        _check("4.precondition", False, f"create call failed: {s1} {b1}")
        return
    _CREATED_CLIENT_IDS.append(b1["client_id"])
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            "UPDATE clients SET archived_at = now() WHERE id = %s",
            (b1["client_id"],),
        )
        conn.commit()
    finally:
        conn.close()

    # Verify archived
    pre = _client_state(email)
    _check("4.archived_pre", pre.get("archived_at") is not None, f"archived_at={pre.get('archived_at')!r}")

    # Step 2: fire webhook again with same email → reactivate.
    s2, b2 = _post_with_secret(
        url,
        _full_payload(
            email=email,
            full_name="Reactivate Subject",
            slack_user_id=slack_user,
            slack_channel_id=slack_chan,
        ),
    )
    _check("4.status", s2 == 200, f"got HTTP {s2}, body={b2}")
    _check("4.action", b2 and b2.get("action") == "reactivated", f"got {b2.get('action') if b2 else None}")

    post = _client_state(email)
    _check("4.archived_post", post.get("archived_at") is None, f"archived_at={post.get('archived_at')!r}")
    _check("4.status_active", post.get("status") == "active", f"status={post.get('status')!r}")


def test_5_missing_fields(url: str) -> None:
    print("\n[5] Missing each of the 4 REQUIRED fields → 400 missing_field with the right detail")
    base = _full_payload(email=f"onboarding-test-missing-{RUN_TOKEN}@nowhere.invalid")
    fields = ["full_name", "email", "country", "date_joined"]
    for field in fields:
        payload = {k: v for k, v in base.items() if k != field}
        status, body = _post_with_secret(url, payload)
        _check(
            f"5.{field}.status",
            status == 400,
            f"got HTTP {status}, body={body}",
        )
        _check(
            f"5.{field}.error",
            body and body.get("error") == "missing_field",
            f"got {body.get('error') if body else None}",
        )
        _check(
            f"5.{field}.detail",
            body and field in body.get("detail", ""),
            f"detail={body.get('detail') if body else None}",
        )


def test_5b_optional_fields_omitted(url: str) -> None:
    print("\n[5b] Omit phone + slack_user_id + slack_channel_id → 200 created, all three null in DB, no slack_channels row")
    email = f"onboarding-test-noslack-{RUN_TOKEN}@nowhere.invalid"

    # Build a 4-field payload — only the required ones.
    payload = {
        "full_name": "No Slack On First Pass",
        "email": email,
        "country": "USA",
        "date_joined": "2026-05-05",
    }
    status, body = _post_with_secret(url, payload)
    _check("5b.status", status == 200, f"got HTTP {status}, body={body}")
    if not body or status != 200:
        return
    _check("5b.action", body.get("action") == "created", f"got {body.get('action')!r}")
    if not body.get("client_id"):
        _check("5b.has_client_id", False, f"client_id missing in body={body}")
        return
    _CREATED_CLIENT_IDS.append(body["client_id"])

    state = _client_state(email)
    _check("5b.db.found", state["id"] is not None, f"client found: {state['id']}")
    _check("5b.db.phone_null", state.get("phone") is None, f"phone={state.get('phone')!r}")
    _check(
        "5b.db.slack_user_id_null",
        state.get("slack_user_id") is None,
        f"slack_user_id={state.get('slack_user_id')!r}",
    )
    _check("5b.db.status_active", state.get("status") == "active", f"status={state.get('status')!r}")
    _check(
        "5b.db.csm_standing_content",
        state.get("csm_standing") == "content",
        f"csm_standing={state.get('csm_standing')!r}",
    )
    _check(
        "5b.db.needs_review",
        "needs_review" in state.get("tags", []),
        f"tags={state.get('tags')}",
    )

    channels = _slack_channels_for(state["id"])
    _check(
        "5b.db.no_slack_channels_row",
        len(channels) == 0,
        f"expected zero channels for this client, got {channels}",
    )


def test_5c_refire_with_slack_ids(url: str) -> None:
    print("\n[5c] Re-fire test 5b's email with slack_user_id + slack_channel_id populated → 200 updated, IDs backfilled, slack_channels row created")
    email = f"onboarding-test-noslack-{RUN_TOKEN}@nowhere.invalid"

    pre = _client_state(email)
    if pre["id"] is None:
        _check("5c.precondition", False, "test 5b client not found — did 5b run first?")
        return

    slack_user = f"UREFIRE{RUN_TOKEN.upper()[:8]}"
    slack_chan = f"CREFIRE{RUN_TOKEN.upper()[:8]}"
    _SEEDED_SLACK_CHANNEL_IDS.append(slack_chan)

    # Re-fire with the SAME required fields plus the previously-omitted
    # slack identifiers populated.
    payload = {
        "full_name": "No Slack On First Pass",
        "email": email,
        "country": "USA",
        "date_joined": "2026-05-05",
        "phone": "+1 555-LATER",
        "slack_user_id": slack_user,
        "slack_channel_id": slack_chan,
    }
    status, body = _post_with_secret(url, payload)
    _check("5c.status", status == 200, f"got HTTP {status}, body={body}")
    if not body or status != 200:
        return
    _check("5c.action", body.get("action") == "updated", f"got {body.get('action')!r}")
    _check(
        "5c.client_id",
        body.get("client_id") == pre["id"],
        f"expected same client_id {pre['id']}, got {body.get('client_id')!r}",
    )

    post = _client_state(email)
    _check(
        "5c.db.slack_user_id_backfilled",
        post.get("slack_user_id") == slack_user,
        f"expected {slack_user!r}, got {post.get('slack_user_id')!r}",
    )
    # NULL-only backfill: phone was null on pre-state, so the re-fire's
    # phone DOES land. (If 5b had set phone, this would assert no-overwrite
    # — but 5b explicitly omits phone.)
    _check(
        "5c.db.phone_backfilled",
        post.get("phone") == "+1 555-LATER",
        f"expected '+1 555-LATER', got {post.get('phone')!r}",
    )

    channels = _slack_channels_for(post["id"])
    matching = [c for c in channels if c["slack_channel_id"] == slack_chan]
    _check(
        "5c.db.slack_channels_inserted",
        len(matching) == 1
        and matching[0]["client_id"] == post["id"]
        and matching[0]["is_archived"] is False,
        f"expected one active row for client_id={post['id']!r}, got {channels}",
    )


def test_5d_refire_partial(url: str) -> None:
    print("\n[5d] Seed a fresh slackless client, re-fire with slack_user_id only → 200 updated, slack_user_id set, no slack_channels row")
    email = f"onboarding-test-partial-{RUN_TOKEN}@nowhere.invalid"

    # Seed via the webhook itself (simpler than direct DB seed; same
    # path as 5b but with a different email).
    seed_payload = {
        "full_name": "Partial Refire Subject",
        "email": email,
        "country": "USA",
        "date_joined": "2026-05-05",
    }
    s0, b0 = _post_with_secret(url, seed_payload)
    if s0 != 200 or not b0 or not b0.get("client_id"):
        _check("5d.seed", False, f"seed call failed: {s0} {b0}")
        return
    _CREATED_CLIENT_IDS.append(b0["client_id"])
    _check(
        "5d.seed.action_created",
        b0.get("action") == "created",
        f"seed action={b0.get('action')!r}",
    )

    # Re-fire with slack_user_id only — slack_channel_id intentionally absent.
    slack_user = f"UPART{RUN_TOKEN.upper()[:8]}"
    payload = {
        "full_name": "Partial Refire Subject",
        "email": email,
        "country": "USA",
        "date_joined": "2026-05-05",
        "slack_user_id": slack_user,
    }
    status, body = _post_with_secret(url, payload)
    _check("5d.status", status == 200, f"got HTTP {status}, body={body}")
    if not body or status != 200:
        return
    _check("5d.action", body.get("action") == "updated", f"got {body.get('action')!r}")

    post = _client_state(email)
    _check(
        "5d.db.slack_user_id_backfilled",
        post.get("slack_user_id") == slack_user,
        f"expected {slack_user!r}, got {post.get('slack_user_id')!r}",
    )

    channels = _slack_channels_for(post["id"])
    _check(
        "5d.db.no_slack_channels_row",
        len(channels) == 0,
        f"expected zero channels for this client, got {channels}",
    )


def test_6_wrong_type(url: str) -> None:
    print("\n[6] full_name as int → 400 wrong_type")
    payload = _full_payload(email=f"onboarding-test-wt-{RUN_TOKEN}@nowhere.invalid")
    payload["full_name"] = 12345
    status, body = _post_with_secret(url, payload)
    _check("6.status", status == 400, f"got HTTP {status}")
    _check("6.error", body and body.get("error") == "wrong_type", f"got {body!r}")
    _check("6.detail_mentions_full_name", body and "full_name" in body.get("detail", ""), f"detail={body.get('detail') if body else None}")


def test_7_unparseable_date(url: str) -> None:
    print("\n[7] date_joined='yesterday' → 400 wrong_type")
    payload = _full_payload(email=f"onboarding-test-date-{RUN_TOKEN}@nowhere.invalid")
    payload["date_joined"] = "yesterday"
    status, body = _post_with_secret(url, payload)
    _check("7.status", status == 400, f"got HTTP {status}")
    _check("7.error", body and body.get("error") == "wrong_type", f"got {body!r}")
    _check("7.detail_mentions_date", body and "date_joined" in body.get("detail", ""), f"detail={body.get('detail') if body else None}")


def test_8_invalid_json(url: str) -> None:
    print("\n[8] Invalid JSON body → 400 invalid_json")
    status, body = _post(
        url,
        b"not valid json {{",
        {"X-Webhook-Secret": _RESOLVED_SECRET},
    )
    _check("8.status", status == 400, f"got HTTP {status}")
    _check("8.error", body and body.get("error") == "invalid_json", f"got {body!r}")


def test_9_wrong_secret(url: str) -> None:
    print("\n[9] Wrong X-Webhook-Secret → 401 unauthorized, no webhook_deliveries row")
    payload = _full_payload(email=f"onboarding-test-401-{RUN_TOKEN}@nowhere.invalid")
    status, body = _post_with_secret(url, payload, secret="definitely_wrong_value")
    _check("9.status", status == 401, f"got HTTP {status}")
    _check("9.error", body and body.get("error") == "unauthorized", f"got {body!r}")
    # Verify NO webhook_deliveries row was written. We can't check by
    # delivery_id (server didn't generate one) — verify by counting rows
    # in the source table for the recent window.
    conn = _pg_conn()
    try:
        cur = conn.cursor()
        cur.execute(
            """
            SELECT count(*) FROM webhook_deliveries
            WHERE source = 'airtable_onboarding_webhook'
              AND received_at >= now() - interval '5 seconds'
              AND processing_status = 'received'
              AND payload IS NULL;
            """
        )
        # The check is: zero received-status rows with NULL payload from
        # the last 5 seconds. (If a 401 had written a row, it would have
        # NULL payload and 'received' status by mistake.)
        zero_count = cur.fetchone()[0]
        _check(
            "9.no_delivery_row",
            zero_count == 0,
            f"unexpected received-rows-with-null-payload count: {zero_count}",
        )
    finally:
        conn.close()


def test_10_slack_user_id_conflict(url: str) -> None:
    print("\n[10] Slack user_id conflict — fixture has slack_user_id set, payload sends a different one → 409")
    if _UPDATE_FIXTURE_ID is None:
        _check("10.skipped", False, "no update fixture")
        return

    different_uid = f"UDIFF{RUN_TOKEN.upper()[:8]}"

    status, body = _post_with_secret(
        url,
        _full_payload(
            email=TEST_UPDATE_EMAIL,
            slack_user_id=different_uid,
            slack_channel_id=TEST_UPDATE_SLACK_CHAN_PRE,
        ),
    )
    _check("10.status", status == 409, f"got HTTP {status}, body={body}")
    _check(
        "10.error",
        body and body.get("error") == "slack_user_id_conflict",
        f"got {body.get('error') if body else None}",
    )


def test_11_slack_channel_id_conflict(url: str) -> None:
    print("\n[11] Slack channel_id conflict — fixture has an active channel, payload sends a different one → 409")
    if _UPDATE_FIXTURE_ID is None:
        _check("11.skipped", False, "no update fixture")
        return

    different_chan = f"CDIFF{RUN_TOKEN.upper()[:8]}"

    status, body = _post_with_secret(
        url,
        _full_payload(
            email=TEST_UPDATE_EMAIL,
            # Match user id to avoid hitting the user-id conflict first.
            slack_user_id=TEST_UPDATE_SLACK_USER_PRE,
            slack_channel_id=different_chan,
        ),
    )
    _check("11.status", status == 409, f"got HTTP {status}, body={body}")
    _check(
        "11.error",
        body and body.get("error") == "slack_channel_id_conflict_for_client",
        f"got {body.get('error') if body else None}",
    )


# ---------------------------------------------------------------------------
# Driver
# ---------------------------------------------------------------------------


def main() -> int:
    print("=" * 72)
    print("Airtable onboarding webhook — local test harness")
    print(f"Run token: {RUN_TOKEN}")
    print(f"Test secret: {_RESOLVED_SECRET[:24]}... (truncated)")
    print("=" * 72)

    url = _start_server()
    print(f"Receiver listening at {url}")

    print("\nSeeding update fixture…")
    _seed_update_fixture()
    print(
        f"  fixture_id={_UPDATE_FIXTURE_ID} email={TEST_UPDATE_EMAIL} "
        f"slack_user={TEST_UPDATE_SLACK_USER_PRE} slack_chan={TEST_UPDATE_SLACK_CHAN_PRE}"
    )

    try:
        test_1_happy_create(url)
        test_2_happy_update(url)
        test_3_idempotent_update(url)
        test_4_happy_reactivate(url)
        test_5_missing_fields(url)
        test_5b_optional_fields_omitted(url)
        test_5c_refire_with_slack_ids(url)
        test_5d_refire_partial(url)
        test_6_wrong_type(url)
        test_7_unparseable_date(url)
        test_8_invalid_json(url)
        test_9_wrong_secret(url)
        test_10_slack_user_id_conflict(url)
        test_11_slack_channel_id_conflict(url)
    finally:
        print("\n" + "=" * 72)
        print("Cleanup")
        print("=" * 72)
        try:
            _teardown_update_fixture()
            print(f"  Hard-deleted update fixture ({_UPDATE_FIXTURE_ID})")
        except Exception:
            traceback.print_exc()
        try:
            _archive_test_clients()
            print(f"  Soft-archived {len(_CREATED_CLIENT_IDS)} created client(s)")
            print(f"  Deleted {len(_SEEDED_SLACK_CHANNEL_IDS)} seeded slack_channels row(s)")
        except Exception:
            traceback.print_exc()
        _stop_server()

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
