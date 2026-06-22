"""Chunk a Fathom transcript into retrieval-friendly pieces.

Implements `docs/fulfillment/metadata-conventions.md` §3 and §4:

  - Target 400–600 words per chunk (~500 tokens).
  - Start and end on speaker-turn boundaries — never mid-utterance.
  - ~50-word overlap with the previous chunk, taken from its tail.
  - Filler filter: drop utterances with fewer than 8 words whose full
    text is a single agreement-style filler phrase (yeah, 100%, for
    sure, etc.). Keep short utterances that carry numbers, proper
    nouns, or domain verbs — those can be meaningful.
  - Speaker labels and timestamps preserved in the rendered chunk
    text (`[HH:MM:SS] Speaker: utterance`).

Output: list of `Chunk` dicts with `chunk_index`, `content`, and
`metadata` (chunk_start_ts, chunk_end_ts, speaker_list,
speaker_turn_count).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any

from ingestion.fathom.parser import Utterance

DEFAULT_TARGET_WORDS = 500
DEFAULT_OVERLAP_WORDS = 50
MIN_UTTERANCE_WORDS_TO_ALWAYS_KEEP = 8

# Agreement-style filler phrases. Matched after lowercasing and
# stripping trailing punctuation from the whole utterance. Keep the
# set tight — we'd rather under-filter than drop a short but
# substantive utterance by accident.
_FILLER_PHRASES: frozenset[str] = frozenset({
    "yeah", "yep", "yes", "yeah yeah", "yep yep",
    "100%", "for sure", "right",
    "mhm", "mm-hmm", "mmhmm", "mm hmm",
    "okay", "ok", "kk", "k",
    "thanks", "thank you", "got it",
    "sure", "totally", "exactly",
    "cool", "nice",
})

_WHITESPACE_RE = re.compile(r"\s+")


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Chunk:
    chunk_index: int
    content: str
    metadata: dict[str, Any]


def chunk_transcript(
    utterances: list[Utterance],
    *,
    target_words: int = DEFAULT_TARGET_WORDS,
    overlap_words: int = DEFAULT_OVERLAP_WORDS,
) -> list[Chunk]:
    """Split utterances into chunks per the conventions doc.

    Empty input returns an empty list. Input containing only fillers
    returns an empty list.
    """
    if not utterances:
        return []

    filtered = filter_fillers(utterances)
    if not filtered:
        return []

    turns = _group_speaker_turns(filtered)
    turn_groups = _pack_turns_into_chunks(turns, target_words=target_words)

    chunks: list[Chunk] = []
    for idx, group in enumerate(turn_groups):
        content_lines = [_render_utterance(u) for turn in group for u in turn.utterances]
        if idx > 0:
            overlap_text = _overlap_tail(turn_groups[idx - 1], overlap_words)
            if overlap_text:
                content_lines = [overlap_text, ""] + content_lines
        chunks.append(
            Chunk(
                chunk_index=idx,
                content="\n".join(content_lines),
                metadata=_build_chunk_metadata(group),
            )
        )
    return chunks


def filter_fillers(utterances: list[Utterance]) -> list[Utterance]:
    """Return the subset of utterances that carry signal."""
    return [u for u in utterances if not _is_pure_filler(u.text)]


# ---------------------------------------------------------------------------
# Filler detection
# ---------------------------------------------------------------------------


def _is_pure_filler(text: str) -> bool:
    """Drop only when the whole normalized utterance is a known filler
    phrase. Short utterances with any other content — numbers, names,
    domain verbs — survive implicitly because their normalized form
    isn't in the filler set (`Okay, $900 then` ≠ `okay`)."""
    if len(text.split()) >= MIN_UTTERANCE_WORDS_TO_ALWAYS_KEEP:
        return False
    return _normalize_for_filler_match(text) in _FILLER_PHRASES


