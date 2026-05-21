# Ella Doc Hygiene Sweep + Dead-Code Inventory

**Slug:** ella-doc-hygiene-sweep-2026-05-21
**Status:** in-flight
**Type:** Documentation reconciliation (code-touching forbidden)

## Context

Four Ella-related ships landed in the last 36 hours: routing gate + assigned-advisor (2026-05-20 morning), realtime-ingest idempotency (2026-05-20 afternoon), duplicate-webhook diagnostic + dedup message_changed fix (2026-05-21 morning/afternoon), unanswered-flagger client-only + terse format (2026-05-21 afternoon). The work resolved a production misfire pattern that surfaced 2026-05-19 EOD and produced four shipped specs, four reports, three runbook updates, four state.md entries, and three known-issues edits across the arc.

Mid-arc, two prior-spec claims turned out to be wrong in production. The 2026-05-20 idempotency spec asserted "duplicates short-circuit before any side effect" and shipped a test pinning `test_message_changed_uses_outer_ts_for_dedup_key` as expected behavior. Both were technically accurate descriptions of what the code did, but the code's behavior was the bug — the dedup key was structurally unable to catch the dominant duplicate pattern (Slack edits). The diagnostic on 2026-05-21 surfaced this, the fix landed the same day, and Builder flagged the contradiction honestly in both follow-up reports.

