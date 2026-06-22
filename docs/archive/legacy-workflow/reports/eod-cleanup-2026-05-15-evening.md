# Report: EOD cleanup 2026-05-15 (evening)

**Slug:** eod-cleanup-2026-05-15-evening
**Spec:** docs/specs/eod-cleanup-2026-05-15-evening.md

## Files touched

**Modified:**
- `docs/state.md` — inserted the "2026-05-15 — EOD (evening)" consolidated header above the morning EOD header (most-recent-at-top) + post-state counts.
- `CLAUDE.md` — § Current Focus rewritten to post-Gregory-V1; § Next Session Priorities restructured (1 item + Watch posture); § Stack secrets row += `FAQ_DIGEST_CC_SLACK_USER_ID`; § Folder Structure `api/` 10 → 11.
- `docs/runbooks/cost_hub.md`, `docs/decisions/0003-timezone-conventions.md`, `docs/decisions/0002-title-convention-enforcement.md` — reference sweep: redirected soon-deleted `docs/specs/<slug>.md` citations to slug-as-identifier + git-history-recovery phrasing.

**Created:**
- `docs/reports/.gitkeep` — the CLAUDE.md convention claims it exists; it didn't. Created so the folder survives an empty state going forward.
- `docs/reports/eod-cleanup-2026-05-15-evening.md` — this report.

**Deleted (archive commit, 25 files):** 11 shipped spec/report pairs (incl. 3 `-resume` reports) — the 7 evening-cycle specs, 3 Thursday carryover, 1 morning meta-spec. Full list in the archive commit message.

## What I did, in plain English

Evening doc-hygiene wrap of the post-morning Friday ship cycle (cost hub, FAQ harvest, title v2, timezone alignment), mirroring the morning `eod-cleanup-2026-05-15` precedent.

**state.md (T1):** added a 6-8-sentence evening EOD consolidated header above the morning one — chronological-record principle, most-recent-at-top, morning header + all per-spec entries left verbatim. Post-state: 39 migrations / 11 Python serverless functions / 6 TopNav tabs / 607 pytest.

**CLAUDE.md (T2-T4):** § Current Focus was still framing the morning Director-tier cycle as "the" focus with stale 36/10 counts and a superseded "Next: Send-to-Slack #1" pointer — rewrote to "Gregory V1 closed 2026-05-15" + the evening operational refinements + "next arc: Gregory V2 sales-side". § Next Session Priorities restructured to a single Gregory-V2 item plus a "Watch posture" block (Ella weekly cost trend, FAQ digest first fire May 22, post-2026-05-18 title-convention adoption). § Stack secrets row gained `FAQ_DIGEST_CC_SLACK_USER_ID`; § Folder Structure `api/` count 10 → 11.

**Reference sweep (T5):** grep of durable surfaces (runbooks / ADRs / CLAUDE.md, excluding state.md + the specs/reports themselves) found 3 live citations of about-to-be-deleted spec paths. Reworded each to the established "deleted at EOD — recover from git history" precedent (ADR 0002 already used this pattern for the `classifier-enforce-new-title-convention` spec).

**Archive (T6):** `git rm` of the 25 files in one `chore:` commit. The evening meta-pair (`eod-cleanup-2026-05-15-evening` spec + this report) stays — deleted at the next EOD per the recursive convention.

## Verification

- **state.md:** evening header sits above the morning header; morning header byte-unchanged; per-spec entries intact (only an insertion above the `### 2026-05-15 — EOD:` line).
- **CLAUDE.md:** `grep` confirms no remaining `0001–00XX` migration-range string (none ever existed in CLAUDE.md — it lives in state.md/schema-v1.md, already current); the only count is the refreshed "39 migrations / 11 functions / 6 tabs". `FAQ_DIGEST_CC_SLACK_USER_ID` present in the secrets row; `api/` reads "11 deployed".
- **Reference sweep:** post-edit re-grep of durable surfaces for the 11 deleted slugs returns only the reworded git-history-recovery mentions — no live `docs/specs/<slug>.md` link that resolves to a deleted file. state.md per-spec slug refs intentionally retained (convention: slug = identifier, git = recovery).
- **Archive commit:** 26 files changed — exactly 25 deletions (verified count: 11 specs + 14 reports) + 1 `.gitkeep` add. `docs/specs/` left with only `eod-cleanup-2026-05-15-evening.md`; `docs/reports/` left with `.gitkeep` + `README.md`.
- **`pytest tests/ -q`:** 607 passed — unchanged (doc-only spec, no code touched). `tsc --noEmit` / `next lint` not run — not relevant, zero code/TS files in the diff.

## Surprises and judgment calls

- **Spec said "38 migrations"; disk + ledger show 39.** The spec's Task 1 + acceptance criteria state 38, but the parenthetical math ("36-then-37 count" then +0038 +0039) and the filesystem (`ls supabase/migrations/*.sql` = 39, contiguous 0001–0039, 0037+0038+0039 all present) make the truthful count 39 (morning's latest was 0036; the evening cycle added 0037 trustpilot-first-month + 0038 cost_hub_tables + 0039 subscription_effective_from = three). Used **39** per CLAUDE.md's "stale state.md is worse than none" principle — a spec arithmetic slip shouldn't propagate a wrong count into the durable record. Flagged here per the spec's "if Builder's read differs from Director's framing, surface the gap" guidance.
- **`docs/reports/.gitkeep` didn't exist** despite CLAUDE.md § Spec-and-report-convention asserting "`docs/reports/` has a `.gitkeep` so the folder exists even when empty post-cleanup." Latent gap. Created it as part of the archive commit (zero-risk, squarely in the cleanup's blast radius, makes the stated convention actually true). `docs/reports/` also still has `README.md`, so the folder was never actually at risk — the `.gitkeep` is belt-and-suspenders per the written convention.
- **§ Current Focus rewrite is descriptive, not Director-signed-off verbatim.** The spec gave a direction paragraph; I wrote the actual prose to match the post-state I verified (39/11/6, ADRs 0001-0003, V1-closed framing). It tracks the spec's intent closely; no material divergence to escalate — surfacing only that it's Builder-authored per the convention that Director writes specs, Builder writes the doc edits.
- **Reference sweep was light (3 hits).** Each spec's own report had already pointed its durable docs at the right surfaces during its ship, so only 3 residual spec-path citations remained — consistent with the spec's "most references should already be in place" expectation.

## Out of scope / deferred

- The evening meta-pair (this spec + report) is intentionally NOT deleted — recursive convention; it goes at the next EOD cleanup.
- No code, schema, or migration changes — pure doc hygiene.
- The "38 vs 39 migrations" spec slip is not fixed in the spec itself (spec is about to be deleted anyway; the durable record — state.md/CLAUDE.md — carries the correct 39).

## Side effects

- **No cloud writes, no API calls, no Slack posts, no env changes, no migrations.** Pure local doc edits + git operations.
- **Git history is the recovery path** for all 25 archived files (`git log --diff-filter=D -- <path>` then `git show <commit>^:<path>`), per the standing convention.
- **Push** publishes 7 commits (T1 state.md / T2 CLAUDE.md focus+priorities / T3 stack+folder / T5 reference sweep / T6 archive / this report) to `main`; no deploy-affecting changes (docs only — Vercel rebuilds but nothing user-facing changes).
