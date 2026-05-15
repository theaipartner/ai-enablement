# Report: Enforce new title convention for client classification (cutoff Mon May 18 EST)

**Slug:** classifier-enforce-new-title-convention
**Spec:** docs/specs/classifier-enforce-new-title-convention.md

## Files touched

**Created**
- `docs/runbooks/call_title_convention.md` — new operational runbook covering the cutoff rule, why it exists, recovery via manual override, CSM-facing communication recipe, and audit SQL queries for monitoring adoption.

**Modified**
- `ingestion/fathom/classifier.py` — new constants (`_NEW_TITLE_CONVENTION_CUTOFF` zoneinfo-anchored to America/New_York for DST safety; `NEW_CLIENT_TITLE_PATTERNS` tuple of six canonical lowercase prefixes); new helpers (`_matches_new_client_title_convention`, `_is_after_new_convention_cutoff`, `_classify_by_new_convention`); `classify` cascade extended with a post-cutoff branch slotted between the internal-title-pattern step and the Scott-1:1 step; `_classify_by_participants` gained an `allow_client_classification: bool = True` keyword arg so the post-cutoff non-matching path can suppress the matched-client → client promotion without losing the rest of the cascade.
- `tests/ingestion/fathom/test_classifier.py` — `_record` helper gains a `started_at: datetime | None = None` parameter (default keeps the existing 2026-03-15 fixture intact for backward compat). Appended 13 new tests covering pre-cutoff regression, post-cutoff new title with confidence=1.0, call_type derivation for coaching vs sales, trailing-context tolerance, old-style title rejection, ad-hoc title with known client participant rejection, case variants + whitespace, boundary inclusivity, new-title with no-resolvable-client (still client), post-cutoff internal-title still internal, Scott-1:1 retirement, and direct coverage of `_matches_new_client_title_convention` + `_is_after_new_convention_cutoff` edge cases.
- `docs/schema/calls.md` — Populated-by section gains a paragraph describing the cutoff + the six canonical patterns + the cascade-change semantics + link to runbook + spec.
- `docs/state.md` — new top-line entry under "Gregory editorial skin shipped" describing the full shipped surface.

## What I did, in plain English

Wired a hard cutoff into the Fathom classifier: calls with `started_at` at or after 2026-05-18 00:00 EST only auto-classify as `client` when the title starts with one of six canonical patterns (`Coaching Call with {Scott|Lou|Nico}` or `Sales Call with {Scott|Lou|Nico}`, case-insensitive). The booking links Zain set up generate exactly these titles; ad-hoc meetings + legacy recurrings + the old 30-min-with-Scott pattern all stop classifying as client post-cutoff. The friction is the lever — CSMs whose calls don't show up where expected will rebook through the link or rename the recurring.

Cascade order matters: short-file heuristic and internal-title-pattern still fire first (CSM Sync, Backend Team, NCF, etc. still classify as `internal` post-cutoff — the new gate only governs `client` classification). Post-cutoff, if the title matches one of the six new patterns, classify as `client` with method=`title_pattern` + confidence=`1.0` (above CONFIDENCE_HIGH; the spec called out 1.0 explicitly). Otherwise, skip the Scott-1:1 client path entirely and route the call through participant-match WITH the new-client gate flag set to False — internal / external / unclassified outcomes all still fire, just not `client`. Pre-cutoff calls use the prior cascade unchanged.

Primary client resolution for new-pattern matches reuses the existing `_resolve_participant` helper (email + alternate-name lookup). When no external participant resolves to a known client, the row still lands as `client` with `primary_client_id=null` per spec — the new convention assumes Zain's onboarding flow seeds the `clients` row before the booking link is shared, so an unresolved attendee surfaces as a data-hygiene gap rather than a classification failure. No auto-create on this path (the auto-create lives on the legacy Scott-1:1 path, which is retired post-cutoff).

## Verification

- **`pytest tests/`** → 570 passed, 0 failed. Up from 557 pre-spec; +13 new tests in `tests/ingestion/fathom/test_classifier.py` covering every cutoff-related case the spec called out plus three I added (post-cutoff internal title still internal; Scott-1:1 retirement; sales call call_type derivation).
- **`pytest tests/ingestion/fathom/test_classifier.py`** → 41 passed (was 28 pre-spec).
- **`npx tsc --noEmit`** → clean.
- **`npm run lint`** → "No ESLint warnings or errors."
- **No DB changes.** Pure code + test + doc change. No migration; the cutoff is checked at classify-time against `record.started_at`.
- **Direct helper coverage** verifies `_matches_new_client_title_convention` against None / empty / whitespace-only / non-matching / all six canonical patterns, and `_is_after_new_convention_cutoff` against None / unparseable string / Z-suffix ISO string / pre-cutoff string / datetime object.
- **Boundary test** confirms `started_at` exactly at `2026-05-18T00:00:00 America/New_York` is treated as post-cutoff (inclusive) while one minute earlier is pre-cutoff.

## Surprises and judgment calls

