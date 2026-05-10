"""Slack Events API webhook for Ella.

Deployed by Vercel as a serverless Python function at
`/api/slack_events`. Slack's Event Subscriptions point at this URL;
this module is the only place `app_mention` events cross from
Slack's edge into our agent code.

V1 flow (synchronous):

  1. Verify the HMAC signature on the raw body. Reject bad signatures
     (401) and stale timestamps (>5 min) without further work.
  2. Handle the one-off `url_verification` challenge inline. Slack
     fires this once when the Event Subscription is first configured.
  3. On Slack retries (`X-Slack-Retry-Num` header present): ack 200
     immediately without re-processing. The original invocation is
     still handling this event; a duplicate would produce two Slack
     replies.
  4. On `event_callback` + `app_mention`: run the agent and post the
     reply synchronously via `chat.postMessage`, then return 200.
     Ella's roundtrip is ~5–10s and Slack's ack window is 3s, so the
     first-delivery on a cold start will time out from Slack's
     perspective — Slack retries, our retry branch acks fast (step 3)
     and the original invocation still lands the post.

Why synchronous and not background-threaded: Vercel's Python runtime
terminates the function process as soon as `do_POST` returns, which
kills any non-daemon `threading.Thread` before it can finish
`chat.postMessage`. Smoke test on 2026-04-23 confirmed this — the
first deployment tried the ack-then-thread pattern and produced zero
replies in Slack despite 200 acks on every request. Fluid Compute
would fix it at the runtime level, but it's a project-level opt-in
we don't have enabled yet. The sync+retry pattern works without any
Vercel config change and costs ~2x container seconds per mention
(first invocation does the work; one retry is acked fast then
discarded). Acceptable for V1 pilot volume.

Env vars required (must be set in the Vercel project):
  SLACK_SIGNING_SECRET       — HMAC verification of inbound webhooks.
  SLACK_BOT_TOKEN            — xoxb- token for outbound chat.postMessage.
  SUPABASE_URL               — shared.db client.
  SUPABASE_SERVICE_ROLE_KEY  — shared.db client.
  ANTHROPIC_API_KEY          — shared.claude_client (Ella's LLM calls).
  OPENAI_API_KEY             — shared.kb_query (embedding retrieval).
"""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import time
from http.server import BaseHTTPRequestHandler
from typing import Any

from agents.ella.slack_handler import handle_slack_event
from ingestion.slack.realtime_ingest import ingest_message_event
from shared.slack_identity import get_user_id_for_token
from shared.slack_post import call_chat_post_message

# Vercel's Python runtime pre-configures the root logger at WARNING
# level, so a naive `logging.basicConfig(level=INFO)` is a no-op and
# our INFO lines get silently dropped. Set the root logger level
# directly so our INFO-level operational logs land in the Vercel log
# stream (smoke test on 2026-04-23 confirmed this was happening).
logging.getLogger().setLevel(logging.INFO)
logger = logging.getLogger("ai_enablement.slack_webhook")
logger.setLevel(logging.INFO)

# Slack's replay-protection window. Requests older than this are
# rejected regardless of signature — an attacker who captured a valid
# signed request can't replay it hours later.
_MAX_REQUEST_AGE_SECONDS = 300

# Outbound chat.postMessage timeout. Short enough to surface transport
# problems quickly; long enough for Slack's normal tail latency.
_SLACK_POST_TIMEOUT_SECONDS = 10


