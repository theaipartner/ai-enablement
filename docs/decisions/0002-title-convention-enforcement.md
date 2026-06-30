# ADR 0002: Enforce Booking-Link Title Convention for Client Classification

**Date:** 2026-05-15
**Status:** Accepted
**Decision makers:** Engineering (with Nabeel as the organizational stakeholder pushing for the management lever)

## Context

The Fathom classifier (`ingestion/fathom/classifier.py`) attributes incoming calls to a `call_category` — `client`, `internal`, `external`, `unclassified`, or `excluded`. Pre-cutoff (before May 18, 2026), the cascade for client classification was a mix of title patterns (`[Client] Session with X`, `30mins with Scott`), participant-match (any known client email on the invite), and LLM fallback. Workable, but two problems compounded:

1. **CSMs had no enforcement loop.** A CSM could schedule a client call with any title — Fathom + the classifier would pick it up via participant match, and the call would appear correctly on `/clients`. The CSM never learned what made a meeting "discoverable" by the system, so titling drift accumulated. Recurring meetings from months ago still fired weekly under names nobody would write today.
2. **Nabeel wanted the title convention to land.** Zain created standardized booking links that generate one of six canonical titles (`Coaching Call with {Scott|Lou|Nico}` or `Sales Call with {Scott|Lou|Nico}`). Adoption was inconsistent because the cost of bypassing the link was zero — ad-hoc-titled calls still classified correctly via participant match.

The framing: the convention needs a management lever, not a memo. Making non-compliance technically visible (via classification dropping out, not just a dashboard pill) creates the loop where a CSM who books outside the link can immediately see the call doesn't show up where expected. The friction is the lever.

## Decision

Enforce a hard cutoff at **`started_at >= 2026-05-18T00:00:00 America/New_York`**. Calls at or after that point can only auto-classify as `call_category='client'` when the title matches one of the six canonical patterns (case-insensitive prefix, trailing context tolerated):

- `Coaching Call with Scott`
- `Coaching Call with Lou`
- `Coaching Call with Nico`
- `Sales Call with Scott`
- `Sales Call with Lou`
- `Sales Call with Nico`

Post-cutoff calls failing the pattern check fall through to `internal` / `external` / `unclassified` based on participant shape. Participant-match cannot promote to `client` post-cutoff. Pre-cutoff calls use the prior cascade unchanged; **no retroactive reclassification**.

The implementation lives in `ingestion/fathom/classifier.py` (constants `_NEW_TITLE_CONVENTION_CUTOFF` + `NEW_CLIENT_TITLE_PATTERNS`, helpers `_matches_new_client_title_convention` + `_is_after_new_convention_cutoff` + `_classify_by_new_convention`, plus the `allow_client_classification` gate flag on `_classify_by_participants`). Operational guide at `docs/runbooks/call_title_convention.md`.

### Safety net

The forcing function would silently drop legitimate edge cases if there were no recovery path. Three exist:

1. **Auto-create on new-pattern matches.** When a post-cutoff call's title matches but no external participant resolves to a known client, the classifier emits an `AutoCreateRequest`. The pipeline reifies a minimal `clients` row tagged `needs_review`. This catches new prospects who book through the link before being formally onboarded.
2. **Merge + Mark-as-reviewed UI on `/clients/[id]`.** Auto-created rows surface in the existing "Needs review" filter on `/clients`; the detail page renders a Merge button (calls `merge_clients` RPC, migration 0015) + a "Mark as reviewed" button. CSMs can sweep the queue with two clicks per row.
3. **Manual classification override via the `update_call_classification` RPC.** The Calls detail page's classification section stays editable. If a CSM books outside the link for a legitimate reason (emergency reschedule, client preference), the override flips the row to `client` manually. Discouraged but always available.

## Consequences

### Positive

- **Adoption pressure is automatic.** Non-compliant calls drop out of `/clients`, Ella's retrieval, and `/teams` Fathom-match checkmarks. The CSM sees the gap within a render cycle, not at a quarterly review.
- **The booking-link UX becomes the path of least resistance.** Zain's links produce canonical titles automatically. No memorization, no drift.
- **Auto-create + merge UI gives a clean recovery path.** Unresolved external participants don't fall through silently — they surface as a needs-review row CSMs can act on.
- **Historical data is preserved.** No retroactive reclassification means existing `/clients` views, Ella's retrieval, and analytics don't lose context.

### Negative / accepted costs

