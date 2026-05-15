# EOD cleanup 2026-05-15 (evening)
**Slug:** eod-cleanup-2026-05-15-evening
**Status:** in-flight

End-of-day doc hygiene + state.md / CLAUDE.md refresh after the Friday post-morning ship cycle. Mirrors the precedent set by `gregory-day-end-wrap-2026-05-14` and the (now-shipped) `eod-cleanup-2026-05-15` from this morning.

**Note on naming:** there are two EODs today. The morning one (`eod-cleanup-2026-05-15`) already shipped and refreshed state.md / CLAUDE.md for the Director-tier surfaces work. This evening one wraps the cost hub / FAQ harvest / title v2 / timezone alignment cycle that ran after.

## Context Builder needs

Read these first, confirm understanding in 3-4 bullets:

- The shipped spec/report pairs in `docs/specs/` + `docs/reports/` from today's cycle (listed below).
- `docs/state.md` — the current bundled 2026-05-15 entries; some sections may need consolidation now that more shipped on top of them.
- `CLAUDE.md` § Current Focus + § Next Session Priorities — both should reflect the now-shipped state.
- The morning's EOD cleanup spec + its report (`eod-cleanup-2026-05-15`) — that pair gets deleted in THIS evening cleanup per the "delete at next EOD" rule from the prior precedent.

## What ran today (post-morning)

Six specs shipped between the morning EOD and now. All are `Status: shipped` or `in-flight` with completed reports:

1. **`ella-threshold-trustpilot-first-month-faq-harvest`** — Ella keyword extension + Trustpilot first-month carve-out (migration 0037) + FAQ harvest (prompt v2 + backfill + Friday cron at `0 19 * * 5`). Report + resume report both present.
2. **`faq-digest-cc-and-questions-surface-check`** — Optional CC env var for FAQ digest + read-only verification that `questions_asked` doesn't surface on `/calls/[id]`. Report present.
3. **`cost-hub`** — Admin-tier cost hub at `/cost-hub` with 5 Anthropic buckets + editable subs/extras + history view + migration 0038. Report + resume report both present.
4. **`cost-hub-call-review-haiku-audit`** — Diagnosed + fixed scenario 1 (sentiment classifier untracked). Forward-only fix. Report present.
5. **`cost-hub-effective-from-and-title-convention-v2`** — Migration 0039 subscription effective_from + title convention v2 classifier (`[Client Name] - Coaching/Sales Call with {CSM}`). Report + resume report both present.
6. **`cost-hub-vs-ella-cost-discrepancy-diagnostic`** — Read-only diagnostic identifying the cost-hub-vs-Ella mismatch causes. Report present, no code.
7. **`ella-summary-est-alignment-and-timezone-adr`** — Aligned Ella page summary to cost hub windows + ADR 0003 timezone conventions + cron schedule runbook. Report present.

Three leftover pairs from yesterday (Thursday) carrying over per the prior cleanup spec's "limited to today's batch" boundary:

8. **`ella-escalation-unify-and-route-to-scott`** (shipped 2026-05-14)
9. **`ella-passive-escalation-keyword-bypass`** (shipped 2026-05-14)
10. **`gregory-day-end-wrap-2026-05-14`** (shipped 2026-05-14)

And from this morning's cleanup:

11. **`eod-cleanup-2026-05-15`** (shipped earlier today; the meta-spec itself is now ripe for deletion per its own "delete at NEXT EOD" rule).

## Task 1: state.md consolidation pass

`docs/state.md` already has bundled 2026-05-15 entries for everything that shipped today (each spec's report updates state.md as part of its own work, per the convention). Builder's job is a consolidation pass:

- Read every 2026-05-15-dated entry in `state.md`.
- If multiple entries cover the same day's cycle, ensure they read coherently when scanned top-to-bottom. Don't aggressively rewrite — `state.md` is chronological record, not a curated summary.
- Add a top-of-day "2026-05-15 — EOD (evening)" consolidated header before the per-spec entries from today's cycle, mirroring the morning's "2026-05-15 — EOD" header pattern. The header is a 6-8-sentence summary of what shipped in this cycle, suitable for someone scanning state.md at a later date who needs the gestalt without reading every per-spec entry.

The morning's "2026-05-15 — EOD" consolidated header stays where it is. The new evening header sits ABOVE it in the file (most recent at top). Per-spec entries from both cycles stay verbatim — those are the durable chronological record.

If the morning's header inadvertently said anything that's been superseded by the evening's work (e.g., a "Next: cost hub" pointer that's now closed), Builder leaves it as-is — historical record. The evening header makes any superseded items clear.

