# Report: EOD 2026-05-19 Doc Update
**Slug:** eod-2026-05-19-doc-update
**Spec:** docs/specs/eod-2026-05-19-doc-update.md

## Acclimatization (3-4 bullets, per spec)

- `CLAUDE.md` § Working Norms + § Director / Builder System read; the spec-writing-standards / gate-trajectory shape is consistent with the new bullet's framing.
- `docs/state.md` — the 4 existing 2026-05-19 entries (refactor + daily digest, unified path, prompt sharpening v1, prompt sharpening v2, structural override, default-on) are stacked top-of-block with newest first under `## Gregory editorial skin shipped`. The EOD entry inserts as the new newest, immediately above the default-on entry.
- `docs/known-issues.md` convention is `## <title>` heading followed by a 4-bullet block (What / Why it matters / Next action / Logged), entries separated by blank lines, ordered topical-list-newest-first after the `## NEXT SESSION FIRST ACTION` gate block. The 3 new entries go at the top of the topical list (before the `## getClientsList …` entry that previously led).
- The three diagnostic-source reports (`ella-decision-haiku-prompt-sharpening-smoke-diagnostic.md`, `ella-passive-monitoring-default-on.md` + `…-shipped.md`, the C0AFEC456JG diagnostic from the kill-switch turn) ground the today's-events narrative — the EOD entry is consistent with all of them and adds no new claims beyond what the diagnostic already established.

## 1. Files touched

**Modified — docs (3 + spec):**
- `docs/state.md` — new EOD entry (2026-05-19 — EOD: Production misfire + emergency kill switch + paused-pending-investigation) inserted at the top of the dated-section block, verbatim from spec § "What changes — by file" → "Modify: `docs/state.md`".
- `CLAUDE.md` — new bullet in `## Working Norms` § Operational patterns Director and Builder are strict about, inserted immediately after the "Real-API smoke test before `--apply` on backfills" bullet, verbatim from spec § "Modify: `CLAUDE.md`".
- `docs/known-issues.md` — three new entries at the top of the topical list (after `## NEXT SESSION FIRST ACTION` block, before `## getClientsList …`): idempotency on passive dispatch, ack rate-limiting, client-routed-to-humans rule. Each formatted to match the file's 4-bullet convention (What / Why it matters / Next action / Logged).
- `docs/specs/eod-2026-05-19-doc-update.md` — `Status:` flipped `in-flight` → `shipped`.

**Deleted / created code / migrations / env / tests:** none. Doc-only per spec.

## 2. What I did, in plain English

Wrote the end-of-day reconciliation for 2026-05-19 across the three docs the spec named. The state.md entry tells the day's late-evening story: Drake's production misfire (Dhamen's GHL question fired 3 Ella acks even though it @-mentioned Scott and Lou rather than Ella), the kill switch (136 channels off, test channel preserved), the three structural gaps the misfire surfaced as distinct problems (duplicate Slack delivery → duplicate acks; no rate-limit when a stuck client posts multiple messages; no rule for "client routed to humans → defer"), and the architectural lesson that prompted today's structural-override pattern (when an LLM keeps rationalizing through an enumerated output set, remove the wrong option from the schema rather than adding more prose constraints). The CLAUDE.md bullet codifies that lesson as a Working Norm so it's discoverable by future Builders — "structural fixes beat prompt iteration when an LLM keeps rationalizing through an enumerated decision," with the day's @-mention override as the working example. The three known-issues entries capture the structural gaps as concrete production-resume blockers, each with a defined fix shape so future specs against them can build straight from the entry. Flipped the spec status to shipped in the report commit per the spec convention.

## 3. Verification

- **`pytest tests/`:** 653 passed, 0 failed (pre- and post-edit — doc-only changes don't touch test surface).
- **`npx tsc --noEmit`:** exit 0; **`next lint`:** "No ESLint warnings or errors." (Hard stop #2 satisfied — no TS touched, verified clean.)
- **Git status post-edit:** exactly four files modified (state.md, CLAUDE.md, known-issues.md, the spec status flip) — no out-of-scope changes (hard stop #3 satisfied).
- **Doc edits read back:** all three insertions land at the intended anchors (state.md top-of-dated-block under `## Gregory editorial skin shipped`; CLAUDE.md Working Norms bullet immediately after the Real-API smoke test bullet; known-issues.md entries at the top of the topical list, in the order idempotency → rate-limit → routing-recognition, each conforming to the 4-bullet convention with `**Logged:** 2026-05-19` on each).
- **Spec verbatim copy:** the state.md entry body and the CLAUDE.md bullet text are byte-equal to the spec's quoted blocks (verified during the Edit calls by lifting both directly from the spec).

## 4. Surprises and judgment calls

1. **The three known-issues entries were summarized into the file's 4-bullet shape, not pasted verbatim from the spec.** The spec gave each entry in narrative paragraph form and explicitly delegated formatting ("Builder reads the file first to match whatever the existing convention is for entry formatting"). The convention is short — What / Why it matters / Next action / Logged. I compressed the spec's prose into that shape while preserving every concrete claim (the C0AFEC456JG misfire as the source, "Caused N of the 3 acks", the fix-shape sentences, the "spec required before production resume" gating). Flagged because the underlying spec body is paraphrased, by spec design.
2. **No tests added — confirmed against the spec's explicit instruction.** Spec § Tests says "None. This is doc-only. Builder confirms `pytest tests/` still passes at 653 post-edit but doesn't add new tests." Verified: 653 baseline, 653 post-edit.
3. **The CLAUDE.md bullet sits in the bulleted list after "Real-API smoke test before `--apply` on backfills"** (line 97 pre-edit). The spec specified that exact anchor; the section it's in (`### Operational patterns Director and Builder are strict about`) is the right place for a norm that's about how Builder operates, not about how Drake collaborates.
4. **The pre-existing out-of-scope `unused import pytest` in `tests/agents/ella/test_agent.py`** is documented in the new EOD entry as still untouched. Not in scope to fix here — that's a separate hygiene-pass call.

## 5. Out of scope / deferred

- Closing the three new known-issues entries (idempotency, rate-limit, routing-recognition) — each gets its own spec before production resume, per the entries themselves. The next session will pick the order.
- Re-enabling passive monitoring on the 136 channels — gated on closing all three known-issues entries. State of the channel kill (`UPDATE … WHERE test_mode = false`) stays as-is; `#ella-test-drakeonly` remains the only monitored channel.
- The pre-existing `test_agent.py` ruff hygiene item — still deferred.

## 6. Side effects

- **No** code, DB writes, Slack posts, external API calls. Tests fully mock anything they touch; this turn touched no test surface.
- Git: 2 commits — `1cdaabf docs: EOD 2026-05-19 reconciliation` (the three doc edits) + this report commit. To be pushed together at the end of this turn.
