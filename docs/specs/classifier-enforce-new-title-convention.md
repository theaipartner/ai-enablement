# Enforce new title convention for client classification (cutoff: Mon May 18 EST)

**Slug:** classifier-enforce-new-title-convention
**Status:** in-flight

## Context

Drake is pushing The AI Partner team to use Zain's new booking links exclusively. The links generate one of six canonical titles:

- `Coaching Call with Scott`
- `Coaching Call with Lou`
- `Coaching Call with Nico`
- `Sales Call with Scott`
- `Sales Call with Lou`
- `Sales Call with Nico`

This is a deliberate forcing function. Nabeel expects Drake to make the new convention happen as part of growing into the Director role; making non-compliance technically visible (via classification dropping out) is the lever. CSMs who keep using ad-hoc titles or pre-existing recurring meetings will find their calls don't classify as `client` — they won't show on `/clients/[id]`, won't get retrieved by Ella, won't appear correctly on `/teams`. The cost of forgetting is real, and that's the point.

**The cutoff is by `calls.started_at`, not by ingestion time:**

- `started_at < 2026-05-18T00:00:00 America/New_York` (Mon May 18, midnight EST) → existing classification logic applies, no change.
- `started_at >= cutoff` → title must match one of the six canonical patterns (case-insensitive prefix match) for the call to be eligible for `client` classification.

**Historical calls are preserved.** Calls already classified as `client` via the old patterns (`"[Client] Session with..."`, participant-match, LLM fallback) keep their classification. No retroactive reclassification. Ella's retrieval, client detail pages, and existing analytics surfaces stay intact.

## Files Builder reads first (acclimatization)

1. `ingestion/fathom/classifier.py` — the auto-classifier. The new logic slots into the `title_pattern` step (probably) but Builder confirms where the current pattern matching lives. Read the full file.
2. `ingestion/fathom/pipeline.py` — to confirm where `classifier.classify()` is invoked and whether `started_at` is available at that point (it should be — Fathom delivers it on the webhook).
3. `docs/schema/calls.md` — confirm `call_category`, `call_type`, `classification_method`, `classification_confidence` semantics. The new pattern's method label is what we set.
4. `tests/ingestion/fathom/test_classifier.py` (if it exists, else where current classifier tests live) — pattern Builder mirrors for the new tests.
5. The webhook adapter / pipeline entry — to confirm that calls flowing in carry their `started_at` reliably (UTC ISO string from Fathom).

