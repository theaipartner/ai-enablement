# Report: Ella Doc Hygiene Sweep + Dead-Code Inventory
**Slug:** ella-doc-hygiene-sweep-2026-05-21
**Spec:** docs/specs/ella-doc-hygiene-sweep-2026-05-21.md

## Files touched

**Modified — forward-pointer annotations:**
- `docs/specs/ella-realtime-ingest-idempotency.md` — annotation block immediately after the status line (top-of-doc); annotation block at the top of § "What could go wrong" (just above subsection #1, calling out subsection #6 by reference). Two annotations total.
- `docs/reports/ella-realtime-ingest-idempotency.md` — annotation block immediately after the spec-pointer line (top-of-doc).
- `docs/runbooks/slack_message_ingest.md` — short annotation block at the top of § "Dedup gate (step 0, restructured 2026-05-21)" — note already-post-fix shape, forward-link to corrective spec.
- `docs/state.md` — annotation block at the top of the 2026-05-20 idempotency-gate entry, explicitly calling out the premature "(production resume unblocked)" framing in that entry's heading.

**Modified — dead-code inventory:**
- `docs/known-issues.md` — new section "Code hygiene — deferred cleanup (catalog, flagged 2026-05-21)" inserted at the end of the existing Ella-arc entry group (immediately before the `---` separator that begins the Fathom/Gregory entry group). Three sub-entries: (a) cosmetic malformed-fallback in `realtime_ingest.py`, (b) `_insert_audit_terminal` prefix parameterization, (c) confirmed-not-dead `_SNIPPET_MAX` + `_truncate`. Section uses `## Code hygiene — deferred cleanup` as a group header and `### Code hygiene: <title>` for each entry, deliberately distinct from the file's `## <bug title>` pattern so future scans by file outline can see the inventory as a single thing.

**Modified — this spec's own bookkeeping:**
- `docs/state.md` — new entry "2026-05-21 — Ella doc hygiene sweep + dead-code inventory" at the top of the shipped log. Short by design — pure doc reconciliation, no behavioral impact.
- `docs/specs/ella-doc-hygiene-sweep-2026-05-21.md` — status flipped from `in-flight` to `shipped` in the same commit-sequence as this report, per the spec's "Done means" (no gate (c) — no behavior to validate).

**Not modified (by deliberate decision per the spec):**
- `docs/known-issues.md` Problem A resolution note (line 53). The existing prose already references both the 2026-05-20 idempotency ship AND the 2026-05-21 dedup-message-changed corrective; per the spec's § (1) item 5 "no change needed — Builder reports what's there."
- `docs/agents/ella/ella.md` changelog. Per spec § "Locations NOT needing annotation" — chronological by design, the doc chain captures the evolution.
- The diagnostic spec + report (`ella-duplicate-webhook-delivery-diagnostic`) and the dedup-message-changed spec + report — they ARE themselves the forward-pointers; nothing in them needs updating.

**Zero code, test, or migration files touched** (per the spec's hard stop #1).

## What I did, in plain English

Walked the spec's acclimatization checklist by reading the four affected spec docs, their reports, and the runbook + state.md + known-issues sections enumerated in the spec. Confirmed in 4 bullets:

- **Idempotency spec needs annotations at top + at § "What could go wrong" subsection #6** (line 311 in the existing doc — the "acceptable for v1" framing for message_changed edits).
- **Idempotency report needs an annotation at top** — the report's "structurally race-proof" framing was technically accurate but missed the production failure mode.
- **Runbook Dedup gate section already says "restructured 2026-05-21"** in the section header. Per the spec's § (1) item 3, the annotation here can be short — just a forward-pointer naming the corrective spec. Did that.
- **State.md 2026-05-20 entry's heading says "(production resume unblocked)"** — premature given the message_changed gap surfaced 24 hours later. The annotation block I added calls this out explicitly.

Then split the work into three commits:

**Commit 1 (forward-pointer annotations):** the four annotation blocks landed in the four locations enumerated. All four use the consistent `> **UPDATED 2026-05-21:** ...\n> See: ...` format so future scans (e.g., `grep "UPDATED 2026-05-21:" docs/`) are trivial. Original prose untouched — the annotations prefix the affected sections without rewriting history. **Known-issues Problem A intentionally NOT modified**, per the spec's § (1) item 5 — its existing resolution note (line 53) already references both ships in plain prose; adding a second annotation would have been the "peppering" the spec's hard stop #2 forbids.

**Commit 2 (dead-code inventory):** added a new section to `docs/known-issues.md` titled "Code hygiene — deferred cleanup (catalog, flagged 2026-05-21)" with a one-paragraph intro framing the section's intent (not bug reports — code-hygiene decisions catalogued in one canonical location). Three entries under it, each titled `### Code hygiene: <title>` so file-outline scans see them as a single group. Each entry follows the spec's format: 2-3 sentence description, Location, Surfaced by, Cost of cleanup, Trigger to address. The third entry — `_SNIPPET_MAX` + `_truncate` — is the "confirmed not dead" entry the spec called for; explicit Status: "NOT dead. Verified 2026-05-21." so a future reader doesn't repeat the investigation.

**Commit 3 (this commit):** state.md entry + spec status flip from `in-flight` → `shipped` + this report. Hard-stops sanity check before commit: pytest 706 passed (unchanged from prior count), tsc clean, next lint clean — confirming the spec's hard stop #5 ("test suite not affected") held.

## Verification

**pytest:** 706 passed, 2 warnings (pre-existing supabase library deprecation, unrelated). **Unchanged from prior count** per the spec's hard stop #5 — zero code touched in this spec.

**tsc --noEmit:** clean.

**next lint:** `✔ No ESLint warnings or errors`.

**Manual reads:**
- Re-read each annotation in context (i.e., as a future reader would encounter it) to confirm the forward-pointer leads to the right destination and reads coherently against the original prose below it.
- Verified the dead-code inventory section's location in `docs/known-issues.md` — inserted between the existing Ella-arc-related entries (pip-install leak) and the Fathom/Gregory entry group's `---` separator. The new section sits within the same major group as the rest of the Ella-related entries.
- Confirmed the spec's status line is now `**Status:** shipped` post-flip.
- Confirmed no link rot — every forward-pointer in the annotations points to a file that exists at the listed path.

## Surprises and judgment calls

**Known-issues Problem A was already well-annotated**, so no edit was made there. The spec anticipated this case explicitly ("If the existing resolution pointer already references both ships, no change needed — Builder reports what's there") — flagging here because it's a meaningful no-op that affects how future readers parse the inventory.

**The dead-code section's headings use `### Code hygiene: <title>` rather than the file's existing bare `## <title>` pattern.** Deliberate divergence — the file's `## <title>` entries are individual bugs/ops items, distinct from the catalog this section provides. The `## Code hygiene — deferred cleanup` group header + `### Code hygiene: <title>` sub-entries make the catalog discoverable as a unit while still letting individual entries be quoted/linked to. The spec called out (§ What could go wrong #3) that "If known-issues currently has no 'deferred cleanup' section pattern, Builder creates one" — I created one and noted the format choice here per gate (b).

**The runbook annotation was kept short** per the spec's permission to do so when the section already reflects post-fix behavior. The full text is two lines (the standard UPDATED 2026-05-21 + See: pair). Erring on minimalism since the section header itself already says "restructured 2026-05-21."

**No additional contradicted claims surfaced during the read.** I went through all five reports + the spec docs + the runbooks expecting to find at least one more "should have been annotated" location per the spec's § What could go wrong #2 — the four-ship arc is complex enough that something else might be off-spec. None found. The corrective work was consistently tagged across the new reports in their own "Surprises" sections, so the forward-pointer arc was the only gap.

**The dead-code inventory's third entry deliberately documents a non-finding.** Per the spec's § (2) item (c), it's a "confirmed-not-dead" entry rather than a cleanup target. The framing ("Status: NOT dead. Verified 2026-05-21. Trigger to address: none — entry exists for documentation") matters because a future reader scanning the inventory needs to know which entries are "to do" versus "decisions already made." I added the explicit Status line so the distinction is unambiguous.

## Out of scope / deferred

- **Code edits.** Zero, per the spec's hard stop #1. The dead-code inventory catalogs but doesn't clean up. A future spec can pick from the inventory.
- **Updating `docs/agents/ella/ella.md` changelog.** Per the spec § "Locations NOT needing annotation."
- **Reorganizing or compressing existing reports.** Per spec — they stand as historical artifacts.
- **Adding non-Ella code paths to the inventory.** Per spec — the sweep is scoped to the four 2026-05-20/2026-05-21 Ella ships.
- **Spec status flip on the prior in-flight specs** (e.g., the unanswered-flagger spec is still in-flight pending Drake's organic smoke validation). Not in scope here — each spec's status is owned by its own arc.

## Side effects

None. Pure doc reconciliation. No code touched, no tests touched, no migrations, no env-var changes, no production data, no Slack posts. Three commits this run: (1) forward-pointer annotations, (2) dead-code inventory, (3) state.md entry + spec-status flip + this report.

This spec ships immediately (status flipped to `shipped` in the same commit-sequence as the report) — no behavior to validate, no gate (c). The four-ship Ella arc that started 2026-05-19 EOD is now documented with consistent forward-pointers showing how understanding evolved across the arc, and the code-hygiene decisions made along the way are catalogued for the next person.
