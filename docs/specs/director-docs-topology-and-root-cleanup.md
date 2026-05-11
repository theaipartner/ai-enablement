# Director-docs-only topology + repo-root cleanup
**Slug:** director-docs-topology-and-root-cleanup
**Status:** shipped

## Context

Two bundled changes today. They're not strictly related but Drake explicitly asked to bundle, and both are doc-hygiene / repo-cleanup shaped — one logical Builder session lands them cleanly.

**Change 1 — codify the new Director/Builder topology.** Conversation 2026-05-11: Director was making CLAUDE.md edits directly via filesystem MCP and pushing via GitHub MCP. This created a real footgun — Director's filesystem-MCP write puts uncommitted changes in Drake's local working tree, and the GitHub MCP push creates a commit on `origin` with the same content; when Drake then `git pull`s, the pull fails with "local changes would be overwritten by merge" because git doesn't know the contents are byte-identical. Drake hit this exact failure today after the EOD doc-hygiene commit landed.

Beyond the mechanical footgun, the larger issue is conceptual: Director writing CLAUDE.md / runbooks / known-issues mid-conversation conflates two different things — (a) **planning artifacts** (specs, which describe work to be done) and (b) **state-description artifacts** (CLAUDE.md / runbooks / known-issues / future-ideas / ADRs / schema docs, which describe work that has been done). Planning artifacts are naturally Director's job because they come out of the strategy conversation. State-description artifacts are naturally Builder's job because they're part of executing a change — the CLAUDE.md § Live System State entry for a shipped batch belongs in the same Builder commit-sequence as the code that shipped the batch.

Drake's call (2026-05-11): tighten the topology. Director writes ONLY specs. Every other doc edit is Builder's, always, bundled into whatever spec produces the underlying work. Doc edits that aren't tied to existing in-flight work get their own tiny spec; very-short-term hold-in-memory is acceptable if Builder is actively mid-task and the doc edit can ride along.