class handler(BaseHTTPRequestHandler):
    """Vercel's Python runtime instantiates this per request."""

    def do_POST(self) -> None:
        body = self._read_body()

        if not self._verify_signature(body):
            logger.warning("slack_webhook: signature verification failed")
            self._respond(401, "invalid signature")
            return

        try:
            payload = json.loads(body.decode("utf-8"))
        except json.JSONDecodeError:
            logger.warning("slack_webhook: body was not valid JSON")
            self._respond(400, "bad payload")
            return

        # One-off handshake when the Event Subscription URL is first
        # saved in the Slack app console. We echo `challenge` back.
        if payload.get("type") == "url_verification":
            challenge = payload.get("challenge", "")
            logger.info("slack_webhook: url_verification challenge received")
            self._respond(
                200,
                json.dumps({"challenge": challenge}),
                content_type="application/json",
            )
            return

        # Slack retries the webhook on any non-200 or slow response.
        # Retries carry `X-Slack-Retry-Num` and the original event
        # (same event_id). The first delivery's background thread is
        # still handling the mention, so re-running it here would
        # produce a duplicate Slack reply.
        retry_num = self.headers.get("X-Slack-Retry-Num")
        if retry_num:
            logger.info(
                "slack_webhook: skipping retry #%s (reason=%s)",
                retry_num,
                self.headers.get("X-Slack-Retry-Reason"),
            )
            self._respond(200, "ok")
            return

        if payload.get("type") == "event_callback":
            event = payload.get("event") or {}
            if event.get("type") == "app_mention":
                logger.info(
                    "slack_webhook: processing app_mention channel=%s user=%s",
                    event.get("channel"),
                    event.get("user"),
                )
                # Synchronous so the work actually happens. Vercel's
                # Python runtime kills background threads the moment
                # the response is written, so a fire-and-forget
                # threaded post never lands. See module docstring for
                # why this is acceptable: Slack retries fast on our
                # missed ack, and the retry branch above catches them.
                _process_mention(payload)
            elif event.get("type") == "message":
                # Ella V2 Batch 1 — cloud Slack ingestion. Every
                # message in a client channel lands in
                # `slack_messages`; non-client channels are skipped
                # with an audit row. Fail-soft: any exception is
                # caught inside ingest_message_event so Slack's 200
                # ack still fires below.
                _ingest_message_event(payload)

                # Ella V2 Batch 1.5 (Task 7) — dual-trigger detection.
                # If this message @-mentions Ella's human user_id AND
                # not the bot user_id, also treat it as an app_mention.
                # (Messages that contain BOTH mentions are handled by
                # the natural app_mention event Slack fires alongside;
                # we de-dupe to avoid double-response.)
                if _should_dual_trigger(event):
                    logger.info(
                        "slack_webhook: dual-trigger on message channel=%s user=%s",
                        event.get("channel"),
                        event.get("user"),
                    )
                    _process_mention(_build_app_mention_from_message(payload))

        # Ack regardless of inner event type. Anything non-200 tells
        # Slack to retry, which we don't want for events we didn't
        # subscribe to.
        self._respond(200, "ok")

    def do_GET(self) -> None:
        # Browser hits / uptime pings land here. A 200 + a small hint
        # is friendlier than a Vercel 404 when someone opens the URL
        # to sanity-check the deployment.
        self._respond(200, "ella slack webhook — POST only")

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length", "0"))
        return self.rfile.read(length) if length else b""

    def _verify_signature(self, body: bytes) -> bool:
        """HMAC-SHA256 verification per Slack's request-signing spec.

        Operates on raw bytes end-to-end so encoding-roundtrip bugs
        can't cause a false rejection. Returns False on any missing
        header, stale timestamp, or mismatch.
        """
        secret = os.environ.get("SLACK_SIGNING_SECRET")
        if not secret:
            logger.error("slack_webhook: SLACK_SIGNING_SECRET not set")
            return False

        timestamp = self.headers.get("X-Slack-Request-Timestamp")
        signature = self.headers.get("X-Slack-Signature")
        if not timestamp or not signature:
            return False

        try:
            ts_int = int(timestamp)
        except ValueError:
            return False

        delta = abs(time.time() - ts_int)
        if delta > _MAX_REQUEST_AGE_SECONDS:
            logger.warning(
                "slack_webhook: rejecting request with timestamp delta %.0fs",
                delta,
            )
            return False

        basestring = b"v0:" + timestamp.encode("utf-8") + b":" + body
        expected = "v0=" + hmac.new(
            secret.encode("utf-8"),
            basestring,
            hashlib.sha256,
        ).hexdigest()

        return hmac.compare_digest(expected, signature)

    def _respond(
        self,
        status: int,
        body: str = "",
        content_type: str = "text/plain",
    ) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        encoded = body.encode("utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        if encoded:
            self.wfile.write(encoded)


# ---------------------------------------------------------------------------
# Background worker
# ---------------------------------------------------------------------------


def _should_dual_trigger(event: dict[str, Any]) -> bool:
    """Decide whether a `message` event should also fire Ella's
    app_mention response path (Task 7 of Batch 1.5).

    Returns True when:
      - The message text contains `<@<human_ella_user_id>>` (resolved
        from `SLACK_USER_TOKEN` via auth.test, cached per-process).
      - The message text does NOT contain `<@<bot_user_id>>` — those
        get handled by the parallel `app_mention` event Slack fires.
      - The message author is neither the bot nor the human Ella
        account (don't trigger on self-responses or response loops).

    Any exception or missing token resolves to False (fail-soft —
    don't trigger if anything is ambiguous).
    """
    try:
        text = event.get("text") or ""
        human_uid = get_user_id_for_token(os.environ.get("SLACK_USER_TOKEN"))
        if not human_uid:
            return False
        if f"<@{human_uid}>" not in text:
            return False
        bot_uid = get_user_id_for_token(os.environ.get("SLACK_BOT_TOKEN"))
        if bot_uid and f"<@{bot_uid}>" in text:
            # Will be handled by the parallel app_mention event.
            return False
        author = event.get("user")
        if author and author in (bot_uid, human_uid):
            return False
        return True
    except Exception as exc:
        logger.warning("slack_webhook: dual-trigger check raised: %s", exc)
        return False


def _build_app_mention_from_message(payload: dict[str, Any]) -> dict[str, Any]:
    """Reshape a `message`-event payload so the existing app_mention
    path can process it. Just flips `event.type` to `app_mention` and
    leaves everything else verbatim — channel, user, text (with the
    `<@U...>` mention syntax already in place), ts, thread_ts.
    """
    inner = dict(payload.get("event") or {})
    inner["type"] = "app_mention"
    return {**payload, "event": inner}


def _ingest_message_event(payload: dict[str, Any]) -> None:
    """Forward a `message` event into the realtime ingestion pipeline.

    Wraps `ingestion.slack.realtime_ingest.ingest_message_event` so the
    HTTP handler doesn't need to know about audit-row mechanics. The
    ingestion function is fail-soft (catches all exceptions and
    records them in the audit ledger) — this wrapper has a defensive
    outer try/except in case the import or dispatch itself raises.
    """
    try:
        ingest_message_event(payload)
    except Exception as exc:
        logger.exception(
            "slack_webhook: ingest_message_event raised: %s", exc
        )


def _process_mention(payload: dict[str, Any]) -> None:
    """Run Ella on the event and post her response back to Slack.

    Any exception is caught and logged: a single bad mention must not
    take the function down for the next one, and an unhandled
    exception in a background thread would otherwise be swallowed by
    Vercel with no diagnostic trail.
    """
    try:
        result = handle_slack_event(payload)
    except Exception as exc:
        logger.exception("slack_webhook: handle_slack_event raised: %s", exc)
        return

    if not result.get("responded") or not result.get("text"):
        logger.info(
            "slack_webhook: agent returned no response (reason=%s)",
            result.get("reason") or "responded=False",
        )
        return

    channel = result.get("channel_id")
    text = result["text"]

    try:
        _post_to_slack(channel=channel, text=text)
    except Exception as exc:
        logger.exception("slack_webhook: chat.postMessage raised: %s", exc)


def _post_to_slack(*, channel: str, text: str) -> None:
    """POST Ella's reply to Slack via chat.postMessage.

    Batch 1.5: always posts to the main channel. V1 threaded the
    response under the triggering message — Drake's V2 direction is
    main-channel-only so the new last-N-turns context window (Task 5)
    serves as the conversational thread.

    Two-token strategy (M1.4):
      1. If `SLACK_USER_TOKEN` is set, post via the user token (`xoxp-`).
         Renders as a regular user message — no APP tag. This is the
         polish Nabeel asked for.
      2. On any failure of the user path (HTTP error, network exception,
         Slack-side `ok=false` like missing_scope / not_in_channel),
         fall through to the bot-token path (`xoxb-`). Bot path renders
         with the APP tag but works as a permanent safety net.

    Operational rollback: unset `SLACK_USER_TOKEN` on Vercel and redeploy.
    The user path is then skipped entirely and posts revert to the bot
    path — no code change needed.

    Failure logging captures HTTP status and Slack `error` codes only.
    Tokens and request bodies are NEVER logged.
    """
    body: dict[str, Any] = {"channel": channel, "text": text}

    user_token = os.environ.get("SLACK_USER_TOKEN")
    if user_token:
        try:
            ok, slack_error = _call_chat_post_message(user_token, body)
            if ok:
                logger.info(
                    "slack.postMessage ok via user-token: channel=%s",
                    channel,
                )
                return
            logger.warning(
                "slack.postMessage user-token path returned ok=false "
                "(slack_error=%s) — falling back to bot-token",
                slack_error,
            )
        except Exception as exc:
            # Any transport-level failure on the user path: HTTP non-2xx,
            # timeout, JSON decode error, etc. Catch broadly so the bot
            # path is reachable. Don't include the request body or token
            # in the log line.
            logger.warning(
                "slack.postMessage user-token path raised %s: %s — "
                "falling back to bot-token",
                type(exc).__name__,
                exc,
            )

    # Bot path — either user token absent or user path failed. This is
    # the exact behavior the handler had before M1.4; preserved verbatim
    # as the safety net.
    bot_token = os.environ.get("SLACK_BOT_TOKEN")
    if not bot_token:
        raise RuntimeError("SLACK_BOT_TOKEN not set")
    try:
        ok, slack_error = _call_chat_post_message(bot_token, body)
        if ok:
            logger.info(
                "slack.postMessage ok via bot-token: channel=%s",
                channel,
            )
        else:
            # Bot path also failed at the Slack-app layer. Log loudly
            # so this surfaces in Vercel logs; caller (_process_mention)
            # already swallows exceptions, so we don't re-raise on
            # ok=false. The original Slack ack was already 200; this
            # is post-ack error logging only.
            logger.error(
                "slack.postMessage bot-token also returned ok=false: "
                "channel=%s slack_error=%s",
                channel,
                slack_error,
            )
    except Exception:
        # Bot path transport failure — re-raise so the caller's
        # logger.exception captures the traceback. Slack's ack already
        # returned 200; the function's caller never sees this exception
        # propagate to the HTTP response.
        logger.exception(
            "slack.postMessage bot-token path raised — both paths failed",
        )
        raise


# `_call_chat_post_message` was extracted to shared/slack_post.py
# (M6.1). The two-token Ella post path above imports it from there;
# the new internal-CS post helpers (per-call summary, accountability
# cron) use shared.slack_post.post_message directly. Keeping this
# alias so the in-file references and existing test patches remain
# stable; tests still patch urllib.request.urlopen but now in
# shared.slack_post.
_call_chat_post_message = call_chat_post_message