def _normalize_for_filler_match(text: str) -> str:
    """Lowercase, strip leading/trailing punctuation, collapse spaces."""
    stripped = text.strip().lower()
    # Remove surrounding punctuation ("yeah," "yeah!" "yeah.") without
    # nuking internal chars in things like "100%" or "mm-hmm".
    while stripped and not (stripped[0].isalnum() or stripped[0] == "%"):
        stripped = stripped[1:]
    while stripped and not (stripped[-1].isalnum() or stripped[-1] == "%"):
        stripped = stripped[:-1]
    return _WHITESPACE_RE.sub(" ", stripped)


# ---------------------------------------------------------------------------
# Speaker turns
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Turn:
    """Contiguous utterances from a single speaker."""
    speaker: str
    utterances: list[Utterance]

    @property
    def word_count(self) -> int:
        return sum(len(u.text.split()) for u in self.utterances)

    @property
    def start_ts(self) -> str:
        return self.utterances[0].timestamp

    @property
    def end_ts(self) -> str:
        return self.utterances[-1].timestamp


def _group_speaker_turns(utterances: list[Utterance]) -> list[_Turn]:
    turns: list[_Turn] = []
    current_speaker: str | None = None
    current_utterances: list[Utterance] = []
    for u in utterances:
        if current_speaker is None or u.speaker != current_speaker:
            if current_utterances:
                turns.append(_Turn(speaker=current_speaker or "", utterances=current_utterances))
            current_speaker = u.speaker
            current_utterances = [u]
        else:
            current_utterances.append(u)
    if current_utterances:
        turns.append(_Turn(speaker=current_speaker or "", utterances=current_utterances))
    return turns


# ---------------------------------------------------------------------------
# Chunk packing
# ---------------------------------------------------------------------------


def _pack_turns_into_chunks(
    turns: list[_Turn], *, target_words: int
) -> list[list[_Turn]]:
    """Greedily fill chunks up to the target word count.

    A chunk closes as soon as adding the next turn would push the
    running count ABOVE target_words — the closing boundary always
    lands on a speaker-turn edge, never mid-utterance. Single turns
    larger than target_words get their own chunk.
    """
    chunks: list[list[_Turn]] = []
    current: list[_Turn] = []
    current_words = 0
    for turn in turns:
        if current and current_words + turn.word_count > target_words:
            chunks.append(current)
            current = []
            current_words = 0
        current.append(turn)
        current_words += turn.word_count
    if current:
        chunks.append(current)
    return chunks


def _overlap_tail(previous_group: list[_Turn], overlap_words: int) -> str:
    """Render the last ~overlap_words of a previous chunk's utterances
    as the lead-in to the next chunk.

    Walks the previous group backwards, accumulating utterances until
    the word count meets or exceeds `overlap_words`, then reverses to
    preserve chronological order.
    """
    if overlap_words <= 0:
        return ""
    collected: list[Utterance] = []
    words = 0
    for turn in reversed(previous_group):
        for u in reversed(turn.utterances):
            collected.append(u)
            words += len(u.text.split())
            if words >= overlap_words:
                break
        if words >= overlap_words:
            break
    collected.reverse()
    if not collected:
        return ""
    return "\n".join(_render_utterance(u) for u in collected)


# ---------------------------------------------------------------------------
# Rendering + metadata
# ---------------------------------------------------------------------------


def _render_utterance(u: Utterance) -> str:
    return f"[{u.timestamp}] {u.speaker}: {u.text}"


def _build_chunk_metadata(group: list[_Turn]) -> dict[str, Any]:
    speakers: list[str] = []
    seen: set[str] = set()
    turn_count = 0
    for turn in group:
        turn_count += 1
        if turn.speaker and turn.speaker not in seen:
            seen.add(turn.speaker)
            speakers.append(turn.speaker)
    start = group[0].start_ts if group else "00:00:00"
    end = group[-1].end_ts if group else start
    return {
        "chunk_start_ts": start,
        "chunk_end_ts": end,
        "speaker_list": speakers,
        "speaker_turn_count": turn_count,
    }