Post-state count update: 38 migrations (0038 cost_hub_tables + 0039 subscription_effective_from added today after the morning entry's 36-then-37 count); 11 Python serverless functions (added `api/faq_digest_cron.py`); 6 TopNav tabs unchanged.

## Task 2: CLAUDE.md § Current Focus refresh

§ Current Focus today describes the Director-tier-surfaces + permissions-infrastructure shipping cycle. That paragraph is now historical relative to today's later work. Rewrite to reflect the post-evening post-state:

**New § Current Focus shape (Builder writes; this is direction):**

Post-Gregory-V1 state. The Director-tier surfaces (permissions, Teams Meeting Tracker, May 18 title-convention forcing function, `/tasks` page) shipped 2026-05-14 + morning of 2026-05-15. The cost hub at `/cost-hub` shipped 2026-05-15 evening, closing out Gregory V1 — Nabeel's cost-visibility ask is met with 5 Anthropic LLM-spend buckets, editable subscriptions + one-off extras, monthly history. Ella + Trustpilot operational refinements landed in parallel: Ella's passive-monitor escalation thresholds lowered (softer signals like uncertainty / confusion / clarification-seeking surface through Gate 4), Trustpilot cascade got a first-month carve-out, and the call_reviewer prompt v2 adds `questions_asked` extraction feeding a Friday Slack DM to Scott. Title convention v2 (`[Client Name] - Coaching/Sales Call with {Scott|Lou|Nico}`) extends the May 18 forcing function with name-prefix-as-primary client resolution. Timezone conventions codified as ADR 0003 (store-UTC, render-ET, calendar periods, UTC crons with EST-equivalent comments).

**Next major arc: Gregory V2 — sales-side.** Specifics TBD; the scoping conversation will happen in a future session.

## Task 3: CLAUDE.md § Next Session Priorities refresh

The morning EOD already collapsed this to two items: (1) Admin cost hub, (2) Gregory V2 sales side. Cost hub is now shipped. Update to remove the cost hub item, leaving Gregory V2 as the only standing priority. Also add a brief "Watch posture" pointer covering things that don't warrant a spec but want EOD-eyeball:

**New § Next Session Priorities shape:**

1. **Gregory V2 — sales-side.** Scoping conversation needed. No spec drafted yet.

**Watch posture (no spec yet):**

- **Ella weekly cost trend.** Per Nabeel's "90% of messages through Ella" goal, cost-per-message could matter at scale. Today's run rate is ~$1.25/month — premature to optimize. Check `/cost-hub` Ella buckets weekly; if month-total trends toward $200+/month sustained, spec optimization work (model routing, prompt caching, output token caps).
- **FAQ digest first real fire** is Friday May 22 at 15:00 EDT. Drake validates Scott receives the DM; CC env var (`FAQ_DIGEST_CC_SLACK_USER_ID=U0AMC23G1SM`) lets Drake see it too. Pending gate (d) — Drake sets env var in Vercel + manual curl to test.
- **Post-2026-05-18 title-convention adoption.** Zain's booking link rollout. Audit SQL in `docs/runbooks/call_title_convention.md`. Drake runs Monday afternoon / Wednesday / Thursday next week to catch stragglers.

## Task 4: Stack / folder-structure freshness

CLAUDE.md § Stack table secrets row already lists most current env vars. After today's work, the new env var is `FAQ_DIGEST_CC_SLACK_USER_ID` (optional). Add it to the row. Other env vars unchanged.

§ Folder Structure: bump the `api/` count from "10 deployed" to "11 deployed" (`api/faq_digest_cron.py` shipped today). Bump the migration range any place it's mentioned to "0001–0039."

## Task 5: Reference sweep

Quick sweep for any lingering references to today's shipped specs that should now point at the durable doc instead (runbook, schema doc, ADR, state.md). Same pattern as the morning cleanup's 9-line sweep. Most references should already be in place since each spec's report updated its target docs.

Specifically check for:
- Any reference to `docs/specs/cost-hub*.md` in non-state.md surfaces (should point at `docs/runbooks/cost_hub.md` or `docs/schema/monthly_subscriptions.md` / `cost_extras.md` instead).
- Any reference to `docs/specs/ella-threshold-trustpilot*.md` (should point at the per-feature surfaces — `ella_passive_monitoring.md`, `schema-v1.md` for the 0037 migration, `faq_digest.md`).
- Any reference to `docs/specs/ella-summary-est-alignment*.md` (should point at ADR 0003 or `cron_schedule.md`).
- Any reference to `docs/specs/cost-hub-effective-from*.md` (should point at `monthly_subscriptions.md` schema doc or `cost_hub.md` runbook for the effective_from semantics, and ADR 0002 revision section for title convention v2).

`state.md` per-spec entries keep their `docs/specs/<slug>.md` references — those are slug identifiers + git history is the recovery path; surrounding text stands alone.

## Task 6: Archive (delete) today's spec/report pairs

After Tasks 1-5 commit cleanly, delete the following 11 spec/report pairs in a single doc-hygiene commit:

**Today's evening cycle (7 pairs):**
- `docs/specs/ella-threshold-trustpilot-first-month-faq-harvest.md` + reports (`docs/reports/ella-threshold-trustpilot-first-month-faq-harvest.md` + `docs/reports/ella-threshold-trustpilot-first-month-faq-harvest-resume.md`)
- `docs/specs/faq-digest-cc-and-questions-surface-check.md` + `docs/reports/faq-digest-cc-and-questions-surface-check.md`
- `docs/specs/cost-hub.md` + `docs/reports/cost-hub.md` + `docs/reports/cost-hub-resume.md`
- `docs/specs/cost-hub-call-review-haiku-audit.md` + `docs/reports/cost-hub-call-review-haiku-audit.md`
- `docs/specs/cost-hub-effective-from-and-title-convention-v2.md` + reports (`docs/reports/cost-hub-effective-from-and-title-convention-v2.md` + `docs/reports/cost-hub-effective-from-and-title-convention-v2-resume.md`)
- `docs/specs/cost-hub-vs-ella-cost-discrepancy-diagnostic.md` + `docs/reports/cost-hub-vs-ella-cost-discrepancy-diagnostic.md`
- `docs/specs/ella-summary-est-alignment-and-timezone-adr.md` + `docs/reports/ella-summary-est-alignment-and-timezone-adr.md`

**Yesterday's carryover (3 pairs):**
- `docs/specs/ella-escalation-unify-and-route-to-scott.md` + `docs/reports/ella-escalation-unify-and-route-to-scott.md`
- `docs/specs/ella-passive-escalation-keyword-bypass.md` + `docs/reports/ella-passive-escalation-keyword-bypass.md`
- `docs/specs/gregory-day-end-wrap-2026-05-14.md` + `docs/reports/gregory-day-end-wrap-2026-05-14.md`

**This morning's meta-spec (1 pair):**
- `docs/specs/eod-cleanup-2026-05-15.md` + `docs/reports/eod-cleanup-2026-05-15.md`

**This evening's meta-spec stays in place** — it references its own report; both get deleted at the next EOD per the recursive convention.

`docs/reports/.gitkeep` should remain (per CLAUDE.md convention — folder exists even when empty post-cleanup).

## Hard stops

None. All deletes are recoverable via git history.

## What could go wrong

- **Reference sweep miss.** If a runbook / schema doc somewhere references a deleted spec path, the link breaks. Builder catches via grep before commit; surfaces any uncertain cases in the report rather than guessing.
- **state.md ordering churn.** The chronological-record principle means evening entries go ABOVE morning entries. Builder reads existing entries to verify ordering before inserting.
- **§ Current Focus rewrite drift.** The direction above is descriptive; Builder writes the actual paragraph. If Builder's read of "what's the actual current focus" differs from Director's framing, surface the gap rather than committing a paragraph Drake didn't sign off on.

## Mandatory doc-update list

- `docs/state.md` — evening EOD consolidated header + post-state count update.
- `CLAUDE.md` — § Current Focus rewrite + § Next Session Priorities collapse + Stack secrets row addition + folder structure count update.
- (Possibly) any runbook / schema doc / ADR that still references a soon-to-be-deleted spec path.

## Acceptance criteria

- state.md has the evening EOD header + accurate post-state counts (38 migrations, 11 Python serverless functions).
- CLAUDE.md § Current Focus reflects post-Gregory-V1 state + Gregory V2 as the next arc.
- CLAUDE.md § Next Session Priorities collapsed to "Gregory V2 sales-side" + watch posture.
- CLAUDE.md § Stack secrets row includes `FAQ_DIGEST_CC_SLACK_USER_ID`.
- 11 spec/report pairs (above) deleted in a single `chore: archive 2026-05-15 evening cycle specs and reports` commit.
- This spec's own report references its own slug; both get deleted at the NEXT EOD.
- No broken references in surfaces other than state.md (reference sweep clean).
- `pytest tests/ -q` still 607 passing (no code touched; doc-only).
- `tsc --noEmit` + `next lint` not relevant (no code touched).

## Sequence

1. Read state.md current state. Read CLAUDE.md current state. Read all 11 in-scope spec/report pairs (skim — for grounding).
2. Doc-edit commits (split per logical change):
   - `docs: state.md evening EOD header + post-state count update`
   - `docs: CLAUDE.md current focus + next session priorities refresh`
   - `docs: stack table + folder structure counts (post-2026-05-15-evening)`
   - Reference-sweep commit if anything turns up (`docs: redirect lingering 2026-05-15 spec references to durable surfaces`).
3. Archive commit: `chore: archive 2026-05-15 evening cycle specs and reports` — single deletion commit for the 11 pairs.
4. Final report at `docs/reports/eod-cleanup-2026-05-15-evening.md`.
