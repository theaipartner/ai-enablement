# Merge gregory-editorial-skin to main
**Slug:** merge-gregory-editorial-skin-to-main
**Status:** in-flight
**Target branch:** `main`

## Context

Drake reviewed the `gregory-editorial-skin` branch's Vercel preview and approved it. Gregory's editorial-dark reskin (electric-blue accent, serif headlines, small-caps labels, warm-dark backgrounds) is ready to ship to production.

This spec executes the merge from `gregory-editorial-skin` → `main` and handles the operational follow-on (state.md update, post-merge verification, branch cleanup).

The visual changes don't touch data, schema, or any backend logic — same data, new paint. Production users (Scott, Lou, Nico, Drake) will see the new look on their next page load after the deploy lands.

## Drake-confirmed scope

- **Merge type:** straight merge from `gregory-editorial-skin` into `main`. No squash. Preserves the commit history of the design work for future reference / forensics.
- **Conflict expectations:** none expected — `gregory-editorial-skin` was cut from main, and Drake hasn't made conflicting changes to main since (the only main-side commits since the branch was cut are specs in `docs/specs/`, which don't conflict with code changes on the feature branch).
- **Post-merge:** delete the `gregory-editorial-skin` branch (its work has landed) and update `docs/state.md` to log the ship.
- **No production verification step in this spec.** Drake handles post-deploy smoke himself (gate c). Builder's responsibility ends at "merge committed and pushed."

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. `git status` shows clean working tree. If not, surface — don't merge with uncommitted local changes.
2. `git fetch origin && git checkout main && git pull origin main` to ensure local main is current with origin.
3. `git log --oneline origin/main..origin/gregory-editorial-skin` — confirm the feature branch has commits that aren't on main yet. If the output is empty, the branch was already merged or has no new work; stop and surface.
4. `git log --oneline origin/gregory-editorial-skin..origin/main` — confirm main has commits that aren't on the feature branch. These are the main-side specs that landed during the design work. They should NOT conflict; if any of them touched files the feature branch also modified, surface for Drake's call before merging.
5. Read `docs/reports/gregory-editorial-dark-skin.md` on the `gregory-editorial-skin` branch. Confirm it reports `npm run build` clean and that no off-scope files were modified. This is the final pre-merge sanity check that the work is actually shippable.

## Work

### Step 1 — Merge

```bash
git checkout main
git pull origin main
git merge origin/gregory-editorial-skin --no-ff -m "merge: gregory-editorial-skin → main (visual reskin)"
```

The `--no-ff` flag preserves the merge commit so the feature-branch history is visible. Without it, fast-forward would just replay the commits and lose the visual grouping.

**Expected:** clean merge, no conflicts. If conflicts surface:
- Stop immediately. Don't auto-resolve.
- Surface the conflicting files to Drake.
- Wait for direction.

### Step 2 — Verify locally before pushing

```bash
npm run build
```

Build should be clean. If it fails post-merge despite the feature branch's pre-merge build being clean, something went sideways in the merge (rare but possible if a main-side spec change accidentally referenced code the feature branch removed). Stop and surface.

### Step 3 — Push to origin

```bash
git push origin main
```

Vercel auto-deploys main as production. The new Gregory styling is live on `https://ai-enablement-sigma.vercel.app/clients` (and every other Gregory surface) within ~2-3 minutes of the push completing.

### Step 4 — Delete the feature branch

After the push lands and Vercel's production deploy goes green:

```bash
git push origin --delete gregory-editorial-skin
```

This deletes the remote branch. Builder's local copy can be deleted too:

```bash
git branch -d gregory-editorial-skin
```

If `git branch -d` complains the branch isn't fully merged (it should be merged at this point, but git sometimes gets confused), use `git branch -D` to force-delete after confirming via `git log` that the commits are reachable from main.

### Step 5 — Update docs/state.md on main

Add a single entry under § Gregory or appropriate section noting the editorial-dark reskin shipped 2026-05-12. Short, factual: branch shipped, electric-blue accent, no functional changes, references the original spec slug. One commit:

```bash
git add docs/state.md
git commit -m "docs: log Gregory editorial reskin ship in state.md"
git push origin main
```

This is the only doc update needed. CLAUDE.md doesn't need updating; the reskin doesn't change system state.

## Hard stops

- **Conflicts during merge.** Don't auto-resolve. Surface immediately, wait for Drake's call.
- **`npm run build` fails after merge.** Don't push. Surface. Possible recovery: `git reset --hard origin/main` and investigate before retrying.
- **The feature-branch report (`docs/reports/gregory-editorial-dark-skin.md`) shows red flags** — off-scope file modifications, failed build, unresolved ambiguity. Don't merge until those are addressed.
- **Production deploy fails post-push.** Don't try to fix-forward immediately. Surface to Drake. May need to revert: `git revert -m 1 <merge-commit-sha>` then push to roll back the merge.
- **DO NOT delete the feature branch before confirming the production deploy is green on Vercel.** The branch is the recovery surface if the merge needs to be rolled back. Only after Drake confirms production is good, delete the branch.

## What could go wrong

- **A main-side spec accidentally referenced or modified a file the feature branch also touched.** Mitigation: the pre-merge git log check (acclimatization Step 4) catches this. If it surfaces, manual conflict resolution is required.
- **Production deploy fails because Vercel's build environment differs from local.** Mitigation: the feature branch's preview deploy was already passing on Vercel, so the production build should pass too. If it fails, look at the Vercel build log for the differential.
- **Vercel's auto-deploy doesn't fire from the merge push.** Has happened before (known-issues.md entries from 2026-05-10 and 2026-05-11). Mitigation: monitor the Vercel dashboard after pushing. If no deploy is queued within 5 minutes, trigger a manual deploy from the dashboard.
- **CSMs notice the visual change unexpectedly.** Drake should give Scott / Lou / Nico a heads-up before the deploy lands so they're not surprised. This is Drake's call, not Builder's responsibility. Builder just notes it in the report as a Drake-side follow-up.
- **The reskin reveals a styling regression on a surface Drake didn't review in preview.** Mitigation: rollback path is `git revert -m 1 <merge-commit-sha> && git push origin main`. Reverting brings Gregory back to its pre-reskin state in one commit. The feature branch can then be revived for the fix.

## Mandatory doc updates

Already covered in Step 5 — single line in `docs/state.md`. No other doc changes.

## Commit + report

Per CLAUDE.md § Commits, one logical change per commit. Three commits total:

- The merge commit itself (created by `git merge --no-ff` in Step 1).
- `docs: log Gregory editorial reskin ship in state.md` (Step 5).
- `docs: add report for merge-gregory-editorial-skin-to-main` (the report).

Report at `docs/reports/merge-gregory-editorial-skin-to-main.md` on main. Include:

- Confirmation the merge landed cleanly (no conflicts).
- The merge commit SHA.
- `npm run build` status post-merge.
- Confirmation the feature branch was deleted from origin.
- Vercel deployment URL for the production deploy that ran off the merge.
- A reminder for Drake: smoke the production Gregory surfaces (clients list, client detail, calls list, calls detail, ella/runs, login page) in incognito to confirm the reskin landed correctly. Production URL: `https://ai-enablement-sigma.vercel.app/clients`.
- Any post-merge anomalies that surfaced and how they were resolved (likely none).
