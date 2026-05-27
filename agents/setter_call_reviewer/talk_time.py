"""Talk-time computation from a Deepgram diarized words array.

Deepgram returns a list of {word, punctuated_word, start, end,
speaker, confidence} objects. `speaker` is an integer label (0, 1, ...).
Diarization is imperfect — Drake has observed 3-speaker labels on
2-speaker calls and mid-call swaps. V1 keeps the math simple and
defensible rather than trying to clean up labels:

  1. Count words per speaker label.
  2. If exactly two speakers are present, the speaker with MORE words
     is identified as the setter. Working assumption: setters
     dominate outbound setting calls — they're driving the
     conversation, qualifying, and asking for the booking. Holds in
     the 80%+ case; for the (rare) call where the prospect monologues
     longer than the setter, this gets the labels backward, but the
     ratio itself is still informative.
  3. Anything other than exactly two speakers → return None across
     the board. The UI renders "—" for null values.

Returning None when uncertain is intentional. Wrong-but-confident
numbers are worse than a clean abstain — Drake can iterate the
algorithm if/when the false-label rate becomes a coaching problem.
"""

from __future__ import annotations

from collections import Counter
from typing import Any


def compute_talk_time(words: list[dict[str, Any]]) -> tuple[int | None, int | None, float | None]:
    """Returns (setter_words, prospect_words, talk_ratio_setter).

    talk_ratio_setter = setter_words / (setter_words + prospect_words),
    rounded to 4 decimals.

    All three are None when we can't confidently identify two speakers.
    """
    if not words:
        return None, None, None

    counts: Counter[int] = Counter()
    for w in words:
        spk = w.get("speaker")
        if isinstance(spk, int):
            counts[spk] += 1

    if len(counts) != 2:
        # 0 speakers (no diarization) or 3+ (mis-diarized) — abstain.
        return None, None, None

    # Pick the speaker with more words as the setter. Tied counts are
    # extremely rare; default to the lower-numbered speaker (usually
    # the one who opened the call, which biases correctly for outbound).
    ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
    setter_speaker, setter_words = ranked[0]
    prospect_speaker, prospect_words = ranked[1]
    _ = setter_speaker  # speaker labels themselves aren't stored — only counts
    _ = prospect_speaker

    total = setter_words + prospect_words
    ratio = round(setter_words / total, 4) if total > 0 else None
    return setter_words, prospect_words, ratio
