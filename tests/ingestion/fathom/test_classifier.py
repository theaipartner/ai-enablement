"""Unit tests for ingestion.fathom.classifier.

Every cascade step has at least one passing and one non-passing case.
Auto-create-client email-exists vs email-new branches are both covered.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from ingestion.fathom import classifier as c
from ingestion.fathom.parser import FathomCallRecord, Participant


def _record(
    *,
    title: str = "Test call",
    duration_seconds: int | None = 600,
    participants: list[Participant] | None = None,
    started_at: datetime | None = None,
) -> FathomCallRecord:
    return FathomCallRecord(
        external_id="test-1",
        title=title,
        # Default 2026-03-15 is pre-cutoff (new-convention cutoff is
        # 2026-05-18 EST). Tests covering post-cutoff behavior pass
        # `started_at=` explicitly.
        started_at=started_at or datetime(2026, 3, 15, tzinfo=timezone.utc),
        scheduled_start=None,
        scheduled_end=None,
        recording_start=None,
        recording_end=None,
        duration_seconds=duration_seconds,
        language="en",
        recording_url=None,
        share_link=None,
        participants=participants or [],
        recorded_by=None,
        utterances=[],
        transcript="",
        raw_text="",
    )


def _pt(email: str, name: str | None = None) -> Participant:
    return Participant(display_name=name or email.split("@")[0], email=email)


# ---------------------------------------------------------------------------
# Step 5 — short-file heuristic (runs first in the implementation)
# ---------------------------------------------------------------------------


def test_short_duration_excludes():
    record = _record(duration_seconds=45, participants=[_pt("lou@theaipartner.io")])
    result = c.classify(record, c.ClientResolver({}))
    assert result.call_category == "excluded"
    assert result.classification_method == "short_file_heuristic"


def test_small_file_excludes():
    record = _record(
        duration_seconds=600,
        participants=[_pt("lou@theaipartner.io"), _pt("scott@theaipartner.io")],
    )
    result = c.classify(record, c.ClientResolver({}), file_size_bytes=1024)
    assert result.call_category == "excluded"


def test_long_call_not_excluded():
    record = _record(
        duration_seconds=600,
        participants=[_pt("lou@theaipartner.io"), _pt("scott@theaipartner.io")],
    )
    result = c.classify(record, c.ClientResolver({}), file_size_bytes=50_000)
    assert result.call_category == "internal"  # 2 team + 0 external


# ---------------------------------------------------------------------------
# Step 3 — title pattern override (runs before participant match in impl)
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "title",
    ["CSM Sync", "csm_sync_weekly", "Backend Team Weekly Planning",
     "Backend_Team_Daily", "Fulf Sales Sync", "NCF Backend Sync"],
)
def test_title_patterns_force_internal(title):
    record = _record(
        title=title,
        participants=[
            _pt("nabeel@theaipartner.io"), _pt("scott@theaipartner.io"),
            _pt("external@example.com"),  # should NOT flip to client
        ],
    )
    result = c.classify(record, c.ClientResolver({"external@example.com": "c1"}))
    assert result.call_category == "internal"
    assert result.classification_method == "title_pattern"


def test_title_leadership_picks_leadership_call_type():
    record = _record(
        title="AUS Leadership Sync",
        participants=[
            _pt("nabeel@theaipartner.io"),
            _pt("scott@theaipartner.io"),
        ],
    )
    # Not in the internal override set, so falls to step 2 (2 team + 0 external → internal)
    result = c.classify(record, c.ClientResolver({}))
    assert result.call_category == "internal"


def test_title_without_pattern_falls_through():
    record = _record(
        title="Allison / Scott",
        participants=[_pt("scott@theaipartner.io"), _pt("allison@example.com")],
    )
    result = c.classify(record, c.ClientResolver({"allison@example.com": "c-allison"}))
    # Falls into step 2 → client (matched) high
    assert result.call_category == "client"
    assert result.primary_client_id == "c-allison"


# ---------------------------------------------------------------------------
# Step 4 — 30mins_with_Scott pattern
# ---------------------------------------------------------------------------


def test_scott_1on1_matched_client_high_confidence():
    record = _record(
        title="30mins with Scott (The AI Partner) (Abel Asfaw)",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("abel.f.asfaw@gmail.com", "Abel Asfaw"),
        ],
    )
    resolver = c.ClientResolver({"abel.f.asfaw@gmail.com": "c-abel"})
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_confidence == c.CONFIDENCE_HIGH
    assert result.classification_method == "title_pattern"
    assert result.primary_client_id == "c-abel"
    assert result.should_auto_create_client is None
    assert result.should_be_retrievable is True


def test_scott_1on1_unmatched_requests_auto_create():
    record = _record(
        title="30mins with Scott (The AI Partner) (Random Prospect)",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("prospect@example.com", "Random Prospect"),
        ],
    )
    resolver = c.ClientResolver({})   # email not in clients
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_confidence == c.CONFIDENCE_MEDIUM
    assert result.primary_client_id is None
    assert result.should_auto_create_client is not None
    assert result.should_auto_create_client.email == "prospect@example.com"
    assert result.should_auto_create_client.display_name == "Random Prospect"
    # Medium confidence never passes the retrievability floor.
    assert result.should_be_retrievable is False


def test_scott_1on1_underscored_title_also_matches():
    record = _record(
        title="30mins_with_Scott_The_AI_Partner_Abel_Asfaw",
        participants=[_pt("scott@theaipartner.io"), _pt("abel@example.com")],
    )
    result = c.classify(record, c.ClientResolver({"abel@example.com": "c-abel"}))
    assert result.call_category == "client"
    assert result.classification_method == "title_pattern"


# ---------------------------------------------------------------------------
# Step 2 — participant match (when no title override fires)
# ---------------------------------------------------------------------------


def test_two_team_no_external_internal():
    record = _record(
        title="Drake / Scott",
        participants=[_pt("drake@theaipartner.io"), _pt("scott@theaipartner.io")],
    )
    result = c.classify(record, c.ClientResolver({}))
    assert result.call_category == "internal"
    assert result.classification_confidence == c.CONFIDENCE_HIGH


def test_external_matches_client_row_sets_primary_client():
    record = _record(
        title="Jenny / Scott",
        participants=[_pt("scott@theaipartner.io"), _pt("jenny@example.com")],
    )
    result = c.classify(record, c.ClientResolver({"jenny@example.com": "c-jenny"}))
    assert result.call_category == "client"
    assert result.primary_client_id == "c-jenny"
    assert result.should_be_retrievable is True


def test_external_no_match_medium_external():
    record = _record(
        title="Prop Logic",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("john@proplogic.com"),
        ],
    )
    result = c.classify(record, c.ClientResolver({}))
    assert result.call_category == "external"
    assert result.classification_confidence == c.CONFIDENCE_MEDIUM


# ---------------------------------------------------------------------------
# Step 2.5 — Aman sales override
# ---------------------------------------------------------------------------


def test_aman_no_csm_external_becomes_sales():
    record = _record(
        title="Setter 1st Interview",
        participants=[
            _pt("aman@theaipartner.io"),
            _pt("prospect@example.com"),
        ],
    )
    result = c.classify(record, c.ClientResolver({}))
    assert result.call_category == "external"
    assert result.call_type == "sales"
    assert result.classification_confidence == c.CONFIDENCE_HIGH


def test_aman_with_csm_does_not_override():
    """If a CSM is on the call, it's not a pure sales call. Keep the
    medium-external classification."""
    record = _record(
        title="Prop Logic",
        participants=[
            _pt("aman@theaipartner.io"),
            _pt("lou@theaipartner.io"),   # CSM present
            _pt("prospect@example.com"),
        ],
    )
    result = c.classify(record, c.ClientResolver({}))
    assert result.call_category == "external"
    assert result.call_type is None
    assert result.classification_confidence == c.CONFIDENCE_MEDIUM


def test_aman_on_client_call_does_not_override():
    """When the external matches a known client, participant_match
    already says `client`. Aman's presence shouldn't downgrade it."""
    record = _record(
        title="Allison check-in",
        participants=[
            _pt("aman@theaipartner.io"),
            _pt("allison@example.com"),
        ],
    )
    result = c.classify(record, c.ClientResolver({"allison@example.com": "c-allison"}))
    assert result.call_category == "client"
    assert result.primary_client_id == "c-allison"


# ---------------------------------------------------------------------------
# Step 6 — retrievability floor
# ---------------------------------------------------------------------------


def test_retrievability_requires_high_confidence_client_with_primary():
    # client + high + primary → True
    high = c.ClassificationResult(
        call_category="client",
        call_type="coaching",
        classification_confidence=c.CONFIDENCE_HIGH,
        classification_method="title_pattern",
        primary_client_id="c-1",
    )
    assert high.should_be_retrievable is True

    # client + medium + primary → False
    medium = c.ClassificationResult(
        call_category="client",
        call_type="coaching",
        classification_confidence=c.CONFIDENCE_MEDIUM,
        classification_method="title_pattern",
        primary_client_id="c-1",
    )
    assert medium.should_be_retrievable is False

    # client + high + no primary → False
    no_primary = c.ClassificationResult(
        call_category="client",
        call_type="coaching",
        classification_confidence=c.CONFIDENCE_HIGH,
        classification_method="title_pattern",
        primary_client_id=None,
    )
    assert no_primary.should_be_retrievable is False

    # internal + high + whatever → False (not client)
    internal = c.ClassificationResult(
        call_category="internal",
        call_type="team_sync",
        classification_confidence=c.CONFIDENCE_HIGH,
        classification_method="title_pattern",
        primary_client_id=None,
    )
    assert internal.should_be_retrievable is False


# ---------------------------------------------------------------------------
# ClientResolver lookup semantics
# ---------------------------------------------------------------------------


def test_resolver_is_case_insensitive():
    resolver = c.ClientResolver({"Mixed@Example.com": "c-1"})
    assert resolver.lookup("mixed@example.com") == "c-1"
    assert resolver.lookup("MIXED@EXAMPLE.COM") == "c-1"


def test_resolver_returns_none_for_missing():
    resolver = c.ClientResolver({})
    assert resolver.lookup("missing@example.com") is None
    assert resolver.lookup("") is None


# ---------------------------------------------------------------------------
# Alternate email + alternate name matching
# ---------------------------------------------------------------------------


def test_resolver_lookup_by_name_matches_primary_and_alt_names():
    resolver = c.ClientResolver(
        client_id_by_email={"real@example.com": "c-real"},
        client_id_by_name={
            "Dhamen Hothi": "c-real",
            "DHAMEN HOTHI": "c-real",   # alternate_names entry
        },
    )
    assert resolver.lookup_by_name("Dhamen Hothi") == "c-real"
    # Case-insensitive, whitespace-stripped
    assert resolver.lookup_by_name("  dhamen hothi  ") == "c-real"
    assert resolver.lookup_by_name("DHAMEN HOTHI") == "c-real"
    assert resolver.lookup_by_name("Unknown Person") is None


def test_30mins_scott_matches_client_via_alternate_email():
    """Dhamen case: real row has metadata.alternate_emails =
    [dhamen@flowstatetech.co]. A new 30mins call with that alt email
    must resolve to the real client via email, not auto-create."""
    record = _record(
        title="30mins with Scott (The AI Partner) (DHAMEN HOTHI)",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("dhamen@flowstatetech.co", "DHAMEN HOTHI"),
        ],
    )
    resolver = c.ClientResolver(
        client_id_by_email={
            "dhamenhothi@gmail.com": "c-dhamen",
            "dhamen@flowstatetech.co": "c-dhamen",  # from alternate_emails
        },
        client_id_by_name={"Dhamen Hothi": "c-dhamen", "DHAMEN HOTHI": "c-dhamen"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_confidence == c.CONFIDENCE_HIGH
    assert result.primary_client_id == "c-dhamen"
    assert result.should_auto_create_client is None
    assert "email" in result.reasoning


def test_30mins_scott_falls_back_to_name_when_email_unknown():
    """If a participant's email isn't in the resolver but their
    display name matches an alternate_name on a real client, resolve
    via name and skip auto-create."""
    record = _record(
        title="30mins with Scott (The AI Partner) (King Musa)",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("brand_new_email@elsewhere.com", "King Musa"),
        ],
    )
    resolver = c.ClientResolver(
        client_id_by_email={"legendarywork1@gmail.com": "c-musa"},
        client_id_by_name={"Musa Elmaghrabi": "c-musa", "King Musa": "c-musa"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_confidence == c.CONFIDENCE_HIGH
    assert result.primary_client_id == "c-musa"
    assert result.should_auto_create_client is None
    assert "alternate_name" in result.reasoning


def test_participant_match_alt_email_promotes_external_to_client():
    """A non-30mins call with a participant whose alt-email matches a
    known client: step 2 participant_match should hit and classify
    as client, not external."""
    record = _record(
        title="Allison / Scott",  # ordinary client call title
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("javier@buildficial.com", "Javier Pena"),  # alt email of real Javi
        ],
    )
    resolver = c.ClientResolver(
        client_id_by_email={
            "javpen93@gmail.com": "c-javi",
            "javier@buildficial.com": "c-javi",  # alt
        },
        client_id_by_name={"Javi Pena": "c-javi", "Javier Pena": "c-javi"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_confidence == c.CONFIDENCE_HIGH
    assert result.primary_client_id == "c-javi"
    assert result.classification_method == "participant_match"


def test_unknown_name_and_email_still_auto_creates():
    """Regression guard: if neither email nor alt-name matches, the
    30mins path must still request auto-create. The new lookup
    behavior must not swallow unmatched participants."""
    record = _record(
        title="30mins with Scott (The AI Partner) (Brand New Prospect)",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("prospect@example.com", "Brand New Prospect"),
        ],
    )
    resolver = c.ClientResolver(
        client_id_by_email={"other@example.com": "c-other"},
        client_id_by_name={"Some Other Client": "c-other"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_confidence == c.CONFIDENCE_MEDIUM
    assert result.should_auto_create_client is not None
    assert result.should_auto_create_client.email == "prospect@example.com"


# ---------------------------------------------------------------------------
# New-convention cutoff (2026-05-18 EST onward) — spec: classifier-enforce-
# new-title-convention.md. Post-cutoff calls require one of the six
# canonical title patterns for `client` classification; pre-cutoff calls
# use the prior cascade unchanged.
# ---------------------------------------------------------------------------


from zoneinfo import ZoneInfo as _ZoneInfo

# Boundary moment (Mon May 18 2026 00:00 EST), used as the post-cutoff
# anchor for the tests below. May 19 is comfortably past EDT-side noise;
# the boundary itself is tested separately.
_POST_CUTOFF = datetime(2026, 5, 19, 14, 0, tzinfo=timezone.utc)
_PRE_CUTOFF = datetime(2026, 5, 17, 14, 0, tzinfo=timezone.utc)


def test_pre_cutoff_old_title_still_classifies_as_client():
    """Pre-cutoff: prior cascade unchanged. Participant match against
    a known client still promotes to `client`."""
    record = _record(
        title="[Client] Session with Scott (Andrew Hsu)",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com", "Andrew Hsu"),
        ],
        started_at=_PRE_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={"andrew@example.com": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_method == "participant_match"
    assert result.primary_client_id == "c-andrew"


def test_post_cutoff_new_title_classifies_as_client_with_confidence_one():
    """Post-cutoff: canonical new-convention title → `client`,
    method='title_pattern', confidence=1.0. Primary client resolved
    from external participant."""
    record = _record(
        title="Coaching Call with Scott",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com", "Andrew Hsu"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={"andrew@example.com": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.call_type == "coaching"
    assert result.classification_method == "title_pattern"
    assert result.classification_confidence == 1.0
    assert result.primary_client_id == "c-andrew"


def test_post_cutoff_sales_call_pattern_classifies_with_sales_type():
    """The 'Sales Call with X' family produces call_type='sales'."""
    record = _record(
        title="Sales Call with Lou",
        participants=[
            _pt("lou@theaipartner.io"),
            _pt("prospect@example.com", "Prospect"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={"prospect@example.com": "c-prospect"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.call_type == "sales"


def test_post_cutoff_new_title_with_trailing_extra_still_matches():
    """Case-insensitive prefix match — trailing context after the
    canonical prefix doesn't break the match."""
    record = _record(
        title="Coaching Call with Scott - Andrew Hsu follow-up",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com", "Andrew Hsu"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={"andrew@example.com": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_confidence == 1.0


def test_post_cutoff_old_style_title_does_not_classify_as_client():
    """The forcing function: post-cutoff calls with the old title style
    do NOT get promoted to `client` even when participant match would
    have classified them as such pre-cutoff."""
    record = _record(
        title="[Client] Session with Scott (Andrew Hsu)",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com", "Andrew Hsu"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={"andrew@example.com": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category != "client"
    # Suppression note lands in reasoning for audit.
    assert "post-cutoff title gate" in (result.reasoning or "")


def test_post_cutoff_adhoc_title_with_known_client_participant_does_not_classify_as_client():
    """Even with a known client on the invite, an ad-hoc title doesn't
    earn `client` classification. Falls through to `external`."""
    record = _record(
        title="Quick sync with Andrew",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com", "Andrew Hsu"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={"andrew@example.com": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "external"
    assert result.primary_client_id is None


def test_post_cutoff_case_variants_all_match():
    """ALL CAPS, all lowercase, and mixed-case titles all match the
    same patterns (case-insensitive prefix)."""
    for variant in (
        "COACHING CALL WITH SCOTT",
        "coaching call with scott",
        "Coaching Call With Scott",
        "  coaching call with scott  ",  # whitespace
    ):
        record = _record(
            title=variant,
            participants=[
                _pt("scott@theaipartner.io"),
                _pt("andrew@example.com", "Andrew Hsu"),
            ],
            started_at=_POST_CUTOFF,
        )
        resolver = c.ClientResolver(
            client_id_by_email={"andrew@example.com": "c-andrew"},
        )
        result = c.classify(record, resolver)
        assert result.call_category == "client", f"variant {variant!r} failed"
        assert result.classification_confidence == 1.0


def test_cutoff_boundary_inclusive():
    """`started_at` exactly at the cutoff moment uses the new logic."""
    boundary = datetime(2026, 5, 18, 0, 0, 0, tzinfo=_ZoneInfo("America/New_York"))
    one_min_before = datetime(2026, 5, 17, 23, 59, 0, tzinfo=_ZoneInfo("America/New_York"))

    # At-boundary call with old title → NOT client.
    record_at = _record(
        title="[Client] Session with Scott (Andrew)",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com"),
        ],
        started_at=boundary,
    )
    resolver = c.ClientResolver(
        client_id_by_email={"andrew@example.com": "c-andrew"},
    )
    assert c.classify(record_at, resolver).call_category != "client"

    # One-minute-before call with old title → still client (pre-cutoff
    # cascade applies).
    record_before = _record(
        title="[Client] Session with Scott (Andrew)",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com"),
        ],
        started_at=one_min_before,
    )
    assert c.classify(record_before, resolver).call_category == "client"


def test_post_cutoff_new_title_with_no_resolvable_client_auto_creates():
    """Auto-create on new patterns (auto-created-client-lifecycle
    spec, 2026-05-15): when the new title matches and no external
    participant resolves to a known client, the classifier emits an
    AutoCreateRequest so the pipeline reifies a minimal clients row
    tagged needs_review. Distinct reason string from the legacy
    Scott-1:1 path so audit queries can tell them apart.

    Reverses the prior-spec assertion. Prior behavior (no auto-create)
    was a side effect of the cutoff implementation; new behavior fills
    the gap so every post-cutoff client call gets a client row."""
    record = _record(
        title="Coaching Call with Scott",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("brand-new@unknown.com", "Brand New"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(client_id_by_email={})
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_confidence == 1.0
    assert result.primary_client_id is None
    assert result.should_auto_create_client is not None
    assert result.should_auto_create_client.email == "brand-new@unknown.com"
    assert result.should_auto_create_client.display_name == "Brand New"
    assert (
        result.should_auto_create_client.reason
        == "new title convention with unresolved participant"
    )


def test_post_cutoff_internal_title_still_internal():
    """Internal-title patterns (CSM Sync, etc.) still produce `internal`
    post-cutoff. The cutoff gate only governs `client` classification."""
    record = _record(
        title="CSM Sync",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("lou@theaipartner.io"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(client_id_by_email={})
    result = c.classify(record, resolver)

    assert result.call_category == "internal"


def test_post_cutoff_scott_1on1_does_not_classify_as_client():
    """The legacy `30mins with Scott` pattern is retired post-cutoff —
    it's a title pattern that produced `client`, and only the six
    canonical patterns can do that now."""
    record = _record(
        title="30mins with Scott (Andrew Hsu)",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com", "Andrew Hsu"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={"andrew@example.com": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category != "client"


def test_helper_matches_new_client_title_convention_edge_cases():
    """Direct coverage of the helper for empty / None / non-matching
    titles."""
    assert c._matches_new_client_title_convention(None) is False
    assert c._matches_new_client_title_convention("") is False
    assert c._matches_new_client_title_convention("   ") is False
    assert c._matches_new_client_title_convention("Some Other Call") is False
    # Prefix doesn't have to be the full string.
    assert c._matches_new_client_title_convention("Coaching Call with Scott") is True
    # All six canonical patterns return True.
    for pattern in (
        "Coaching Call with Scott",
        "Coaching Call with Lou",
        "Coaching Call with Nico",
        "Sales Call with Scott",
        "Sales Call with Lou",
        "Sales Call with Nico",
    ):
        assert c._matches_new_client_title_convention(pattern) is True


def test_helper_is_after_new_convention_cutoff_handles_iso_strings():
    """Helper accepts both datetime and ISO string. Naive ISO strings
    are treated as UTC."""
    assert c._is_after_new_convention_cutoff(None) is False
    assert c._is_after_new_convention_cutoff("not-a-date") is False
    # Z suffix tolerated.
    assert c._is_after_new_convention_cutoff("2026-05-19T14:00:00Z") is True
    assert c._is_after_new_convention_cutoff("2026-05-17T14:00:00Z") is False
    # Datetime branch.
    assert (
        c._is_after_new_convention_cutoff(
            datetime(2026, 5, 19, tzinfo=timezone.utc)
        )
        is True
    )


# ---------------------------------------------------------------------------
# Auto-create on new title convention (2026-05-15) — spec:
# auto-created-client-lifecycle. The pre-cutoff legacy Scott-1:1 auto-create
# stays; this section pins the new post-cutoff auto-create behavior.
# ---------------------------------------------------------------------------


def test_post_cutoff_new_title_matched_client_does_not_auto_create():
    """When the external participant resolves to a known client, no
    auto-create — the existing row is used as primary_client_id and
    should_auto_create_client stays None."""
    record = _record(
        title="Coaching Call with Scott",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com", "Andrew Hsu"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={"andrew@example.com": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.primary_client_id == "c-andrew"
    assert result.should_auto_create_client is None


def test_post_cutoff_new_title_multiple_unresolved_externals_auto_creates_first():
    """Rare but possible: a client invites a coworker we don't know
    about. V1 simple: auto-create the FIRST unresolved external email.
    Others surface through call_participants for later manual review.
    Spec § "Multiple unresolved external participants"."""
    record = _record(
        title="Sales Call with Nico",
        participants=[
            _pt("nico@theaipartner.io"),
            _pt("first-unknown@example.com", "First Unknown"),
            _pt("second-unknown@example.com", "Second Unknown"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(client_id_by_email={})
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.primary_client_id is None
    assert result.should_auto_create_client is not None
    # FIRST external (participants list order) wins.
    assert (
        result.should_auto_create_client.email == "first-unknown@example.com"
    )


def test_post_cutoff_new_title_no_external_participants_no_auto_create():
    """Degenerate but valid: booking-link title with only team members
    on the invite. Row lands as client with no primary, no auto-create.
    Surfaces as a data hygiene flag without polluting clients table."""
    record = _record(
        title="Coaching Call with Scott",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("lou@theaipartner.io"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(client_id_by_email={})
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_confidence == 1.0
    assert result.primary_client_id is None
    assert result.should_auto_create_client is None


def test_post_cutoff_auto_create_distinct_reason_from_scott_1on1():
    """Reason string distinguishes new-convention auto-creates from the
    legacy Scott-1:1 path's auto-creates. Audit queries can split via
    metadata.auto_create_reason (set by the pipeline from this field)."""
    record = _record(
        title="Coaching Call with Lou",
        participants=[
            _pt("lou@theaipartner.io"),
            _pt("unknown@example.com", "Unknown"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(client_id_by_email={})
    result = c.classify(record, resolver)

    assert result.should_auto_create_client is not None
    assert (
        result.should_auto_create_client.reason
        == "new title convention with unresolved participant"
    )
    # Distinct from the legacy AutoCreateRequest default:
    assert (
        result.should_auto_create_client.reason
        != "30mins_with_Scott pattern with unresolved participant"
    )


def test_pre_cutoff_new_title_does_not_take_new_path():
    """Pre-cutoff calls with new-convention titles still go through
    the prior cascade — they classify as client via participant match
    if the participant resolves, NOT via the new-convention path. No
    new-convention auto-create on pre-cutoff calls."""
    record = _record(
        title="Coaching Call with Scott",  # matches new pattern
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("unknown@example.com", "Unknown"),
        ],
        started_at=_PRE_CUTOFF,
    )
    resolver = c.ClientResolver(client_id_by_email={})
    result = c.classify(record, resolver)

    # Pre-cutoff falls to participant match. Unknown email + no client
    # resolver → external (not client). No new-convention auto-create.
    assert result.call_category != "client"
    assert result.should_auto_create_client is None


# ---------------------------------------------------------------------------
# Title convention v2 — `[Client Name] - Coaching/Sales Call with {CSM}`
# spec: cost-hub-effective-from-and-title-convention-v2
# ---------------------------------------------------------------------------


def test_v2_title_name_resolves_to_existing_client():
    """v2 title + name prefix resolves via lookup_by_name → primary set,
    method='title_pattern_v2', reasoning mentions the name + call_type."""
    record = _record(
        title="Andrew Hsu - Coaching Call with Scott",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com", "Andrew Hsu"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={"andrew@example.com": "c-andrew"},
        client_id_by_name={"Andrew Hsu": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.call_type == "coaching"
    assert result.classification_method == "title_pattern_v2"
    assert result.classification_confidence == 1.0
    assert result.primary_client_id == "c-andrew"
    assert "name prefix" in result.reasoning.lower()


def test_v2_title_name_resolves_even_when_email_does_not_match():
    """Name prefix is the PRIMARY signal — resolves even when the
    participant joined from an email not in the resolver."""
    record = _record(
        title="Andrew Hsu - Coaching Call with Scott",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("different-email@example.com", "Andrew Hsu"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={},  # email NOT mapped
        client_id_by_name={"Andrew Hsu": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_method == "title_pattern_v2"
    assert result.primary_client_id == "c-andrew"
    assert result.should_auto_create_client is None


def test_v2_title_name_misses_email_resolves():
    """Name prefix doesn't resolve → fall back to email resolution.
    Still v2-shaped so method stays title_pattern_v2."""
    record = _record(
        title="Unknown Person - Coaching Call with Scott",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("known@example.com", "Unknown Person"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={"known@example.com": "c-known"},
        client_id_by_name={},  # name NOT indexed
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_method == "title_pattern_v2"
    assert result.primary_client_id == "c-known"


def test_v2_title_neither_name_nor_email_resolves_auto_creates():
    """v2 title, name + email both unresolvable → AutoCreateRequest
    for the first external email (same safety net as v1)."""
    record = _record(
        title="Unknown Person - Coaching Call with Scott",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("nobody@example.com", "Unknown Person"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(client_id_by_email={}, client_id_by_name={})
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_method == "title_pattern_v2"
    assert result.primary_client_id is None
    assert result.should_auto_create_client is not None
    assert result.should_auto_create_client.email == "nobody@example.com"
    assert (
        result.should_auto_create_client.reason
        == "new title convention with unresolved participant"
    )


def test_v2_title_no_external_participants_no_auto_create():
    """v2 title but only team on the invite → client, no primary, no
    auto-create (degenerate-but-valid, same as v1)."""
    record = _record(
        title="Andrew Hsu - Coaching Call with Scott",
        participants=[_pt("scott@theaipartner.io")],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(client_id_by_email={}, client_id_by_name={})
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_method == "title_pattern_v2"
    assert result.primary_client_id is None
    assert result.should_auto_create_client is None


def test_v2_title_pre_cutoff_uses_prior_cascade():
    """v2-shaped title before the cutoff → prior cascade, not the
    new-convention path. Participant match against a known client."""
    record = _record(
        title="Andrew Hsu - Coaching Call with Scott",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com", "Andrew Hsu"),
        ],
        started_at=_PRE_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={"andrew@example.com": "c-andrew"},
        client_id_by_name={"Andrew Hsu": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_method == "participant_match"
    assert result.primary_client_id == "c-andrew"


def test_v1_title_post_cutoff_still_works_regression():
    """v1 canonical title post-cutoff still classifies cleanly and
    keeps classification_method='title_pattern' (NOT v2)."""
    record = _record(
        title="Coaching Call with Scott",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com", "Andrew Hsu"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={"andrew@example.com": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_method == "title_pattern"
    assert result.primary_client_id == "c-andrew"


def test_v2_title_trailing_context_tolerated():
    """Trailing context after the CSM name still matches v2."""
    record = _record(
        title="Andrew Hsu - Coaching Call with Scott - May 22 follow up",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com", "Andrew Hsu"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={},
        client_id_by_name={"Andrew Hsu": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_method == "title_pattern_v2"
    assert result.primary_client_id == "c-andrew"


def test_v2_title_case_insensitive():
    """ALL-CAPS / mixed-case v2 title still matches + resolves by name
    (lookup_by_name is case-insensitive)."""
    record = _record(
        title="ANDREW HSU - coaching call with SCOTT",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com", "Andrew Hsu"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={},
        client_id_by_name={"Andrew Hsu": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_method == "title_pattern_v2"
    assert result.call_type == "coaching"
    assert result.primary_client_id == "c-andrew"


def test_v2_title_whitespace_trimmed():
    """Leading/trailing whitespace + padded separators still match."""
    record = _record(
        title="  Andrew Hsu  -  Coaching Call with Scott  ",
        participants=[
            _pt("scott@theaipartner.io"),
            _pt("andrew@example.com", "Andrew Hsu"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={},
        client_id_by_name={"Andrew Hsu": "c-andrew"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.classification_method == "title_pattern_v2"
    assert result.primary_client_id == "c-andrew"


def test_v2_sales_title_derives_sales_call_type():
    """v2 'Sales Call with X' → call_type='sales' from the regex
    capture (distinct classification_method from v1)."""
    record = _record(
        title="Prospect Co - Sales Call with Nico",
        participants=[
            _pt("nico@theaipartner.io"),
            _pt("prospect@example.com", "Prospect Co"),
        ],
        started_at=_POST_CUTOFF,
    )
    resolver = c.ClientResolver(
        client_id_by_email={},
        client_id_by_name={"Prospect Co": "c-prospect"},
    )
    result = c.classify(record, resolver)

    assert result.call_category == "client"
    assert result.call_type == "sales"
    assert result.classification_method == "title_pattern_v2"
    assert result.primary_client_id == "c-prospect"
