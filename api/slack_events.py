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

from ingestion.slack.realtime_ingest import ingest_message_event

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
            sales_channel = os.environ.get("SALES_FORM_NOTIFY_SLACK_CHANNEL", "").strip()
            if (
                event.get("type") == "app_mention"
                and sales_channel
                and event.get("channel") == sales_channel
            ):
                # Sales form-notify channel: an @Ella mention here is a rep
                # dismissing a missing-form ping (form genuinely not needed).
                # Route to the engagement dismisser, NOT Ella's client monitor.
                _handle_engagement_dismissal(event)
            elif event.get("type") == "app_mention":
                # Unified-path refactor (2026-05-18 PM): the reactive
                # path is GONE. Slack fires a parallel `message` event
                # alongside every `app_mention` (the app is subscribed
                # to message.groups for all client channels), and that
                # `message` event flows through realtime ingest →
                # passive monitor → the decision Haiku, which weighs
                # the @-mention as a signal. Handling app_mention here
                # too would double-fire. So this is a logged no-op.
                logger.info(
                    "slack_webhook: app_mention deduped — handled via the "
                    "passive path (message event) channel=%s user=%s",
                    event.get("channel"),
                    event.get("user"),
                )
            elif event.get("type") == "message":
                if sales_channel and event.get("channel") == sales_channel:
                    # Sales form-notify channel isn't a client channel — the
                    # dismissal signal is the app_mention above, so this
                    # message event is a no-op (skip the ingest round-trip).
                    pass
                else:
                    # Every message in a client channel lands in
                    # `slack_messages` and forks into the unified passive
                    # monitor (the ONLY evaluation path now — @-mentions
                    # included). Fail-soft: any exception is caught inside
                    # ingest_message_event so Slack's 200 ack still fires.
                    _ingest_message_event(payload)

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
        expected = (
            "v0="
            + hmac.new(
                secret.encode("utf-8"),
                basestring,
                hashlib.sha256,
            ).hexdigest()
        )

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


def _handle_engagement_dismissal(event: dict[str, Any]) -> None:
    """Forward an @Ella mention in the sales form-notify channel to the
    engagement dismisser. A rep replies @Ella in a missing-form ping's thread
    when the form isn't needed; that dismisses the engagement and stops pings.
    Fail-soft: any error is logged so Slack's 200 ack still fires."""
    try:
        from shared.engagements import handle_dismissal_mention

        result = handle_dismissal_mention(event)
        logger.info("slack_webhook: engagement dismissal -> %s", result)
    except Exception as exc:
        logger.exception("slack_webhook: handle_dismissal_mention raised: %s", exc)


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
        logger.exception("slack_webhook: ingest_message_event raised: %s", exc)


# `_post_to_slack` deleted 2026-05-23 — the M1.4 two-token reply path
# moved to `shared.slack_post.post_message_as_user_first` (used by
# `agents.ella.agent.handle_at_mention`). The function had been dead
# code since the 2026-05-18 unified-path collapse made the
# `app_mention` branch a no-op; its only callers were tests.
# Spec: `docs/specs/ella-reply-as-human.md`.
