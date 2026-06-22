# Merge + close the ella-worktree (close out the @-mention split thread)
**Slug:** merge-and-close-ella-worktree
**Status:** shipped

**Target branch: main**

> Run from the MAIN checkout. This closes out the Ella @-mention/passive-split work thread: verify the `ella-worktree` branch is fully merged into `main`, fast-forward anything outstanding, then remove the worktree + branch. The reply-as-human change (the last worktree thread) is CONFIRMED working on the live deploy by Drake, so the merge gate is clear. The Close backfill is a separate local OS process (PID-tracked, loaded in memory) — git worktree/branch operations do NOT affect it; leave it running.

## Why

Ella's @-mention/passive split + recent-context + reply-as-human work was developed on a separate worktree (`ella-worktree`, checked out at `~/projects/ai-enablement-ella`). The work is validated (reply-as-human confirmed live). Time to fold the branch into `main` and tear down the worktree so there's one source of truth again. NOTE: much of the Ella work appears to have already landed on `main` directly this session — CLAUDE.md is byte-identical across both branches — so the branch may already be even with or only slightly ahead of `main`. Do NOT assume a big divergent merge; ESTABLISH the actual state first.

## Step 1 — establish the divergence (READ FIRST, do not merge blind)

From the main checkout, fetch and compare:

```
git fetch origin
git log --oneline origin/main..origin/ella-worktree   # commits on worktree NOT on main
git log --oneline origin/ella-worktree..origin/main    # commits on main NOT on worktree
```

Report what each shows. Three cases:

- **(A) worktree has ZERO commits ahead of main** (`origin/main..origin/ella-worktree` empty) → nothing to merge; the work already landed on main. Skip to Step 3 (teardown). This is the likely case given CLAUDE.md is identical.
- **(B) worktree is ahead, and main has NOT diverged** (clean fast-forward possible) → Step 2 fast-forward merge.
- **(C) BOTH have commits the other lacks** (true divergence) → STOP and surface to Drake. A divergent merge with potential conflicts is a judgment moment — show Drake the two logs + which files conflict, don't auto-resolve. This is gate (b) territory.

## Step 2 — merge (only if case B)

If and only if it's a clean fast-forward (case B):

```
git checkout main
git merge --ff-only ella-worktree
git push origin main
```

`--ff-only` is deliberate: if it can't fast-forward, it fails loudly rather than creating a merge commit or silently resolving — which kicks back to case C (stop + surface). After push, Vercel auto-deploys; Drake does the gate (c) post-deploy glance.

Confirm post-merge: `git log --oneline origin/ella-worktree..origin/main` is now EMPTY (main contains everything the worktree had).

## Step 3 — verify main has everything, THEN tear down

Before deleting anything, confirm main is a superset of the worktree:

```
git log --oneline origin/main..origin/ella-worktree    # MUST be empty before teardown
```

If that's empty (main has everything), tear down:

```
git worktree remove ~/projects/ai-enablement-ella       # remove the worktree dir
git worktree prune                                       # clean up worktree admin refs
git branch -d ella-worktree                              # delete local branch (-d = safe, refuses if unmerged)
git push origin --delete ella-worktree                   # delete remote branch
```

Use `git branch -d` (lowercase, safe) NOT `-D` (force). If `-d` refuses because the branch looks unmerged, STOP — that means main does NOT have everything, contradicting the Step 3 check, and something's wrong. Surface it.

If the worktree path differs from `~/projects/ai-enablement-ella` (Builder should confirm via `git worktree list`), use the actual path.

## Acclimatization checklist

Confirm in 4 bullets:
- `git worktree list` — the actual worktree path + branch name (confirm it matches `ella-worktree` / `~/projects/ai-enablement-ella`).
- The two `git log` divergence outputs (Step 1) — which case (A/B/C) applies.
- The Close backfill process is running independently (don't touch it) — confirm it's a separate OS process, not a git-tracked thing.
- Whether `ella-worktree` has any UNCOMMITTED/UNPUSHED changes in its working dir (`cd` to the worktree, `git status`) — if there's uncommitted work in the worktree, STOP and surface; teardown would lose it.

## What success looks like

- `git log --oneline origin/main..origin/ella-worktree` is empty (main has all the worktree's work).
- The worktree dir is removed, `git worktree list` no longer shows it.
- The `ella-worktree` branch is gone both locally and on origin.
- The Close backfill process is still running (untouched).
- Report states which case (A/B/C) applied + what was merged (if anything).

## Hard stops

- **Case C (true divergence) → STOP + surface.** Don't auto-resolve a divergent merge.
- **Uncommitted work in the worktree → STOP + surface.** Teardown would destroy it.
- **`git branch -d` refuses (unmerged) → STOP.** Contradicts the superset check; something's off.
- **Do NOT touch the Close backfill process.** It's a separate in-memory OS process; git ops don't affect it, but don't kill/restart it.
- **Do NOT force-delete (`-D`), do NOT force-push, do NOT `--no-ff` merge-commit** without surfacing — the safe path is ff-only or stop.
- MAIN checkout for the merge/teardown commands (the worktree removal is run from the main checkout, not from inside the worktree dir — you can't remove a worktree you're standing in).

## What could go wrong — think this through yourself

Seeds: the likely case is (A) — nothing to merge, because the session pushed Ella work to main directly; if so, don't manufacture a merge, just verify-even and tear down. The dangerous case is uncommitted work sitting in the worktree's working dir that was never committed/pushed — `git status` in the worktree before teardown catches it; losing it is unrecoverable. `git worktree remove` refuses if the worktree has uncommitted changes (good safety), so don't `--force` past that — investigate instead. Removing a worktree you're currently `cd`'d into fails — run teardown from the main checkout. The branch-delete safety (`-d` vs `-D`) is the backstop: if `-d` refuses, trust it over the spec's assumption that main is a superset. And the Close process: it's loaded in memory, so branch deletion / worktree removal can't hurt it — but don't get clever and restart anything.

## Mandatory doc updates

- `docs/state.md` — if it references the ella-worktree as an active dev surface, note the worktree's closed + the @-mention-split work is merged to main. (Read it first; only edit if it actually mentions the worktree.)
- `docs/reports/merge-and-close-ella-worktree.md` — the report: which case applied, the divergence logs, what merged, teardown confirmation, Close-process-untouched confirmation.
- Flip Status to shipped on completion.
- No code changes expected (this is git plumbing) — if a merge brings code, that's the worktree's existing commits, not new work.