- **Confidence 1.0 is a new tier** that's above the existing `CONFIDENCE_HIGH = 0.9`. Spec called it out explicitly: "Confidence: `1.0` for new-pattern matches. The new patterns are the strongest signal we have." Used a literal `1.0` rather than introducing a new `CONFIDENCE_PERFECT` constant — the value is load-bearing in its own right (it's a forcing-function declaration that the booking-link match is authoritative) and a constant felt like obscuring intent. If we ever land more 1.0-confidence paths a constant becomes worth introducing.
- **`_classify_by_participants` gained an `allow_client_classification` flag** rather than writing a parallel `_classify_non_client_post_cutoff` function. Two reasons: (1) the other branches (internal / external / unclassified) are identical between pre- and post-cutoff, so duplication would have meant copy-paste; (2) the flag-based seam is small (one if-branch around the matched-client → client promotion) and makes the post-cutoff suppression visible at the call site in `classify`. The flag defaults to True so every existing caller is unaffected.
- **Post-cutoff `external` classification gains a reasoning note** when the matched-client promotion was suppressed: "matched-client promotion suppressed by post-cutoff title gate". Surfaces in audit queries — a future Director investigating "why didn't this call classify as client?" sees the cause directly on the row.
- **Scott-1:1 pattern (`30mins with scott`) is implicitly retired post-cutoff.** The spec said the new convention replaces it, and the cleanest implementation was to skip the `_classify_scott_1on1` step entirely on the post-cutoff branch — even a title that DID match `30mins with Scott` won't auto-classify as client post-cutoff unless it ALSO matches one of the six new patterns (it won't, by definition). The Scott-1:1 auto-create-client path is therefore retired too. New-convention matches do NOT auto-create — per spec rationale, Zain's onboarding seeds the client before the booking link is shared. Worth flagging because a CSM might wonder why a Scott 1:1 booking that previously auto-created a client suddenly doesn't.
- **`call_type` derived from the title prefix** in the new path: `"coaching call"` → `coaching`; `"sales call"` → `sales`; else `None`. This goes slightly beyond the spec (which didn't pin call_type for the new path) but felt necessary — the existing client paths set call_type and the dashboard renders it. Coaching vs sales is a meaningful split.
- **Naive datetime defensiveness in `_is_after_new_convention_cutoff`.** The Fathom parser always emits tz-aware UTC, but the helper accepts naive datetimes and treats them as UTC (matching the codebase convention). Defensive against any downstream caller that strips tzinfo somewhere; in practice the production path won't hit this branch.
- **Spec mentioned a DST-boundary test** but said skip if cutoff is far from DST. May 18 is comfortably inside EDT (DST started 2026-03-08; ends 2026-11-01) — boundary test confirms the cutoff lands at `2026-05-18T04:00:00Z` correctly. No fall-DST test added; the `zoneinfo.ZoneInfo` handling is the same code path regardless.
- **Spec didn't mention `docs/agents/gregory.md`** as load-bearing but the mandatory doc-update list said "only if classification is documented there." I grepped and confirmed gregory.md references classification only at the Calls detail-page surface level — the new behavior is invisible from the page's perspective (it still reads `call_category` regardless of how it was set). Skipped the gregory.md edit; flagging here so a future read doesn't think it was missed.
- **No `vercel.json` or env var changes.** Pure-code spec; no runtime configuration involved.

## Out of scope / deferred

- **Adding patterns for Aman / Zain / others.** Spec explicit: six patterns only today. Future spec when their booking links exist.
- **Onboarding-specific pattern.** Spec acknowledges Drake will instruct the team to either use Coaching/Sales for onboarding or Zain creates an Onboarding link. Until that decision lands, onboarding calls drop to non-client — that's intentional friction.
- **Backfilling historical calls.** Forward-only; cutoff is `started_at`-based, not ingestion-time. A call ingested today with `started_at` from March still uses the pre-cutoff cascade.
- **Auto-create-client on new-pattern path.** Per spec rationale, the new convention assumes Zain's onboarding seeds the client record before the booking link is shared. The legacy Scott-1:1 auto-create is retired post-cutoff.
- **Communications artifact** — Drake's job per spec § 7. Builder doesn't author the Slack announcement.

## Side effects

- **Two commits pushed to `main` this turn** (plus the report commit after this writes): `dbfd0e4` (feature code + tests), `27a1d29` (docs).
- **No cloud DB changes.** No migration applied; no DML run. The cutoff lives entirely in code + test fixtures.
- **No real Slack posts, no DMs, no external API calls.**
- **Vercel auto-deploys on push.** Post-deploy, every Fathom webhook delivery after 2026-05-18 00:00 EST runs through the new cutoff gate. Any call already in `calls` keeps its existing classification — the cutoff is checked at classify-time, not at ingestion-time, but the codebase doesn't reclassify historical calls.
- **First call after the deploy + cutoff** is the live integration test. Drake's gate (c): post-2026-05-18 review of the audit query in the runbook (`calls WHERE started_at >= cutoff AND call_category != 'client'`) to spot which CSMs are still using old titles + which legacy recurrings are still firing.