After reading, confirm in 4-5 bullets:
- Where in `classifier.py` the title-pattern step lives today.
- What the function signature of the entry classifier function looks like (so the spec's new gate slots cleanly).
- Whether `started_at` is reliably present at classification time.
- Whether `participant_match` runs BEFORE or AFTER `title_pattern` today (the cutoff logic affects both — see below).

## Decisions baked in (do NOT re-litigate)

- **Cutoff is hard, not soft.** Calls at or after Mon May 18 12:00 AM EST that don't match the new pattern do NOT get classified as `client` — even if participant match would normally classify them as client. This is the forcing function. A call where Scott + a known client both attended, but the title is "Quick sync with Andrew" — under the new rule, this is NOT a client call.
- **Pattern matching is case-insensitive prefix match.** `title.lower().startswith(pattern.lower())`. Both Drake's typed-out list and the actual booking links will produce one canonical form, but case variations + trailing extras ("Coaching Call with Scott - Andrew Hsu follow-up") are tolerated.
- **The six patterns are the entire list.** Coaching + Sales × Scott / Lou / Nico. Aman, Zain, and others not included — they don't take client calls via these booking links today. Adding them is a future spec when their links exist.
- **Onboarding calls:** Drake will instruct the team to use one of the Coaching/Sales patterns for onboarding too, OR have Zain create an Onboarding link. Until that decision is made, onboarding calls that don't match the six patterns will drop to non-client under the new rule. That's acceptable — the friction surfaces the gap.
- **Cutoff is `started_at >= 2026-05-18T00:00:00` in America/New_York.** Builder must use `zoneinfo.ZoneInfo("America/New_York")` for the comparison — NOT a fixed UTC offset. DST safety, same as the calendar cron's week-window math.
- **`classification_method` for new-pattern matches:** `'title_pattern'` (same as today's title-pattern matches). Confidence: `1.0` for new-pattern matches. The new patterns are the strongest signal we have.
- **Fall-through behavior for post-cutoff calls that don't match:** the classifier continues through its existing steps (participant match, LLM fallback, etc.) but participant match is NOT allowed to classify as `client` anymore for post-cutoff calls. They go to `internal`, `external`, or `unclassified` based on the rest of the logic.
- **No retroactive reclassification of historical calls.** The cutoff is checked at classify time using `started_at`. A call ingested today with `started_at` from last month still uses old logic. Forward-only.
- **Behavior on title edge cases:**
  - Empty title → existing logic applies (probably falls through to LLM or unclassified). The new gate only fires if there's a title to check.
  - Title with leading/trailing whitespace → trim before matching.
  - Title with extra prefixes like "FW:" or "Re:" or "[CANCELED]" → my lean: don't strip. The booking link won't generate these; if a CSM manually edits the title with a prefix, that's drift from the convention and should fail the match. Surface as a forcing-function effect.

## Implementation

### 1. Add the cutoff + pattern constants

In `ingestion/fathom/classifier.py`, near the existing pattern constants:

```python
from zoneinfo import ZoneInfo

# Cutoff: Mon May 18, 2026 00:00 America/New_York. Calls with
# started_at >= this point require a new-convention title to be
# classified as `client`. See
# docs/specs/classifier-enforce-new-title-convention.md.
_NEW_TITLE_CONVENTION_CUTOFF = datetime(
    2026, 5, 18, 0, 0, 0, tzinfo=ZoneInfo("America/New_York")
)

# Canonical new-convention titles, lowercased for case-insensitive
# prefix match. Booking links generate these exactly; CSMs scheduling
# outside the links must match the prefix for client classification
# to fire.
_NEW_CLIENT_TITLE_PATTERNS: tuple[str, ...] = (
    "coaching call with scott",
    "coaching call with lou",
    "coaching call with nico",
    "sales call with scott",
    "sales call with lou",
    "sales call with nico",
)
```

### 2. Helper function

```python
def _matches_new_client_title_convention(title: str | None) -> bool:
    """Return True iff title (case-insensitive, leading whitespace
    trimmed) starts with one of the six canonical new-convention
    titles. Empty / None titles return False.
    """
    if not title:
        return False
    normalized = title.strip().lower()
    if not normalized:
        return False
    return any(normalized.startswith(p) for p in _NEW_CLIENT_TITLE_PATTERNS)


def _is_after_new_convention_cutoff(started_at: datetime | str | None) -> bool:
    """Return True iff started_at is on or after the new-convention
    cutoff. Accepts datetime or ISO string. Returns False on None
    (defensive — pre-cutoff behavior is the safe default if a call
    somehow lacks started_at).
    """
    if started_at is None:
        return False
    if isinstance(started_at, str):
        try:
            started_at = datetime.fromisoformat(started_at.replace("Z", "+00:00"))
        except ValueError:
            return False
    if started_at.tzinfo is None:
        # Naive datetime — assume UTC, the convention everywhere else
        # in the codebase.
        started_at = started_at.replace(tzinfo=timezone.utc)
    return started_at >= _NEW_TITLE_CONVENTION_CUTOFF
```

### 3. Wire into the classifier

Builder reads the classifier first and confirms where to wire the gate. My best guess at the shape (verify against actual code):

```python
def classify_call(call_data: dict) -> ClassificationResult:
    title = call_data.get("title")
    started_at = call_data.get("started_at")

    # Post-cutoff path: require new-convention title for client class.
    if _is_after_new_convention_cutoff(started_at):
        if _matches_new_client_title_convention(title):
            return ClassificationResult(
                call_category="client",
                classification_method="title_pattern",
                classification_confidence=1.0,
                # ... derive primary_client_id from existing participant
                # match logic, since we still want the client identity
            )
        # Title doesn't match new convention. Skip the existing
        # participant-match-as-client path entirely; fall through to
        # internal/external/unclassified logic.
        return _classify_non_client(call_data)

    # Pre-cutoff path: existing logic unchanged.
    return _classify_pre_cutoff(call_data)
```

The exact factoring depends on the existing code structure. Builder picks the cleanest seam — the goal is: post-cutoff calls that don't match the new pattern can NEVER get `call_category='client'` from automatic classification, regardless of participants. They can still be flipped to `client` manually via `update_call_classification` (the existing RPC) — that's the escape hatch for legitimate edge cases.

### 4. Primary client resolution still uses participant match

When the new pattern DOES match, we still need to figure out which client the call is for. Existing participant-match logic resolves that (attendee emails → `clients.id`). The new pattern gate doesn't replace participant resolution; it gates whether `client` category fires at all.

If the new pattern matches but no client can be resolved from participants → `call_category='client'`, `primary_client_id=null`. Per the schema, this is allowed (other client calls have null primary_client_id when the attendee couldn't be resolved). The Fathom auto-create-client logic that Drake flagged earlier still fires here — that's a separate concern.

### 5. Tests

Add to `tests/ingestion/fathom/test_classifier.py` (or wherever):

- **Pre-cutoff call with old title** (`"[Client] Session with Scott (Andrew Hsu)"`, started_at = May 17): classifies as `client` via existing logic.
- **Post-cutoff call with new title** (`"Coaching Call with Scott"`, started_at = May 19): classifies as `client`, method=`title_pattern`, confidence=1.0.
- **Post-cutoff call with new title + trailing extra** (`"Coaching Call with Scott - Andrew Hsu"`, started_at = May 19): classifies as `client`.
- **Post-cutoff call with old title** (`"[Client] Session with Scott (Andrew Hsu)"`, started_at = May 19): does NOT classify as `client`. Falls through to internal/external/unclassified.
- **Post-cutoff call with ad-hoc title + known client participant** (`"Quick sync with Andrew"`, Andrew is in clients table, started_at = May 19): does NOT classify as `client`. The participant match doesn't override the missing pattern.
- **Post-cutoff call with case-variant title** (`"COACHING CALL WITH SCOTT"` or `"coaching call with scott"`): all classify as `client`.
- **Cutoff boundary**: started_at exactly at `2026-05-18T00:00:00 EST` → uses new logic. One minute before → uses old logic.
- **DST safety**: Builder writes one test crossing into November DST shift (May 18 is before DST end so this is forward-looking, but the test pattern matters for the codebase). Skip if Builder confirms the cutoff date is far enough from DST boundaries to not matter; flag in report.

### 6. Doc updates

- `docs/schema/calls.md` — under "Category Semantics" or "Populated By," add a paragraph about the May 18 cutoff and the title-convention enforcement.
- `docs/agents/gregory.md` — if there's a relevant section on call classification, note the new enforcement.
- `docs/state.md` — entry describing what shipped.
- New: `docs/runbooks/call_title_convention.md` — short ops doc covering: the six patterns, why the cutoff exists, how to retroactively fix a misclassified call (point at the dashboard's Calls detail page manual-override flow + the `update_call_classification` RPC), what to tell a CSM whose call didn't classify correctly.

### 7. Communications artifact (not in spec, Drake's job)

Drake needs to send a Slack message to the team Monday morning announcing the change. Not part of the spec — but worth knowing the team should be told this is happening before the first call lands. Spec ships Friday, takes effect Monday; gives one weekend for the warning shot.

## What success looks like

1. **Pre-cutoff calls unaffected.** Backfill any old call through the classifier (e.g., re-trigger ingestion on a historical row) — same result as before.
2. **Post-cutoff call with new title** classifies as `client` with `method=title_pattern`, `confidence=1.0`.
3. **Post-cutoff call with old title** does NOT classify as `client`. Goes to `unclassified` or `internal` based on the rest of the logic.
4. **Post-cutoff call with new title + trailing client name** still matches.
5. **Manual override via `update_call_classification` still works** to fix mis-classified calls. The Calls detail page Save button keeps functioning.
6. **All tests pass.** `pytest tests/` green.

## Hard stops

- **Don't retroactively reclassify historical calls.** Cutoff is at `started_at` time, not at ingestion time. A call with old `started_at` re-ingested today still gets old logic.
- **Don't add patterns beyond the six.** Aman, Zain, etc. aren't included. Future spec when their links exist.
- **Don't change `update_call_classification` RPC.** The manual override path stays. CSMs who need to fix a miscategorized call still can.
- **Don't auto-create or auto-modify the existing client auto-create-on-classification logic** in the pipeline. That's a separate concern (and a separate upcoming spec per Drake).

## What could go wrong

- **A CSM books outside the link for a legitimate reason** (client requests an emergency time outside booking-link hours). Call gets titled ad-hoc → doesn't classify as client → doesn't surface correctly on `/clients`. **This is intended behavior.** The friction is the lever. If it gets too painful, the CSM rebooks through the link or comes to Drake; both reinforce the convention.
- **A booking-link title gets typo'd** (Zain's link is `"Coaching call with Scott"` lowercase 'c'). Case-insensitive prefix match handles it. But if Zain's link is `"Coaching Sessions with Scott"` (different noun), it won't match. Drake should verify the actual link titles match the spec's six patterns before merge — paste a real booking link title into chat as proof if uncertain.
- **A historical recurring meeting** (set up months ago with title `"Weekly check-in with Scott"`) keeps generating instances post-cutoff. Those instances don't classify as `client`. CSMs need to either rename the recurring series or delete + rebook via the new link. Visibility via `/teams` will surface which CSMs have lingering legacy recurrings.
- **A call's `started_at` is missing or malformed.** `_is_after_new_convention_cutoff` returns False on missing — meaning the call uses pre-cutoff logic (safer default). Builder logs a warning if this case actually fires in production.
- **DST around the cutoff.** May 18 is in EDT (UTC-4). November is when DST ends. Builder confirms `ZoneInfo("America/New_York")` handles the boundary; if cutoff date ever moves to fall, this matters more.

## Mandatory doc-update list

- `ingestion/fathom/classifier.py` — new constants, helpers, cutoff gate.
- `tests/ingestion/fathom/test_classifier.py` — new tests per § Tests.
- `docs/schema/calls.md` — cutoff note.
- `docs/runbooks/call_title_convention.md` — new file.
- `docs/state.md` — entry.
- `docs/agents/gregory.md` — only if classification is documented there.

## Commit shape

One feature commit ("feat: enforce new title convention for post-2026-05-18 client classification"). One docs commit. One report commit. Push at end.
