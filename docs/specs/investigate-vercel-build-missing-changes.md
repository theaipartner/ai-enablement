# Investigate: Gregory list changes shipped to main but not present in Vercel production build
**Slug:** investigate-vercel-build-missing-changes
**Status:** in-flight

## Context

Three commits landed on `main` 2026-05-11 21:14 UTC under spec `gregory-list-editable-reorder-refresh`:

- `778253b` — `app/clients: add inline-editable cells, reorder columns, force-dynamic`
- `3e9dff0` — `app/clients/[id]: replace back link with history-aware Client Component`
- `d475e64` + `8d39c91` — docs

Builder's own report stated `npm run build` was clean: 0 type errors, `/clients` route flipped from Static → Dynamic, bundle size delta consistent with `EditableField` + four wrapper components being pulled into the client bundle.

The Vercel Production deployment is on the latest commit (`8d39c91`), promoted to Production, alias verified, build green. A redeploy WITHOUT build cache (clean rebuild) was just attempted by Drake — same broken result.

**The production site is serving the OLD build's HTML and JS.** Verified via Cowork hands-on browser investigation:

- `/clients` returns `x-vercel-cache: MISS`, `age: 0` — fresh response from origin every time
- Response HTML contains 8 `<th>` elements in the OLD order: `Full name / Status / Journey stage / Primary CSM / NPS standing / Health score / Trustpilot / Meetings this mo`. No `CSM Standing` column header anywhere in HTML.
- Every `<td>` is wrapped in `<a href="/clients/<id>">` — no editable-cell components present
- All 5 JS chunks fetched from the live site (`fd9d1056-8a3b1316f869f542.js`, `117-aab1283851af5534.js`, `main-app-2dcde4753ea0d175.js`, etc.) grepped clean for `EditableStatusCell`, `editable-cell`, `CSMStanding`, `inlineedit`, `inline-edit` — zero hits in any chunk
- No service worker, no Cache Storage, no console errors
- The single `CSM Standing` string in view-source is a pre-existing filter button in the toolbar, NOT the new column header

So the new code is on `main`, Builder's report said the build worked locally, Vercel is on the right commit, but the deployed JS bundles don't contain the new code. Either:

1. **Vercel's build of commit `8d39c91` did NOT produce the new code in its output**, OR
2. **Vercel built the right output but is serving a different one**, OR
3. **Builder's `npm run build` locally didn't actually include the new code either**, and the report's claim of "clean build, /clients route flipped to Dynamic" was misread

(3) is the lowest-probability but the cheapest to disprove, and if true it changes everything.

## Acclimatization checklist — confirm in 4-5 bullets before starting

1. `git log --oneline origin/main | head -10` — confirm `8d39c91`, `d475e64`, `3e9dff0`, `778253b` are all present on `origin/main` in that order. If they're missing or out of order, surface immediately — the diagnosis assumption is wrong.
2. `git show 778253b --stat` and `git show 3e9dff0 --stat` — confirm the file changes match Builder's previous report (`app/(authenticated)/clients/clients-table.tsx`, `app/(authenticated)/clients/page.tsx`, `app/(authenticated)/clients/editable-cell.tsx` created, `app/(authenticated)/clients/[id]/page.tsx` modified, `app/(authenticated)/clients/[id]/back-to-clients-button.tsx` created).
3. Cat `app/(authenticated)/clients/editable-cell.tsx` to verify the file content on disk matches the version Director read via MCP (confirms repo state matches what we've been assuming).
4. Confirm `next` version + Node version: `cat package.json | grep -E "\"next\"|\"node\""` and `node --version`. Vercel's build env vs local should match.
5. Read `vercel.json` if it exists at repo root, and `next.config.js` / `next.config.mjs`. Look for anything that could exclude `app/(authenticated)/clients/` from the build, like a custom output config, route group exclusion, or experimental flag that changes routing.

## Work

### Step 1 — Reproduce the build locally on the exact commit Vercel built

```bash
# Confirm you're on the right commit
git fetch origin
git checkout 8d39c91

# Clean build, no cache
rm -rf .next node_modules/.cache
npm ci
npm run build 2>&1 | tee /tmp/build.log
```

**Report from the build:**
- Did it succeed? Any warnings?
- The output table should show every route. Find the row for `/clients`. Is it marked `ƒ (Dynamic)` or `○ (Static)`? Builder's prior report said Dynamic post-change. Confirm.
- What's the bundle size for `/clients`?
- Are there ANY warnings about `app/(authenticated)/clients/editable-cell.tsx` or `back-to-clients-button.tsx` being unused, excluded, or unresolved imports?

### Step 2 — Inspect the local build's output for the new code

```bash
# Find every JS file the build emitted
find .next/static/chunks -name "*.js" -type f | xargs grep -l "EditableStatusCell" 2>/dev/null
find .next/static/chunks -name "*.js" -type f | xargs grep -l "editable-cell" 2>/dev/null
find .next/static/chunks -name "*.js" -type f | xargs grep -l "CSM Standing" 2>/dev/null

# Inspect the server-rendered HTML for /clients
# Run the production build server and capture the response
npm run start &
SERVER_PID=$!
sleep 5

# Auth is required, but we can at least see the redirect to /login
# Or hit a route that doesn't require auth, OR use the build's
# `.next/server/app/(authenticated)/clients/page.html` if statically
# generated (it shouldn't be, post-force-dynamic — but check)

curl -s -L --max-redirs 0 http://localhost:3000/clients -o /tmp/local-clients.html
cat /tmp/local-clients.html | grep -E "CSM Standing|EditableStatusCell|editable-cell" | head

# Also check the build output for /clients's page chunk
ls -la .next/server/app/\(authenticated\)/clients/
cat .next/server/app/\(authenticated\)/clients/page.js | grep -E "EditableStatusCell|editable-cell" | head -5

kill $SERVER_PID
```

**Report:**
- Which (if any) JS chunks contain `EditableStatusCell`?
- Does `.next/server/app/(authenticated)/clients/page.js` (the server-side compiled route) reference the editable cell components?
- If grep returns zero hits in `.next/`, the LOCAL build is also broken — the bug is in the code, not Vercel
- If grep returns hits in `.next/`, the LOCAL build is correct — the bug is in Vercel's build or its output serving

### Step 3 — If local build is broken (no hits in .next)

Surface immediately to Drake with the grep evidence. Possible causes:

- `tsconfig.json` paths misconfiguration excluding the new files
- `next.config.js` having a `pageExtensions` or experimental option that's filtering
- The new files have a syntax error that's silently excluded during compilation (Next.js sometimes warns but doesn't fail)
- The route group `(authenticated)` is being skipped due to a parsing quirk with the parentheses

