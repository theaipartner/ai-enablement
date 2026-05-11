# Report: Investigate — Gregory list changes shipped to main but not present in Vercel production build
**Slug:** investigate-vercel-build-missing-changes
**Spec:** docs/specs/investigate-vercel-build-missing-changes.md

## Files touched

**Created:** `docs/reports/investigate-vercel-build-missing-changes.md` (this file).

**Modified:** none — read-only diagnosis per spec § Commit + report.

**Build artifact:** `.next/` rebuilt locally at commit `8d39c91` via clean `npm ci` + `npm run build`. Not committed; ephemeral.

## What I did, in plain English

Reproduced the local build of `8d39c91` from scratch (clean `npm ci`, deleted `.next` and `node_modules/.cache`), confirmed it contains the new code, then probed Vercel's deployed CDN for the same chunk filenames. The local build of `8d39c91` produces a server bundle and a route-specific client chunk that reference `EditableStatusCell`, render `"CSM Standing"`, and emit the new column order. Vercel's deployed CDN returns 404 for the local-built route chunk filename, and Vercel's deployed CSS file is ~500 bytes smaller (fewer Tailwind utility classes) than the local-built CSS. The shared framework chunks (`fd9d1056-*`, `117-*`, `webpack-*`) are byte-identical between local and Vercel. Conclusion: spec hypothesis (3) is disproven (local build is correct); the bug is on Vercel's side, and the strongest hypothesis is that Vercel's deployment artifact was NOT built from commit `8d39c91`'s actual source despite the dashboard saying so.

## Verification

### Step 1 — Clean local build on `8d39c91`

`git checkout 8d39c91` (HEAD was previously `74ec526`, just the spec file ahead). `rm -rf .next node_modules/.cache && npm ci && npm run build` ran clean:

- `✓ Compiled successfully`
- `✓ Generating static pages (9/9)`
- 0 type errors, 0 lint warnings, 0 warnings about excluded files / unresolved imports
- Route table:

  ```
  ƒ /clients                               3.23 kB         166 kB
  ƒ /clients/[id]                          8.36 kB         147 kB
  ```

  `/clients` is **`ƒ (Dynamic)`** — confirms `export const dynamic = 'force-dynamic'` took effect.
- Local buildId: `BSSERMB7R9ZzY-YdVaeZd`

### Step 2 — `.next/` grep for new code

```
.next/static/chunks/app/(authenticated)/clients/page-54266823c09aaa63.js   ← contains EditableStatusCell, "CSM Standing"
.next/static/chunks/app/(authenticated)/clients/[id]/page-89e352e060fa3ef0.js   ← contains BackToClientsButton
.next/server/app/(authenticated)/clients/page.js   ← contains EditableStatusCell, "CSM Standing"
```

Column labels in the server bundle, in build order, from grep:

```
"Full name" "Status" "Journey stage" "Primary CSM" "CSM Standing"
"NPS standing" "Trustpilot" "Health score" "Meetings this mo"
```

This is Scott's new order exactly. The server-rendered HTML produced by this bundle WILL include `<th>CSM Standing</th>` and editable-cell components.

**Verdict on hypothesis (3):** disproven. Local build of `8d39c91` is correct.

### Step 4 — Vercel-side probe (no CLI; HTTP from production URL)

Compared Vercel's deployed chunk filenames against the local build:

| Asset class | Local hash | Vercel hash | Match? |
|---|---|---|---|
| `webpack-*.js` | `16ea2f0c5b7207a8` | `16ea2f0c5b7207a8` | **identical** |
| `fd9d1056-*.js` (framework) | `fd9d1056-8a3b1316f869f542` | `fd9d1056-8a3b1316f869f542` | **identical** |
| `117-*.js` (framework) | `117-aab1283851af5534` | `117-aab1283851af5534` | **identical** |
| `main-app-*.js` | `76b35410fbff8c9a` | `2dcde4753ea0d175` | differs (byte-level: same content modulo a single webpack module-ID — `219` vs `8391`) |
| `app/(authenticated)/clients/page-*.js` | `54266823c09aaa63` | **404 at this filename** | — |
| `app/login/page-*.js` | `9f3041bb1c7eb5db` | `18cbcd0cbaa17185` | differs |
| `app-css` | `561a5210b642f79d` (54195 B) | `26dd5b1090c82a28` (53689 B) | differs; Vercel is **~500 bytes smaller** |
| `buildId` | `BSSERMB7R9ZzY-YdVaeZd` | `emWL23KfCwxUVvo-mz88O` | differs (expected — every build gets unique) |