- **CSMs who don't read the announcement will be confused.** A Slack message goes to the team Sunday evening so the cutoff isn't a surprise Monday morning. Beyond that, the friction is the teaching mechanism.
- **Legacy recurring meetings keep generating non-classifying instances.** Each weekly check-in titled `Weekly review with Andrew` continues to fire post-cutoff and drop out. CSMs either rename the recurring series or delete + rebook via the link. Visibility into which series are still firing is via the audit SQL in the runbook.
- **One forced manual cleanup category: legitimate emergency-rebooked calls outside the link.** The manual-override RPC handles these. If the count of overrides grows, it's a signal the convention has too-narrow patterns and a future spec adds more (e.g., onboarding-specific or sales-followup-specific patterns).
- **First Monday-Tuesday will have a learning curve.** Expect to field one or two "why didn't my call show up?" questions; the runbook's debugging recipe is the answer. By Wednesday the friction has done its job.

### Not what this changes

- The seven existing internal-title patterns (`csm sync`, `backend team`, etc.) keep producing `internal`. They were always title-based; the cutoff gate only governs `client` classification.
- The 30-day `call_review` document lookback for the Gregory brain is untouched. Calls that don't classify as `client` simply don't get reviews — same as today's non-client calls.
- Ella's retrieval gate (`is_retrievable_by_client_agents`) is untouched. The cutoff doesn't change Ella's safety posture; it just changes which calls reach the gate.

## Implementation pointers

- **Code:** `ingestion/fathom/classifier.py`.
- **Tests:** `tests/ingestion/fathom/test_classifier.py` (look for `test_pre_cutoff_*`, `test_post_cutoff_*`, `test_cutoff_boundary_*`).
- **Auto-create safety net:** `docs/runbooks/auto_created_client_management.md`.
- **Operational guide:** `docs/runbooks/call_title_convention.md`.

## Revision: 2026-05-15 — v2 name-prefixed titles

**What changed.** Zain naturally iterated the booking-link convention from `Coaching Call with Scott` to `Andrew Hsu - Coaching Call with Scott` — the client's name now prefixes the canonical pattern. This is a refinement of the same forcing function, not a new policy.

**Decisions:**

- **Both v1 and v2 patterns stay valid indefinitely. No second cutoff.** v1 (`Coaching/Sales Call with {Scott|Lou|Nico}`) and v2 (`[Client Name] - Coaching/Sales Call with {Scott|Lou|Nico}`) both classify as `client` post-2026-05-18. A booking link mid-migration may emit either; both work. There is no v2 cutoff date — adding one would re-introduce the exact confusion the original ADR's safety net exists to prevent.
- **v2 uses the name prefix as the PRIMARY client-resolution signal; participant email is the backup.** When a v2-shaped title resolves its name prefix via `ClientResolver.lookup_by_name`, that sets `primary_client_id` directly — no dependency on the participant's email being mapped. If the name doesn't resolve (client joined from an unmapped email, or a duplicate-`full_name` collision left this client un-indexed in the name map), the classifier falls back to the existing participant-email resolution. If neither resolves, the same `AutoCreateRequest` safety net fires.
- **v2 matches surface `classification_method='title_pattern_v2'`** (v1 stays `'title_pattern'`) so audit queries can split adoption of the two conventions.
- **Why no separate ADR 0003.** Same management lever, same forcing function, same safety net, same fence — v2 is strictly an improvement to the title shape, not a new decision. A separate ADR would imply a separate policy choice; there isn't one. This revision section is the durable record.

**Collision surface.** `ClientResolver.lookup_by_name` indexes a single `client_id` per normalized `full_name`. If two non-archived clients share a name, only one is name-resolvable; the other gracefully falls back to email matching. A SQL count of duplicate non-archived `full_name` values returned **0 groups** at implementation time (2026-05-15) — no clients currently collide. Revisit if that count climbs (the spec's threshold was >5).

**Implementation:** `ingestion/fathom/classifier.py` constants `_V2_TITLE_RE` + helper `_extract_v2_title_prefix_and_type`; `_matches_new_client_title_convention` ORs in the v2 matcher; `_classify_by_new_convention` does name-prefix-first resolution for v2-shaped titles. Tests: `tests/ingestion/fathom/test_classifier.py` (11 v2 tests added; the ~46 pre-existing cutoff tests stay green). Spec slug `cost-hub-effective-from-and-title-convention-v2` (spec + report deleted at 2026-05-15 EOD — recover from git history if needed).

## Review

Revisit this ADR if:

- The volume of manual classification overrides grows above ~5/week — signals the pattern set is too narrow.
- A new role-based booking link launches (Aman sales, Zain onboarding, etc.) — extend `NEW_CLIENT_TITLE_PATTERNS`.
- The cutoff date itself needs to move backward (unlikely; forward-only design).
- The forcing function produces enough drag on CSM workflow that strict prefix matching is reconsidered for something looser (e.g., title regex with required keywords).