Run `npx tsc --noEmit` against the project to see if TypeScript compiles cleanly. If TS fails, the failing errors are the bug.

### Step 4 — If local build is correct (hits in .next exist)

The bug is on Vercel's side. Pull the Vercel build log for the latest production deployment via the Vercel CLI:

```bash
# Install vercel CLI if not already present
npx vercel --version

# Login if needed (Drake handles interactive login)
# Don't run `vercel login` unattended

# List recent deployments
npx vercel ls ai-enablement --token <ask Drake for token if needed>

# Pull the build log for the deployment ID matching commit 8d39c91
npx vercel inspect <deployment-url> --logs
```

If the Vercel CLI isn't trivially usable (token / login flow), STOP — Drake will handle the Vercel-side investigation via the dashboard or Cowork. Don't burn cycles getting `vercel inspect` working.

The key Vercel build-log details to surface:
- Did Vercel run `npm install` cleanly (no version mismatch)?
- Did Vercel run `npm run build` with the same Next version?
- Are there any warnings in the build log about excluded files, unresolved imports, or skipped routes?
- Does the build log show `/clients` as Dynamic in the route table at the end?

### Step 5 — Check Vercel project settings indirectly

Surface to Drake any of these that could be relevant — Drake checks them in the Vercel dashboard:

- **Build & Development Settings → Build Command:** should be the default `next build` or `npm run build`. If overridden to something custom (e.g., `next build --no-experimental-app`), that could exclude App Router routes.
- **Build & Development Settings → Output Directory:** should be `.next` (default). If overridden, the deployment serves a different build output.
- **Build & Development Settings → Root Directory:** should be the repo root (empty or `./`). If set to a subdirectory, the new files might be outside the build scope.
- **Environment Variables → Production:** are all required env vars present? Missing env vars sometimes cause silent build issues, especially if a top-level component reads `process.env.FOO` at module-load time.
- **Git → Production Branch:** is it `main`? If it's pointing at a different branch (`master`, `release`, etc.), commits to `main` don't trigger production deploys.

### Step 6 — Sanity check the deployed Vercel build matches the local build

If both local and Vercel builds CLAIM to be building from `8d39c91` and producing the right output, but the deployed JS bundles don't have the new code:

```bash
# What's the commit Vercel actually checked out?
# The build log will show this in the "Cloning" step at the top.
# Compare to: git rev-parse 8d39c91
git rev-parse 8d39c91
```

If Vercel checked out a different commit than `8d39c91` despite the dashboard showing `8d39c91`, that's the bug — a sync issue between Vercel's GitHub connection and the actual repo state.

## Hard stops

- **Local build fails to start (`next build` errors out).** Surface the error verbatim. Don't try to fix code yourself; this is a diagnosis spec.
- **`git checkout 8d39c91` produces uncommitted-change conflicts.** Stash, surface, ask Drake whether to proceed. Don't force.
- **Vercel CLI login flow is required and Drake isn't paired.** Skip Step 4's CLI portion — Drake will pull build logs from the dashboard manually.
- **You find a fix-worthy bug in the code.** STOP. Surface, don't fix. This spec is investigation-only; a fix spec comes after diagnosis is complete.

## What could go wrong

- **The local build succeeds AND contains the new code, AND Vercel's logs claim to build the same way, AND the deployed output still lacks it.** That's the truly weird case. Possible: Vercel's CDN is serving a stale cached build artifact at the deployment level (not edge cache, but build-artifact cache). Documented occasionally in Vercel forums; fix is to delete the deployment entirely and trigger a fresh one. Surface if you reach this state.
- **The local build subtly differs from Vercel's.** Node version mismatch, npm vs Vercel's package manager, etc. The acclimatization-step `package.json` read should surface this; if it doesn't, dig into the build log.
- **The route group `(authenticated)` parens-handling has a Next.js quirk.** Worth verifying via `ls .next/server/app/` — the route group should appear as a literal `(authenticated)` directory. If it's missing entirely, that's a build-time exclusion.

## Mandatory doc updates

- **None during investigation.** Once Drake confirms the root cause, a follow-up spec writes the fix and updates state.md / docs/known-issues.md.

## Commit + report

- **No code commits.** This is read-only diagnosis.
- **Report at `docs/reports/investigate-vercel-build-missing-changes.md`** with:
  - Step 1 build output (success/fail, route table for /clients, warnings)
  - Step 2 grep results from `.next/`
  - Step 4 Vercel build log excerpts (if accessible)
  - Step 5 Vercel project settings flags (if Drake reports them)
  - Step 6 commit-sha comparison
  - Final hypothesis with the strongest evidence behind it
  - Specific next action Drake should take (e.g., "delete the deployment and redeploy fresh," or "Production branch is set wrong in Vercel settings," or "tsconfig is excluding `app/(authenticated)/`")
