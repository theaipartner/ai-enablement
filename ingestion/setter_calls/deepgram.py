"""Deepgram URL-ingest client.

One-shot transcription via Deepgram's batch HTTP API. Direct urllib —
the call is a single POST and we want to keep the dependency surface
honest. The `deepgram-sdk` package in pyproject is currently unused;
holding it as an option for later (streaming / live transcription) but
swappable.

Deepgram Nova-3 pricing (verified 2026-05-27): $0.0043 per audio
minute for batch URL ingest. Cost we report on the
`setter_call_transcripts.deepgram_cost_usd` column uses this rate.
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlencode

from shared.logging import logger

DEEPGRAM_BASE_URL = "https://api.deepgram.com/v1/listen"
DEEPGRAM_TIMEOUT_S = 180.0
DEEPGRAM_MAX_RETRIES = 3

# Per-minute rate for the Nova-3 model on the batch URL-ingest endpoint.
# Update here if Deepgram pricing changes (and bump the value in any
# rows already in setter_call_transcripts if you want them retro-priced).
NOVA_3_USD_PER_MINUTE = 0.0043


class DeepgramError(RuntimeError):
    """Raised for non-2xx responses or exhausted retries."""


def transcribe_url(
    audio_url: str,
    *,
    api_key: str | None = None,
    model: str = "nova-3",
    diarize: bool = True,
    smart_format: bool = True,
    punctuate: bool = True,
) -> dict[str, Any]:
    """POST {url: audio_url} to Deepgram, return parsed JSON.

    Defaults are tuned for setter-call review:
      - nova-3: highest accuracy model in the Nova family
      - diarize: speaker labels (setter vs prospect)
      - smart_format: numbers/dates/etc. formatted for human reading
      - punctuate: sentence boundaries (Sonnet handles ragged text but
        clean text gives better attention)

    Args:
        audio_url: Publicly fetchable URL — typically a pre-signed S3
            URL handed to us by Close. Deepgram fetches it itself.
        api_key: DEEPGRAM_API_KEY env var if None.

    Returns:
        The raw Deepgram response dict. Top-level keys: `metadata`,
        `results`. The single channel/alternative is at
        `results.channels[0].alternatives[0]`.

    Raises:
        DeepgramError: non-2xx after retries, or env var missing.
    """
    key = api_key or os.getenv("DEEPGRAM_API_KEY")
    if not key:
        raise DeepgramError(
            "DEEPGRAM_API_KEY not set. Add to .env.local (Vercel env in prod)."
        )

    params: dict[str, str] = {"model": model}
    if diarize:
        params["diarize"] = "true"
    if smart_format:
        params["smart_format"] = "true"
    if punctuate:
        params["punctuate"] = "true"
    url = f"{DEEPGRAM_BASE_URL}?{urlencode(params)}"

    body = json.dumps({"url": audio_url}).encode()
    headers = {
        "Authorization": f"Token {key}",
        "Content-Type": "application/json",
    }

    # Retry on transient errors (timeout, 5xx). 4xx fails fast — the URL
    # is probably wrong / expired and retrying won't help.
    last_exc: Exception | None = None
    for attempt in range(DEEPGRAM_MAX_RETRIES):
        req = urllib.request.Request(url, method="POST", data=body, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=DEEPGRAM_TIMEOUT_S) as resp:
                payload = resp.read().decode()
                return json.loads(payload)
        except urllib.error.HTTPError as e:
            err_body = ""
            try:
                err_body = e.read().decode()[:1000]
            except Exception:
                pass
            if 500 <= e.code < 600 and attempt < DEEPGRAM_MAX_RETRIES - 1:
                logger.warning(
                    "deepgram.5xx_retry status=%d attempt=%d body=%s",
                    e.code, attempt + 1, err_body,
                )
                time.sleep(2 + attempt * 2)
                continue
            raise DeepgramError(
                f"Deepgram HTTP {e.code}: {err_body}"
            ) from e
        except (urllib.error.URLError, TimeoutError) as e:
            last_exc = e
            if attempt < DEEPGRAM_MAX_RETRIES - 1:
                logger.warning(
                    "deepgram.network_retry attempt=%d err=%s",
                    attempt + 1, e,
                )
                time.sleep(2 + attempt * 2)
                continue
            raise DeepgramError(
                f"Deepgram network failure after {DEEPGRAM_MAX_RETRIES} attempts: {e}"
            ) from e

    # Unreachable — the loop above always either returns or raises.
    raise DeepgramError(f"Exhausted Deepgram retries: {last_exc}")


def compute_cost_usd(duration_s: float, model: str = "nova-3") -> float:
    """Cost in USD for `duration_s` seconds of `model` transcription.

    Rounded to 6 decimal places (matches setter_call_transcripts.
    deepgram_cost_usd numeric(10, 6)).
    """
    if model != "nova-3":
        # Reminder to update the rate table if we add models. Don't
        # silently bill at the wrong rate.
        raise DeepgramError(
            f"Unknown pricing for model={model!r}. Update NOVA_3_USD_PER_MINUTE "
            f"or add a per-model rate table in ingestion/setter_calls/deepgram.py."
        )
    cost = (duration_s / 60.0) * NOVA_3_USD_PER_MINUTE
    return round(cost, 6)


def extract_speaker_count(words: list[dict[str, Any]]) -> int:
    """Count distinct `speaker` integers in a Deepgram words array.

    Returns 0 if no words carry a speaker label (e.g. diarize=False or
    a single-channel transcription that didn't split speakers).
    """
    speakers: set[int] = set()
    for w in words:
        spk = w.get("speaker")
        if isinstance(spk, int):
            speakers.add(spk)
    return len(speakers)