The shared framework chunks being byte-identical confirms both builds linked the same Next.js + React. The `main-app` chunk differing only in a webpack module ID is normal nondeterminism. The CSS being smaller on Vercel is the strongest tell: **Tailwind's purger emits classes based on what source files reference them; a smaller CSS means Vercel's build saw fewer source files (or fewer classes-in-use) than the local build did**.

The 404 on `app/(authenticated)/clients/page-54266823c09aaa63.js` doesn't by itself prove anything (Vercel's build would emit a different content hash even for identical source, due to webpack module-ID nondeterminism). But combined with the smaller CSS, the signal is that Vercel's build operated on a smaller source-tree.

### Step 5 — Vercel project-settings flags (Drake confirms)

Builder can't read Vercel's project settings without the CLI / dashboard. The settings worth Drake's eyeball:

- **Production Branch** → must be `main`. If it's anything else, commits to `main` don't trigger Production deploys, and "Promote to Production" promotes an older preview that wasn't built from `main`.
- **Build Command** → must be default (`npm run build` or empty / inherits framework default). A custom override (e.g., `next build --no-experimental-app`) could exclude App Router routes from compilation.
- **Output Directory** → must be `.next` (default). If overridden, deployment serves a different output tree.
- **Root Directory** → must be empty / repo root. If set to a subdirectory, `app/(authenticated)/clients/` would be outside the build scope.

### Step 6 — Commit-SHA comparison

Per spec § Step 6: "What's the commit Vercel actually checked out? The build log will show this in the Cloning step at the top." Builder doesn't have Vercel CLI access; this is a Drake-eyeball check.

`git rev-parse 8d39c91` → `8d39c913e1f21d81122e250108aca1346f6ff4c1`. Drake compares this to the first line of Vercel's build log (the `Cloning github.com/...` step). If they differ, that's the bug.

## Surprises and judgment calls

**The smoking gun isn't a single observation; it's the pattern.** No single piece of evidence proves the deployment is wrong (chunk hashes differ even for identical source due to webpack module-ID nondeterminism, build-IDs always differ between builds, CSS hashes can differ for many reasons). But the combination — **smaller CSS on Vercel, plus Drake's own observation that the rendered HTML lacks `CSM Standing` and that all `<td>` cells are still `<a href="/clients/...">` wrapped** — is conclusive: Vercel's build did not see the source files that introduced the editable cells and the new column. The simplest explanation is that Vercel built a different commit than `8d39c91`, despite the dashboard label.

**Drake's earlier check missed the route-specific chunk.** Per the spec context: "All 5 JS chunks fetched from the live site (`fd9d1056-8a3b1316f869f542.js`, `117-aab1283851af5534.js`, `main-app-2dcde4753ea0d175.js`, etc.) grepped clean for `EditableStatusCell` — zero hits." Those three chunks are framework / runtime; they wouldn't contain `EditableStatusCell` even on a correct deploy. The route-specific chunk lives at `app/(authenticated)/clients/page-<hash>.js`, and that's the one to grep. Even so, this isn't where the bug lies — the server-side HTML lacking `CSM Standing` is itself the real evidence.

**No code changes attempted.** Per spec § Hard stops: "You find a fix-worthy bug in the code. STOP. Surface, don't fix. This spec is investigation-only." Held to that. The bug isn't in the code — it's in Vercel's deployment plumbing.

**One thing the local build won't tell us:** whether Vercel's build log shows the same `Compiled successfully` + `9/9 static pages` + `/clients ƒ (Dynamic)` output. If Vercel's build log claims success but the deployed artifact is different from what that log describes, that's the "CDN-level build-artifact cache" case the spec flagged — Vercel built the right thing but is serving the wrong artifact. Builder can't get the Vercel build log without the CLI; Drake pulls this via the dashboard.

