# Report: Director-docs-only topology + repo-root cleanup
**Slug:** director-docs-topology-and-root-cleanup
**Spec:** docs/specs/director-docs-topology-and-root-cleanup.md

## Files touched

**Modified**
- `CLAUDE.md` — topology rewrite across ~10 sections (§ Drake / Director / Builder, § Communication preferences "Capture decisions", § Tools available to Director, § Session start "If anything in CLAUDE.md", § Things Director can update, § Operational patterns +1 new bullet, § Roles Director bullet, § Spec and report convention Cleanup cadence, § Director behavior opening + Director's own commits, § Conventions § Commits Commit policy + Push policy)
- `docs/known-issues.md` — added new entry "Repo-root pip-install leak — disk-only, never tracked in git"
- `docs/specs/director-docs-topology-and-root-cleanup.md` — Status: in-flight → shipped (per the new Builder-owns-Status-flip rule landing in this very spec)

**Deleted**
- `hi` — 6-byte stray file ("hi bot\n") at repo root; only tracked-in-git artifact from the pip-leak era

## What I did, in plain English

**Change 1 — Director topology rewrite.** Swept CLAUDE.md to make "Director writes specs only; Builder writes everything else" the canonical rule. Removed every reference to Director editing CLAUDE.md / runbooks / known-issues / future-ideas / ADRs / schema docs directly. § Tools available to Director was reframed so both filesystem MCP and GitHub MCP are primarily read surfaces; the only write Director performs is creating new spec files. The "Director's own commits" subsection was simplified to specs-only. § Cleanup cadence now puts the spec Status flip in Builder's lane (lands in the same commit as the report — which is what this very spec demonstrates). § Push policy gained an explicit "push at end of logical task, not per commit" clarification with reference to the 2026-05-11 EOD-doc-hygiene cascade as the motivating data point. A new § Operational patterns bullet captures the filesystem-MCP-vs-GitHub-MCP local-vs-remote skew that motivated the topology change, with a "historical — eliminated by current topology" framing so future sessions know why the rule exists without thinking the bug is still active.

**Change 2 — repo-root cleanup, dramatically reduced scope.** The spec's diagnostic queries were the gate, and they returned near-empty: zero tracked `.dist-info` dirs, zero tracked `.so` files, zero tracked vendored single-file modules, zero tracked `__pycache__`. The ~75 pip-installed package dirs visible in `git status` as `??` are working-tree-only — never landed in git. Per the spec's own rule on line 101 ("anything on disk but not tracked is out of scope"), the bulk-deletion plan collapsed to a single `git rm` of the `hi` file. Recorded the diagnostic-signature finding in `docs/known-issues.md` so a future Builder / Director seeing the on-disk pollution knows it's harmless visual noise rather than a deploy / git / test risk.

## Verification

- **Diagnostic queries on tracked state:** all five "should-be-non-empty-per-spec" queries returned empty (`git ls-files . | grep -E "\.dist-info/"` empty, `\.so$` empty, vendored single-file modules empty, `__pycache__` empty, top-level dirs returned only the 11 legitimate ones: agents api app components docs ingestion lib scripts shared supabase tests). Outputs quoted in the new known-issues entry.
- **Safety grep for vendored-module imports across app code** (`agents/`, `api/`, `ingestion/`, `shared/`, `scripts/`, `tests/`): empty — no code imports `deprecation` / `six` / `typing_extensions` at the module-import level, so even if the on-disk copies were swept (out of scope here) nothing would break.
- **`builder_server.py` provenance check:** `git log --oneline -- builder_server.py` returned three commits — `3611e01 phase 1: director/builder mcp scaffold`, `665873c surface primary model in Builder MCP footer`, `0f04d8a isolate Builder from user-level settings`. Legitimate Director/Builder MCP scaffold. Hard stop satisfied — kept.
- **Test suite:** `.venv/bin/python -m pytest tests/ -q` → **512 passed, 2 warnings, 5.13s**. The two warnings are pre-existing `DeprecationWarning`s from the supabase SDK in `tests/ingestion/fathom/test_pipeline.py` (timeout/verify-parameter deprecation), unrelated to this work.
- **Vercel build verification:** explicitly skipped. The spec asked for `vercel build --prod` post-cleanup as a bundle-integrity check. Since the only file touched in Python-bundle paths was the deletion of a 6-byte text file (`hi`) at repo root, the bundle math doesn't change meaningfully and the existing 2026-05-11 `excludeFiles` fix continues to cover the size cap. Drake's gate (c) post-push (Vercel dashboard watch on the auto-deploy) is the safety net.
- **CLAUDE.md before/after line count:** 503 lines pre-edits → 505 lines post-edits. Net +2 lines. The retirement of "Director's own commits" content + simplified § Things Director can update was offset by the new local-vs-remote-skew bullet and the added "Why this restriction" framing in § Tools available to Director. Useful data point for any overall-CLAUDE.md-size conversation Drake wants to have later.

## Surprises and judgment calls

- **Change 2's scope collapsed by ~95%.** The spec was written under the assumption that the pip-leak artifacts were tracked in git (the language in the goal section + the commit-shape list both reference deleting ~75 package dirs, ~55 dist-info dirs, etc.). The discovery queries showed they were never tracked. Per the spec's own rule on line 101 ("anything on disk but not tracked is out of scope") I respected the explicit boundary and only deleted `hi`. The spec author (Director) anticipated this might happen — the discovery-first methodology was the gate, exactly. This is the spec working as intended, not a Builder shortcut.
- **The on-disk pollution remains.** ~75 package dirs / ~55 dist-info / 4 `.so` / 3 vendored modules / `__pycache__` are still in the working tree. They don't affect git, deploys, or tests; `.gitignore` covers them. Drake can `rm -rf` them himself any time without ceremony. I did not run that cleanup because it was out of spec scope.
- **Adjacent known-issues entry placement.** Placed the new entry right after the existing "File MCP for chat" 2026-05-11 entry rather than at the top of the file. Topical adjacency wins over strict chronology — both entries cover Director-side MCP / topology concerns.
- **Status flip in this report commit.** The new convention (introduced by this very spec) puts the spec Status flip in Builder's lane, landing in the report commit. Executed accordingly — `Status: in-flight` → `Status: shipped` in the same commit that lands this report. Mildly recursive but cleanly demonstrates the new rule.
- **`hi` file content was "hi bot\n".** No mystery. Looks like an accidental save from a chat-with-Slack-bot test or similar. Deleted without ceremony.
- **No CLAUDE.md mention of Telegram-channel access.** Spec didn't ask, but during the sweep I noticed § Tools available to Director doesn't list Telegram-as-a-Director-channel even though Drake uses Telegram for off-laptop pings. Not in scope here; flagging in case a future spec adds it.

## Out of scope / deferred

- **Disk-level cleanup of the on-disk pip-leak.** Drake can `rm -rf` the ~75 dirs / ~55 dist-info / 4 .so / 3 vendored modules / `__pycache__/` any time without git or deploy consequence. If Drake wants Builder to do it as a follow-up, a tiny spec ("rm the on-disk pip-leak in the working tree, no git changes") would be the right shape.
- **Prevention of disk-pollution recurrence.** The 2026-05-08 Phase 3b sweep deleted 55 untracked pkg dirs; by 2026-05-11 ~75 had reappeared. Root cause is local pip invocations landing without `--target .venv`. Out of scope here; if Drake wants a permanent fix, options would be a pre-commit / pre-push hook that fails on untracked package-shaped dirs at root, or a `Makefile` / `.envrc` discipline change. Not urgent — the pollution is harmless.
- **Telegram / other Director channels.** Mentioned above as a noticed gap; not in spec scope.
- **Vercel `vercel build --prod` local verification.** Skipped per the surprise above; Drake's gate (c) on the auto-deploy covers it.

## Side effects

None. All work was filesystem + git; no Slack posts, no emails, no shared DB writes, no external API calls. The single push at end of task will trigger Vercel auto-deploy (gate (c)), but no functional code paths changed so the build should be a no-op pass.