**Change 2 — clean up the repo-root pip-install leak.** Repo root currently contains ~75 Python package directories (`anthropic/`, `pydantic/`, `openai/`, `supabase/`, `httpx/`, etc.), ~55 `.dist-info` directories, 4 loose `.so` files, 3 loose vendored single-file Python modules (`deprecation.py`, `six.py`, `typing_extensions.py`), the `hi` mystery file (6 bytes, Drake previously deferred), and a `__pycache__/` at root. These got there during the M3 / M3.3 era pip-install leak (see `docs/known-issues.md` for the historic pattern + the May 8 Phase-3b fix that closed the cache-contamination signature for the Vercel build but didn't sweep the already-tracked junk from git history). The 2026-05-11 Vercel bundle-size fix landed `excludeFiles: "{.next,node_modules}/**"` per Python function but did NOT touch the root-level Python cruft — that work was deliberately left for a separate cleanup pass.

This work IS that pass.

**Bundle rationale.** Change 1 is a doc edit. Change 2 is repo-root cleanup. They're not strictly related but Drake explicitly asked to bundle, both are hygiene-shaped, and both produce mostly-doc + some-delete commits. The independence-rule caveat from CLAUDE.md § Bundling escape valve applies — but the relaxation here is deliberate and acceptable per Drake's call. Builder splits the two changes into clearly-separated commit batches; the report covers both with their own sections.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. **Read this spec end-to-end** and confirm both changes are in scope. Surface anything that's ambiguous.

2. **Read `CLAUDE.md` § Working Norms § Drake / Director / Builder + § Tools available to Director (chat surface) + § Session start + § Things Director can update without asking, AND § Director / Builder System § Roles + § Spec and report convention + § Director behavior + § Director's own commits.** These are the load-bearing sections for Change 1. Map the existing language to the new topology before drafting edits — there are at least 8-10 spots that reference Director-writes-CLAUDE.md / Director-commits-doc-work / Director-uses-filesystem-MCP-for-writes that need rewording.

3. **Read `.vercelignore` and `.gitignore` at repo root.** The cleanup work (Change 2) must NOT remove anything legitimately gitignored (the ignore files exist for a reason — those files don't need to be in git, but might be needed locally). The actual deletions are for things that are CURRENTLY tracked in git but shouldn't be.

4. **Run `git ls-files | grep -E "^(deprecation|six|typing_extensions)\.py$"` and `git ls-files | grep -E "\.dist-info/"` and `git ls-files | grep -E "\.so$"`** to confirm what's actually tracked. The filesystem listing shows what's on disk, but the deletions must operate on what's in git. If something's on disk but already untracked / gitignored, it's not in scope for this spec — leave it alone.

5. **Read `docs/known-issues.md` for the historic pip-leak entry** (the May 8 Phase-3b narrative). Confirm the resolved-status entry is accurate and decide whether this spec's cleanup warrants extending that entry or adding a new one. Likely a new entry: "Repo-root pip-install leak swept from git history" with the diagnostic signature for future detection.

## Goal

**Change 1.** CLAUDE.md reflects the new Director-writes-specs-only topology. Every reference to Director writing CLAUDE.md / runbooks / known-issues / future-ideas / ADRs / schema docs gets reworded — those are now Builder-only. Director's tool description (§ Tools available to Director) gets reframed: filesystem MCP and GitHub MCP are now primarily *read* surfaces, with the only *write* operation being spec creation. The two-step write-then-commit handshake language goes away — there's nothing for Director to commit that isn't a spec.

**Change 2.** Repo root contains only legitimate top-level project files. Every pip-leak artifact (package dirs, dist-info dirs, loose `.so` files, vendored single-file modules) deleted from git tracking. The mystery `hi` file deleted. The `__pycache__/` at root deleted (and gitignore extended if needed to keep it gone). Test suite passes; `vercel build --prod` succeeds; the production deploy that follows this work lands clean.

## What success looks like

### Change 1 — CLAUDE.md topology edits

The principle: **Director writes specs. Builder writes everything else.**

Specific rewordings (Builder owns final phrasing; these are the load-bearing changes):

- **§ Working Norms § Drake / Director / Builder** (the paragraph that introduces Director's role). Today's text says Director "writes specs to `docs/specs/<slug>.md` for non-trivial work, persists those specs and any CLAUDE.md / docs / runbook updates (via filesystem MCP on desktop, or GitHub MCP on mobile), commits + pushes them to GitHub via the GitHub MCP connector". New text: Director writes specs only. Everything else routes through Builder. No mention of Director committing or pushing.

- **§ Working Norms § Communication preferences § "Capture decisions in writing"**. Today: "CLAUDE.md / spec / runbook updates land in the same chat turn as the decision — written via filesystem MCP (desktop) or GitHub MCP (mobile), then committed + pushed via GitHub MCP." New: decisions land in specs (if substantial) or get held in chat memory if Builder is actively mid-task and the doc edit rides along with the current work. Director never writes non-spec docs directly.

- **§ Working Norms § Tools available to Director (chat surface)**. Rewrite the filesystem MCP and GitHub MCP bullets to reflect: both tools are primarily *read* surfaces (read CLAUDE.md, read specs, read reports, read code, read schema docs). The only *write* operation is creating new spec files in `docs/specs/<slug>.md`. Filesystem MCP for spec writes on desktop; GitHub MCP for spec writes on mobile (single-step `create_or_update_file`). Mention the drift footgun and how it's avoided by-construction now: Director's only write is creating new files, not editing existing ones, so the local-vs-remote race that bit Drake on 2026-05-11 doesn't recur for non-spec edits (there are no non-spec edits) and for spec edits the risk is minimal because new files don't conflict with existing local working-tree state.

- **§ Working Norms § Session start**. Today: "On desktop, loads CLAUDE.md and any recent specs/reports via filesystem MCP (live disk state). On mobile, loads via GitHub MCP." Keep the read-surface framing; remove any implication that Director will write during session start.

- **§ Working Norms § Things Director can update without asking**. Today lists working norms / known-issues / specs / Live-System-State / Next-Session-Priorities / Current-Focus. Tighten to: **specs only**. Working-norms changes, known-issues entries, Live-System-State updates, etc. all route through specs that Builder executes. If Director and Drake decide a CLAUDE.md edit needs to happen, Director writes a spec for that edit — even if the spec body is "rewrite paragraph X in § Y to say Z."

- **§ Director / Builder System § Roles** (the bullet for Director). Today: "persists doc changes via filesystem MCP (desktop) or GitHub MCP (mobile), then commits + pushes via GitHub MCP". New: "writes specs to `docs/specs/<slug>.md` (via filesystem MCP on desktop or GitHub MCP on mobile). Does not edit any other documentation directly — every doc change rides in a spec that Builder executes."

- **§ Director / Builder System § Spec and report convention § Cleanup cadence**. Today: "Director updates the spec's `Status:` to `shipped` (via filesystem MCP on desktop, GitHub MCP on mobile, then committed via GitHub MCP) but leaves both spec and report files in place during the working day." Question for Builder: is the `Status:` flip itself a Director action (a spec is a Director artifact) or a Builder action (changing a doc file = Builder)? Strict reading of the new rule says Builder. But it's mechanically awkward — Builder would need a tiny commit just to flip status. Builder's call on resolution; suggest Builder flips status as part of the same final commit that lands the report. Update the section wording accordingly.

- **§ Director / Builder System § Director behavior** (the opening paragraph + the "Director's own commits" subsection). Today says Director uses filesystem MCP on desktop and GitHub MCP on mobile to write doc work, then commits + pushes. The "Director's own commits" subsection gets retired entirely. The opening paragraph reduces to: Director plans with Drake, writes specs, tells Drake the spec is ready. That's it. Drake hands the spec to Builder.

- **§ Conventions § Commits § "Commit policy" paragraph**. Today: "Director commits doc work (CLAUDE.md, specs, runbooks, ADRs) via GitHub MCP as Drake confirms changes in chat." New: "Director writes specs only. Builder commits every other doc change as part of executing the spec that produced the change."

- **§ Ella (active focus) and other in-line references**. Sweep for any lingering "Director updates X" or "Director commits Y" language and reword. There may be a handful of small references scattered.

### Change 1 — push timing

Today's CLAUDE.md commit policy says Builder commits frequently and pushes per the existing rule. The 2026-05-11 conversation surfaced that Director was pushing-per-doc-commit (16 commits cascaded for the EOD doc-hygiene), which violated "one push per logical task" even though it satisfied "one logical change per commit."

Add an explicit clarification to the CLAUDE.md § Commits § "Push policy" paragraph: **push at end of logical task, not per commit**. Multiple commits can land in one push. Single-push-per-task is the rule.

This change is mostly a Director-side discipline thing (Builder already operates this way), but worth pinning in CLAUDE.md so future Director sessions don't drift back.

### Change 1 — local-vs-remote skew note

The 2026-05-11 footgun is worth documenting so future Builder / Director sessions don't re-discover it the hard way. Add a short subsection under § Working Norms § Operational patterns or similar — Builder picks the right home — describing:

- Filesystem MCP writes go to Drake's local disk
- GitHub MCP writes go to `origin`
- When Director writes via filesystem MCP AND pushes via GitHub MCP, the local working tree carries uncommitted changes that mirror the resulting remote commit — `git pull` aborts because git doesn't recognize the byte-identical match
- Resolution: `git checkout -- <file>` to discard local copies, then pull
- Prevention going forward: under the new topology, Director never writes non-spec docs, so this race is eliminated by construction. The remaining case (Director writes a new spec via filesystem MCP and Builder pulls in a fresh Code session) is safe because new files don't conflict with anything in Drake's working tree.

This section is descriptive (here's how the system actually works), not aspirational. Keep it tight.

### Change 2 — repo-root cleanup

**Diagnostic first.** Before deleting anything, Builder runs three classification queries:

```
git ls-files . | wc -l                          # baseline count
git ls-files . | grep -E "^[a-z_]+/" | head -20 # tracked package-like dirs at root
git ls-files . | grep -E "\.dist-info/"         # tracked dist-info dirs
git ls-files . | grep -E "\.so$"                # tracked .so files
git ls-files . | grep -E "^(deprecation|six|typing_extensions)\.py$"  # vendored single-file modules
git ls-files . | grep -E "__pycache__"          # tracked pycache anywhere
git ls-files . | grep "^hi$"                    # the hi file
```

Quote the outputs in the report. The deletion list is *exactly* what these queries return, no more. Anything on disk but not tracked is out of scope (it might be gitignored locally and irrelevant to this cleanup).

**Pre-deletion safety grep.** For each vendored single-file module (`deprecation.py`, `six.py`, `typing_extensions.py`) and for each `.so` file's base name (`mmh3`, `_cffi_backend`, `pyroaring`, `81d243bd2c585b0f4821__mypyc`), grep the codebase for imports:

```
grep -rn "^import deprecation\|^from deprecation " --include="*.py" .
grep -rn "^import six\|^from six " --include="*.py" .
grep -rn "^import typing_extensions\|^from typing_extensions " --include="*.py" .
grep -rn "^import mmh3\|^from mmh3 " --include="*.py" .
# ... etc per file
```

These imports SHOULD all resolve to `.venv/lib/python3.12/site-packages/` rather than the repo root — but if any code is importing from root (because the root copy ended up first on `sys.path`), deleting the root copy will break the import. If grep returns imports of `deprecation` / `six` / `typing_extensions`, Builder checks whether those imports are legitimate dependencies (then verifies `.venv` has them) or accidental (then the imports themselves may need cleanup before the root files are deleted). Surface findings; don't blind-delete.

**`builder_server.py` at repo root.** This file's purpose isn't clear from context. Builder runs `git log -- builder_server.py` and `git blame builder_server.py | head -10` to identify provenance. **Do not delete without surfacing.** If it's legitimate (e.g., a local dev server for Builder/Code), it stays. If it's another stray artifact, flag and ask Drake before removing. **Hard stop on this specific file.**

**`__pycache__/` at root + elsewhere.** `git ls-files | grep __pycache__` shows what's tracked. Tracked `__pycache__` is always wrong — it's compiled bytecode that should be regenerated locally. Delete all tracked instances. Verify `.gitignore` already excludes `__pycache__/` (it should); if for some reason it doesn't, add it.

**The `hi` file.** 6 bytes, no purpose, Drake previously deferred. Delete.

**Deletion sequence.** Group into logical commits (the EOD doc-hygiene cascade showed why per-file commits get ugly):

1. `chore(cleanup): remove tracked __pycache__/ directories from git`
2. `chore(cleanup): remove vendored single-file Python modules from repo root` (deprecation.py, six.py, typing_extensions.py — if grep confirms safe)
3. `chore(cleanup): remove loose .so files from repo root`
4. `chore(cleanup): remove pip-leaked package directories from repo root` (the ~75 directory deletion — this commit is mechanically large but conceptually one change)
5. `chore(cleanup): remove pip-leaked .dist-info directories from repo root`
6. `chore(cleanup): remove stray hi file from repo root`

Use `git rm -r <dir>` for directories, `git rm <file>` for files. Verify deletion locally before each commit (`git status` should show the staged deletions only).

**Test gate between commits.** After EACH commit batch above, run `.venv/bin/python -m pytest tests/ -x` (`-x` to fail-fast). If any test breaks, STOP, surface, and roll back the offending commit before continuing. The 507-test suite is the safety net — if a vendored module deletion broke an import, the suite catches it immediately.

**Vercel build verification.** After all the deletion commits land but BEFORE pushing to `origin/main`, run `vercel build --prod` locally to confirm the Python function bundles still resolve correctly. The 2026-05-11 bundle-size fix (`excludeFiles: "{.next,node_modules}/**"`) drops `.next/` and `node_modules/` from the bundle — but the root-level pip-leak directories were NOT excluded, which means they WERE being bundled. Removing them should make the bundle smaller (potentially significantly), not break it. If `vercel build` fails, STOP and surface.

**Push.** One push, at the end, containing all the deletion commits + the Change 1 doc commits.

## Hard stops

- **`builder_server.py` at repo root.** Do not delete without surfacing to Drake first. Run `git log --oneline -- builder_server.py` and quote the output in the report.

- **Pre-deletion grep returns imports of vendored modules from app code.** If `from deprecation import` or `from six import` or `from typing_extensions import` shows up in `agents/`, `api/`, `ingestion/`, `shared/`, `scripts/`, or `tests/`, STOP and surface. Don't assume the import resolves to site-packages — verify, then proceed.

- **Test suite fails after any deletion batch.** Roll back the offending commit, surface what broke. Don't continue.

- **`vercel build --prod` fails after deletions.** Roll back; surface.

- **CLAUDE.md edits would change the meaning of Drake's gates (a)/(b)/(c)/(d) or alter the spec/report convention's structural rules.** The topology change is about *who writes what*, not about *what the rules are*. Don't expand scope. If a reword feels like it's changing more than the "Director writes, Builder writes" boundary, stop and surface.

- **Any deletion commit exceeds ~300 file changes.** Split into smaller batches. (The ~75 package directories deletion will be near this limit; that's why it's its own commit.)

## What could go wrong (think this through)

- **A vendored single-file module IS being imported from root.** Unlikely (Python's import system prefers site-packages when both are on sys.path), but possible if any code does `sys.path.insert(0, '.')` or similar. The pre-deletion grep + test suite catch this. If it happens, the fix is to remove the bad `sys.path` manipulation and import from site-packages instead.

- **The `__pycache__/` deletion regenerates instantly when tests run.** That's fine — those regenerated ones are gitignored. The issue is only with the *tracked* `__pycache__/` content that's polluting git history.

- **Vercel bundle size CHANGES after the cleanup.** Should decrease, possibly significantly. The 2026-05-11 fix landed `excludeFiles` to drop `.next/` + `node_modules/`; this cleanup removes another ~50-100 MB of pip-leak content from the actual repo. Result: bundles get smaller, deploys faster, more headroom under the 250 MB cap. Worth noting in the report.

- **The `git rm -r` on 75 directories takes a noticeable wall-clock time and produces a wall-of-text in `git status`.** Expected. Verify the staged deletions match the list from `git ls-files` before committing.

- **CLAUDE.md gets longer or shorter as a result of the topology edits.** Drake has flagged CLAUDE.md size as something he wants to talk about. This spec's edits are likely net-shorter (removing the two-step write-then-commit language, removing the "Director's own commits" subsection, simplifying § Tools available to Director). Note the before/after line count in the report so the conversation about overall CLAUDE.md size has a data point.

- **The local-vs-remote skew note added to CLAUDE.md may not be needed in CLAUDE.md if it's purely historical.** Builder's call on whether to include it as a permanent reference or just leave it as a one-time correction note in this report. Lean toward: include in CLAUDE.md briefly (one paragraph) so future Director/Builder sessions know why the topology was tightened.

- **Status flip on this very spec.** When this work ships, the spec's `Status:` flips from `in-flight` to `shipped`. Under the new rule, that's Builder's job — flip it as part of the final report-commit. The cleanup-from-the-shipped-pair (delete-the-spec, delete-the-report) is still Drake's gate ("delete now" or "EOD cleanup" cue), per the existing cleanup-cadence rule.

## Mandatory doc updates

All in `CLAUDE.md` per Change 1's spec body above. Specifically:

- § Working Norms § Drake / Director / Builder — paragraph reworded
- § Working Norms § Communication preferences § "Capture decisions in writing" bullet — reworded
- § Working Norms § Tools available to Director (chat surface) — full subsection rewritten
- § Working Norms § Session start — paragraph tightened
- § Working Norms § Things Director can update without asking — list reduced to specs-only
- § Working Norms § Operational patterns — new short bullet/paragraph documenting the local-vs-remote-skew gotcha (Builder picks placement)
- § Director / Builder System § Roles — Director bullet reworded
- § Director / Builder System § Spec and report convention § Cleanup cadence — Status-flip ownership clarified (Builder owns Status flip; Drake still owns the EOD-cleanup delete-the-pair cue)
- § Director / Builder System § Director behavior — opening paragraph tightened; "Director's own commits" subsection retired
- § Conventions § Commits § "Commit policy" paragraph — Director writes specs only language
- § Conventions § Commits § "Push policy" paragraph — explicit push-at-end-of-task-not-per-commit clarification

Plus: `docs/known-issues.md` gets a new resolved-status entry capturing the pip-leak cleanup (Change 2) with the diagnostic signature (~75 package dirs + 55 dist-info + 4 loose .so files + 3 vendored single-file modules at repo root, all tracked in git, swept 2026-05-11) so future-Builder/Director can detect a recurrence.

No new ADR needed — the topology change is captured in CLAUDE.md directly.

No `docs/agents/` updates — this is meta-work, not agent-work.

No `docs/runbooks/` updates — no new operational procedure introduced.

## Commit shape

Per CLAUDE.md § Commits + the push-at-end-of-task rule from Change 1:

Change 1 (doc edits):
1. `docs: tighten Director topology — Director writes specs only, Builder owns all other doc edits`
2. `docs: clarify push-at-end-of-task in commit/push policy`
3. `docs: note filesystem-MCP-vs-GitHub-MCP local-vs-remote skew gotcha`

Change 2 (repo-root cleanup):
4. `chore(cleanup): remove tracked __pycache__/ directories from git`
5. `chore(cleanup): remove vendored single-file Python modules from repo root`
6. `chore(cleanup): remove loose .so files from repo root`
7. `chore(cleanup): remove pip-leaked package directories from repo root`
8. `chore(cleanup): remove pip-leaked .dist-info directories from repo root`
9. `chore(cleanup): remove stray hi file from repo root`
10. `docs: record pip-leak cleanup in known-issues`

Final:
11. Report commit.

All commits go in ONE push at the end of the task. Not per-commit pushes. The 11 commits above all push together via a single `git push origin main` after the report is written.

Report at `docs/reports/director-docs-topology-and-root-cleanup.md` per the spec/report convention.

After report lands, Drake reads it. The Status flip on this spec (in-flight → shipped) happens in the report commit per the new convention. The EOD-cleanup delete-the-pair happens at Drake's explicit cue, separately, as today.