**The problem this spec addresses:** the prior spec's report, the prior state.md entry, and the prior runbook section still read confidently — they describe a fix that didn't fully work in production, framed as if it did. The corrective is documented across THREE separate places (the diagnostic report's Surprises, the dedup-message-changed report's Surprises, the new known-issues entry's resolution note), but the prior docs themselves don't reference forward to the corrective. A future reader of `docs/specs/ella-realtime-ingest-idempotency.md` or its report will form a wrong mental model without knowing to check what came after.

**The fix:** annotate the prior docs with forward-pointers to the corrective work, without rewriting history. Add freshness markers ("UPDATED 2026-05-21:") at the relevant sections of each prior doc explaining what subsequently changed and pointing to the follow-up. Do NOT retroactively edit the original claims — leave them visible so the doc chain captures the actual sequence of how understanding evolved.

**Secondary deliverable: dead-code inventory in the docs.** Builder catalogs the dead/stale code paths flagged as "left in place" across today's reports (the cosmetic malformed-fallback in `realtime_ingest.py`, the `_insert_audit_terminal` parameterized prefix only called with one value, the `_truncate` / `_SNIPPET_MAX` post-format-rewrite usage check) into a single docs-side inventory at `docs/known-issues.md` under a new "Code hygiene — deferred cleanup" section. This is NOT a fix spec for that dead code — it's a single canonical doc location for future cleanup decisions, so the next person doesn't have to re-discover them by reading every report.

## Acclimatization checklist

Builder reads these first and confirms understanding in 3-4 bullets:

- `CLAUDE.md` § Working Norms — particularly the "never retroactively rewrite history" pattern (if it exists; if not, this spec is establishing it for doc updates).
- The four shipped specs from 2026-05-20 and 2026-05-21:
  - `docs/specs/ella-at-mention-routing-gate-and-advisor-context.md`
  - `docs/specs/ella-realtime-ingest-idempotency.md`
  - `docs/specs/ella-duplicate-webhook-delivery-diagnostic.md`
  - `docs/specs/ella-realtime-ingest-dedup-message-changed.md`
  - `docs/specs/ella-unanswered-flagger-client-only-and-terse-post.md`
- The five reports from the same ships (same filenames under `docs/reports/`).
- `docs/state.md` — the four 2026-05-20/2026-05-21 entries plus the 2026-05-19 EOD misfire entry.
- `docs/known-issues.md` — particularly the struck-through Problems A/B/C entries with their resolution pointers, and the new `author_type='bot'` entry.
- `docs/agents/ella/ella.md` — changelog section and the trigger description.
- `docs/runbooks/slack_message_ingest.md` — the Dedup gate section.
- `docs/runbooks/ella_passive_monitoring.md` — Gate descriptions.
- `docs/runbooks/ella_unanswered_flagger.md` — Candidate filter + post format sections.

This is a doc-only spec. Builder does NOT read code files unless verifying a specific claim in a doc against the actual code (e.g., confirming the cosmetic malformed-fallback is still in place where the dead-code inventory says it is).

## What changes

### (1) Forward-pointer annotations in prior docs

Builder adds inline annotation blocks in the following locations. Format for each annotation:

```markdown
> **UPDATED 2026-05-21:** [one sentence describing what subsequently changed.]
> See: [link to the follow-up doc].
```

The annotation is placed at the top of the affected section (not at the end), so a reader scanning the doc encounters the freshness flag before reading the now-partially-stale content. The original content stays unchanged — the annotation prefixes it, doesn't replace it.

**Locations needing annotation:**

1. **`docs/specs/ella-realtime-ingest-idempotency.md`** — at the top of the document immediately under the title/status, AND in § "What could go wrong" subsection #6 (the `message_changed` acknowledgment). The top-of-doc annotation should say: *"The dedup gate this spec ships uses `event.get('ts')` as the key, which is the OUTER event ts. Slack `message_changed` events have a different outer ts than the original `message` event for the same logical message, so the gate did not prevent edit-driven duplicate dispatches in production. See `docs/specs/ella-realtime-ingest-dedup-message-changed.md` for the fix (moves the dedup-key construction post-parse so it uses the inner/stable message ts)."* The subsection #6 annotation should say: *"Production observation 2026-05-21: 11 documented duplicate dispatches across 8 channels in 36 hours of post-resume traffic. The 'acceptable for v1' framing under-estimated edit frequency. See the dedup-message-changed spec."*

2. **`docs/reports/ella-realtime-ingest-idempotency.md`** — at the top of the document. Annotation: *"This report's claim that the dedup gate's behavior was verified is technically accurate (the unit tests pinned the implemented behavior) but the implemented behavior was wrong for the dominant production failure mode. The 2026-05-21 diagnostic established that the dedup key was structurally unable to catch Slack edit-driven duplicates. See `docs/reports/ella-duplicate-webhook-delivery-diagnostic.md` for the diagnosis and `docs/reports/ella-realtime-ingest-dedup-message-changed.md` for the fix."*

3. **`docs/runbooks/slack_message_ingest.md`** — at the top of the Dedup gate section. Annotation: *"Dedup-key construction was moved from pre-parse (outer event ts) to post-parse (inner message ts) on 2026-05-21 to handle Slack `message_changed` events correctly. The runbook section below reflects the current (post-fix) behavior; the prior behavior is preserved for historical reference in `docs/specs/ella-realtime-ingest-idempotency.md`."* If Builder finds the runbook section already reflects the post-fix behavior (which it should, since the unanswered-flagger spec touched it), the annotation can be shorter — just a forward-pointer noting which spec produced the current shape.

4. **`docs/state.md` § 2026-05-20 — Ella realtime-ingest idempotency gate entry** — at the top of that entry. Annotation: *"UPDATED 2026-05-21: This ship's dedup gate did not catch the dominant duplicate pattern (Slack edits) in production. See the 2026-05-21 entries for the diagnostic and the corrective ship. Test count and ship surface from this entry are accurate; the behavioral claim 'production resume unblocked' was premature."*

5. **`docs/known-issues.md` § Problem A resolved-by entry** — Builder verifies the existing resolution pointer reads correctly post-2026-05-21 fixes. If the struck-through entry says "Resolved via `ella-realtime-ingest-idempotency`" without mention of the follow-up, update the resolution note to: *"Initially addressed by `ella-realtime-ingest-idempotency` (2026-05-20). That ship's dedup-key construction did not handle Slack `message_changed` events correctly; the full resolution shipped via `ella-realtime-ingest-dedup-message-changed` (2026-05-21)."* If the existing resolution pointer already references both ships, no change needed — Builder reports what's there.

**Locations NOT needing annotation:**

- The diagnostic spec/report (`ella-duplicate-webhook-delivery-diagnostic`). They are themselves the forward-pointers; nothing in them needs updating.
- The dedup-message-changed spec/report. Same reason.
- The routing-gate spec/report. That ship's claims held; nothing has been contradicted.
- The unanswered-flagger spec/report. Same.
- `docs/agents/ella/ella.md`. The changelog entries are chronological by design; the doc chain captures the evolution.

### (2) Dead-code inventory in known-issues

Builder adds a new section to `docs/known-issues.md` titled "Code hygiene — deferred cleanup" (or matches whatever the existing precedent for non-bug deferred-cleanup entries is). Under it, three entries each shaped like:

```markdown
**[Title — one phrase describing the dead code]** (deferred, flagged 2026-05-21)

[2-3 sentences describing what the dead code is, why it's dead, and why it was left in place.]

Location: [file path + line range or function name].
Surfaced by: [report slug].
Cost of cleanup: [trivial / small / requires-care]. Trigger to address: [what would prompt cleanup, e.g., "if a future spec touches this function for other reasons" / "if the file gets refactored" / "next code hygiene pass"].
```

The three entries Builder writes:

**(a) Cosmetic malformed-fallback in `realtime_ingest.py`.** The pre-2026-05-21 dedup-key construction had a fallback `slack_msg_ingest_malformed_{uuid.uuid4()}` for events with null channel or ts. After the 2026-05-21 dedup-message-changed fix moved the key construction post-parse, that path is unreachable — null channel hits the non-client gate first, null ts causes the parser to return None. The fallback is still computed early in the function for the result-dict's `delivery_id` field; removing it would require a result-dict-shape refactor. Builder reads the dedup-message-changed report's Surprises section #3 for the exact location.

**(b) `_insert_audit_terminal` prefix parameterization in `realtime_ingest.py`.** The helper takes a `prefix` parameter but is only ever called with `_PRE_DEDUP_PREFIX`. Builder noted this in the dedup-message-changed report as a deliberate choice — kept parameterized for future flexibility if another terminal-row shape ever needs one. Cost of inlining the prefix: trivial. Trigger to address: never urgent; if anyone touches this helper for other reasons.

**(c) `_SNIPPET_MAX` / `_truncate` usage in `ella_unanswered_flagger_cron.py`.** After the 2026-05-21 unanswered-flagger format rewrite, `_REASONING_MAX` was removed (only used in the rewritten format function). `_SNIPPET_MAX` and `_truncate` are still used in audit-row payload construction at two other call sites. NOT dead — Builder verifies by reading the unanswered-flagger report's hard stop #1 and the file itself if needed. **This entry exists to document that the usage was verified during the format rewrite, NOT to flag it as dead.** Title accordingly: *"Confirmed-not-dead: `_SNIPPET_MAX` + `_truncate` post unanswered-flagger format rewrite (verified 2026-05-21)."*

The third entry is intentionally a "not dead" entry — it captures the verification done so a future reader doesn't repeat the investigation. The "Code hygiene — deferred cleanup" section is broader than just dead-code; it's a single canonical location for code-hygiene decisions that were made consciously but might surface as questions later.

Builder may discover additional dead-code candidates while reading the reports. If so, add them to the inventory using the same shape. Surface in the report's Surprises section if any of them feel like more than just deferred cleanup (e.g., if Builder finds something genuinely broken rather than just cosmetic).

### (3) state.md entry for this spec

Builder adds a new entry to `docs/state.md` documenting this doc hygiene sweep. Standard shape — what changed, what files were touched, no behavioral impact (zero code touched), production state unchanged. Should be the shortest entry in the file since the deliverable is purely doc reconciliation.

### What's explicitly out of scope

- **Code edits.** Zero. If Builder finds a typo or bug while reading docs, do NOT fix in this spec — flag in Surprises.
- **Test edits.** Zero.
- **Fixing the dead code in the inventory.** This spec catalogs it, doesn't clean it up. A future spec can pick from the inventory.
- **Updating `docs/agents/ella/ella.md`.** The changelog is chronological by design; updates would muddy the historical record.
- **Reorganizing or compressing the existing reports.** The reports stand as historical artifacts. Annotations add freshness flags WITHOUT replacing the original content.
- **Adding entries for non-Ella code paths.** This sweep is scoped to the four 2026-05-20/2026-05-21 Ella ships.

## Hard stops

1. **Never retroactively edit a claim.** Builder adds annotation blocks that prefix the affected section. Does NOT change the original text. The doc chain captures evolution; rewriting the past obscures the lessons.

2. **One forward-pointer per affected section, not many.** If a section needs multiple pointers (e.g., the prior spec's #6 subsection needs to reference both the diagnostic AND the fix), bundle them in a single annotation block at the top of that section. Don't pepper the doc with annotations.

3. **No new known-issues entries beyond the three dead-code entries.** This spec is reconciliation + dead-code inventory, not a forum for surfacing fresh findings. If Builder finds something fresh while reading, flag in Surprises and a separate spec handles it.

4. **No migration, no env-var changes, no production traffic.** This spec touches Markdown only.

5. **Test suite not affected.** `pytest tests/` should pass at exactly the prior count (706) since no code changes. `tsc --noEmit` + `next lint` should pass since no TS touched.

6. **Annotation freshness markers use the exact format above.** Consistent format makes future scans for "what's been updated" trivial (grep `UPDATED 2026-05-21:`). Don't improvise the format.

## What could go wrong

1. **The prior docs are already heavily annotated and a fresh annotation makes them harder to read.** Builder reads each target doc first and reports the current annotation density. If a doc already has 3+ annotations and another would push it past readable, Builder surfaces in Surprises and asks before adding.

2. **Builder discovers a contradicted claim that wasn't on the list.** Possible — the four-ship arc is complex enough that something might be off-spec. Builder adds the additional annotation following the same format and flags in Surprises so Drake knows the inventory expanded.

3. **The dead-code inventory section in known-issues clashes with existing precedent.** If known-issues currently has no "deferred cleanup" section pattern, Builder creates one (using the format above). If it has a different pattern for similar entries, Builder matches that pattern and notes the choice in Surprises.

4. **A forward-pointer link is to a file that was renamed or moved.** Builder verifies each link before committing. If a target file doesn't exist at the expected path, surface in Surprises and check git log for the rename.

## Done means

- All forward-pointer annotations added to the five locations listed in § (1).
- Three dead-code inventory entries added to `docs/known-issues.md` under the "Code hygiene — deferred cleanup" section (or equivalent existing precedent).
- New state.md entry added for this spec (short — doc reconciliation only).
- `pytest tests/`, `tsc --noEmit`, `next lint` all pass at prior counts (no code touched).
- Spec status flipped to `shipped` in the same Builder commit-sequence as the report. No gate (c) — no behavior to validate.
- Report at `docs/reports/ella-doc-hygiene-sweep-2026-05-21.md` follows the 6-section structure.

Drake's gates:
- (a) None — no migrations, no irreversible actions.
- (b) Any surprise finding worth surfacing — e.g., a contradicted prior claim Builder discovered that wasn't on the spec's list. Surface immediately, don't silently add to the annotation list.
- (c) None — no behavior to validate.
- (d) None.

**The report should specifically include:** a flat list of every file modified with the line range of each annotation, so Drake can quickly review the diff scope. The annotation content itself is reviewable by reading the diff; the report's What I did section should focus on which decisions Builder made (e.g., "doc X already had a forward-pointer and didn't need another" / "doc Y's existing resolution note already covered the corrective, no edit needed").