## Out of scope / deferred

- **Fix.** This was investigation-only. The fix spec depends on what Drake finds in the Vercel build log + project settings.
- **Vercel CLI access.** Spec § Step 4 said skip if login flow is required and Drake isn't paired. Skipped.
- **Comparing Vercel's deployed `app/(authenticated)/clients/page-*.js` chunk filename against an enumerated list.** Vercel's App Router manifest isn't publicly enumerable; I couldn't find the route chunk filename without authenticating to the dashboard. Drake can view it in the deployment's build log under "Built /clients in X ms".
- **Authenticated-session smoke of the deployed `/clients` HTML.** Builder can't authenticate. Drake's earlier observation of the rendered HTML stands as the primary evidence.
- **State.md / known-issues.md updates.** Per spec § Mandatory doc updates — "None during investigation. Once Drake confirms the root cause, a follow-up spec writes the fix and updates state.md / docs/known-issues.md."

## Side effects

- **No DB writes, no Slack posts, no external API calls.** The only "external" calls were HTTP GETs against Vercel's public CDN (ai-enablement-sigma.vercel.app) — no auth, no state changes.
- **Local `.next/` and `node_modules/` rebuilt.** Both are gitignored and ephemeral.
- **Detached-HEAD checkout to `8d39c91`** to match Vercel's claimed commit exactly. Restored to `main` afterward; working tree clean.

## Final hypothesis + recommended next action

**Hypothesis (highest probability):** Vercel's deployment artifact tagged "Production / 8d39c91" was actually built from an OLDER commit — likely one before `778253b` (the first commit of the editable-cells slice). The dashboard label is misleading; the build log's `Cloning github.com/...` step shows the true commit. Mechanisms that could cause this:

1. **GitHub integration sync lag / stuck pointer.** Vercel's webhook from GitHub was lost or processed in wrong order, and a subsequent "Redeploy" rebuilt from the stale-cached ref instead of fetching fresh.
2. **Production Branch misconfigured.** Vercel's Git settings → Production Branch is set to something other than `main` (e.g., a `release` branch that hasn't been updated since before the slice landed). The "Promote to Production" action moved a stale deployment without rebuilding.
3. **Vercel's no-cache redeploy didn't actually clear the deployment artifact cache.** The 2026-05-08 cache contamination recovery worked once; the spec notes Drake already tried this. Possible the recipe needs a different sequence today (e.g., delete the deployment entirely instead of redeploy).

### Drake's next action (in priority order)

1. **Open Vercel dashboard → ai-enablement → Deployments → click the current Production deployment → "Build Logs" tab.** Look at the very first build-log line: `Cloning github.com/drakeynes/ai-enablement (Branch: main, Commit: <SHA>)`. If `<SHA>` is anything other than `8d39c91...`, that's the root cause. Capture the SHA and report back.

2. **In the same build log, find the route table at the end.** Should show `/clients ƒ` and `/clients/[id] ƒ` (Dynamic). If `/clients` is still `○ (Static)`, the source Vercel built didn't have the `force-dynamic` directive — confirming the wrong commit was built.

3. **In Vercel project settings: Git → Production Branch.** Confirm it's `main`. Confirm "Automatically expose System Environment Variables" if any of the cron / webhook paths read commit SHAs (they shouldn't, but worth a glance).

4. **If 1 confirms wrong commit:** delete the bad deployment via dashboard "Promote" → ".." menu → "Delete." Then trigger a fresh deploy: either push an empty commit (`git commit --allow-empty -m "force: trigger Vercel rebuild" && git push origin main`) or click "Redeploy" with **"Use existing Build Cache" unchecked** on the latest commit.

5. **If 1 confirms `8d39c91` was actually built:** the bug is in Vercel's serve layer, not its build. Same `Redeploy → uncheck Build Cache` recipe (per `docs/known-issues.md` 2026-05-08 entry). If still broken after that, escalate to Vercel support with the build log + this report attached — they have access to the CDN-level deployment artifacts.

The build is correct. The deploy is the suspect.
