"""Classify a parsed Fathom call into a `call_category`, `call_type`,
confidence, and (for client calls) `primary_client_id`.

Implements the 6-step cascade pinned in
`docs/fulfillment/metadata-conventions.md` §5. Short-circuits short
files at the top because `excluded` is terminal regardless of what
later steps would have said.

The classifier doesn't touch the DB directly — callers pass a
`ClientResolver` they built from a single pre-fetch. That keeps batch
classification of the 389-call backlog to two SELECTs total instead
of ~800.

Auto-create-client semantics: when the "30mins with Scott" pattern
matches with an unresolved participant, the classifier emits an
`AutoCreateRequest` rather than inserting. The pipeline does the
lookup-by-email-then-insert dance (per conventions §5 step 4) so the
classifier stays a pure function.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Iterable
from zoneinfo import ZoneInfo

from ingestion.fathom.parser import FathomCallRecord, Participant

TEAM_EMAIL_DOMAIN = "@theaipartner.io"
AMAN_EMAIL = "aman@theaipartner.io"
CSM_EMAILS = frozenset({"lou@theaipartner.io", "nico@theaipartner.io"})

# New-convention title cutoff. Calls with `started_at` at or after this
# point can ONLY be classified as `client` if their title matches one
# of the six canonical new-convention patterns below. Pre-cutoff calls
# use the prior cascade unchanged.
#
# America/New_York anchored to dodge DST math; May 18 2026 is in EDT
# (UTC-4) so the cutoff lands at 2026-05-18T04:00:00Z. Spec:
# docs/specs/classifier-enforce-new-title-convention.md.
_NEW_TITLE_CONVENTION_CUTOFF = datetime(
    2026, 5, 18, 0, 0, 0, tzinfo=ZoneInfo("America/New_York")
)

# The six canonical post-cutoff client-call titles. Lowercased here for
# case-insensitive prefix match; trailing extras after the canonical
# prefix are tolerated ("Coaching Call with Scott - Andrew Hsu follow
# up" still matches). Booking links generate these exactly; ad-hoc /
# manually-titled meetings must match the prefix to be classified
# as client post-cutoff.
NEW_CLIENT_TITLE_PATTERNS: tuple[str, ...] = (
    "coaching call with scott",
    "coaching call with lou",
    "coaching call with nico",
    "sales call with scott",
    "sales call with lou",
    "sales call with nico",
)

# v2 convention (Zain's natural iteration, 2026-05-15): the booking
# link now prefixes the client's name —
# `[Client Name] - Coaching/Sales Call with {Scott|Lou|Nico}`. Both v1
# and v2 stay valid indefinitely; no second cutoff (same management
# lever, ADR 0002 revision). The name prefix becomes the PRIMARY
# client-resolution signal (participant email is the backup).
#
# Non-greedy name capture anchors to the FIRST ` - (Coaching|Sales)
# Call with` so a drifted "FW: Andrew Hsu - Coaching Call with Scott"
# captures name="FW: Andrew Hsu" — that lookup just fails and falls
# back to email resolution, which is the correct degradation (the
# booking link never emits an FW: prefix). Trailing context after the
# CSM name is tolerated ("... with Scott - May 22 follow up").
_V2_TITLE_RE = re.compile(
    r"^(?P<name>.+?)\s+-\s+(?P<type>coaching|sales)\s+call\s+with\s+"
    r"(?:scott|lou|nico)\b",
    re.IGNORECASE,
)

CONFIDENCE_HIGH = 0.9
CONFIDENCE_MEDIUM = 0.6
CONFIDENCE_LOW = 0.3

MIN_DURATION_SECONDS = 90
MIN_FILE_SIZE_BYTES = 3 * 1024

# Titles matching any of these force `internal`. Match is case-insensitive
# and treats spaces and underscores equivalently, so both `CSM Sync` and
# `CSM_Sync_Weekly` match the same rule. Substring-level.
INTERNAL_TITLE_PATTERNS: tuple[str, ...] = (
    "csm sync",
    "backend team",
    "fulf sales sync",
    "ncf",
)

# The 30mins-with-Scott 1:1 pattern. Normalized form; matcher below
# handles spaces/underscores/case.
SCOTT_1ON1_PATTERN = "30mins with scott"


# ---------------------------------------------------------------------------
# Public surface
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AutoCreateRequest:
    """Payload the pipeline uses to reify a minimal clients row.

    Only surfaced when the 30mins-with-Scott pattern hits with an
    unresolved participant — per conventions §5 step 4, that's always
    a client 1:1 even when the email isn't in the clients table yet.
    The pipeline must lookup-by-email first (case-insensitive) before
    inserting, to avoid duplicating an auto-created row across
    multiple calls with the same unmatched participant.
    """

    email: str
    display_name: str
    reason: str = "30mins_with_Scott pattern with unresolved participant"


@dataclass(frozen=True)
class ClassificationResult:
    call_category: str
    call_type: str | None
    classification_confidence: float
    classification_method: str
    primary_client_id: str | None
    should_auto_create_client: AutoCreateRequest | None = None
    reasoning: str = ""

    @property
    def should_be_retrievable(self) -> bool:
        """Apply the conventions §5 step 6 retrievability floor.

        `is_retrievable_by_client_agents = true` only when all three
        hold: category is `client`, confidence is high, and a
        primary_client_id is set. Callers wire this to `calls.
        is_retrievable_by_client_agents` on insert; the asymmetric
        re-classification rule (never auto-promote on re-run) lives
        in pipeline.py.
        """
        return (
            self.call_category == "client"
            and self.classification_confidence >= CONFIDENCE_HIGH
            and self.primary_client_id is not None
        )


class ClientResolver:
    """Resolve participant emails / display-names to `clients.id`.

    Constructed once per batch from a single SELECT in the pipeline.
    All lookups are lower-cased. Email map includes primary email plus
    every entry in `metadata.alternate_emails`; name map includes
    primary `full_name` plus `metadata.alternate_names`.

    The name map is the fallback — classifier tries email first and
    only falls back to name when email doesn't resolve. Prevents a
    client with a common first name from accidentally matching an
    unrelated participant.
    """

    def __init__(
        self,
        client_id_by_email: dict[str, str],
        client_id_by_name: dict[str, str] | None = None,
    ):
        self._map: dict[str, str] = {
            email.lower(): cid for email, cid in client_id_by_email.items()
        }
        self._name_map: dict[str, str] = {
            name.lower().strip(): cid
            for name, cid in (client_id_by_name or {}).items()
            if name
        }

    def lookup(self, email: str) -> str | None:
        if not email:
            return None
        return self._map.get(email.lower())

    def lookup_by_name(self, display_name: str) -> str | None:
        if not display_name:
            return None
        return self._name_map.get(display_name.lower().strip())

    def __contains__(self, email: str) -> bool:
        return email.lower() in self._map


def classify(
    record: FathomCallRecord,
    resolver: ClientResolver,
    *,
    file_size_bytes: int | None = None,
) -> ClassificationResult:
    """Run the cascade and return a ClassificationResult."""
    # Step 5 pulled forward — short files are excluded terminally.
    if _is_short_file(record, file_size_bytes):
        return ClassificationResult(
            call_category="excluded",
            call_type=None,
            classification_confidence=CONFIDENCE_HIGH,
            classification_method="short_file_heuristic",
            primary_client_id=None,
            reasoning=(
                f"duration={record.duration_seconds}s, "
                f"file_size={file_size_bytes}B — below minimums"
            ),
        )

    participant_emails = [pt.email for pt in record.participants]
    team_emails = [e for e in participant_emails if _is_team_email(e)]
    external_emails = [e for e in participant_emails if not _is_team_email(e)]
    title_norm = _normalize_for_title_match(record.title)

    # Step 3 runs before Step 2 here because title overrides always
    # win. The conventions doc orders them 2 then 3-as-override; same
    # result, cleaner control flow.
    title_hit = _matched_internal_pattern(title_norm)
    if title_hit is not None:
        return ClassificationResult(
            call_category="internal",
            call_type=_internal_call_type(title_norm),
            classification_confidence=CONFIDENCE_HIGH,
            classification_method="title_pattern",
            primary_client_id=None,
            reasoning=f"title matched internal pattern {title_hit!r}",
        )

    # New-convention cutoff gate (spec: classifier-enforce-new-title-
    # convention). Post-cutoff calls can ONLY produce `client`
    # classification via the six canonical new-convention titles. The
    # Scott-1:1 title pattern and participant-match-as-client both stop
    # promoting to client post-cutoff; participant match still produces
    # internal/external/unclassified as appropriate.
    post_cutoff = _is_after_new_convention_cutoff(record.started_at)
    if post_cutoff:
        if _matches_new_client_title_convention(record.title):
            return _classify_by_new_convention(record, resolver, external_emails)
        # No new-convention title; client classification is BLOCKED.
        # Skip Scott-1:1 (which is itself a client classifier) and
        # gate participant-match against producing `client`.
        step2 = _classify_by_participants(
            record,
            resolver,
            team_emails,
            external_emails,
            allow_client_classification=False,
        )
        return _apply_aman_sales_override(step2, team_emails)

    # Pre-cutoff path — existing cascade unchanged.
    # Step 4 — 30mins-with-Scott 1:1.
    if _matches_scott_1on1(title_norm):
        return _classify_scott_1on1(record, resolver, external_emails)

    # Step 2 — participant match.
    step2 = _classify_by_participants(record, resolver, team_emails, external_emails)

    # Step 2.5 — Aman + no CSM → call_type='sales' bump.
    return _apply_aman_sales_override(step2, team_emails)


# ---------------------------------------------------------------------------
# Step helpers
# ---------------------------------------------------------------------------


def _is_team_email(email: str) -> bool:
    return email.lower().endswith(TEAM_EMAIL_DOMAIN)


def _is_short_file(record: FathomCallRecord, file_size_bytes: int | None) -> bool:
    if record.duration_seconds is not None and record.duration_seconds < MIN_DURATION_SECONDS:
        return True
    if file_size_bytes is not None and file_size_bytes < MIN_FILE_SIZE_BYTES:
        return True
    return False


def _normalize_for_title_match(title: str) -> str:
    """Lower-case and treat spaces/underscores equivalently.

    "CSM_Sync_Weekly" and "CSM Sync - April 21" both collapse to a
    form where `"csm sync"` is a substring.
    """
    return " ".join(title.lower().replace("_", " ").split())


def _matched_internal_pattern(title_norm: str) -> str | None:
    for pattern in INTERNAL_TITLE_PATTERNS:
        if pattern in title_norm:
            return pattern
    return None


def _internal_call_type(title_norm: str) -> str:
    """Pick a call_type for internal calls based on title keywords."""
    if "leadership" in title_norm:
        return "leadership"
    if "strategy" in title_norm:
        return "strategy"
    return "team_sync"


def _matches_scott_1on1(title_norm: str) -> bool:
    return title_norm.startswith(SCOTT_1ON1_PATTERN)


def _matches_new_client_title_convention(title: str | None) -> bool:
    """Return True iff `title` (case-insensitive, trimmed) starts with
    one of the six canonical new-convention patterns. Empty / None
    titles return False — the cutoff gate falls through to non-client
    classification when there's nothing to match.

    Trailing context after the pattern is tolerated; a CSM appending
    the client's name ("Coaching Call with Scott - Andrew Hsu") still
    matches the prefix. Prefixes like "FW:" or "[CANCELED]" do NOT
    match — the booking link generates clean titles, so anything else
    is drift from convention and should fail.
    """
    if not title:
        return False
    normalized = title.strip().lower()
    if not normalized:
        return False
    if any(normalized.startswith(p) for p in NEW_CLIENT_TITLE_PATTERNS):
        return True
    # v2: `[Client Name] - Coaching/Sales Call with {Scott|Lou|Nico}`.
    return _extract_v2_title_prefix_and_type(title) is not None


def _extract_v2_title_prefix_and_type(
    title: str | None,
) -> tuple[str, str] | None:
    """Match the v2 booking-link convention. Returns
    `(client_name_prefix, call_type)` with `call_type` one of
    `'coaching'` / `'sales'`, or None when the title isn't v2-shaped.

    Case-insensitive; leading/trailing whitespace trimmed; trailing
    context after the CSM name tolerated. Empty captured name → None
    (a title like " - Coaching Call with Scott" is malformed, not v2).
    """
    if not title:
        return None
    m = _V2_TITLE_RE.match(title.strip())
    if not m:
        return None
    name = m.group("name").strip()
    if not name:
        return None
    return name, m.group("type").lower()


def _is_after_new_convention_cutoff(started_at: datetime | str | None) -> bool:
    """Return True iff `started_at` is on or after the new-convention
    cutoff. Accepts datetime or ISO string. Returns False on None
    (defensive — pre-cutoff behavior is the safe default if a call
    somehow lacks `started_at`).

    Naive datetimes are assumed UTC (the codebase convention; the
    Fathom parser always emits tz-aware UTC, so the naive branch is
    a defensive safety net for downstream callers that might strip
    tzinfo somewhere).
    """
    if started_at is None:
        return False
    if isinstance(started_at, str):
        try:
            started_at = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        except ValueError:
            return False
    if started_at.tzinfo is None:
        started_at = started_at.replace(tzinfo=timezone.utc)
    return started_at >= _NEW_TITLE_CONVENTION_CUTOFF


def _classify_by_new_convention(
    record: FathomCallRecord,
    resolver: ClientResolver,
    external_emails: list[str],
) -> ClassificationResult:
    """Post-cutoff: title matched one of the six canonical patterns.

    Classify as `client` with confidence 1.0. Resolve
    `primary_client_id` from the external participants using the same
    email + alternate-name lookup the rest of the cascade uses.

    When no external participant resolves to a known client AND at
    least one external participant exists, emit an `AutoCreateRequest`
    for the FIRST unresolved external email. The pipeline's
    `_lookup_or_create_auto_client` does the dedup-then-insert dance
    and tags the new row `needs_review` — same primitive the legacy
    Scott-1:1 pre-cutoff path uses. Reason string is distinct
    (`"new title convention with unresolved participant"`) so audit
    queries can split new-pattern auto-creates from legacy ones.

    When the title matches but NO external participants are present
    at all (booking-link title with only team members on the invite —
    degenerate but legal), the row lands as `client` with no primary
    and no auto-create. Surfaces as a data hygiene flag.

    v2 (2026-05-15): when the title is the name-prefixed shape
    `[Client Name] - Coaching/Sales Call with {Scott|Lou|Nico}`, the
    name prefix is the PRIMARY client-resolution signal — try
    `resolver.lookup_by_name(name_prefix)` first; only fall back to
    participant-email resolution when the name doesn't resolve.
    v2-shaped titles surface `classification_method='title_pattern_v2'`
    (v1 stays `'title_pattern'`) so audit queries can split them, and
    `call_type` comes from the regex's Coaching/Sales capture rather
    than the prefix heuristic. Both conventions stay valid
    indefinitely — no second cutoff (ADR 0002 revision 2026-05-15).

    Spec: docs/specs/cost-hub-effective-from-and-title-convention-v2.md,
    docs/specs/auto-created-client-lifecycle.md.
    """
    v2 = _extract_v2_title_prefix_and_type(record.title)
    classification_method = "title_pattern_v2" if v2 is not None else "title_pattern"

    matched_client_id: str | None = None
    matched_email: str | None = None
    matched_via: str = ""

    # v2: name-prefix resolution is primary.
    if v2 is not None:
        name_prefix, _v2_type = v2
        cid = resolver.lookup_by_name(name_prefix)
        if cid is not None:
            matched_client_id = cid
            matched_via = "title_name_prefix"

    # Email resolution: the v1 path's only mechanism, AND the v2
    # fallback when the name prefix didn't resolve (client joined from
    # an unmapped email, name not indexed due to a duplicate, etc.).
    if matched_client_id is None:
        for email in external_emails:
            cid, via = _resolve_participant(resolver, record.participants, email)
            if cid is not None:
                matched_client_id = cid
                matched_email = email
                matched_via = via
                break

    # call_type: from the v2 regex capture when v2-shaped; otherwise
    # the v1 title-prefix heuristic.
    if v2 is not None:
        call_type = v2[1]
    else:
        title_lower = (record.title or "").strip().lower()
        if title_lower.startswith("coaching call"):
            call_type = "coaching"
        elif title_lower.startswith("sales call"):
            call_type = "sales"
        else:
            call_type = None

    if matched_client_id is not None:
        if matched_via == "title_name_prefix":
            reasoning = (
                f"v2 title; name prefix {v2[0]!r} resolved to existing "
                f"client ({call_type} call)"
            )
        else:
            reasoning = (
                f"new-convention title; {matched_email} matched existing "
                f"client via {matched_via}"
            )
        auto_create: AutoCreateRequest | None = None
    elif external_emails:
        # No external participant resolved. Auto-create the FIRST
        # unresolved external — V1 simple. Multi-external cases (rare:
        # client invites a coworker) get the first attendee promoted
        # to client; others surface via call_participants for later
        # manual review.
        first_unresolved = external_emails[0]
        display = _find_display_name(record.participants, first_unresolved)
        auto_create = AutoCreateRequest(
            email=first_unresolved,
            display_name=display,
            reason="new title convention with unresolved participant",
        )
        reasoning = (
            f"new-convention title; {first_unresolved} unresolved — "
            "auto-create requested"
        )
    else:
        # No external participants at all. Booking-link title but only
        # team on the invite. Degenerate but valid; no auto-create.
        auto_create = None
        reasoning = (
            "new-convention title but no external participants — "
            "primary_client_id stays null"
        )

    # Confidence 1.0 because the new patterns are the strongest signal
    # we have — booking-link-generated titles are explicit declarations
    # of intent, not heuristics. Above CONFIDENCE_HIGH so
    # `should_be_retrievable` fires correctly.
    return ClassificationResult(
        call_category="client",
        call_type=call_type,
        classification_confidence=1.0,
        classification_method=classification_method,
        primary_client_id=matched_client_id,
        should_auto_create_client=auto_create,
        reasoning=reasoning,
    )


def _resolve_participant(
    resolver: ClientResolver, participants: Iterable[Participant], email: str
) -> tuple[str | None, str]:
    """Try email first (includes alternate_emails); fall back to the
    participant's display name (includes alternate_names).

    Returns `(client_id, matched_via)` where matched_via is one of
    `email`, `alternate_name`, or empty when no match.
    """
    cid = resolver.lookup(email)
    if cid is not None:
        return cid, "email"
    display = _find_display_name(participants, email)
    cid = resolver.lookup_by_name(display)
    if cid is not None:
        return cid, "alternate_name"
    return None, ""


def _classify_scott_1on1(
    record: FathomCallRecord,
    resolver: ClientResolver,
    external_emails: list[str],
) -> ClassificationResult:
    """Step 4 — Scott's 30mins 1:1 pattern.

    Exactly one non-team participant → client call. If that email
    matches a known client (or its display name matches the client's
    full_name / alternate_names), confidence is high and primary_
    client_id is set. If neither matches, confidence is medium and
    the pipeline is asked to auto-create.
    """
    if len(external_emails) != 1:
        # Pattern match but unexpected participant shape — mark client
        # with medium confidence, no primary_client_id, no auto-create.
        return ClassificationResult(
            call_category="client",
            call_type="coaching",
            classification_confidence=CONFIDENCE_MEDIUM,
            classification_method="title_pattern",
            primary_client_id=None,
            reasoning=(
                f"30mins_with_Scott pattern but {len(external_emails)} externals — "
                "no primary client identified"
            ),
        )

    participant_email = external_emails[0]
    client_id, matched_via = _resolve_participant(
        resolver, record.participants, participant_email
    )
    if client_id is not None:
        return ClassificationResult(
            call_category="client",
            call_type="coaching",
            classification_confidence=CONFIDENCE_HIGH,
            classification_method="title_pattern",
            primary_client_id=client_id,
            reasoning=(
                f"30mins_with_Scott + {participant_email} matched existing client via {matched_via}"
            ),
        )

    # Unmatched participant — pipeline reifies a minimal clients row.
    display = _find_display_name(record.participants, participant_email)
    return ClassificationResult(
        call_category="client",
        call_type="coaching",
        classification_confidence=CONFIDENCE_MEDIUM,
        classification_method="title_pattern",
        primary_client_id=None,
        should_auto_create_client=AutoCreateRequest(
            email=participant_email,
            display_name=display,
        ),
        reasoning=(
            f"30mins_with_Scott + {participant_email} — no clients match, "
            "auto-create requested"
        ),
    )


def _classify_by_participants(
    record: FathomCallRecord,
    resolver: ClientResolver,
    team_emails: list[str],
    external_emails: list[str],
    *,
    allow_client_classification: bool = True,
) -> ClassificationResult:
    """Step 2 — participant match.

    `allow_client_classification=False` is the post-cutoff path: the
    "matched external → client" promotion is suppressed. Internal /
    external / unclassified outcomes still fire as normal. Used by
    the new-convention cutoff gate to enforce "client classification
    requires a canonical title post-cutoff" without losing the rest
    of the participant-match cascade.
    """
    # 2+ team + no external → internal, high
    if len(team_emails) >= 2 and not external_emails:
        return ClassificationResult(
            call_category="internal",
            call_type="team_sync",
            classification_confidence=CONFIDENCE_HIGH,
            classification_method="participant_match",
            primary_client_id=None,
            reasoning=f"{len(team_emails)} team + 0 external",
        )

    # Any external matches a client (by email, then alternate_name)
    # → client, high. Gated by `allow_client_classification` so the
    # post-cutoff path can suppress this promotion.
    matched_client_id: str | None = None
    matched_email: str | None = None
    matched_via: str = ""
    if allow_client_classification:
        for email in external_emails:
            cid, via = _resolve_participant(resolver, record.participants, email)
            if cid is not None:
                matched_client_id = cid
                matched_email = email
                matched_via = via
                break

    if matched_client_id is not None:
        return ClassificationResult(
            call_category="client",
            call_type=_client_call_type(record.title),
            classification_confidence=CONFIDENCE_HIGH,
            classification_method="participant_match",
            primary_client_id=matched_client_id,
            reasoning=f"{matched_email} matched existing client via {matched_via}",
        )

    # External but no match (OR matched-client-blocked-by-cutoff) →
    # external, medium. Post-cutoff: a call with an external attendee
    # who's actually a known client but lacks the new title falls
    # here, which is the intended forcing-function behavior.
    if external_emails:
        suppressed_note = (
            "; matched-client promotion suppressed by post-cutoff title gate"
            if not allow_client_classification
            else ""
        )
        return ClassificationResult(
            call_category="external",
            call_type=None,
            classification_confidence=CONFIDENCE_MEDIUM,
            classification_method="participant_match",
            primary_client_id=None,
            reasoning=(
                f"{len(external_emails)} external email(s), none matching clients"
                f"{suppressed_note}"
            ),
        )

    # No external, <2 team — weird shape (1 team, possibly unresolved)
    return ClassificationResult(
        call_category="unclassified",
        call_type=None,
        classification_confidence=CONFIDENCE_LOW,
        classification_method="participant_match",
        primary_client_id=None,
        reasoning=f"{len(team_emails)} team, 0 external — cannot classify",
    )


def _client_call_type(title: str) -> str | None:
    """Derive call_type for client calls from the title."""
    t = _normalize_for_title_match(title)
    if "onboarding" in t:
        return "onboarding"
    if "dfy" in t:
        return "coaching"
    return None


def _apply_aman_sales_override(
    result: ClassificationResult, team_emails: list[str]
) -> ClassificationResult:
    """Step 2.5 — Aman leading an external call without a CSM.

    Aman is sales, not a client handler. Keep the category as-is
    (external) but set call_type='sales' and bump confidence to high.
    Only fires when the prior step produced `external`.
    """
    if result.call_category != "external":
        return result
    team_set = {e.lower() for e in team_emails}
    if AMAN_EMAIL not in team_set:
        return result
    if team_set & CSM_EMAILS:
        return result
    return ClassificationResult(
        call_category="external",
        call_type="sales",
        classification_confidence=CONFIDENCE_HIGH,
        classification_method="participant_match",
        primary_client_id=None,
        reasoning=result.reasoning + "; Aman present and no CSM — sales call",
    )


def _find_display_name(
    participants: Iterable[Participant], email: str
) -> str:
    email_l = email.lower()
    for pt in participants:
        if pt.email.lower() == email_l:
            return pt.display_name
    # Fall back to the local-part of the email so we never insert an
    # empty full_name on auto-create.
    return email_l.split("@", 1)[0]
